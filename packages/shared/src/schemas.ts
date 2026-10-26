import { z } from 'zod';
import {
  isValidCalendarDate,
  isValidIanaTimeZone,
  isValidReminderTime,
} from './scheduler.js';

export class ConfigurationError extends Error {
  public readonly variableName: string;

  constructor(variableName: string, detail?: string) {
    const message = detail
      ? `ConfigurationError: ${variableName} ${detail}`
      : `ConfigurationError: ${variableName} is required.`;
    super(message);
    this.name = 'ConfigurationError';
    this.variableName = variableName;
  }
}

export function requireNonEmptyEnvString(
  env: Record<string, string | undefined>,
  key: string
): string {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') {
    throw new ConfigurationError(key);
  }
  return raw.trim();
}

export function requirePositiveIntEnv(
  env: Record<string, string | undefined>,
  key: string,
  options?: { min?: number; max?: number }
): number {
  const raw = requireNonEmptyEnvString(env, key);
  if (!/^\d+$/.test(raw)) {
    throw new ConfigurationError(key, `must be a positive integer (got "${raw}").`);
  }
  const num = Number(raw);
  if (!Number.isSafeInteger(num) || num <= 0) {
    throw new ConfigurationError(key, `must be a positive integer (got "${raw}").`);
  }
  if (options?.min !== undefined && num < options.min) {
    throw new ConfigurationError(key, `must be >= ${options.min} (got ${num}).`);
  }
  if (options?.max !== undefined && num > options.max) {
    throw new ConfigurationError(key, `must be <= ${options.max} (got ${num}).`);
  }
  return num;
}

export function requirePositiveNumberEnv(
  env: Record<string, string | undefined>,
  key: string
): number {
  const raw = requireNonEmptyEnvString(env, key);
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) {
    throw new ConfigurationError(key, `must be a positive number (got "${raw}").`);
  }
  return num;
}

export function requireBooleanEnv(
  env: Record<string, string | undefined>,
  key: string
): boolean {
  const raw = requireNonEmptyEnvString(env, key);
  if (raw === 'true') {
    return true;
  }
  if (raw === 'false') {
    return false;
  }
  throw new ConfigurationError(key, `must be "true" or "false" (got "${raw}").`);
}

export function requireUrlEnv(
  env: Record<string, string | undefined>,
  key: string,
  allowedProtocols: readonly string[] = ['http:', 'https:']
): string {
  const raw = requireNonEmptyEnvString(env, key);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigurationError(key, `must be a valid URL (got "${raw}").`);
  }
  if (!allowedProtocols.includes(parsed.protocol)) {
    throw new ConfigurationError(
      key,
      `must use protocol ${allowedProtocols.join(' or ')} (got "${parsed.protocol}").`
    );
  }
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

export const PhotoStatusSchema = z.enum(['pending', 'published', 'deleted']);

export const UploadStateSchema = z.enum([
  'local_only',
  'upload_pending',
  'uploading',
  'uploaded',
  'upload_failed',
]);

export const SupportedImageMimeTypeSchema = z.enum([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
]);

export const PostponementDurationSchema = z.enum([
  '15m',
  '1h',
  '3h',
  '6h',
  'tomorrow',
]);

export const ReminderTimeSchema = z
  .string()
  .refine(isValidReminderTime, 'Reminder time must be in 24-hour HH:MM format.');

export const IanaTimeZoneSchema = z
  .string()
  .refine(isValidIanaTimeZone, 'Must be a valid IANA time zone identifier.');

export const CalendarDateSchema = z
  .string()
  .refine(isValidCalendarDate, 'Must be a valid YYYY-MM-DD calendar date.');

export const PhotoRecordSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  fileName: z.string().min(1).max(255),
  mimeType: SupportedImageMimeTypeSchema,
  sizeBytes: z.number().int().positive(),
  description: z.string().max(10000),
  status: PhotoStatusSchema,
  queuePosition: z.number().int().nonnegative().nullable(),
  uploadState: UploadStateSchema,
  s3Key: z.string().min(1).nullable(),
  checksumSha256: z.string().min(8).max(128),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  publishedAt: z.string().datetime().nullable(),
  scheduledDateAtPublication: CalendarDateSchema.nullable(),
  deletedAt: z.string().datetime().nullable(),
  revision: z.number().int().positive(),
});

export const CreatePhotoPayloadSchema = z.object({
  photo: PhotoRecordSchema,
});

export const UpdateDescriptionPayloadSchema = z.object({
  photoId: z.string().uuid(),
  description: z.string().max(10000),
  baseRevision: z.number().int().positive(),
  updatedAt: z.string().datetime(),
});

export const MarkPublishedPayloadSchema = z.object({
  photoId: z.string().uuid(),
  publishedAt: z.string().datetime(),
  scheduledDateAtPublication: CalendarDateSchema.nullable(),
  baseRevision: z.number().int().positive(),
});

export const DeletePhotoPayloadSchema = z.object({
  photoId: z.string().uuid(),
  deletedAt: z.string().datetime(),
  baseRevision: z.number().int().positive(),
});

export const ReorderQueuePayloadSchema = z.object({
  orderedPhotoIds: z.array(z.string().uuid()),
  baseQueueRevision: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
});

export const PostponeReminderPayloadSchema = z.object({
  photoId: z.string().uuid(),
  duration: PostponementDurationSchema,
  requestedAt: z.string().datetime(),
  baseQueueRevision: z.number().int().nonnegative(),
});

export const UpdateSettingsPayloadSchema = z.object({
  reminderTime: ReminderTimeSchema,
  timeZone: IanaTimeZoneSchema,
  baseQueueRevision: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
});

export const SyncOperationRequestSchema = z.discriminatedUnion('type', [
  z.object({
    idempotencyKey: z.string().uuid(),
    type: z.literal('CREATE_PHOTO'),
    payload: CreatePhotoPayloadSchema,
  }),
  z.object({
    idempotencyKey: z.string().uuid(),
    type: z.literal('UPDATE_DESCRIPTION'),
    payload: UpdateDescriptionPayloadSchema,
  }),
  z.object({
    idempotencyKey: z.string().uuid(),
    type: z.literal('MARK_PUBLISHED'),
    payload: MarkPublishedPayloadSchema,
  }),
  z.object({
    idempotencyKey: z.string().uuid(),
    type: z.literal('DELETE_PHOTO'),
    payload: DeletePhotoPayloadSchema,
  }),
  z.object({
    idempotencyKey: z.string().uuid(),
    type: z.literal('REORDER_QUEUE'),
    payload: ReorderQueuePayloadSchema,
  }),
  z.object({
    idempotencyKey: z.string().uuid(),
    type: z.literal('POSTPONE_REMINDER'),
    payload: PostponeReminderPayloadSchema,
  }),
  z.object({
    idempotencyKey: z.string().uuid(),
    type: z.literal('UPDATE_SETTINGS'),
    payload: UpdateSettingsPayloadSchema,
  }),
]);

export const BatchSyncRequestSchema = z.object({
  operations: z.array(SyncOperationRequestSchema).max(200),
});

export const PushSubscriptionKeysSchema = z.object({
  p256dh: z.string().min(1),
  auth: z.string().min(1),
});

export const PushSubscriptionInputSchema = z.object({
  endpoint: z.string().url(),
  expirationTime: z.number().nullable().optional(),
  keys: PushSubscriptionKeysSchema,
  userAgent: z.string().max(500).optional(),
});
