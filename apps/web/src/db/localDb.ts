import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type {
  PhotoRecord,
  SupportedImageMimeType,
  SyncConflict,
  SyncOperationRecord,
  UserSettings,
} from '@publish-calendar/shared';

export interface StoredPhotoBlob {
  photoId: string;
  bytes: Uint8Array;
  mimeType: SupportedImageMimeType;
  fileName: string;
  sizeBytes: number;
  cachedAt: string;
}

export interface StoredSyncOperation extends SyncOperationRecord {
  seq: number;
}

export interface StoredAuthSession {
  token: string;
  userId: string;
  expiresAt: string;
  vapidPublicKey: string;
}

interface PublishCalendarDBSchema extends DBSchema {
  photos: {
    key: string;
    value: PhotoRecord;
    indexes: {
      'by-status': string;
      'by-upload-state': string;
    };
  };
  photo_blobs: {
    key: string;
    value: StoredPhotoBlob;
  };
  sync_queue: {
    key: string;
    value: StoredSyncOperation;
    indexes: {
      'by-seq': number;
    };
  };
  meta: {
    key: string;
    value: {
      key: string;
      data: unknown;
    };
  };
}

const DB_NAME = 'publish-calendar-pwa-db';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<PublishCalendarDBSchema>> | null = null;

export function getLocalDb(): Promise<IDBPDatabase<PublishCalendarDBSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<PublishCalendarDBSchema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('photos')) {
          const photoStore = db.createObjectStore('photos', { keyPath: 'id' });
          photoStore.createIndex('by-status', 'status');
          photoStore.createIndex('by-upload-state', 'uploadState');
        }
        if (!db.objectStoreNames.contains('photo_blobs')) {
          db.createObjectStore('photo_blobs', { keyPath: 'photoId' });
        }
        if (!db.objectStoreNames.contains('sync_queue')) {
          const syncStore = db.createObjectStore('sync_queue', {
            keyPath: 'idempotencyKey',
          });
          syncStore.createIndex('by-seq', 'seq');
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      },
    });
  }
  return dbPromise;
}

export async function resetLocalDbForTests(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise;
    db.close();
    dbPromise = null;
  }
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error('Failed to delete DB'));
    req.onblocked = () => resolve();
  });
}

export async function getAllLocalPhotos(): Promise<PhotoRecord[]> {
  const db = await getLocalDb();
  return await db.getAll('photos');
}

export async function getLocalPhotoById(
  photoId: string
): Promise<PhotoRecord | undefined> {
  const db = await getLocalDb();
  return await db.get('photos', photoId);
}

export async function putLocalPhoto(photo: PhotoRecord): Promise<void> {
  const db = await getLocalDb();
  await db.put('photos', photo);
}

export async function putLocalPhotosBatch(
  photos: readonly PhotoRecord[]
): Promise<void> {
  const db = await getLocalDb();
  const tx = db.transaction('photos', 'readwrite');
  for (const photo of photos) {
    await tx.store.put(photo);
  }
  await tx.done;
}

export async function putLocalPhotoBlob(blob: StoredPhotoBlob): Promise<void> {
  const db = await getLocalDb();
  await db.put('photo_blobs', blob);
}

export async function getLocalPhotoBlob(
  photoId: string
): Promise<StoredPhotoBlob | undefined> {
  const db = await getLocalDb();
  return await db.get('photo_blobs', photoId);
}

export async function getAllLocalPhotoBlobs(): Promise<StoredPhotoBlob[]> {
  const db = await getLocalDb();
  return await db.getAll('photo_blobs');
}

export async function enqueueSyncOperation(
  op: SyncOperationRecord
): Promise<StoredSyncOperation> {
  const db = await getLocalDb();
  const tx = db.transaction(['sync_queue', 'meta'], 'readwrite');
  const seqMeta = await tx.objectStore('meta').get('syncSeq');
  const nextSeq =
    typeof seqMeta?.data === 'number' ? seqMeta.data + 1 : 1;
  await tx.objectStore('meta').put({ key: 'syncSeq', data: nextSeq });

  const stored: StoredSyncOperation = {
    ...op,
    seq: nextSeq,
  };
  await tx.objectStore('sync_queue').put(stored);
  await tx.done;
  return stored;
}

