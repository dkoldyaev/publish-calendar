import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import {
  addCalendarDays,
  applyPostponement,
  buildMonthDaysProjection,
  calculateSchedule,
  ConfigurationError,
  formatInstantToLocalDate,
  localDateAndTimeToUtcInstant,
  normalizeQueuePositions,
  requireBooleanEnv,
  requireNonEmptyEnvString,
  requirePositiveIntEnv,
  requireUrlEnv,
  resolveDeletePhoto,
  resolveMarkPublished,
  resolveQueueReorder,
  resolveUpdateDescription,
  validateUploadBatch,
  type PhotoRecord,
  type UploadValidationLimits,
  type UserSettings,
} from './index.js';

const USER_ID = '00000000-0000-4000-8000-000000000001';

function makePhoto(
  overrides: Partial<PhotoRecord> & { id: string; queuePosition?: number | null }
): PhotoRecord {
  return {
    id: overrides.id,
    userId: overrides.userId ?? USER_ID,
    fileName: overrides.fileName ?? `${overrides.id}.jpg`,
    mimeType: overrides.mimeType ?? 'image/jpeg',
    sizeBytes: overrides.sizeBytes ?? 1024,
    description: overrides.description ?? 'Описание',
    status: overrides.status ?? 'pending',
    queuePosition:
      overrides.queuePosition !== undefined ? overrides.queuePosition : 0,
    uploadState: overrides.uploadState ?? 'uploaded',
    s3Key: overrides.s3Key ?? `photos/${overrides.id}.jpg`,
    checksumSha256: overrides.checksumSha256 ?? 'abcdef0123456789',
    createdAt: overrides.createdAt ?? '2026-03-01T08:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-03-01T08:00:00.000Z',
    publishedAt: overrides.publishedAt ?? null,
    scheduledDateAtPublication: overrides.scheduledDateAtPublication ?? null,
    deletedAt: overrides.deletedAt ?? null,
    revision: overrides.revision ?? 1,
  };
}

function makeSettings(overrides?: Partial<UserSettings>): UserSettings {
  return {
    userId: USER_ID,
    reminderTime: overrides?.reminderTime ?? '09:00',
    timeZone: overrides?.timeZone ?? 'Europe/Madrid',
    postponedUntilDate: overrides?.postponedUntilDate ?? null,
    activePostponedRemindAt: overrides?.activePostponedRemindAt ?? null,
    activePostponedPhotoId: overrides?.activePostponedPhotoId ?? null,
    queueRevision: overrides?.queueRevision ?? 1,
    updatedAt: overrides?.updatedAt ?? '2026-03-01T08:00:00.000Z',
  };
}

function makeValidJpegBytes(seed = 1): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  bytes[3] = 0xe0;
  bytes[4] = seed & 0xff;
  bytes[30] = 0xff;
  bytes[31] = 0xd9;
  return bytes;
}

const TEST_LIMITS: UploadValidationLimits = {
  maxUploadFileBytes: 10 * 1024 * 1024,
  maxBatchFiles: 50,
  maxBatchTotalBytes: 50 * 1024 * 1024,
  maxZipExpansionRatio: 25,
  maxZipExtractedBytes: 30 * 1024 * 1024,
  maxZipEntries: 100,
};

