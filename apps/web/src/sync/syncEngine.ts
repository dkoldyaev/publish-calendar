import {
  applyPostponement,
  calculateSchedule,
  normalizeQueuePositions,
  sortPendingQueue,
  validateUploadBatch,
  type PhotoRecord,
  type PostponementDuration,
  type RawUploadCandidate,
  type ScheduleOutput,
  type SyncConflict,
  type UserSettings,
  type ValidationIssue,
} from '@publish-calendar/shared';
import type { WebConfig } from '../config/env.js';
import {
  enqueueSyncOperation,
  getAllLocalPhotos,
  getLocalAuthSession,
  getLocalConflicts,
  getLocalPhotoBlob,
  getLocalPhotoById,
  getLocalSettings,
  getPendingSyncOperations,
  getSyncMetadata,
  putLocalPhoto,
  putLocalPhotoBlob,
  putLocalPhotosBatch,
  removeCompletedSyncOperation,
  saveLocalAuthSession,
  saveLocalConflicts,
  saveLocalSettings,
  saveSyncMetadata,
  updateSyncOperationStatus,
  type StoredSyncOperation,
} from '../db/localDb.js';

const DEFAULT_USER_ID = '00000000-0000-4000-8000-000000000001';

export interface UploadProgressState {
  phase: 'idle' | 'validating' | 'saving_local' | 'syncing_remote' | 'completed';
  totalFiles: number;
  processedFiles: number;
  importedPhotos: PhotoRecord[];
  issues: ValidationIssue[];
}

export interface FullClientState {
  photos: PhotoRecord[];
  settings: UserSettings;
  schedule: ScheduleOutput;
  pendingOperations: StoredSyncOperation[];
  pendingUploadsCount: number;
  conflicts: SyncConflict[];
  lastSyncedAt: string | null;
  lastSyncError: string | null;
}

