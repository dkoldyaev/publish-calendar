import type {
  DeletePhotoPayload,
  MarkPublishedPayload,
  PhotoRecord,
  ReorderQueuePayload,
  SyncConflict,
  UpdateDescriptionPayload,
  UpdateSettingsPayload,
  UserSettings,
} from './types.js';
import { sortPendingQueue } from './scheduler.js';

export interface ConflictResolutionResult<T> {
  applied: boolean;
  updatedState: T;
  conflict: SyncConflict | null;
}

export function resolveMarkPublished(params: {
  operationId: string;
  serverPhoto: PhotoRecord;
  payload: MarkPublishedPayload;
  nowIso: string;
  conflictId: string;
}): ConflictResolutionResult<PhotoRecord> {
  const { operationId, serverPhoto, payload, nowIso, conflictId } = params;

  // Idempotent duplicate confirmation
  if (serverPhoto.status === 'published') {
    return {
      applied: false,
      updatedState: serverPhoto,
      conflict: null,
    };
  }

  // If deleted on another device, 'published' terminal state wins because actual external publication occurred
  if (serverPhoto.status === 'deleted') {
    const updated: PhotoRecord = {
      ...serverPhoto,
      status: 'published',
      queuePosition: null,
      publishedAt: payload.publishedAt,
      scheduledDateAtPublication: payload.scheduledDateAtPublication,
      deletedAt: null,
      updatedAt: nowIso,
      revision: serverPhoto.revision + 1,
    };
    return {
      applied: true,
      updatedState: updated,
      conflict: {
        id: conflictId,
        operationId,
        photoId: serverPhoto.id,
        conflictType: 'TERMINAL_STATE_CONFLICT',
        resolution: 'CLIENT_WON',
        message:
          'Фотография была удалена на другом устройстве, но подтверждение публикации имеет приоритет и сохранено в истории.',
        clientValue: { status: 'published', publishedAt: payload.publishedAt },
        serverValue: { status: 'deleted', deletedAt: serverPhoto.deletedAt },
        createdAt: nowIso,
        resolved: true,
      },
    };
  }

  const updated: PhotoRecord = {
    ...serverPhoto,
    status: 'published',
    queuePosition: null,
    publishedAt: payload.publishedAt,
    scheduledDateAtPublication: payload.scheduledDateAtPublication,
    updatedAt: nowIso,
    revision: serverPhoto.revision + 1,
  };

  return {
    applied: true,
    updatedState: updated,
    conflict: null,
  };
}

export function resolveDeletePhoto(params: {
  operationId: string;
  serverPhoto: PhotoRecord;
  payload: DeletePhotoPayload;
  nowIso: string;
  conflictId: string;
}): ConflictResolutionResult<PhotoRecord> {
  const { operationId, serverPhoto, payload, nowIso, conflictId } = params;

  // Idempotent duplicate deletion
  if (serverPhoto.status === 'deleted') {
    return {
      applied: false,
      updatedState: serverPhoto,
      conflict: null,
    };
  }

  // Published terminal state cannot be overwritten by a concurrent deletion
  if (serverPhoto.status === 'published') {
    return {
      applied: false,
      updatedState: serverPhoto,
      conflict: {
        id: conflictId,
        operationId,
        photoId: serverPhoto.id,
        conflictType: 'TERMINAL_STATE_CONFLICT',
        resolution: 'SERVER_WON',
        message:
          'Удаление отклонено: эта фотография уже была отмечена как опубликованная на другом устройстве.',
        clientValue: { status: 'deleted', deletedAt: payload.deletedAt },
        serverValue: { status: 'published', publishedAt: serverPhoto.publishedAt },
        createdAt: nowIso,
        resolved: true,
      },
    };
  }

  const updated: PhotoRecord = {
    ...serverPhoto,
    status: 'deleted',
    queuePosition: null,
    deletedAt: payload.deletedAt,
    updatedAt: nowIso,
    revision: serverPhoto.revision + 1,
  };

  return {
    applied: true,
    updatedState: updated,
    conflict: null,
  };
}

export function resolveUpdateDescription(params: {
  operationId: string;
  serverPhoto: PhotoRecord;
  payload: UpdateDescriptionPayload;
  nowIso: string;
  conflictId: string;
}): ConflictResolutionResult<PhotoRecord> {
  const { operationId, serverPhoto, payload, nowIso, conflictId } = params;

  if (serverPhoto.status === 'deleted') {
    return {
      applied: false,
      updatedState: serverPhoto,
      conflict: {
        id: conflictId,
        operationId,
        photoId: serverPhoto.id,
        conflictType: 'TERMINAL_STATE_CONFLICT',
        resolution: 'SERVER_WON',
        message:
          'Изменение описания не применено, так как фотография была удалена на другом устройстве.',
        clientValue: { description: payload.description },
        serverValue: { status: 'deleted' },
        createdAt: nowIso,
        resolved: true,
      },
    };
  }

  // No-op if identical description
  if (serverPhoto.description === payload.description) {
    return {
      applied: false,
      updatedState: serverPhoto,
      conflict: null,
    };
  }

  // Detect concurrent modification if baseRevision < serverPhoto.revision
  if (payload.baseRevision < serverPhoto.revision) {
    return {
      applied: false,
      updatedState: serverPhoto,
      conflict: {
        id: conflictId,
        operationId,
        photoId: serverPhoto.id,
        conflictType: 'DESCRIPTION_CONFLICT',
        resolution: 'MANUAL_REQUIRED',
        message:
          'Конфликт редактирования описания: фотография была изменена на другом устройстве. Выберите нужный вариант.',
        clientValue: {
          description: payload.description,
          baseRevision: payload.baseRevision,
        },
        serverValue: {
          description: serverPhoto.description,
          revision: serverPhoto.revision,
        },
        createdAt: nowIso,
        resolved: false,
      },
    };
  }

  const updated: PhotoRecord = {
    ...serverPhoto,
    description: payload.description,
    updatedAt: nowIso,
    revision: serverPhoto.revision + 1,
  };

  return {
    applied: true,
    updatedState: updated,
    conflict: null,
  };
}

