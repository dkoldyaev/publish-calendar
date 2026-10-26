import crypto from 'node:crypto';
import {
  applyPostponement,
  calculateSchedule,
  formatInstantToLocalDate,
  normalizeQueuePositions,
  resolveDeletePhoto,
  resolveMarkPublished,
  resolveQueueReorder,
  resolveUpdateDescription,
  resolveUpdateSettings,
  type PhotoRecord,
  type PostponementDuration,
  type ScheduleOutput,
  type SupportedImageMimeType,
  type SyncConflict,
  type UploadState,
  type UserSettings,
} from '@publish-calendar/shared';
import type { DatabaseClient, DatabasePool } from '../db/pool.js';

interface DbPhotoRow {
  id: string;
  user_id: string;
  file_name: string;
  mime_type: SupportedImageMimeType;
  size_bytes: number;
  description: string;
  status: 'pending' | 'published' | 'deleted';
  queue_position: number | null;
  upload_state: UploadState;
  s3_key: string | null;
  checksum_sha256: string;
  created_at: Date | string;
  updated_at: Date | string;
  published_at: Date | string | null;
  scheduled_date_at_publication: string | null;
  deleted_at: Date | string | null;
  revision: number;
}

interface DbSettingsRow {
  user_id: string;
  reminder_time: string;
  time_zone: string;
  postponed_until_date: string | null;
  active_postponed_remind_at: Date | string | null;
  active_postponed_photo_id: string | null;
  queue_revision: number;
  updated_at: Date | string;
}

interface DbConflictRow {
  id: string;
  user_id: string;
  operation_id: string;
  photo_id: string | null;
  conflict_type: SyncConflict['conflictType'];
  resolution: SyncConflict['resolution'];
  message: string;
  client_value: unknown;
  server_value: unknown;
  resolved: boolean;
  created_at: Date | string;
}

function toIsoString(val: Date | string | null): string | null {
  if (val === null) {
    return null;
  }
  if (val instanceof Date) {
    return val.toISOString();
  }
  return new Date(val).toISOString();
}