export async function computeBytesChecksumHex(
  bytes: Uint8Array
): Promise<string> {
  if (typeof crypto !== 'undefined' && 'subtle' in crypto) {
    try {
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      const digest = await crypto.subtle.digest('SHA-256', copy.buffer);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    } catch {
      // Fallback deterministic hash below
    }
  }
  let h1 = 0xdeadbeef ^ bytes.byteLength;
  let h2 = 0x41c6ce57 ^ bytes.byteLength;
  for (let i = 0; i < bytes.byteLength; i++) {
    const ch = bytes[i] ?? 0;
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (
    (h1 >>> 0).toString(16).padStart(8, '0') +
    (h2 >>> 0).toString(16).padStart(8, '0')
  );
}

export function generateUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export async function loadFullClientState(
  config: WebConfig,
  nowIso = new Date().toISOString()
): Promise<FullClientState> {
  const [rawPhotos, settings, pendingOperations, conflicts, syncMeta] =
    await Promise.all([
      getAllLocalPhotos(),
      getLocalSettings({
        userId: DEFAULT_USER_ID,
        timeZone: config.defaultTimezone,
        reminderTime: config.defaultReminderTime,
      }),
      getPendingSyncOperations(),
      getLocalConflicts(),
      getSyncMetadata(),
    ]);

  const photos = normalizeQueuePositions(rawPhotos).sort((a, b) => {
    const statusOrderA = a.status === 'pending' ? 0 : 1;
    const statusOrderB = b.status === 'pending' ? 0 : 1;
    if (statusOrderA !== statusOrderB) {
      return statusOrderA - statusOrderB;
    }
    const posA = a.queuePosition ?? Number.MAX_SAFE_INTEGER;
    const posB = b.queuePosition ?? Number.MAX_SAFE_INTEGER;
    if (posA !== posB) {
      return posA - posB;
    }
    const createdCmp = a.createdAt.localeCompare(b.createdAt);
    return createdCmp !== 0 ? createdCmp : a.id.localeCompare(b.id);
  });
  const schedule = calculateSchedule({
    photos,
    settings,
    currentInstant: nowIso,
  });

  const pendingUploadsCount = photos.filter(
    (p) => p.status !== 'deleted' && p.uploadState !== 'uploaded'
  ).length;

  return {
    photos,
    settings,
    schedule,
    pendingOperations,
    pendingUploadsCount,
    conflicts,
    lastSyncedAt: syncMeta.lastSyncedAt,
    lastSyncError: syncMeta.lastSyncError,
  };
}

export async function importBatchLocally(params: {
  candidates: readonly RawUploadCandidate[];
  description: string;
  config: WebConfig;
  nowIso?: string;
  onProgress?: (progress: UploadProgressState) => void;
}): Promise<{
  importedPhotos: PhotoRecord[];
  issues: ValidationIssue[];
}> {
  const { candidates, description, config, onProgress } = params;
  const nowIso = params.nowIso ?? new Date().toISOString();

  onProgress?.({
    phase: 'validating',
    totalFiles: candidates.length,
    processedFiles: 0,
    importedPhotos: [],
    issues: [],
  });

  const validation = validateUploadBatch(
    candidates,
    config.uploadLimits,
    generateUuid
  );

  const existingPhotos = await getAllLocalPhotos();
  const pendingQueue = sortPendingQueue(existingPhotos);
  let nextQueuePos = pendingQueue.length;

  const settings = await getLocalSettings({
    userId: DEFAULT_USER_ID,
    timeZone: config.defaultTimezone,
    reminderTime: config.defaultReminderTime,
  });

  const importedPhotos: PhotoRecord[] = [];
  const totalValid = validation.validItems.length;

  for (let i = 0; i < totalValid; i++) {
    const item = validation.validItems[i];
    if (!item) {
      continue;
    }
    const checksumSha256 = await computeBytesChecksumHex(item.bytes);

    try {
      await putLocalPhotoBlob({
        photoId: item.id,
        bytes: item.bytes,
        mimeType: item.mimeType,
        fileName: item.fileName,
        sizeBytes: item.sizeBytes,
        cachedAt: nowIso,
      });
    } catch (err: unknown) {
      const isQuota =
        err instanceof Error &&
        (err.name === 'QuotaExceededError' ||
          err.message.toLowerCase().includes('quota'));
      throw new Error(
        isQuota
          ? 'Недостаточно места в локальном хранилище браузера (QuotaExceededError). Очистите кэш синхронизированных фото в Настройках.'
          : `Ошибка сохранения фотографии "${item.fileName}" в IndexedDB.`
      );
    }

    const photoRecord: PhotoRecord = {
      id: item.id,
      userId: settings.userId,
      fileName: item.fileName,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes,
      description,
      status: 'pending',
      queuePosition: nextQueuePos++,
      uploadState: 'upload_pending',
      s3Key: null,
      checksumSha256,
      createdAt: nowIso,
      updatedAt: nowIso,
      publishedAt: null,
      scheduledDateAtPublication: null,
      deletedAt: null,
      revision: 1,
    };

    // Persist operation before treating local import of this photo as complete
    await enqueueSyncOperation({
      idempotencyKey: generateUuid(),
      type: 'CREATE_PHOTO',
      payload: { photo: photoRecord },
      createdAt: nowIso,
      retryCount: 0,
      lastError: null,
      status: 'pending',
    });

    await putLocalPhoto(photoRecord);
    importedPhotos.push(photoRecord);

    onProgress?.({
      phase: 'saving_local',
      totalFiles: totalValid,
      processedFiles: i + 1,
      importedPhotos: [...importedPhotos],
      issues: validation.issues,
    });
  }

  onProgress?.({
    phase: 'completed',
    totalFiles: totalValid,
    processedFiles: totalValid,
    importedPhotos,
    issues: validation.issues,
  });

  return {
    importedPhotos,
    issues: validation.issues,
  };
}

export async function markPhotoPublishedLocally(params: {
  photoId: string;
  config: WebConfig;
  nowIso?: string;
}): Promise<FullClientState> {
  const nowIso = params.nowIso ?? new Date().toISOString();
  const photo = await getLocalPhotoById(params.photoId);
  if (!photo) {
    throw new Error('Фотография не найдена.');
  }

  // Prevent duplicate confirmation from producing inconsistent state
  if (photo.status === 'published') {
    return await loadFullClientState(params.config, nowIso);
  }

  const preState = await loadFullClientState(params.config, nowIso);
  const scheduledDate =
    preState.schedule.projectedByPhotoId[photo.id] ??
    preState.schedule.todayLocalDate;

  await enqueueSyncOperation({
    idempotencyKey: generateUuid(),
    type: 'MARK_PUBLISHED',
    payload: {
      photoId: photo.id,
      publishedAt: nowIso,
      scheduledDateAtPublication: scheduledDate,
      baseRevision: photo.revision,
    },
    createdAt: nowIso,
    retryCount: 0,
    lastError: null,
    status: 'pending',
  });

  const updatedPhoto: PhotoRecord = {
    ...photo,
    status: 'published',
    queuePosition: null,
    publishedAt: nowIso,
    scheduledDateAtPublication: scheduledDate,
    updatedAt: nowIso,
    revision: photo.revision + 1,
  };

  const allPhotos = await getAllLocalPhotos();
  const normalized = normalizeQueuePositions(
    allPhotos.map((p) => (p.id === photo.id ? updatedPhoto : p))
  );
  await putLocalPhotosBatch(normalized);

  // Clear short postponement if it belonged to this photo
  if (preState.settings.activePostponedPhotoId === photo.id) {
    await saveLocalSettings({
      ...preState.settings,
      activePostponedPhotoId: null,
      activePostponedRemindAt: null,
      updatedAt: nowIso,
    });
  }

  return await loadFullClientState(params.config, nowIso);
}

export async function deletePhotoLocally(params: {
  photoId: string;
  config: WebConfig;
  nowIso?: string;
}): Promise<FullClientState> {
  const nowIso = params.nowIso ?? new Date().toISOString();
  const photo = await getLocalPhotoById(params.photoId);
  if (!photo || photo.status === 'deleted') {
    return await loadFullClientState(params.config, nowIso);
  }

  await enqueueSyncOperation({
    idempotencyKey: generateUuid(),
    type: 'DELETE_PHOTO',
    payload: {
      photoId: photo.id,
      deletedAt: nowIso,
      baseRevision: photo.revision,
    },
    createdAt: nowIso,
    retryCount: 0,
    lastError: null,
    status: 'pending',
  });

  const updatedPhoto: PhotoRecord = {
    ...photo,
    status: 'deleted',
    queuePosition: null,
    deletedAt: nowIso,
    updatedAt: nowIso,
    revision: photo.revision + 1,
  };

  const allPhotos = await getAllLocalPhotos();
  const normalized = normalizeQueuePositions(
    allPhotos.map((p) => (p.id === photo.id ? updatedPhoto : p))
  );
  await putLocalPhotosBatch(normalized);

  return await loadFullClientState(params.config, nowIso);
}

export async function updatePhotoDescriptionLocally(params: {
  photoId: string;
  description: string;
  config: WebConfig;
  nowIso?: string;
}): Promise<FullClientState> {
  const nowIso = params.nowIso ?? new Date().toISOString();
  const photo = await getLocalPhotoById(params.photoId);
  if (!photo) {
    throw new Error('Фотография не найдена.');
  }

  await enqueueSyncOperation({
    idempotencyKey: generateUuid(),
    type: 'UPDATE_DESCRIPTION',
    payload: {
      photoId: photo.id,
      description: params.description,
      baseRevision: photo.revision,
      updatedAt: nowIso,
    },
    createdAt: nowIso,
    retryCount: 0,
    lastError: null,
    status: 'pending',
  });

  await putLocalPhoto({
    ...photo,
    description: params.description,
    updatedAt: nowIso,
  });

  return await loadFullClientState(params.config, nowIso);
}

export async function reorderQueueLocally(params: {
  orderedPhotoIds: string[];
  config: WebConfig;
  nowIso?: string;
}): Promise<FullClientState> {
  const nowIso = params.nowIso ?? new Date().toISOString();
  const preState = await loadFullClientState(params.config, nowIso);

  await enqueueSyncOperation({
    idempotencyKey: generateUuid(),
    type: 'REORDER_QUEUE',
    payload: {
      orderedPhotoIds: params.orderedPhotoIds,
      baseQueueRevision: preState.settings.queueRevision,
      updatedAt: nowIso,
    },
    createdAt: nowIso,
    retryCount: 0,
    lastError: null,
    status: 'pending',
  });

  const posMap = new Map<string, number>();
  params.orderedPhotoIds.forEach((id, idx) => posMap.set(id, idx));

  const updatedPhotos = preState.photos.map((photo) => {
    if (photo.status !== 'pending') {
      return photo;
    }
    const nextPos = posMap.get(photo.id) ?? photo.queuePosition ?? 0;
    return {
      ...photo,
      queuePosition: nextPos,
      updatedAt: nowIso,
    };
  });

  await putLocalPhotosBatch(normalizeQueuePositions(updatedPhotos));
  return await loadFullClientState(params.config, nowIso);
}

export async function postponeReminderLocally(params: {
  photoId: string;
  duration: PostponementDuration;
  config: WebConfig;
  nowIso?: string;
}): Promise<FullClientState> {
  const nowIso = params.nowIso ?? new Date().toISOString();
  const preState = await loadFullClientState(params.config, nowIso);

  await enqueueSyncOperation({
    idempotencyKey: generateUuid(),
    type: 'POSTPONE_REMINDER',
    payload: {
      photoId: params.photoId,
      duration: params.duration,
      requestedAt: nowIso,
      baseQueueRevision: preState.settings.queueRevision,
    },
    createdAt: nowIso,
    retryCount: 0,
    lastError: null,
    status: 'pending',
  });

  const postponed = applyPostponement({
    settings: preState.settings,
    photos: preState.photos,
    duration: params.duration,
    currentInstant: nowIso,
  });

  await saveLocalSettings(postponed.updatedSettings);
  return await loadFullClientState(params.config, nowIso);
}

export async function updateSettingsLocally(params: {
  reminderTime: string;
  timeZone: string;
  config: WebConfig;
  nowIso?: string;
}): Promise<FullClientState> {
  const nowIso = params.nowIso ?? new Date().toISOString();
  const preState = await loadFullClientState(params.config, nowIso);

  await enqueueSyncOperation({
    idempotencyKey: generateUuid(),
    type: 'UPDATE_SETTINGS',
    payload: {
      reminderTime: params.reminderTime,
      timeZone: params.timeZone,
      baseQueueRevision: preState.settings.queueRevision,
      updatedAt: nowIso,
    },
    createdAt: nowIso,
    retryCount: 0,
    lastError: null,
    status: 'pending',
  });

  await saveLocalSettings({
    ...preState.settings,
    reminderTime: params.reminderTime,
    timeZone: params.timeZone,
    updatedAt: nowIso,
  });

  return await loadFullClientState(params.config, nowIso);
}

export async function ensureAuthenticatedToken(
  config: WebConfig,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const cached = await getLocalAuthSession();
  if (cached && new Date(cached.expiresAt).getTime() > Date.now() + 60_000) {
    return cached.token;
  }

  const res = await fetchImpl(`${config.apiOrigin}/api/v1/auth/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessCode: config.defaultAccessCode }),
  });

  if (!res.ok) {
    throw new Error(`Ошибка авторизации на сервере (HTTP ${res.status})`);
  }

  const data = (await res.json()) as {
    token: string;
    userId: string;
    expiresAt: string;
    vapidPublicKey: string;
  };
  await saveLocalAuthSession(data);
  return data.token;
}

/**
 * Synchronizes all pending local operations and unuploaded photograph binaries with the backend.
 * Safe to invoke repeatedly; uses idempotency keys and confirms remote persistence before
 * marking operations completed.
 */
export async function synchronizeWithServer(params: {
  config: WebConfig;
  fetchImpl?: typeof fetch;
  forceOnline?: boolean;
}): Promise<FullClientState> {
  const { config, fetchImpl = fetch, forceOnline = false } = params;

  if (
    !forceOnline &&
    typeof navigator !== 'undefined' &&
    !navigator.onLine
  ) {
    return await loadFullClientState(config);
  }

  try {
    const token = await ensureAuthenticatedToken(config, fetchImpl);
    const pendingOps = await getPendingSyncOperations();

    // 1. Push structured operations in order
    if (pendingOps.length > 0) {
      for (const op of pendingOps) {
        await updateSyncOperationStatus(op.idempotencyKey, {
          status: 'syncing',
        });
      }

      const syncRes = await fetchImpl(`${config.apiOrigin}/api/v1/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          operations: pendingOps.map((op) => ({
            idempotencyKey: op.idempotencyKey,
            type: op.type,
            payload: op.payload,
          })),
        }),
      });

      if (!syncRes.ok) {
        const errText = await syncRes.text();
        for (const op of pendingOps) {
          await updateSyncOperationStatus(op.idempotencyKey, {
            status: 'failed',
            retryCount: op.retryCount + 1,
            lastError: `HTTP ${syncRes.status}: ${errText}`,
          });
        }
        throw new Error(`Ошибка синхронизации операций (HTTP ${syncRes.status})`);
      }

      const syncData = (await syncRes.json()) as {
        outcomes: Array<{ idempotencyKey: string }>;
        photos: PhotoRecord[];
        settings: UserSettings;
        conflicts: SyncConflict[];
        serverTimestamp: string;
      };

      // Confirm remote persistence before deleting from sync_queue
      for (const outcome of syncData.outcomes) {
        await removeCompletedSyncOperation(outcome.idempotencyKey);
      }

      await putLocalPhotosBatch(syncData.photos);
      await saveLocalSettings(syncData.settings);
      await saveLocalConflicts(syncData.conflicts);
    }

    // 2. Upload any pending photograph binaries to S3 via authenticated endpoint
    const currentPhotos = await getAllLocalPhotos();
    const photosNeedingBinaryUpload = currentPhotos.filter(
      (p) => p.status !== 'deleted' && p.uploadState !== 'uploaded'
    );

    for (const photo of photosNeedingBinaryUpload) {
      const localBlob = await getLocalPhotoBlob(photo.id);
      if (!localBlob) {
        continue;
      }

      await putLocalPhoto({
        ...photo,
        uploadState: 'uploading',
      });

      const bodyCopy = new Uint8Array(localBlob.bytes.byteLength);
      bodyCopy.set(localBlob.bytes);

      const uploadRes = await fetchImpl(
        `${config.apiOrigin}/api/v1/photos/${photo.id}/binary`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': localBlob.mimeType,
          },
          body: bodyCopy,
        }
      );

      if (!uploadRes.ok) {
        await putLocalPhoto({
          ...photo,
          uploadState: 'upload_failed',
        });
        throw new Error(
          `Не удалось загрузить файл "${photo.fileName}" в хранилище S3 (HTTP ${uploadRes.status})`
        );
      }

      const uploadData = (await uploadRes.json()) as {
        photo?: PhotoRecord;
      };
      if (uploadData.photo) {
        await putLocalPhoto(uploadData.photo);
      }
    }

    // 3. Pull authoritative state from server if no pending ops remain
    const remainingOps = await getPendingSyncOperations();
    if (remainingOps.length === 0) {
      const stateRes = await fetchImpl(`${config.apiOrigin}/api/v1/state`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      if (stateRes.ok) {
        const remoteState = (await stateRes.json()) as {
          photos: PhotoRecord[];
          settings: UserSettings;
          conflicts: SyncConflict[];
          serverTimestamp: string;
        };
        await putLocalPhotosBatch(remoteState.photos);
        await saveLocalSettings(remoteState.settings);
        await saveLocalConflicts(remoteState.conflicts);
        await saveSyncMetadata({
          lastSyncedAt: remoteState.serverTimestamp,
          lastSyncError: null,
        });
      }
    }

    return await loadFullClientState(config);
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : 'Ошибка сетевой синхронизации';
    await saveSyncMetadata({
      lastSyncError: message,
    });
    return await loadFullClientState(config);
  }
}

export async function resolveConflictWithServer(params: {
  conflictId: string;
  choice: 'KEEP_SERVER' | 'APPLY_CLIENT';
  config: WebConfig;
  fetchImpl?: typeof fetch;
}): Promise<FullClientState> {
  const { conflictId, choice, config, fetchImpl = fetch } = params;
  const token = await ensureAuthenticatedToken(config, fetchImpl);

  const res = await fetchImpl(
    `${config.apiOrigin}/api/v1/conflicts/${conflictId}/resolve`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ choice }),
    }
  );

  if (!res.ok) {
    throw new Error(`Не удалось разрешить конфликт (HTTP ${res.status})`);
  }

  const data = (await res.json()) as {
    photos: PhotoRecord[];
    settings: UserSettings;
    conflicts: SyncConflict[];
  };

  await putLocalPhotosBatch(data.photos);
  await saveLocalSettings(data.settings);
  await saveLocalConflicts(data.conflicts);

  return await loadFullClientState(config);
}
