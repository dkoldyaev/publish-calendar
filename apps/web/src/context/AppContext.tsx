import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type {
  PhotoRecord,
  PostponementDuration,
  RawUploadCandidate,
  ValidationIssue,
} from '@publish-calendar/shared';
import type { WebConfig } from '../config/env.js';
import {
  deletePhotoLocally,
  importBatchLocally,
  loadFullClientState,
  markPhotoPublishedLocally,
  postponeReminderLocally,
  reorderQueueLocally,
  resolveConflictWithServer,
  synchronizeWithServer,
  updatePhotoDescriptionLocally,
  updateSettingsLocally,
  type FullClientState,
  type UploadProgressState,
} from '../sync/syncEngine.js';
import {
  registerAppServiceWorker,
  requestPersistentBrowserStorage,
} from '../services/browserServices.js';

export interface AppContextValue {
  config: WebConfig;
  state: FullClientState | null;
  loading: boolean;
  syncing: boolean;
  isOnline: boolean;
  refreshState: () => Promise<void>;
  triggerSync: () => Promise<void>;
  importBatch: (
    candidates: readonly RawUploadCandidate[],
    description: string,
    onProgress?: (progress: UploadProgressState) => void
  ) => Promise<{ importedPhotos: PhotoRecord[]; issues: ValidationIssue[] }>;
  markPublished: (photoId: string) => Promise<void>;
  deletePhoto: (photoId: string) => Promise<void>;
  updateDescription: (photoId: string, description: string) => Promise<void>;
  reorderQueue: (orderedPhotoIds: string[]) => Promise<void>;
  postponeReminder: (
    photoId: string,
    duration: PostponementDuration
  ) => Promise<void>;
  updateSettings: (reminderTime: string, timeZone: string) => Promise<void>;
  resolveConflict: (
    conflictId: string,
    choice: 'KEEP_SERVER' | 'APPLY_CLIENT'
  ) => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({
  config,
  children,
}: {
  config: WebConfig;
  children: React.ReactNode;
}) {
  const [state, setState] = useState<FullClientState | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [syncing, setSyncing] = useState<boolean>(false);
  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  const refreshState = useCallback(async () => {
    const next = await loadFullClientState(config);
    setState(next);
  }, [config]);

  const triggerSync = useCallback(async () => {
    setSyncing(true);
    try {
      const next = await synchronizeWithServer({ config });
      setState(next);
    } finally {
      setSyncing(false);
    }
  }, [config]);

  useEffect(() => {
    const lifecycle = { mounted: true };
    void (async () => {
      await requestPersistentBrowserStorage();
      await registerAppServiceWorker();
      const initial = await loadFullClientState(config);
      if (lifecycle.mounted) {
        setState(initial);
        setLoading(false);
      }
      if (typeof navigator === 'undefined' || navigator.onLine) {
        setSyncing(true);
        const synced = await synchronizeWithServer({ config });
        if (lifecycle.mounted) {
          setState(synced);
          setSyncing(false);
        }
      }
    })();
    return () => {
      lifecycle.mounted = false;
    };
  }, [config]);

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      void triggerSync();
    };
    const handleOffline = () => {
      setIsOnline(false);
      void refreshState();
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    const interval = window.setInterval(() => {
      if (navigator.onLine) {
        void triggerSync();
      } else {
        void refreshState();
      }
    }, config.syncIntervalMs);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.clearInterval(interval);
    };
  }, [config.syncIntervalMs, refreshState, triggerSync]);

  const importBatch = useCallback(
    async (
      candidates: readonly RawUploadCandidate[],
      description: string,
      onProgress?: (progress: UploadProgressState) => void
    ) => {
      const res = await importBatchLocally({
        candidates,
        description,
        config,
        onProgress,
      });
      await refreshState();
      if (typeof navigator === 'undefined' || navigator.onLine) {
        onProgress?.({
          phase: 'syncing_remote',
          totalFiles: res.importedPhotos.length,
          processedFiles: res.importedPhotos.length,
          importedPhotos: res.importedPhotos,
          issues: res.issues,
        });
        await triggerSync();
      }
      return res;
    },
    [config, refreshState, triggerSync]
  );

  const markPublished = useCallback(
    async (photoId: string) => {
      const next = await markPhotoPublishedLocally({ photoId, config });
      setState(next);
      if (typeof navigator === 'undefined' || navigator.onLine) {
        void triggerSync();
      }
    },
    [config, triggerSync]
  );

  const deletePhoto = useCallback(
    async (photoId: string) => {
      const next = await deletePhotoLocally({ photoId, config });
      setState(next);
      if (typeof navigator === 'undefined' || navigator.onLine) {
        void triggerSync();
      }
    },
    [config, triggerSync]
  );

  const updateDescription = useCallback(
    async (photoId: string, description: string) => {
      const next = await updatePhotoDescriptionLocally({
        photoId,
        description,
        config,
      });
      setState(next);
      if (typeof navigator === 'undefined' || navigator.onLine) {
        void triggerSync();
      }
    },
    [config, triggerSync]
  );

  const reorderQueue = useCallback(
    async (orderedPhotoIds: string[]) => {
      const next = await reorderQueueLocally({ orderedPhotoIds, config });
      setState(next);
      if (typeof navigator === 'undefined' || navigator.onLine) {
        void triggerSync();
      }
    },
    [config, triggerSync]
  );

  const postponeReminder = useCallback(
    async (photoId: string, duration: PostponementDuration) => {
      const next = await postponeReminderLocally({
        photoId,
        duration,
        config,
      });
      setState(next);
      if (typeof navigator === 'undefined' || navigator.onLine) {
        void triggerSync();
      }
    },
    [config, triggerSync]
  );

  const updateSettings = useCallback(
    async (reminderTime: string, timeZone: string) => {
      const next = await updateSettingsLocally({
        reminderTime,
        timeZone,
        config,
      });
      setState(next);
      if (typeof navigator === 'undefined' || navigator.onLine) {
        void triggerSync();
      }
    },
    [config, triggerSync]
  );

  const resolveConflict = useCallback(
    async (conflictId: string, choice: 'KEEP_SERVER' | 'APPLY_CLIENT') => {
      const next = await resolveConflictWithServer({
        conflictId,
        choice,
        config,
      });
      setState(next);
    },
    [config]
  );

  const value = useMemo<AppContextValue>(
    () => ({
      config,
      state,
      loading,
      syncing,
      isOnline,
      refreshState,
      triggerSync,
      importBatch,
      markPublished,
      deletePhoto,
      updateDescription,
      reorderQueue,
      postponeReminder,
      updateSettings,
      resolveConflict,
    }),
    [
      config,
      state,
      loading,
      syncing,
      isOnline,
      refreshState,
      triggerSync,
      importBatch,
      markPublished,
      deletePhoto,
      updateDescription,
      reorderQueue,
      postponeReminder,
      updateSettings,
      resolveConflict,
    ]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error('useApp must be used inside AppProvider');
  }
  return ctx;
}