export function mapRowToPhoto(row: DbPhotoRow): PhotoRecord {
  return {
    id: row.id,
    userId: row.user_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    description: row.description,
    status: row.status,
    queuePosition: row.queue_position,
    uploadState: row.upload_state,
    s3Key: row.s3_key,
    checksumSha256: row.checksum_sha256,
    createdAt: toIsoString(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: toIsoString(row.updated_at) ?? new Date(0).toISOString(),
    publishedAt: toIsoString(row.published_at),
    scheduledDateAtPublication: row.scheduled_date_at_publication,
    deletedAt: toIsoString(row.deleted_at),
    revision: row.revision,
  };
}

export function mapRowToSettings(row: DbSettingsRow): UserSettings {
  return {
    userId: row.user_id,
    reminderTime: row.reminder_time,
    timeZone: row.time_zone,
    postponedUntilDate: row.postponed_until_date,
    activePostponedRemindAt: toIsoString(row.active_postponed_remind_at),
    activePostponedPhotoId: row.active_postponed_photo_id,
    queueRevision: row.queue_revision,
    updatedAt: toIsoString(row.updated_at) ?? new Date(0).toISOString(),
  };
}

export function mapRowToConflict(row: DbConflictRow): SyncConflict {
  return {
    id: row.id,
    operationId: row.operation_id,
    photoId: row.photo_id,
    conflictType: row.conflict_type,
    resolution: row.resolution,
    message: row.message,
    clientValue: row.client_value,
    serverValue: row.server_value,
    resolved: row.resolved,
    createdAt: toIsoString(row.created_at) ?? new Date(0).toISOString(),
  };
}

export async function ensureUserExists(
  client: DatabaseClient,
  userId: string,
  defaultTimezone: string,
  defaultReminderTime: string,
  nowIso: string
): Promise<void> {
  await client.query(
    `INSERT INTO users (id, created_at)
     VALUES ($1, $2)
     ON CONFLICT (id) DO NOTHING`,
    [userId, nowIso]
  );
  await client.query(
    `INSERT INTO user_settings (
       user_id, reminder_time, time_zone, postponed_until_date,
       active_postponed_remind_at, active_postponed_photo_id,
       queue_revision, updated_at
     )
     VALUES ($1, $2, $3, NULL, NULL, NULL, 1, $4)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, defaultReminderTime, defaultTimezone, nowIso]
  );
}

export async function getUserSettings(
  client: DatabaseClient,
  userId: string
): Promise<UserSettings> {
  const res = await client.query<DbSettingsRow>(
    `SELECT * FROM user_settings WHERE user_id = $1`,
    [userId]
  );
  const row = res.rows[0];
  if (!row) {
    throw new Error(`User settings not found for user ${userId}`);
  }
  return mapRowToSettings(row);
}

export async function getAllUserPhotos(
  client: DatabaseClient,
  userId: string
): Promise<PhotoRecord[]> {
  const res = await client.query<DbPhotoRow>(
    `SELECT * FROM photographs
     WHERE user_id = $1
     ORDER BY
       CASE WHEN status = 'pending' THEN 0 ELSE 1 END ASC,
       queue_position ASC NULLS LAST,
       created_at ASC,
       id ASC`,
    [userId]
  );
  return res.rows.map(mapRowToPhoto);
}

export async function getPhotoById(
  client: DatabaseClient,
  userId: string,
  photoId: string
): Promise<PhotoRecord | null> {
  const res = await client.query<DbPhotoRow>(
    `SELECT * FROM photographs WHERE id = $1 AND user_id = $2`,
    [photoId, userId]
  );
  const row = res.rows[0];
  return row ? mapRowToPhoto(row) : null;
}

export async function getUserConflicts(
  client: DatabaseClient,
  userId: string
): Promise<SyncConflict[]> {
  const res = await client.query<DbConflictRow>(
    `SELECT * FROM sync_conflicts
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 100`,
    [userId]
  );
  return res.rows.map(mapRowToConflict);
}

export async function saveConflict(
  client: DatabaseClient,
  userId: string,
  conflict: SyncConflict
): Promise<void> {
  await client.query(
    `INSERT INTO sync_conflicts (
       id, user_id, operation_id, photo_id, conflict_type,
       resolution, message, client_value, server_value, resolved, created_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11)
     ON CONFLICT (id) DO NOTHING`,
    [
      conflict.id,
      userId,
      conflict.operationId,
      conflict.photoId,
      conflict.conflictType,
      conflict.resolution,
      conflict.message,
      JSON.stringify(conflict.clientValue ?? null),
      JSON.stringify(conflict.serverValue ?? null),
      conflict.resolved,
      conflict.createdAt,
    ]
  );
}

export async function upsertPhotoRow(
  client: DatabaseClient,
  photo: PhotoRecord
): Promise<void> {
  await client.query(
    `INSERT INTO photographs (
       id, user_id, file_name, mime_type, size_bytes, description,
       status, queue_position, upload_state, s3_key, checksum_sha256,
       created_at, updated_at, published_at, scheduled_date_at_publication,
       deleted_at, revision
     )
     VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9, $10, $11,
       $12, $13, $14, $15,
       $16, $17
     )
     ON CONFLICT (id) DO UPDATE SET
       file_name = EXCLUDED.file_name,
       mime_type = EXCLUDED.mime_type,
       size_bytes = EXCLUDED.size_bytes,
       description = EXCLUDED.description,
       status = EXCLUDED.status,
       queue_position = EXCLUDED.queue_position,
       upload_state = EXCLUDED.upload_state,
       s3_key = COALESCE(photographs.s3_key, EXCLUDED.s3_key),
       checksum_sha256 = EXCLUDED.checksum_sha256,
       updated_at = EXCLUDED.updated_at,
       published_at = EXCLUDED.published_at,
       scheduled_date_at_publication = EXCLUDED.scheduled_date_at_publication,
       deleted_at = EXCLUDED.deleted_at,
       revision = EXCLUDED.revision`,
    [
      photo.id,
      photo.userId,
      photo.fileName,
      photo.mimeType,
      photo.sizeBytes,
      photo.description,
      photo.status,
      photo.queuePosition,
      photo.uploadState,
      photo.s3Key,
      photo.checksumSha256,
      photo.createdAt,
      photo.updatedAt,
      photo.publishedAt,
      photo.scheduledDateAtPublication,
      photo.deletedAt,
      photo.revision,
    ]
  );
}

export async function updateSettingsRow(
  client: DatabaseClient,
  settings: UserSettings
): Promise<void> {
  await client.query(
    `UPDATE user_settings
     SET reminder_time = $2,
         time_zone = $3,
         postponed_until_date = $4,
         active_postponed_remind_at = $5,
         active_postponed_photo_id = $6,
         queue_revision = $7,
         updated_at = $8
     WHERE user_id = $1`,
    [
      settings.userId,
      settings.reminderTime,
      settings.timeZone,
      settings.postponedUntilDate,
      settings.activePostponedRemindAt,
      settings.activePostponedPhotoId,
      settings.queueRevision,
      settings.updatedAt,
    ]
  );
}

/**
 * Invalidates obsolete pending notification schedules for a user or specific photo,
 * and schedules the active reminder for the current next pending photo idempotently.
 */
export async function reconcileNotificationSchedule(
  client: DatabaseClient,
  userId: string,
  schedule: ScheduleOutput,
  nowIso: string
): Promise<void> {
  const nextPhoto = schedule.nextPendingPhoto;
  const nextInstant = schedule.nextReminderInstant;

  if (!nextPhoto || !nextInstant) {
    // No pending photos — invalidate all pending reminders for this user
    await client.query(
      `UPDATE notification_schedules
       SET status = 'invalidated',
           invalidated_at = $2,
           updated_at = $2
       WHERE user_id = $1 AND status = 'pending'`,
      [userId, nowIso]
    );
    return;
  }

  const occurrenceKey = `${userId}:${nextPhoto.id}:${nextInstant}`;

  // Invalidate any pending reminder that does not match the current active occurrenceKey
  await client.query(
    `UPDATE notification_schedules
     SET status = 'invalidated',
         invalidated_at = $3,
         updated_at = $3
     WHERE user_id = $1
       AND status = 'pending'
       AND occurrence_key <> $2`,
    [userId, occurrenceKey, nowIso]
  );

  // Also ensure any pending reminders for photos that are no longer 'pending' are invalidated
  await client.query(
    `UPDATE notification_schedules ns
     SET status = 'invalidated',
         invalidated_at = $2,
         updated_at = $2
     FROM photographs p
     WHERE ns.photo_id = p.id
       AND ns.user_id = $1
       AND ns.status = 'pending'
       AND p.status <> 'pending'`,
    [userId, nowIso]
  );

  // Upsert the current occurrence idempotently (if already 'sent', do not re-enable!)
  await client.query(
    `INSERT INTO notification_schedules (
       id, user_id, photo_id, scheduled_for, occurrence_key,
       status, attempts, sent_at, invalidated_at, last_error,
       created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, 'pending', 0, NULL, NULL, NULL, $6, $6)
     ON CONFLICT (occurrence_key) DO UPDATE SET
       status = CASE
         WHEN notification_schedules.status = 'sent' THEN 'sent'
         ELSE 'pending'
       END,
       invalidated_at = CASE
         WHEN notification_schedules.status = 'sent' THEN notification_schedules.invalidated_at
         ELSE NULL
       END,
       updated_at = EXCLUDED.updated_at`,
    [
      crypto.randomUUID(),
      userId,
      nextPhoto.id,
      nextInstant,
      occurrenceKey,
      nowIso,
    ]
  );
}

/**
 * Re-normalizes dense queue positions (0..N-1) for all pending photographs of a user
 * and reconciles the notification schedule within the current transaction.
 */
export async function normalizeAndReconcileUserQueue(
  client: DatabaseClient,
  userId: string,
  nowIso: string
): Promise<{
  photos: PhotoRecord[];
  settings: UserSettings;
  schedule: ScheduleOutput;
}> {
  const rawPhotos = await getAllUserPhotos(client, userId);
  const normalized = normalizeQueuePositions(rawPhotos);

  for (const photo of normalized) {
    const prev = rawPhotos.find((r) => r.id === photo.id);
    if (prev && prev.queuePosition !== photo.queuePosition) {
      await client.query(
        `UPDATE photographs
         SET queue_position = $2, updated_at = $3
         WHERE id = $1 AND user_id = $4`,
        [photo.id, photo.queuePosition, nowIso, userId]
      );
    }
  }

  let settings = await getUserSettings(client, userId);

  // Clear short postponement if front photo changed or was published/deleted
  const pendingFront = normalized.find(
    (p) => p.status === 'pending' && p.queuePosition === 0
  );
  if (
    settings.activePostponedPhotoId !== null &&
    (!pendingFront || pendingFront.id !== settings.activePostponedPhotoId)
  ) {
    settings = {
      ...settings,
      activePostponedPhotoId: null,
      activePostponedRemindAt: null,
      updatedAt: nowIso,
    };
    await updateSettingsRow(client, settings);
  }

  const schedule = calculateSchedule({
    photos: normalized,
    settings,
    currentInstant: nowIso,
  });

  await reconcileNotificationSchedule(client, userId, schedule, nowIso);

  return {
    photos: normalized,
    settings,
    schedule,
  };
}

export async function getFullUserState(
  pool: DatabasePool,
  userId: string,
  nowIso = new Date().toISOString()
): Promise<{
  photos: PhotoRecord[];
  settings: UserSettings;
  schedule: ScheduleOutput;
  conflicts: SyncConflict[];
}> {
  return await pool.withTransaction(async (tx) => {
    const { photos, settings, schedule } = await normalizeAndReconcileUserQueue(
      tx,
      userId,
      nowIso
    );
    const conflicts = await getUserConflicts(tx, userId);
    return { photos, settings, schedule, conflicts };
  });
}

export {
  applyPostponement,
  calculateSchedule,
  formatInstantToLocalDate,
  resolveDeletePhoto,
  resolveMarkPublished,
  resolveQueueReorder,
  resolveUpdateDescription,
  resolveUpdateSettings,
  type PostponementDuration,
};