describe('Domain Scheduling & Shared Package Verification', () => {
  it('Scenario 1: Batch upload with 5 photos and 1 ZIP containing 5 valid photos preserves deterministic order', () => {
    const zipArchiveBytes = zipSync({
      '01_arch.jpg': makeValidJpegBytes(10),
      'nested/02_arch.jpg': makeValidJpegBytes(11),
      'nested/deep/03_arch.jpg': makeValidJpegBytes(12),
      '04_arch.jpg': makeValidJpegBytes(13),
      '05_arch.jpg': makeValidJpegBytes(14),
    });

    const candidates = [
      { fileName: 'photo_1.jpg', bytes: makeValidJpegBytes(1) },
      { fileName: 'photo_2.jpg', bytes: makeValidJpegBytes(2) },
      { fileName: 'photo_3.jpg', bytes: makeValidJpegBytes(3) },
      { fileName: 'batch.zip', bytes: zipArchiveBytes },
      { fileName: 'photo_4.jpg', bytes: makeValidJpegBytes(4) },
      { fileName: 'photo_5.jpg', bytes: makeValidJpegBytes(5) },
    ];

    let seq = 0;
    const result = validateUploadBatch(candidates, TEST_LIMITS, () => {
      seq++;
      return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
    });

    expect(result.issues).toEqual([]);
    expect(result.validItems).toHaveLength(10);
    expect(result.validItems.map((i) => i.fileName)).toEqual([
      'photo_1.jpg',
      'photo_2.jpg',
      'photo_3.jpg',
      '01_arch.jpg',
      '04_arch.jpg',
      '05_arch.jpg',
      '02_arch.jpg',
      '03_arch.jpg',
      'photo_4.jpg',
      'photo_5.jpg',
    ]);
  });

  it('Handles invalid ZIPs, path traversal, corrupted images, unsupported extensions, and duplicate names safely', () => {
    const zipWithMixedContent = zipSync({
      '../evil.jpg': makeValidJpegBytes(1),
      'valid.jpg': makeValidJpegBytes(2),
      'sub/valid.jpg': makeValidJpegBytes(3),
      'corrupted_small.jpg': new Uint8Array([0x00, 0x01, 0x02, 0x03]),
      'corrupted_header.jpg': new Uint8Array(24),
      'notes.txt': new TextEncoder().encode('hello world'),
    });

    let seq = 0;
    const result = validateUploadBatch(
      [
        { fileName: 'mixed.zip', bytes: zipWithMixedContent },
        { fileName: 'broken.zip', bytes: new Uint8Array([1, 2, 3]) },
      ],
      TEST_LIMITS,
      () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`
    );

    expect(result.validItems).toHaveLength(2);
    expect(result.validItems.map((i) => i.fileName)).toEqual([
      'valid.jpg',
      'valid (2).jpg',
    ]);
    expect(result.issues.length).toBeGreaterThanOrEqual(5);
    expect(
      result.issues.some((i) => i.reason.includes('Path Traversal'))
    ).toBe(true);
    expect(
      result.issues.some((i) => i.reason.includes('Повреждённый файл JPEG'))
    ).toBe(true);
    expect(
      result.issues.some((i) => i.reason.includes('слишком малый размер'))
    ).toBe(true);
    expect(
      result.issues.some((i) => i.reason.includes('Неподдерживаемый формат'))
    ).toBe(true);
  });

  it('Scenario 2: Delete from calendar closes gap without violating one-per-day rule', () => {
    const photos = [1, 2, 3, 4, 5].map((n, idx) =>
      makePhoto({
        id: `00000000-0000-4000-8000-00000000000${n}`,
        queuePosition: idx,
      })
    );
    const settings = makeSettings({ timeZone: 'UTC' });
    const now = '2026-03-02T10:00:00.000Z';

    const before = calculateSchedule({
      photos,
      settings,
      currentInstant: now,
    });
    expect(
      photos.map((p) => before.projectedByPhotoId[p.id])
    ).toEqual([
      '2026-03-02',
      '2026-03-03',
      '2026-03-04',
      '2026-03-05',
      '2026-03-06',
    ]);

    // Delete the second photograph
    const afterDeletePhotos = normalizeQueuePositions(
      photos.map((p, idx) =>
        idx === 1
          ? {
              ...p,
              status: 'deleted',
              queuePosition: null,
              deletedAt: now,
            }
          : p
      )
    );

    const after = calculateSchedule({
      photos: afterDeletePhotos,
      settings,
      currentInstant: now,
    });
    const remainingIds = [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000004',
      '00000000-0000-4000-8000-000000000005',
    ];
    expect(remainingIds.map((id) => after.projectedByPhotoId[id])).toEqual([
      '2026-03-02',
      '2026-03-03',
      '2026-03-04',
      '2026-03-05',
    ]);
  });

  it('Scenario 3: Missed publication rolls Photo A to Tuesday and Photo B to Wednesday', () => {
    const photoA = makePhoto({
      id: '00000000-0000-4000-8000-00000000000a',
      queuePosition: 0,
      createdAt: '2026-03-02T07:00:00.000Z', // Monday
    });
    const photoB = makePhoto({
      id: '00000000-0000-4000-8000-00000000000b',
      queuePosition: 1,
      createdAt: '2026-03-02T07:00:00.000Z',
    });
    const settings = makeSettings({ timeZone: 'UTC' });

    const mondaySchedule = calculateSchedule({
      photos: [photoA, photoB],
      settings,
      currentInstant: '2026-03-02T12:00:00.000Z',
    });
    expect(mondaySchedule.projectedByPhotoId[photoA.id]).toBe('2026-03-02');
    expect(mondaySchedule.projectedByPhotoId[photoB.id]).toBe('2026-03-03');

    // Monday ends without publication confirmation; now it is Tuesday
    const tuesdaySchedule = calculateSchedule({
      photos: [photoA, photoB],
      settings,
      currentInstant: '2026-03-03T08:00:00.000Z',
    });
    expect(tuesdaySchedule.projectedByPhotoId[photoA.id]).toBe('2026-03-03');
    expect(tuesdaySchedule.projectedByPhotoId[photoB.id]).toBe('2026-03-04');
    expect(tuesdaySchedule.missedDates).toContain('2026-03-02');

    const monthDays = buildMonthDaysProjection(2026, 3, tuesdaySchedule);
    const mondayProjection = monthDays.find((d) => d.date === '2026-03-02');
    const tuesdayProjection = monthDays.find((d) => d.date === '2026-03-03');
    const wednesdayProjection = monthDays.find((d) => d.date === '2026-03-04');

    expect(mondayProjection?.kind).toBe('missed');
    expect(tuesdayProjection?.kind).toBe('pending');
    expect(tuesdayProjection?.photo?.id).toBe(photoA.id);
    expect(wednesdayProjection?.kind).toBe('pending');
    expect(wednesdayProjection?.photo?.id).toBe(photoB.id);
  });

  it('Scenario 4: Publication confirmation marks Photo A historical and keeps Photo B on tomorrow', () => {
    const photoA = makePhoto({
      id: '00000000-0000-4000-8000-00000000000a',
      queuePosition: 0,
    });
    const photoB = makePhoto({
      id: '00000000-0000-4000-8000-00000000000b',
      queuePosition: 1,
    });
    const settings = makeSettings({ timeZone: 'UTC' });
    const now = '2026-03-02T14:00:00.000Z';

    const confirmedA: PhotoRecord = {
      ...photoA,
      status: 'published',
      queuePosition: null,
      publishedAt: now,
      scheduledDateAtPublication: '2026-03-02',
      revision: 2,
    };

    const schedule = calculateSchedule({
      photos: [confirmedA, { ...photoB, queuePosition: 0 }],
      settings,
      currentInstant: now,
    });

    expect(schedule.publishedByDate['2026-03-02']?.[0]?.id).toBe(photoA.id);
    expect(schedule.projectedByPhotoId[photoB.id]).toBe('2026-03-03');
    expect(schedule.effectiveNextPublicationDate).toBe('2026-03-03');
  });

  it('Scenario 5: Reordering moves Photo C to first position and projects C, A, B on consecutive days', () => {
    const photoA = makePhoto({
      id: '00000000-0000-4000-8000-00000000000a',
      queuePosition: 0,
    });
    const photoB = makePhoto({
      id: '00000000-0000-4000-8000-00000000000b',
      queuePosition: 1,
    });
    const photoC = makePhoto({
      id: '00000000-0000-4000-8000-00000000000c',
      queuePosition: 2,
    });

    const reordered = resolveQueueReorder({
      operationId: '00000000-0000-4000-8000-000000000100',
      serverPhotos: [photoA, photoB, photoC],
      serverQueueRevision: 1,
      payload: {
        orderedPhotoIds: [photoC.id, photoA.id, photoB.id],
        baseQueueRevision: 1,
        updatedAt: '2026-03-02T10:00:00.000Z',
      },
      nowIso: '2026-03-02T10:00:00.000Z',
      conflictId: '00000000-0000-4000-8000-000000000200',
    });

    expect(reordered.conflict).toBeNull();
    const schedule = calculateSchedule({
      photos: reordered.updatedPhotos,
      settings: makeSettings({ timeZone: 'UTC' }),
      currentInstant: '2026-03-02T10:00:00.000Z',
    });

    expect(schedule.projectedByPhotoId[photoC.id]).toBe('2026-03-02');
    expect(schedule.projectedByPhotoId[photoA.id]).toBe('2026-03-03');
    expect(schedule.projectedByPhotoId[photoB.id]).toBe('2026-03-04');
  });

  it('Scenario 8 & Scenario 9: Short postponement (1h) vs Postpone until tomorrow', () => {
    const photoA = makePhoto({
      id: '00000000-0000-4000-8000-00000000000a',
      queuePosition: 0,
    });
    const photoB = makePhoto({
      id: '00000000-0000-4000-8000-00000000000b',
      queuePosition: 1,
    });
    const settings = makeSettings({
      timeZone: 'UTC',
      reminderTime: '09:00',
    });

    // Scenario 8: 09:00 postponed by 1h -> 10:00 without changing publication dates
    const shortPostponed = applyPostponement({
      settings,
      photos: [photoA, photoB],
      duration: '1h',
      currentInstant: '2026-03-02T09:00:00.000Z',
    });

    expect(shortPostponed.schedule.nextReminderInstant).toBe(
      '2026-03-02T10:00:00.000Z'
    );
    expect(shortPostponed.schedule.projectedByPhotoId[photoA.id]).toBe(
      '2026-03-02'
    );
    expect(shortPostponed.schedule.projectedByPhotoId[photoB.id]).toBe(
      '2026-03-03'
    );

    // Scenario 9: Postpone until tomorrow moves Photo A to tomorrow and Photo B to day after tomorrow
    const tomorrowPostponed = applyPostponement({
      settings: shortPostponed.updatedSettings,
      photos: [photoA, photoB],
      duration: 'tomorrow',
      currentInstant: '2026-03-02T09:15:00.000Z',
    });

    expect(tomorrowPostponed.schedule.projectedByPhotoId[photoA.id]).toBe(
      '2026-03-03'
    );
    expect(tomorrowPostponed.schedule.projectedByPhotoId[photoB.id]).toBe(
      '2026-03-04'
    );
    expect(tomorrowPostponed.schedule.nextReminderInstant).toBe(
      '2026-03-03T09:00:00.000Z'
    );
  });

  it('Scenario 11: Detects and resolves multi-device conflicts deterministically', () => {
    const basePhoto = makePhoto({
      id: '00000000-0000-4000-8000-00000000000a',
      description: 'Серверное описание (v2)',
      revision: 2,
    });

    // Concurrent description edit with stale baseRevision=1 produces MANUAL_REQUIRED conflict
    const descConflict = resolveUpdateDescription({
      operationId: '00000000-0000-4000-8000-000000000101',
      serverPhoto: basePhoto,
      payload: {
        photoId: basePhoto.id,
        description: 'Клиентское описание (v1->v2)',
        baseRevision: 1,
        updatedAt: '2026-03-02T11:00:00.000Z',
      },
      nowIso: '2026-03-02T11:01:00.000Z',
      conflictId: '00000000-0000-4000-8000-000000000201',
    });

    expect(descConflict.applied).toBe(false);
    expect(descConflict.conflict?.conflictType).toBe('DESCRIPTION_CONFLICT');
    expect(descConflict.conflict?.resolution).toBe('MANUAL_REQUIRED');

    // Delete vs already-published photo: published terminal state wins
    const publishedPhoto: PhotoRecord = {
      ...basePhoto,
      status: 'published',
      publishedAt: '2026-03-02T10:00:00.000Z',
      queuePosition: null,
      revision: 3,
    };

    const deleteVsPublished = resolveDeletePhoto({
      operationId: '00000000-0000-4000-8000-000000000102',
      serverPhoto: publishedPhoto,
      payload: {
        photoId: publishedPhoto.id,
        deletedAt: '2026-03-02T10:05:00.000Z',
        baseRevision: 2,
      },
      nowIso: '2026-03-02T10:06:00.000Z',
      conflictId: '00000000-0000-4000-8000-000000000202',
    });

    expect(deleteVsPublished.applied).toBe(false);
    expect(deleteVsPublished.updatedState.status).toBe('published');
    expect(deleteVsPublished.conflict?.conflictType).toBe(
      'TERMINAL_STATE_CONFLICT'
    );
    expect(deleteVsPublished.conflict?.resolution).toBe('SERVER_WON');

    // Mark published vs deleted photo: published terminal state wins
    const deletedPhoto: PhotoRecord = {
      ...basePhoto,
      status: 'deleted',
      deletedAt: '2026-03-02T10:00:00.000Z',
      queuePosition: null,
      revision: 3,
    };

    const publishVsDeleted = resolveMarkPublished({
      operationId: '00000000-0000-4000-8000-000000000103',
      serverPhoto: deletedPhoto,
      payload: {
        photoId: deletedPhoto.id,
        publishedAt: '2026-03-02T10:02:00.000Z',
        scheduledDateAtPublication: '2026-03-02',
        baseRevision: 2,
      },
      nowIso: '2026-03-02T10:06:00.000Z',
      conflictId: '00000000-0000-4000-8000-000000000203',
    });

    expect(publishVsDeleted.applied).toBe(true);
    expect(publishVsDeleted.updatedState.status).toBe('published');
    expect(publishVsDeleted.conflict?.resolution).toBe('CLIENT_WON');
  });

  it('Scenario 12: Time zone and DST boundary transitions preserve 1 photo per local day and exact local reminder time', () => {
    // Europe/Madrid switches from CET (UTC+1) to CEST (UTC+2) on Sunday 2026-03-29
    // and switches back from CEST (UTC+2) to CET (UTC+1) on Sunday 2026-10-25
    const photos = [1, 2, 3, 4].map((n, idx) =>
      makePhoto({
        id: `00000000-0000-4000-8000-00000000000${n}`,
        queuePosition: idx,
      })
    );
    const settings = makeSettings({
      timeZone: 'Europe/Madrid',
      reminderTime: '09:30',
    });

    // Saturday 2026-03-28 (before spring-forward DST change)
    const springSchedule = calculateSchedule({
      photos,
      settings,
      currentInstant: '2026-03-28T07:00:00.000Z',
    });

    expect(
      photos.map((p) => springSchedule.projectedByPhotoId[p.id])
    ).toEqual([
      '2026-03-28',
      '2026-03-29',
      '2026-03-30',
      '2026-03-31',
    ]);

    // On 2026-03-28 (CET, UTC+1), 09:30 local is 08:30 UTC
    expect(
      localDateAndTimeToUtcInstant('2026-03-28', '09:30', 'Europe/Madrid')
    ).toBe('2026-03-28T08:30:00.000Z');

    // On 2026-03-29 (CEST, UTC+2 after 02:00->03:00 jump), 09:30 local is 07:30 UTC
    expect(
      localDateAndTimeToUtcInstant('2026-03-29', '09:30', 'Europe/Madrid')
    ).toBe('2026-03-29T07:30:00.000Z');

    // On 2026-10-25 (CET, UTC+1 after fall-back), 09:30 local is 08:30 UTC
    expect(
      localDateAndTimeToUtcInstant('2026-10-25', '09:30', 'Europe/Madrid')
    ).toBe('2026-10-25T08:30:00.000Z');

    expect(formatInstantToLocalDate('2026-03-28T23:30:00.000Z', 'Europe/Madrid')).toBe(
      '2026-03-29'
    );
    expect(addCalendarDays('2026-03-28', 1)).toBe('2026-03-29');
  });

  it('Scenario 10 (Shared Helpers): Configuration helpers fail fast with descriptive ConfigurationError', () => {
    expect(() => requireNonEmptyEnvString({}, 'S3_BUCKET')).toThrowError(
      new ConfigurationError('S3_BUCKET')
    );
    expect(() => requireNonEmptyEnvString({}, 'S3_BUCKET')).toThrow(
      'ConfigurationError: S3_BUCKET is required.'
    );
    expect(() =>
      requirePositiveIntEnv({ API_PORT: 'not-a-number' }, 'API_PORT')
    ).toThrow(/ConfigurationError: API_PORT/);
    expect(() =>
      requireBooleanEnv({ S3_FORCE_PATH_STYLE: 'yes' }, 'S3_FORCE_PATH_STYLE')
    ).toThrow(/ConfigurationError: S3_FORCE_PATH_STYLE/);
    expect(() =>
      requireUrlEnv({ S3_ENDPOINT: 'ftp://invalid' }, 'S3_ENDPOINT')
    ).toThrow(/ConfigurationError: S3_ENDPOINT/);
  });
});
