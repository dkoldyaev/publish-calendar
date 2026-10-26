import crypto from 'node:crypto';
import type { z } from 'zod';
import {
  applyPostponement,
  calculateSchedule,
  formatInstantToLocalDate,
  resolveDeletePhoto,
  resolveMarkPublished,
  resolveQueueReorder,
  resolveUpdateDescription,
  resolveUpdateSettings,
  sortPendingQueue,
  type PhotoRecord,
  type ScheduleOutput,
  type SyncConflict,
  type SyncOperationRequestSchema,
  type UserSettings,
} from '@publish-calendar/shared';
import type { DatabaseClient, DatabasePool } from '../db/pool.js';
import type { S3StorageService } from '../storage/s3.js';
import {
  getAllUserPhotos,
  getPhotoById,
  getUserConflicts,
  getUserSettings,
  normalizeAndReconcileUserQueue,
  saveConflict,
  updateSettingsRow,
  upsertPhotoRow,
} from './repository.js';

export type SyncOperationInput = z.infer<typeof SyncOperationRequestSchema>;

export interface ProcessedOperationOutcome {
  idempotencyKey: string;
  type: SyncOperationInput['type'];
  applied: boolean;
  deduplicated: boolean;
  conflict: SyncConflict | null;
}

export interface BatchSyncResponse {
  outcomes: ProcessedOperationOutcome[];
  photos: PhotoRecord[];
  settings: UserSettings;
  schedule: ScheduleOutput;
  conflicts: SyncConflict[];
  serverTimestamp: string;
}

