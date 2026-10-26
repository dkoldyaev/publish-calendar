// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { zipSync } from 'fflate';
import { ConfigurationError } from '@publish-calendar/shared';
import { loadWebConfig, type WebConfig } from './config/env.js';
import {
  cleanupConfirmedRemotePhotoCache,
  getAllLocalPhotoBlobs,
  getPendingSyncOperations,
  putLocalPhoto,
  resetLocalDbForTests,
} from './db/localDb.js';
import {
  deletePhotoLocally,
  importBatchLocally,
  loadFullClientState,
  markPhotoPublishedLocally,
  postponeReminderLocally,
  reorderQueueLocally,
  synchronizeWithServer,
} from './sync/syncEngine.js';
import { App } from './App.js';

function createValidWebEnv(
  overrides: Record<string, string | undefined> = {}
): Record<string, string | undefined> {
  return {
    VITE_API_ORIGIN: 'http://localhost:4010',
    VITE_PUBLIC_ORIGIN: 'http://localhost:8080',
    VITE_VAPID_PUBLIC_KEY:
      'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U',
    VITE_DEFAULT_ACCESS_CODE: 'super-secret-code-123',
    VITE_DEFAULT_TIMEZONE: 'Europe/Moscow',
    VITE_DEFAULT_REMINDER_TIME: '09:00',
    VITE_MAX_UPLOAD_FILE_BYTES: '10485760',
    VITE_MAX_BATCH_FILES: '50',
    VITE_MAX_BATCH_TOTAL_BYTES: '52428800',
    VITE_MAX_ZIP_EXPANSION_RATIO: '25',
    VITE_MAX_ZIP_EXTRACTED_BYTES: '31457280',
    VITE_MAX_ZIP_ENTRIES: '100',
    VITE_SYNC_INTERVAL_MS: '60000',
    VITE_SYNC_MAX_RETRIES: '5',
    VITE_SYNC_RETRY_BASE_MS: '1000',
    ...overrides,
  };
}

function makeJpegBytes(seed = 1): Uint8Array {
  const bytes = new Uint8Array(48);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  bytes[3] = 0xe0;
  bytes[4] = seed & 0xff;
  bytes[46] = 0xff;
  bytes[47] = 0xd9;
  return bytes;
}

