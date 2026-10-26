export type PhotoStatus = 'pending' | 'published' | 'deleted';

export type UploadState =
  | 'local_only'
  | 'upload_pending'
  | 'uploading'
  | 'uploaded'
  | 'upload_failed';

export type PostponementDuration = '15m' | '1h' | '3h' | '6h' | 'tomorrow';

export type SupportedImageMimeType =
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp'
  | 'image/gif'
  | 'image/avif';

export interface PhotoRecord {
  id: string;
  userId: string;
  fileName: string;
  mimeType: SupportedImageMimeType;
  sizeBytes: number;
  description: string;
  status: PhotoStatus;
  queuePosition: number | null;
  uploadState: UploadState;
  s3Key: string | null;
  checksumSha256: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  scheduledDateAtPublication: string | null;
  deletedAt: string | null;
  revision: number;
}

export interface UserSettings {
  userId: string;
  reminderTime: string;
  timeZone: string;
  postponedUntilDate: string | null;
  activePostponedRemindAt: string | null;
  activePostponedPhotoId: string | null;
  queueRevision: number;
  updatedAt: string;
}

export interface CalendarDayProjection {
  date: string;
  kind: 'published' | 'pending' | 'missed' | 'empty';
  photo: PhotoRecord | null;
  publishedPhotos: PhotoRecord[];
  scheduledDate: string;
  isToday: boolean;
  isPast: boolean;
  isFuture: boolean;
  rolledOverFromDate: string | null;
}

export interface ScheduleInput {
  photos: readonly PhotoRecord[];
  settings: Pick<
    UserSettings,
    | 'timeZone'
    | 'reminderTime'
    | 'postponedUntilDate'
    | 'activePostponedRemindAt'
    | 'activePostponedPhotoId'
  >;
  currentInstant: string;
}

export interface ScheduleOutput {
  todayLocalDate: string;
  timeZone: string;
  effectiveNextPublicationDate: string | null;
  nextPendingPhoto: PhotoRecord | null;
  nextReminderInstant: string | null;
  projectedByPhotoId: Record<string, string>;
  projectedByDate: Record<string, PhotoRecord>;
  publishedByDate: Record<string, PhotoRecord[]>;
  missedDates: string[];
  rolledOverFromByPhotoId: Record<string, string>;
}

export type SyncOperationType =
  | 'CREATE_PHOTO'
  | 'UPDATE_DESCRIPTION'
  | 'MARK_PUBLISHED'
  | 'DELETE_PHOTO'
  | 'REORDER_QUEUE'
  | 'POSTPONE_REMINDER'
  | 'UPDATE_SETTINGS';

export interface CreatePhotoPayload {
  photo: PhotoRecord;
}

export interface UpdateDescriptionPayload {
  photoId: string;
  description: string;
  baseRevision: number;
  updatedAt: string;
}

export interface MarkPublishedPayload {
  photoId: string;
  publishedAt: string;
  scheduledDateAtPublication: string | null;
  baseRevision: number;
}

export interface DeletePhotoPayload {
  photoId: string;
  deletedAt: string;
  baseRevision: number;
}

export interface ReorderQueuePayload {
  orderedPhotoIds: string[];
  baseQueueRevision: number;
  updatedAt: string;
}

export interface PostponeReminderPayload {
  photoId: string;
  duration: PostponementDuration;
  requestedAt: string;
  baseQueueRevision: number;
}

export interface UpdateSettingsPayload {
  reminderTime: string;
  timeZone: string;
  baseQueueRevision: number;
  updatedAt: string;
}

export type SyncOperationPayload =
  | { type: 'CREATE_PHOTO'; payload: CreatePhotoPayload }
  | { type: 'UPDATE_DESCRIPTION'; payload: UpdateDescriptionPayload }
  | { type: 'MARK_PUBLISHED'; payload: MarkPublishedPayload }
  | { type: 'DELETE_PHOTO'; payload: DeletePhotoPayload }
  | { type: 'REORDER_QUEUE'; payload: ReorderQueuePayload }
  | { type: 'POSTPONE_REMINDER'; payload: PostponeReminderPayload }
  | { type: 'UPDATE_SETTINGS'; payload: UpdateSettingsPayload };

export interface SyncOperationRecord {
  idempotencyKey: string;
  type: SyncOperationType;
  payload:
    | CreatePhotoPayload
    | UpdateDescriptionPayload
    | MarkPublishedPayload
    | DeletePhotoPayload
    | ReorderQueuePayload
    | PostponeReminderPayload
    | UpdateSettingsPayload;
  createdAt: string;
  retryCount: number;
  lastError: string | null;
  status: 'pending' | 'syncing' | 'completed' | 'failed';
}

export type ConflictType =
  | 'DESCRIPTION_CONFLICT'
  | 'TERMINAL_STATE_CONFLICT'
  | 'QUEUE_REORDER_MERGED'
  | 'SETTINGS_CONFLICT';

export type ConflictResolutionKind =
  | 'SERVER_WON'
  | 'CLIENT_WON'
  | 'MERGED'
  | 'MANUAL_REQUIRED';

export interface SyncConflict {
  id: string;
  operationId: string;
  photoId: string | null;
  conflictType: ConflictType;
  resolution: ConflictResolutionKind;
  message: string;
  clientValue: unknown;
  serverValue: unknown;
  createdAt: string;
  resolved: boolean;
}

export interface ValidationIssue {
  fileName: string;
  reason: string;
}

export interface ValidatedUploadItem {
  id: string;
  fileName: string;
  mimeType: SupportedImageMimeType;
  sizeBytes: number;
  bytes: Uint8Array;
  sourceArchiveName: string | null;
}