export async function getPendingSyncOperations(): Promise<
  StoredSyncOperation[]
> {
  const db = await getLocalDb();
  const all = await db.getAllFromIndex('sync_queue', 'by-seq');
  return all.filter((op) => op.status !== 'completed');
}

export async function removeCompletedSyncOperation(
  idempotencyKey: string
): Promise<void> {
  const db = await getLocalDb();
  await db.delete('sync_queue', idempotencyKey);
}

export async function updateSyncOperationStatus(
  idempotencyKey: string,
  updates: Partial<Pick<StoredSyncOperation, 'status' | 'retryCount' | 'lastError'>>
): Promise<void> {
  const db = await getLocalDb();
  const existing = await db.get('sync_queue', idempotencyKey);
  if (!existing) {
    return;
  }
  await db.put('sync_queue', {
    ...existing,
    ...updates,
  });
}

export async function getLocalSettings(defaults: {
  userId: string;
  timeZone: string;
  reminderTime: string;
}): Promise<UserSettings> {
  const db = await getLocalDb();
  const row = await db.get('meta', 'userSettings');
  if (row?.data) {
    return row.data as UserSettings;
  }
  const initial: UserSettings = {
    userId: defaults.userId,
    timeZone: defaults.timeZone,
    reminderTime: defaults.reminderTime,
    postponedUntilDate: null,
    activePostponedRemindAt: null,
    activePostponedPhotoId: null,
    queueRevision: 1,
    updatedAt: new Date().toISOString(),
  };
  await db.put('meta', { key: 'userSettings', data: initial });
  return initial;
}

export async function saveLocalSettings(settings: UserSettings): Promise<void> {
  const db = await getLocalDb();
  await db.put('meta', { key: 'userSettings', data: settings });
}

export async function getLocalAuthSession(): Promise<StoredAuthSession | null> {
  const db = await getLocalDb();
  const row = await db.get('meta', 'authSession');
  return (row?.data as StoredAuthSession | undefined) ?? null;
}

export async function saveLocalAuthSession(
  session: StoredAuthSession | null
): Promise<void> {
  const db = await getLocalDb();
  await db.put('meta', { key: 'authSession', data: session });
}

export async function getLocalConflicts(): Promise<SyncConflict[]> {
  const db = await getLocalDb();
  const row = await db.get('meta', 'conflicts');
  return (row?.data as SyncConflict[] | undefined) ?? [];
}

export async function saveLocalConflicts(
  conflicts: SyncConflict[]
): Promise<void> {
  const db = await getLocalDb();
  await db.put('meta', { key: 'conflicts', data: conflicts });
}

export async function getSyncMetadata(): Promise<{
  lastSyncedAt: string | null;
  lastSyncError: string | null;
}> {
  const db = await getLocalDb();
  const lastSyncedRow = await db.get('meta', 'lastSyncedAt');
  const lastErrRow = await db.get('meta', 'lastSyncError');
  return {
    lastSyncedAt: (lastSyncedRow?.data as string | null | undefined) ?? null,
    lastSyncError: (lastErrRow?.data as string | null | undefined) ?? null,
  };
}

export async function saveSyncMetadata(params: {
  lastSyncedAt?: string | null;
  lastSyncError?: string | null;
}): Promise<void> {
  const db = await getLocalDb();
  const tx = db.transaction('meta', 'readwrite');
  if (params.lastSyncedAt !== undefined) {
    await tx.store.put({ key: 'lastSyncedAt', data: params.lastSyncedAt });
  }
  if (params.lastSyncError !== undefined) {
    await tx.store.put({ key: 'lastSyncError', data: params.lastSyncError });
  }
  await tx.done;
}

export interface LocalStorageSummary {
  totalCachedBlobsCount: number;
  totalCachedBytes: number;
  safelyRemovableBlobsCount: number;
  safelyRemovableBytes: number;
  unsyncedBlobsCount: number;
  unsyncedBytes: number;
  browserQuotaBytes: number | null;
  browserUsageBytes: number | null;
  persistentStorageGranted: boolean | null;
}