describe('Frontend PWA, Offline Engine, and Acceptance Scenarios', () => {
  let config: WebConfig;

  beforeEach(async () => {
    await resetLocalDbForTests();
    config = loadWebConfig(createValidWebEnv());
    if (typeof URL.createObjectURL !== 'function') {
      URL.createObjectURL = () => 'blob:mock-preview-url';
    }
    if (typeof URL.revokeObjectURL !== 'function') {
      URL.revokeObjectURL = () => undefined;
    }
  });

  afterEach(() => {
    cleanup();
  });

  it('Scenario 10 (Frontend): Validates all VITE_* configuration variables strictly without fallbacks', () => {
    expect(() =>
      loadWebConfig(createValidWebEnv({ VITE_API_ORIGIN: undefined }))
    ).toThrow(ConfigurationError);
    expect(() =>
      loadWebConfig(createValidWebEnv({ VITE_VAPID_PUBLIC_KEY: '' }))
    ).toThrow('ConfigurationError: VITE_VAPID_PUBLIC_KEY is required.');
    expect(() =>
      loadWebConfig(createValidWebEnv({ VITE_DEFAULT_TIMEZONE: 'Invalid/TZ' }))
    ).toThrow(/ConfigurationError: VITE_DEFAULT_TIMEZONE/);
  });

  it('Scenario 1, 2, 5, 6, 7, 8, 9, 13: Offline import, restart persistence, reorder, delete, postpone, publish, and safe cache cleanup', async () => {
    const nowIso = '2026-03-02T07:00:00.000Z';
    const zipBytes = zipSync({
      'z1.jpg': makeJpegBytes(11),
      'z2.jpg': makeJpegBytes(12),
      'z3.jpg': makeJpegBytes(13),
      'z4.jpg': makeJpegBytes(14),
      'z5.jpg': makeJpegBytes(15),
    });

    // Scenario 1 & 7: Offline import of 5 photos + 1 ZIP containing 5 valid photos
    const importRes = await importBatchLocally({
      candidates: [
        { fileName: 'p1.jpg', bytes: makeJpegBytes(1) },
        { fileName: 'p2.jpg', bytes: makeJpegBytes(2) },
        { fileName: 'p3.jpg', bytes: makeJpegBytes(3) },
        { fileName: 'pack.zip', bytes: zipBytes },
        { fileName: 'p4.jpg', bytes: makeJpegBytes(4) },
        { fileName: 'p5.jpg', bytes: makeJpegBytes(5) },
      ],
      description: 'Единое описание пакета',
      config,
      nowIso,
    });

    expect(importRes.issues).toEqual([]);
    expect(importRes.importedPhotos).toHaveLength(10);
    expect(
      importRes.importedPhotos.every(
        (p) => p.description === 'Единое описание пакета'
      )
    ).toBe(true);

    // Scenario 13: Simulate offline browser restart by reloading state directly from IndexedDB
    const reloadedState = await loadFullClientState(config, nowIso);
    expect(reloadedState.photos).toHaveLength(10);
    expect(reloadedState.pendingOperations).toHaveLength(10);

    // Safe cache cleanup protects all 10 unuploaded photos (0 removed, 10 protected)
    const cleanupBeforeSync = await cleanupConfirmedRemotePhotoCache();
    expect(cleanupBeforeSync.removedCount).toBe(0);
    expect(cleanupBeforeSync.protectedCount).toBe(10);

    // Scenario 2: Delete 2nd photo -> remaining 9 close gap on consecutive days
    const secondPhotoId = reloadedState.photos[1]?.id ?? '';
    const afterDelete = await deletePhotoLocally({
      photoId: secondPhotoId,
      config,
      nowIso,
    });
    const pendingAfterDelete = afterDelete.photos.filter(
      (p) => p.status === 'pending'
    );
    expect(pendingAfterDelete).toHaveLength(9);
    expect(pendingAfterDelete.map((p) => p.queuePosition)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8,
    ]);

    // Scenario 5: Reorder queue (move 3rd remaining photo to 1st position)
    const ids = pendingAfterDelete.map((p) => p.id);
    const thirdId = ids[2] ?? '';
    const reorderedIds = [thirdId, ids[0] ?? '', ids[1] ?? '', ...ids.slice(3)];
    const afterReorder = await reorderQueueLocally({
      orderedPhotoIds: reorderedIds,
      config,
      nowIso,
    });
    expect(afterReorder.schedule.nextPendingPhoto?.id).toBe(thirdId);

    // Scenario 8: Short postponement by 1h shifts reminder from 09:00 to 10:00 local without changing date
    const afterShortPostpone = await postponeReminderLocally({
      photoId: thirdId,
      duration: '1h',
      config,
      nowIso: '2026-03-02T06:00:00.000Z', // 09:00 Europe/Moscow (UTC+3)
    });
    expect(afterShortPostpone.schedule.nextReminderInstant).toBe(
      '2026-03-02T07:00:00.000Z' // 10:00 Europe/Moscow
    );
    expect(afterShortPostpone.schedule.effectiveNextPublicationDate).toBe(
      '2026-03-02'
    );

    // Scenario 6: Offline publication confirmation updates local state immediately and enqueues MARK_PUBLISHED
    const afterPublish = await markPhotoPublishedLocally({
      photoId: thirdId,
      config,
      nowIso: '2026-03-02T08:00:00.000Z',
    });
    const publishedRecord = afterPublish.photos.find((p) => p.id === thirdId);
    expect(publishedRecord?.status).toBe('published');
    expect(afterPublish.schedule.effectiveNextPublicationDate).toBe(
      '2026-03-03'
    );

    const pendingOps = await getPendingSyncOperations();
    expect(pendingOps.some((op) => op.type === 'MARK_PUBLISHED')).toBe(true);

    // Simulate remote sync completion for one photo and verify safe cache cleanup removes ONLY that photo's blob
    for (const op of pendingOps) {
      if (
        op.type === 'CREATE_PHOTO' &&
        (op.payload as { photo: { id: string } }).photo.id === thirdId
      ) {
        const { removeCompletedSyncOperation } = await import('./db/localDb.js');
        await removeCompletedSyncOperation(op.idempotencyKey);
      }
      if (
        'photoId' in op.payload &&
        op.payload.photoId === thirdId
      ) {
        const { removeCompletedSyncOperation } = await import('./db/localDb.js');
        await removeCompletedSyncOperation(op.idempotencyKey);
      }
    }
    if (publishedRecord) {
      await putLocalPhoto({
        ...publishedRecord,
        uploadState: 'uploaded',
        s3Key: `users/u1/photos/${thirdId}`,
      });
    }

    const cleanupAfterOneSynced = await cleanupConfirmedRemotePhotoCache();
    expect(cleanupAfterOneSynced.removedCount).toBe(1);
    expect(cleanupAfterOneSynced.protectedCount).toBe(9);
    const remainingBlobs = await getAllLocalPhotoBlobs();
    expect(remainingBlobs).toHaveLength(9);
  });

  it('Synchronizes offline operations and binary uploads with backend fetch handler idempotently', async () => {
    const nowIso = '2026-03-05T08:00:00.000Z';
    const imported = await importBatchLocally({
      candidates: [{ fileName: 'sync_me.jpg', bytes: makeJpegBytes(77) }],
      description: 'Тест синхронизации',
      config,
      nowIso,
    });
    const photo = imported.importedPhotos[0];
    if (!photo) {
      throw new Error('Expected imported photo');
    }

    let syncCalls = 0;
    let binaryPutCalls = 0;

    const mockFetch: typeof fetch = (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.endsWith('/api/v1/auth/session')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              token: 'mock-jwt-token',
              userId: photo.userId,
              expiresAt: '2099-01-01T00:00:00.000Z',
              vapidPublicKey: config.vapidPublicKey,
            }),
            { status: 200 }
          )
        );
      }
      if (url.endsWith('/api/v1/sync')) {
        syncCalls++;
        const body = JSON.parse(init?.body as string) as {
          operations: Array<{ idempotencyKey: string; type: string }>;
        };
        return Promise.resolve(
          new Response(
            JSON.stringify({
              outcomes: body.operations.map((op) => ({
                idempotencyKey: op.idempotencyKey,
                type: op.type,
                applied: true,
                deduplicated: false,
                conflict: null,
              })),
              photos: [
                {
                  ...photo,
                  uploadState: 'upload_pending',
                  s3Key: `k/${photo.id}`,
                },
              ],
              settings: {
                userId: photo.userId,
                reminderTime: '09:00',
                timeZone: 'Europe/Moscow',
                postponedUntilDate: null,
                activePostponedRemindAt: null,
                activePostponedPhotoId: null,
                queueRevision: 2,
                updatedAt: nowIso,
              },
              conflicts: [],
              serverTimestamp: nowIso,
            }),
            { status: 200 }
          )
        );
      }
      if (url.includes(`/api/v1/photos/${photo.id}/binary`)) {
        binaryPutCalls++;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              photo: {
                ...photo,
                uploadState: 'uploaded',
                s3Key: `k/${photo.id}`,
              },
              uploadState: 'uploaded',
            }),
            { status: 200 }
          )
        );
      }
      if (url.endsWith('/api/v1/state')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              photos: [
                {
                  ...photo,
                  uploadState: 'uploaded',
                  s3Key: `k/${photo.id}`,
                },
              ],
              settings: {
                userId: photo.userId,
                reminderTime: '09:00',
                timeZone: 'Europe/Moscow',
                postponedUntilDate: null,
                activePostponedRemindAt: null,
                activePostponedPhotoId: null,
                queueRevision: 2,
                updatedAt: nowIso,
              },
              conflicts: [],
              serverTimestamp: nowIso,
            }),
            { status: 200 }
          )
        );
      }
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    };

    const syncedState = await synchronizeWithServer({
      config,
      fetchImpl: mockFetch,
      forceOnline: true,
    });

    expect(syncCalls).toBe(1);
    expect(binaryPutCalls).toBe(1);
    expect(syncedState.pendingOperations).toHaveLength(0);
    expect(syncedState.pendingUploadsCount).toBe(0);
    expect(syncedState.photos[0]?.uploadState).toBe('uploaded');
  });

  it('Renders Russian PWA UI, displays Today dashboard, and navigates between screens', async () => {
    await importBatchLocally({
      candidates: [{ fileName: 'today_hero.jpg', bytes: makeJpegBytes(42) }],
      description: 'Описание для главной страницы',
      config,
    });

    Object.defineProperty(navigator, 'onLine', {
      value: false,
      configurable: true,
    });

    render(<App config={config} />);

    await waitFor(() => {
      expect(screen.getByTestId('today-active-card')).toBeTruthy();
    });

    expect(screen.getByTestId('today-photo-description').textContent).toContain(
      'Описание для главной страницы'
    );
    expect(screen.getByTestId('offline-badge').textContent).toContain(
      'Офлайн-режим'
    );

    // Confirm publication right from Today screen while offline
    fireEvent.click(screen.getByTestId('mark-published-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('today-published-banner')).toBeTruthy();
    });
  });
});
