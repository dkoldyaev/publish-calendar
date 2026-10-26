import webpush from 'web-push';
import type { ApiConfig } from '../config/env.js';
import type { DatabasePool } from '../db/pool.js';
import { normalizeAndReconcileUserQueue } from '../services/repository.js';

export interface PushSubscriptionTarget {
  id: string;
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface PushNotificationPayload {
  title: string;
  body: string;
  photoId: string | null;
  scheduledDate: string | null;
  url: string;
  occurrenceKey: string;
  actions: Array<{
    action: string;
    title: string;
  }>;
}

export type PushSenderFn = (
  subscription: PushSubscriptionTarget,
  payloadJson: string
) => Promise<{ statusCode: number }>;

export function createDefaultWebPushSender(config: ApiConfig): PushSenderFn {
  let vapidInitialized = false;
  return async (subscription, payloadJson) => {
    if (!vapidInitialized) {
      webpush.setVapidDetails(
        config.vapidSubject,
        config.vapidPublicKey,
        config.vapidPrivateKey
      );
      vapidInitialized = true;
    }
    const result = await webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: subscription.keys,
      },
      payloadJson
    );
    return { statusCode: result.statusCode };
  };
}

export function extractErrorStatusCode(err: unknown): number | null {
  if (typeof err === 'object' && err !== null && 'statusCode' in err) {
    const val = (err as Record<string, unknown>)['statusCode'];
    if (typeof val === 'number') {
      return val;
    }
  }
  return null;
}

export class NotificationSchedulerWorker {
  private timer: NodeJS.Timeout | null = null;
  private runningTick = false;
  private readonly pushSender: PushSenderFn;