async function processSingleOperationInTx(params: {
  tx: DatabaseClient;
  userId: string;
  op: SyncOperationInput;
  s3: S3StorageService;
  nowIso: string;
}): Promise<ProcessedOperationOutcome> {
  const { tx, userId, op, s3, nowIso } = params;

  const existingOp = await tx.query<{
    response_result: ProcessedOperationOutcome;
  }>(
    `SELECT response_result
     FROM sync_operations
     WHERE idempotency_key = $1 AND user_id = $2`,
    [op.idempotencyKey, userId]
  );

  if (existingOp.rows[0]) {
    const prev = existingOp.rows[0].response_result;
    return {
      ...prev,
      deduplicated: true,
    };
  }

  let applied = false;
  let conflict: SyncConflict | null = null;

  switch (op.type) {
    case 'CREATE_PHOTO': {
      const incoming = op.payload.photo;
      const existingPhoto = await getPhotoById(tx, userId, incoming.id);
      if (!existingPhoto) {
        const allPhotos = await getAllUserPhotos(tx, userId);
        const pending = sortPendingQueue(allPhotos);
        const nextPos = pending.length;
        const s3Key = s3.buildPhotoKey(userId, incoming.id);

        const newPhoto: PhotoRecord = {
          ...incoming,
          userId,
          status: 'pending',
          queuePosition: nextPos,
          uploadState:
            incoming.uploadState === 'uploaded' ? 'uploaded' : 'upload_pending',
          s3Key,
          publishedAt: null,
          deletedAt: null,
          revision: 1,
          updatedAt: nowIso,
        };

        await upsertPhotoRow(tx, newPhoto);
        await tx.query(
          `INSERT INTO upload_records (
             photo_id, user_id, s3_bucket, s3_key, upload_state,
             etag, size_bytes, attempts, last_error, updated_at
           )
           VALUES ($1, $2, $3, $4, $5, NULL, $6, 0, NULL, $7)
           ON CONFLICT (photo_id) DO NOTHING`,
          [
            newPhoto.id,
            userId,
            s3.bucket,
            s3Key,
            newPhoto.uploadState,
            newPhoto.sizeBytes,
            nowIso,
          ]
        );

        const settings = await getUserSettings(tx, userId);
        await updateSettingsRow(tx, {
          ...settings,
          queueRevision: settings.queueRevision + 1,
          updatedAt: nowIso,
        });
        applied = true;
      }
      break;
    }

    case 'UPDATE_DESCRIPTION': {
      const serverPhoto = await getPhotoById(tx, userId, op.payload.photoId);
      if (serverPhoto) {
        const resolution = resolveUpdateDescription({
          operationId: op.idempotencyKey,
          serverPhoto,
          payload: op.payload,
          nowIso,
          conflictId: crypto.randomUUID(),
        });
        applied = resolution.applied;
        conflict = resolution.conflict;
        if (resolution.applied) {
          await upsertPhotoRow(tx, resolution.updatedState);
        }
        if (conflict) {
          await saveConflict(tx, userId, conflict);
        }
      }
      break;
    }

    case 'MARK_PUBLISHED': {
      const serverPhoto = await getPhotoById(tx, userId, op.payload.photoId);
      if (serverPhoto) {
        const resolution = resolveMarkPublished({
          operationId: op.idempotencyKey,
          serverPhoto,
          payload: op.payload,
          nowIso,
          conflictId: crypto.randomUUID(),
        });
        applied = resolution.applied;
        conflict = resolution.conflict;

        if (resolution.applied) {
          await upsertPhotoRow(tx, resolution.updatedState);
          const settings = await getUserSettings(tx, userId);
          const pubLocalDate = formatInstantToLocalDate(
            op.payload.publishedAt,
            settings.timeZone
          );

          await tx.query(
            `INSERT INTO publication_history (
               id, user_id, photo_id, scheduled_date, published_at,
               published_local_date, time_zone, idempotency_key, created_at
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (user_id, photo_id) DO NOTHING`,
            [
              crypto.randomUUID(),
              userId,
              serverPhoto.id,
              op.payload.scheduledDateAtPublication,
              op.payload.publishedAt,
              pubLocalDate,
              settings.timeZone,
              op.idempotencyKey,
              nowIso,
            ]
          );

          // Invalidate any pending reminders for this published photo immediately
          await tx.query(
            `UPDATE notification_schedules
             SET status = 'invalidated',
                 invalidated_at = $3,
                 updated_at = $3
             WHERE user_id = $1 AND photo_id = $2 AND status = 'pending'`,
            [userId, serverPhoto.id, nowIso]
          );

          await updateSettingsRow(tx, {
            ...settings,
            queueRevision: settings.queueRevision + 1,
            updatedAt: nowIso,
          });
        }
        if (conflict) {
          await saveConflict(tx, userId, conflict);
        }
      }
      break;
    }

    case 'DELETE_PHOTO': {
      const serverPhoto = await getPhotoById(tx, userId, op.payload.photoId);
      if (serverPhoto) {
        const resolution = resolveDeletePhoto({
          operationId: op.idempotencyKey,
          serverPhoto,
          payload: op.payload,
          nowIso,
          conflictId: crypto.randomUUID(),
        });
        applied = resolution.applied;
        conflict = resolution.conflict;

        if (resolution.applied) {
          await upsertPhotoRow(tx, resolution.updatedState);

          // Invalidate any pending reminders for this deleted photo immediately
          await tx.query(
            `UPDATE notification_schedules
             SET status = 'invalidated',
                 invalidated_at = $3,
                 updated_at = $3
             WHERE user_id = $1 AND photo_id = $2 AND status = 'pending'`,
            [userId, serverPhoto.id, nowIso]
          );

          const settings = await getUserSettings(tx, userId);
          await updateSettingsRow(tx, {
            ...settings,
            queueRevision: settings.queueRevision + 1,
            updatedAt: nowIso,
          });
        }
        if (conflict) {
          await saveConflict(tx, userId, conflict);
        }
      }
      break;
    }

    case 'REORDER_QUEUE': {
      const allPhotos = await getAllUserPhotos(tx, userId);
      const settings = await getUserSettings(tx, userId);
      const reorderResult = resolveQueueReorder({
        operationId: op.idempotencyKey,
        serverPhotos: allPhotos,
        serverQueueRevision: settings.queueRevision,
        payload: op.payload,
        nowIso,
        conflictId: crypto.randomUUID(),
      });

      for (const updatedPhoto of reorderResult.updatedPhotos) {
        const original = allPhotos.find((p) => p.id === updatedPhoto.id);
        if (
          original &&
          (original.queuePosition !== updatedPhoto.queuePosition ||
            original.revision !== updatedPhoto.revision)
        ) {
          await upsertPhotoRow(tx, updatedPhoto);
        }
      }

      await updateSettingsRow(tx, {
        ...settings,
        queueRevision: reorderResult.nextQueueRevision,
        updatedAt: nowIso,
      });

      applied = true;
      conflict = reorderResult.conflict;
      if (conflict) {
        await saveConflict(tx, userId, conflict);
      }
      break;
    }

    case 'POSTPONE_REMINDER': {
      const allPhotos = await getAllUserPhotos(tx, userId);
      const settings = await getUserSettings(tx, userId);
      const beforeSchedule = calculateSchedule({
        photos: allPhotos,
        settings,
        currentInstant: op.payload.requestedAt,
      });

      const postponed = applyPostponement({
        settings,
        photos: allPhotos,
        duration: op.payload.duration,
        currentInstant: op.payload.requestedAt,
      });

      await updateSettingsRow(tx, postponed.updatedSettings);

      const targetPhotoId =
        beforeSchedule.nextPendingPhoto?.id ?? op.payload.photoId;
      const targetPhoto = await getPhotoById(tx, userId, targetPhotoId);
      if (targetPhoto) {
        await tx.query(
          `INSERT INTO postponement_history (
             id, user_id, photo_id, duration, previous_remind_at,
             next_remind_at, postponed_until_date, requested_at, idempotency_key
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [
            crypto.randomUUID(),
            userId,
            targetPhoto.id,
            op.payload.duration,
            beforeSchedule.nextReminderInstant,
            postponed.schedule.nextReminderInstant,
            postponed.updatedSettings.postponedUntilDate,
            op.payload.requestedAt,
            op.idempotencyKey,
          ]
        );
      }
      applied = true;
      break;
    }

    case 'UPDATE_SETTINGS': {
      const settings = await getUserSettings(tx, userId);
      const resolution = resolveUpdateSettings({
        operationId: op.idempotencyKey,
        serverSettings: settings,
        payload: op.payload,
        nowIso,
        conflictId: crypto.randomUUID(),
      });
      applied = resolution.applied;
      conflict = resolution.conflict;
      if (resolution.applied) {
        await updateSettingsRow(tx, resolution.updatedState);
      }
      if (conflict) {
        await saveConflict(tx, userId, conflict);
      }
      break;
    }
  }

  const outcome: ProcessedOperationOutcome = {
    idempotencyKey: op.idempotencyKey,
    type: op.type,
    applied,
    deduplicated: false,
    conflict,
  };

  await tx.query(
    `INSERT INTO sync_operations (
       idempotency_key, user_id, operation_type,
       request_payload, response_result, processed_at
     )
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      op.idempotencyKey,
      userId,
      op.type,
      JSON.stringify(op.payload),
      JSON.stringify(outcome),
      nowIso,
    ]
  );

  return outcome;
}

export async function processSyncBatch(params: {
  pool: DatabasePool;
  userId: string;
  operations: readonly SyncOperationInput[];
  s3: S3StorageService;
  nowIso?: string;
}): Promise<BatchSyncResponse> {
  const nowIso = params.nowIso ?? new Date().toISOString();

  return await params.pool.withTransaction(async (tx) => {
    const outcomes: ProcessedOperationOutcome[] = [];
    for (const op of params.operations) {
      const outcome = await processSingleOperationInTx({
        tx,
        userId: params.userId,
        op,
        s3: params.s3,
        nowIso,
      });
      outcomes.push(outcome);
    }

    const { photos, settings, schedule } = await normalizeAndReconcileUserQueue(
      tx,
      params.userId,
      nowIso
    );
    const conflicts = await getUserConflicts(tx, params.userId);

    return {
      outcomes,
      photos,
      settings,
      schedule,
      conflicts,
      serverTimestamp: nowIso,
    };
  });
}

export async function resolveUserConflictManually(params: {
  pool: DatabasePool;
  userId: string;
  conflictId: string;
  choice: 'KEEP_SERVER' | 'APPLY_CLIENT';
  nowIso?: string;
}): Promise<{
  photos: PhotoRecord[];
  settings: UserSettings;
  schedule: ScheduleOutput;
  conflicts: SyncConflict[];
}> {
  const nowIso = params.nowIso ?? new Date().toISOString();
  return await params.pool.withTransaction(async (tx) => {
    const res = await tx.query<{
      id: string;
      photo_id: string | null;
      conflict_type: string;
      client_value: { description?: string };
      resolved: boolean;
    }>(
      `SELECT id, photo_id, conflict_type, client_value, resolved
       FROM sync_conflicts
       WHERE id = $1 AND user_id = $2`,
      [params.conflictId, params.userId]
    );
    const row = res.rows[0];
    if (row && !row.resolved) {
      if (
        params.choice === 'APPLY_CLIENT' &&
        row.conflict_type === 'DESCRIPTION_CONFLICT' &&
        row.photo_id &&
        typeof row.client_value.description === 'string'
      ) {
        const photo = await getPhotoById(tx, params.userId, row.photo_id);
        if (photo && photo.status !== 'deleted') {
          await upsertPhotoRow(tx, {
            ...photo,
            description: row.client_value.description,
            updatedAt: nowIso,
            revision: photo.revision + 1,
          });
        }
      }
      await tx.query(
        `UPDATE sync_conflicts
         SET resolved = true,
             resolution = $3
         WHERE id = $1 AND user_id = $2`,
        [
          params.conflictId,
          params.userId,
          params.choice === 'APPLY_CLIENT' ? 'CLIENT_WON' : 'SERVER_WON',
        ]
      );
    }

    const { photos, settings, schedule } = await normalizeAndReconcileUserQueue(
      tx,
      params.userId,
      nowIso
    );
    const conflicts = await getUserConflicts(tx, params.userId);
    return { photos, settings, schedule, conflicts };
  });
}