export async function inspectLocalStorageUsage(): Promise<LocalStorageSummary> {
  const [photos, blobs, pendingOps] = await Promise.all([
    getAllLocalPhotos(),
    getAllLocalPhotoBlobs(),
    getPendingSyncOperations(),
  ]);

  const photoMap = new Map<string, PhotoRecord>();
  for (const p of photos) {
    photoMap.set(p.id, p);
  }

  const photosWithPendingOps = new Set<string>();
  for (const op of pendingOps) {
    if (op.type === 'CREATE_PHOTO') {
      const payload = op.payload as { photo: PhotoRecord };
      photosWithPendingOps.add(payload.photo.id);
    } else if ('photoId' in op.payload && typeof op.payload.photoId === 'string') {
      photosWithPendingOps.add(op.payload.photoId);
    }
  }

  let totalCachedBytes = 0;
  let safelyRemovableBlobsCount = 0;
  let safelyRemovableBytes = 0;
  let unsyncedBlobsCount = 0;
  let unsyncedBytes = 0;

  for (const blob of blobs) {
    totalCachedBytes += blob.sizeBytes;
    const photo = photoMap.get(blob.photoId);
    const isConfirmedRemote =
      photo !== undefined &&
      photo.uploadState === 'uploaded' &&
      photo.s3Key !== null &&
      !photosWithPendingOps.has(blob.photoId);

    if (isConfirmedRemote) {
      safelyRemovableBlobsCount++;
      safelyRemovableBytes += blob.sizeBytes;
    } else {
      unsyncedBlobsCount++;
      unsyncedBytes += blob.sizeBytes;
    }
  }

  let browserQuotaBytes: number | null = null;
  let browserUsageBytes: number | null = null;
  let persistentStorageGranted: boolean | null = null;

  if (typeof navigator !== 'undefined' && 'storage' in navigator) {
    if (typeof navigator.storage.estimate === 'function') {
      try {
        const est = await navigator.storage.estimate();
        browserQuotaBytes = est.quota ?? null;
        browserUsageBytes = est.usage ?? null;
      } catch {
        // ignore estimate errors
      }
    }
    if (typeof navigator.storage.persisted === 'function') {
      try {
        persistentStorageGranted = await navigator.storage.persisted();
      } catch {
        // ignore
      }
    }
  }

  return {
    totalCachedBlobsCount: blobs.length,
    totalCachedBytes,
    safelyRemovableBlobsCount,
    safelyRemovableBytes,
    unsyncedBlobsCount,
    unsyncedBytes,
    browserQuotaBytes,
    browserUsageBytes,
    persistentStorageGranted,
  };
}

/**
 * Safely removes local cached binary blobs ONLY for photographs whose remote S3 persistence
 * (`uploadState === 'uploaded'` and `s3Key !== null`) is confirmed and that have no pending
 * synchronization operations. Never deletes the only copy of an unuploaded photograph.
 */
export async function cleanupConfirmedRemotePhotoCache(): Promise<{
  removedCount: number;
  freedBytes: number;
  protectedCount: number;
}> {
  const db = await getLocalDb();
  const [photos, blobs, pendingOps] = await Promise.all([
    getAllLocalPhotos(),
    getAllLocalPhotoBlobs(),
    getPendingSyncOperations(),
  ]);

  const photoMap = new Map<string, PhotoRecord>();
  for (const p of photos) {
    photoMap.set(p.id, p);
  }

  const photosWithPendingOps = new Set<string>();
  for (const op of pendingOps) {
    if (op.type === 'CREATE_PHOTO') {
      const payload = op.payload as { photo: PhotoRecord };
      photosWithPendingOps.add(payload.photo.id);
    } else if ('photoId' in op.payload && typeof op.payload.photoId === 'string') {
      photosWithPendingOps.add(op.payload.photoId);
    }
  }

  let removedCount = 0;
  let freedBytes = 0;
  let protectedCount = 0;

  const tx = db.transaction('photo_blobs', 'readwrite');
  for (const blob of blobs) {
    const photo = photoMap.get(blob.photoId);
    const isConfirmedRemote =
      photo !== undefined &&
      photo.uploadState === 'uploaded' &&
      photo.s3Key !== null &&
      !photosWithPendingOps.has(blob.photoId);

    if (isConfirmedRemote) {
      await tx.store.delete(blob.photoId);
      removedCount++;
      freedBytes += blob.sizeBytes;
    } else {
      protectedCount++;
    }
  }
  await tx.done;

  return {
    removedCount,
    freedBytes,
    protectedCount,
  };
}