  constructor(
    private readonly pool: DatabasePool,
    private readonly config: ApiConfig,
    customPushSender?: PushSenderFn
  ) {
    this.pushSender = customPushSender ?? createDefaultWebPushSender(config);
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.runTick();
    }, this.config.notificationPollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runTick(nowIso = new Date().toISOString()): Promise<{
    processedCount: number;
    sentCount: number;
    invalidatedCount: number;
  }> {
    if (this.runningTick) {
      return { processedCount: 0, sentCount: 0, invalidatedCount: 0 };
    }
    this.runningTick = true;

    let processedCount = 0;
    let sentCount = 0;
    let invalidatedCount = 0;

    try {
      const usersRes = await this.pool.query<{ id: string }>(
        `SELECT id FROM users`
      );
      for (const userRow of usersRes.rows) {
        await this.pool.withTransaction(async (tx) => {
          await normalizeAndReconcileUserQueue(tx, userRow.id, nowIso);
        });
      }

      const dueSchedules = await this.pool.query<{
        id: string;
        user_id: string;
        photo_id: string;
        scheduled_for: Date | string;
        occurrence_key: string;
        attempts: number;
      }>(
        `SELECT id, user_id, photo_id, scheduled_for, occurrence_key, attempts
         FROM notification_schedules
         WHERE status = 'pending' AND scheduled_for <= $1
         ORDER BY scheduled_for ASC`,
        [nowIso]
      );

      for (const scheduleRow of dueSchedules.rows) {
        processedCount++;

        const photoRes = await this.pool.query<{
          id: string;
          file_name: string;
          description: string;
          status: string;
        }>(
          `SELECT id, file_name, description, status
           FROM photographs
           WHERE id = $1 AND user_id = $2`,
          [scheduleRow.photo_id, scheduleRow.user_id]
        );
        const photo = photoRes.rows[0];

        if (!photo || photo.status !== 'pending') {
          await this.pool.query(
            `UPDATE notification_schedules
             SET status = 'invalidated',
                 invalidated_at = $2,
                 updated_at = $2
             WHERE id = $1`,
            [scheduleRow.id, nowIso]
          );
          invalidatedCount++;
          continue;
        }

        const subsRes = await this.pool.query<{
          id: string;
          endpoint: string;
          p256dh_key: string;
          auth_key: string;
        }>(
          `SELECT id, endpoint, p256dh_key, auth_key
           FROM push_subscriptions
           WHERE user_id = $1 AND active = true`,
          [scheduleRow.user_id]
        );

        if (subsRes.rows.length === 0) {
          continue;
        }

        const shortDesc =
          photo.description.trim().length > 0
            ? photo.description.trim().slice(0, 90)
            : 'Нажмите, чтобы скачать фото и подтвердить публикацию.';

        const payload: PushNotificationPayload = {
          title: `Публикация фото: ${photo.file_name}`,
          body: shortDesc,
          photoId: photo.id,
          scheduledDate: null,
          url: `/photo/${photo.id}?from=notification`,
          occurrenceKey: scheduleRow.occurrence_key,
          actions: [
            { action: 'postpone:15m', title: '+15 мин' },
            { action: 'postpone:1h', title: '+1 час' },
            { action: 'postpone:3h', title: '+3 часа' },
            { action: 'postpone:6h', title: '+6 часов' },
            { action: 'postpone:tomorrow', title: 'На завтра' },
          ],
        };

        const payloadJson = JSON.stringify(payload);
        let deliveredToAny = false;
        let lastErrMessage: string | null = null;

        for (const sub of subsRes.rows) {
          try {
            await this.pushSender(
              {
                id: sub.id,
                endpoint: sub.endpoint,
                keys: {
                  p256dh: sub.p256dh_key,
                  auth: sub.auth_key,
                },
              },
              payloadJson
            );
            deliveredToAny = true;
          } catch (err: unknown) {
            const statusCode = extractErrorStatusCode(err);

            if (statusCode === 404 || statusCode === 410) {
              await this.pool.query(
                `UPDATE push_subscriptions
                 SET active = false, updated_at = $2
                 WHERE id = $1`,
                [sub.id, nowIso]
              );
            } else {
              lastErrMessage =
                err instanceof Error ? err.message : 'Push delivery failed';
            }
          }
        }

        if (deliveredToAny) {
          await this.pool.query(
            `UPDATE notification_schedules
             SET status = 'sent',
                 sent_at = $2,
                 attempts = attempts + 1,
                 updated_at = $2
             WHERE id = $1 AND status = 'pending'`,
            [scheduleRow.id, nowIso]
          );
          sentCount++;
        } else if (lastErrMessage !== null) {
          const nextAttempts = scheduleRow.attempts + 1;
          const nextStatus =
            nextAttempts >= this.config.notificationMaxRetries
              ? 'failed'
              : 'pending';
          await this.pool.query(
            `UPDATE notification_schedules
             SET status = $2,
                 attempts = $3,
                 last_error = $4,
                 updated_at = $5
             WHERE id = $1`,
            [scheduleRow.id, nextStatus, nextAttempts, lastErrMessage, nowIso]
          );
        }
      }

      return { processedCount, sentCount, invalidatedCount };
    } finally {
      this.runningTick = false;
    }
  }

  async sendTestNotification(
    userId: string,
    nowIso = new Date().toISOString()
  ): Promise<{ deliveredCount: number }> {
    const subsRes = await this.pool.query<{
      id: string;
      endpoint: string;
      p256dh_key: string;
      auth_key: string;
    }>(
      `SELECT id, endpoint, p256dh_key, auth_key
       FROM push_subscriptions
       WHERE user_id = $1 AND active = true`,
      [userId]
    );

    const payload: PushNotificationPayload = {
      title: 'Проверка уведомлений — Календарь публикаций',
      body: 'Push-уведомления успешно настроены и работают.',
      photoId: null,
      scheduledDate: null,
      url: '/settings',
      occurrenceKey: `test:${userId}:${nowIso}`,
      actions: [],
    };
    const payloadJson = JSON.stringify(payload);

    let deliveredCount = 0;
    for (const sub of subsRes.rows) {
      try {
        await this.pushSender(
          {
            id: sub.id,
            endpoint: sub.endpoint,
            keys: {
              p256dh: sub.p256dh_key,
              auth: sub.auth_key,
            },
          },
          payloadJson
        );
        deliveredCount++;
      } catch (err: unknown) {
        const statusCode = extractErrorStatusCode(err);
        if (statusCode === 404 || statusCode === 410) {
          await this.pool.query(
            `UPDATE push_subscriptions
             SET active = false, updated_at = $2
             WHERE id = $1`,
            [sub.id, nowIso]
          );
        }
      }
    }

    return { deliveredCount };
  }
}