export function resolveQueueReorder(params: {
  operationId: string;
  serverPhotos: readonly PhotoRecord[];
  serverQueueRevision: number;
  payload: ReorderQueuePayload;
  nowIso: string;
  conflictId: string;
}): {
  updatedPhotos: PhotoRecord[];
  nextQueueRevision: number;
  conflict: SyncConflict | null;
} {
  const {
    operationId,
    serverPhotos,
    serverQueueRevision,
    payload,
    nowIso,
    conflictId,
  } = params;

  const currentPending = sortPendingQueue(serverPhotos);
  const currentPendingIds = currentPending.map((p) => p.id);
  const pendingSet = new Set(currentPendingIds);

  // Keep only valid currently-pending IDs from client order, in the client's relative order
  const seen = new Set<string>();
  const mergedOrderIds: string[] = [];
  for (const id of payload.orderedPhotoIds) {
    if (pendingSet.has(id) && !seen.has(id)) {
      seen.add(id);
      mergedOrderIds.push(id);
    }
  }

  // Append any pending photos on the server that were not in the client's list
  for (const id of currentPendingIds) {
    if (!seen.has(id)) {
      seen.add(id);
      mergedOrderIds.push(id);
    }
  }

  const posMap = new Map<string, number>();
  mergedOrderIds.forEach((id, idx) => {
    posMap.set(id, idx);
  });

  const updatedPhotos = serverPhotos.map((photo) => {
    if (photo.status !== 'pending') {
      return photo.queuePosition === null
        ? photo
        : { ...photo, queuePosition: null };
    }
    const newPos = posMap.get(photo.id) ?? 0;
    if (photo.queuePosition === newPos) {
      return photo;
    }
    return {
      ...photo,
      queuePosition: newPos,
      updatedAt: nowIso,
      revision: photo.revision + 1,
    };
  });

  const isConcurrent = payload.baseQueueRevision < serverQueueRevision;
  const hadDifferenceFromClientRequest =
    mergedOrderIds.length !== payload.orderedPhotoIds.length ||
    mergedOrderIds.some((id, idx) => payload.orderedPhotoIds[idx] !== id);

  let conflict: SyncConflict | null = null;
  if (isConcurrent) {
    conflict = {
      id: conflictId,
      operationId,
      photoId: null,
      conflictType: 'QUEUE_REORDER_MERGED',
      resolution: 'MERGED',
      message: hadDifferenceFromClientRequest
        ? 'Очередь была одновременно изменена на другом устройстве. Порядок фотографий безопасно объединён без потери элементов.'
        : 'Очередь синхронизирована с учётом параллельных изменений на другом устройстве.',
      clientValue: { orderedPhotoIds: payload.orderedPhotoIds },
      serverValue: {
        previousServerOrderIds: currentPendingIds,
        mergedOrderIds,
      },
      createdAt: nowIso,
      resolved: true,
    };
  }

  return {
    updatedPhotos,
    nextQueueRevision: serverQueueRevision + 1,
    conflict,
  };
}

export function resolveUpdateSettings(params: {
  operationId: string;
  serverSettings: UserSettings;
  payload: UpdateSettingsPayload;
  nowIso: string;
  conflictId: string;
}): ConflictResolutionResult<UserSettings> {
  const { operationId, serverSettings, payload, nowIso, conflictId } = params;

  const isConcurrent = payload.baseQueueRevision < serverSettings.queueRevision;
  const serverIsNewer = serverSettings.updatedAt > payload.updatedAt;

  if (isConcurrent && serverIsNewer) {
    return {
      applied: false,
      updatedState: serverSettings,
      conflict: {
        id: conflictId,
        operationId,
        photoId: null,
        conflictType: 'SETTINGS_CONFLICT',
        resolution: 'SERVER_WON',
        message:
          'Настройки расписания были обновлены позднее на другом устройстве. Сохранены более свежие настройки сервера.',
        clientValue: {
          reminderTime: payload.reminderTime,
          timeZone: payload.timeZone,
        },
        serverValue: {
          reminderTime: serverSettings.reminderTime,
          timeZone: serverSettings.timeZone,
        },
        createdAt: nowIso,
        resolved: true,
      },
    };
  }

  const updated: UserSettings = {
    ...serverSettings,
    reminderTime: payload.reminderTime,
    timeZone: payload.timeZone,
    queueRevision: serverSettings.queueRevision + 1,
    updatedAt: nowIso,
  };

  return {
    applied: true,
    updatedState: updated,
    conflict: null,
  };
}
