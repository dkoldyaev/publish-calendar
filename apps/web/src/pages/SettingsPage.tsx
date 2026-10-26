import React, { useCallback, useEffect, useState } from 'react';
import {
  Bell,
  BellOff,
  Database,
  RefreshCw,
  Save,
  Send,
  Trash2,
} from 'lucide-react';
import {
  isValidIanaTimeZone,
  isValidReminderTime,
} from '@publish-calendar/shared';
import { useApp } from '../context/AppContext.js';
import {
  cleanupConfirmedRemotePhotoCache,
  inspectLocalStorageUsage,
  type LocalStorageSummary,
} from '../db/localDb.js';
import {
  disablePushNotifications,
  enablePushNotifications,
  inspectNotificationCapabilities,
  triggerServerTestNotification,
  type BrowserNotificationCapabilities,
} from '../services/browserServices.js';

const COMMON_IANA_TIMEZONES = [
  'Europe/Moscow',
  'Europe/Madrid',
  'Europe/Berlin',
  'Europe/Kyiv',
  'Europe/London',
  'Europe/Paris',
  'Asia/Yekaterinburg',
  'Asia/Novosibirsk',
  'Asia/Almaty',
  'Asia/Tbilisi',
  'America/New_York',
  'UTC',
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} Б`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} КБ`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} МБ`;
}

export function SettingsPage() {
  const {
    state,
    config,
    isOnline,
    syncing,
    updateSettings,
    triggerSync,
    resolveConflict,
  } = useApp();

  const [reminderTime, setReminderTime] = useState<string>('09:30');
  const [timeZone, setTimeZone] = useState<string>('Europe/Moscow');
  const [customTimeZone, setCustomTimeZone] = useState<string>('');
  const [feedback, setFeedback] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [notifState, setNotifState] =
    useState<BrowserNotificationCapabilities | null>(null);
  const [storageSummary, setStorageSummary] =
    useState<LocalStorageSummary | null>(null);

  const refreshSystemDiagnostics = useCallback(async () => {
    const [notif, storage] = await Promise.all([
      inspectNotificationCapabilities(),
      inspectLocalStorageUsage(),
    ]);
    setNotifState(notif);
    setStorageSummary(storage);
  }, []);

  useEffect(() => {
    if (state?.settings) {
      setReminderTime(state.settings.reminderTime);
      setTimeZone(state.settings.timeZone);
      if (!COMMON_IANA_TIMEZONES.includes(state.settings.timeZone)) {
        setCustomTimeZone(state.settings.timeZone);
      }
    }
    void refreshSystemDiagnostics();
  }, [state?.settings, refreshSystemDiagnostics]);

  if (!state) {
    return <div className="card">Загрузка настроек...</div>;
  }

  const handleSaveScheduleSettings = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setFeedback(null);

    const targetTz = customTimeZone.trim() || timeZone;
    if (!isValidReminderTime(reminderTime)) {
      setErrorMsg('Введите корректное время в 24-часовом формате ЧЧ:ММ (например, 09:30).');
      return;
    }
    if (!isValidIanaTimeZone(targetTz)) {
      setErrorMsg(`Некорректный идентификатор часового пояса IANA: «${targetTz}».`);
      return;
    }

    await updateSettings(reminderTime, targetTz);
    setFeedback(
      'Настройки времени напоминания и часового пояса сохранены. График будущих публикаций пересчитан.'
    );
  };

  const handleEnablePush = async () => {
    setErrorMsg(null);
    setFeedback(null);
    try {
      const updated = await enablePushNotifications(config);
      setNotifState(updated);
      setFeedback('Push-уведомления успешно подключены.');
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Не удалось включить Push-уведомления.'
      );
    }
  };

  const handleDisablePush = async () => {
    setErrorMsg(null);
    setFeedback(null);
    const updated = await disablePushNotifications(config);
    setNotifState(updated);
    setFeedback('Push-уведомления отключены.');
  };

  const handleTestPush = async () => {
    setErrorMsg(null);
    setFeedback(null);
    try {
      const res = await triggerServerTestNotification(config);
      setFeedback(
        `Тестовое уведомление отправлено (доставлено активным подпискам: ${res.deliveredCount}).`
      );
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Ошибка отправки тестового уведомления.'
      );
    }
  };

  const handleSafeCacheCleanup = async () => {
    setErrorMsg(null);
    setFeedback(null);
    const res = await cleanupConfirmedRemotePhotoCache();
    await refreshSystemDiagnostics();
    setFeedback(
      `Удалено локальных копий уже выгруженных в S3 фото: ${res.removedCount} (освобождено ${formatBytes(res.freedBytes)}). Защищено несинхронизированных фото: ${res.protectedCount}.`
    );
  };

  const unresolvedConflicts = state.conflicts.filter((c) => !c.resolved);

  return (
    <div>
      {feedback && (
        <div
          className="alert alert-success"
          role="status"
          data-testid="settings-feedback"
        >
          {feedback}
        </div>
      )}
      {errorMsg && (
        <div
          className="alert alert-danger"
          role="alert"
          data-testid="settings-error"
        >
          {errorMsg}
        </div>
      )}

      {/* 7.1 & 7.2 Notification Time & Time Zone */}
      <div className="card">
        <h1 className="card-title">Расписание и часовой пояс</h1>
        <form onSubmit={(e) => void handleSaveScheduleSettings(e)}>
          <div className="field-group">
            <label htmlFor="reminder-time-input" className="field-label">
              Ежедневное время напоминания (24-часовой формат ЧЧ:ММ)
            </label>
            <input
              id="reminder-time-input"
              type="text"
              pattern="^([01]\d|2[0-3]):([0-5]\d)$"
              placeholder="09:30"
              className="input"
              value={reminderTime}
              onChange={(e) => setReminderTime(e.target.value)}
              data-testid="settings-reminder-time-input"
            />
          </div>

          <div className="field-group">
            <label htmlFor="timezone-select" className="field-label">
              Часовой пояс (IANA Time Zone)
            </label>
            <select
              id="timezone-select"
              className="select"
              value={timeZone}
              onChange={(e) => {
                setTimeZone(e.target.value);
                setCustomTimeZone('');
              }}
              data-testid="settings-timezone-select"
            >
              {COMMON_IANA_TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </div>

          <div className="field-group">
            <label htmlFor="custom-timezone-input" className="field-label">
              Или укажите другой часовой пояс IANA вручную
            </label>
            <input
              id="custom-timezone-input"
              type="text"
              placeholder="Например: Europe/Madrid или Asia/Tokyo"
              className="input"
              value={customTimeZone}
              onChange={(e) => setCustomTimeZone(e.target.value)}
              data-testid="settings-custom-timezone-input"
            />
          </div>

          <button
            type="submit"
            className="btn btn-primary"
            data-testid="settings-save-btn"
          >
            <Save size={17} />
            Сохранить расписание
          </button>
        </form>
      </div>

      {/* 7.3 Notification Management */}
      <div className="card">
        <h2 className="card-title">Управление Web Push уведомлениями</h2>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: '10px',
            marginBottom: '12px',
          }}
        >
          <div>
            <div className="queue-item-meta">Разрешение браузера:</div>
            <strong data-testid="notif-permission-status">
              {notifState?.permission === 'granted'
                ? 'Разрешено (granted)'
                : notifState?.permission === 'denied'
                  ? 'Заблокировано (denied)'
                  : notifState?.permission === 'default'
                    ? 'Не запрошено (default)'
                    : 'Не поддерживается'}
            </strong>
          </div>
          <div>
            <div className="queue-item-meta">Статус подписки Push:</div>
            <strong data-testid="notif-subscription-status">
              {notifState?.isSubscribed ? 'Активна' : 'Не подключена'}
            </strong>
          </div>
        </div>

        <div className="action-grid">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void handleEnablePush()}
            disabled={!notifState?.supported}
            data-testid="enable-notifications-btn"
          >
            <Bell size={17} />
            Включить уведомления
          </button>

          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void handleDisablePush()}
            disabled={!notifState?.isSubscribed}
            data-testid="disable-notifications-btn"
          >
            <BellOff size={17} />
            Отключить уведомления
          </button>

          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void handleTestPush()}
            disabled={!notifState?.isSubscribed || !isOnline}
            data-testid="test-notification-btn"
          >
            <Send size={17} />
            Тестовое уведомление
          </button>
        </div>

        <p className="queue-item-meta" style={{ marginTop: '12px' }}>
          Ограничения платформ: для доставки Web Push требуется активное подключение к сети и
          поддержка Push API браузером. На iOS (Safari) Web Push работает только после добавления
          приложения на экран «Домой» (iOS 16.4+). Кнопки быстрых действий в уведомлениях могут не
          отображаться в отдельных браузерах — в этом случае нажатие на само уведомление откроет
          карточку фотографии со всеми кнопками отсрочки внутри приложения.
        </p>
      </div>

      {/* 7.4 Synchronization Status & Conflict Resolution */}
      <div className="card">
        <h2 className="card-title">Статус синхронизации</h2>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: '10px',
            marginBottom: '12px',
          }}
        >
          <div>
            <div className="queue-item-meta">Состояние сети:</div>
            <strong data-testid="sync-network-state">
              {isOnline ? 'Онлайн' : 'Офлайн'}
            </strong>
          </div>
          <div>
            <div className="queue-item-meta">Операций в очереди синхр.:</div>
            <strong data-testid="sync-pending-ops-count">
              {state.pendingOperations.length}
            </strong>
          </div>
          <div>
            <div className="queue-item-meta">Фото ожидают выгрузки в S3:</div>
            <strong data-testid="sync-pending-uploads-count">
              {state.pendingUploadsCount}
            </strong>
          </div>
          <div>
            <div className="queue-item-meta">Последняя синхронизация:</div>
            <strong data-testid="sync-last-timestamp">
              {state.lastSyncedAt
                ? new Date(state.lastSyncedAt).toLocaleString('ru-RU')
                : 'Ещё не выполнялась'}
            </strong>
          </div>
        </div>

        {state.lastSyncError && (
          <div className="alert alert-warning" data-testid="sync-error-box">
            Последняя ошибка синхронизации: {state.lastSyncError}
          </div>
        )}

        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void triggerSync()}
          disabled={syncing || !isOnline}
          data-testid="manual-sync-btn"
        >
          <RefreshCw size={17} className={syncing ? 'spin' : ''} />
          {syncing ? 'Выполняется синхронизация...' : 'Синхронизировать сейчас'}
        </button>

        {unresolvedConflicts.length > 0 && (
          <div style={{ marginTop: '16px' }} data-testid="conflicts-resolution-panel">
            <h3 style={{ fontSize: '1rem', marginBottom: '8px' }}>
              Неразрешённые конфликты синхронизации ({unresolvedConflicts.length})
            </h3>
            <div className="queue-list">
              {unresolvedConflicts.map((conflict) => (
                <div key={conflict.id} className="queue-item">
                  <div className="queue-item-info">
                    <div className="queue-item-title">{conflict.message}</div>
                    <div className="queue-item-meta">
                      Ваш вариант:{' '}
                      <code>{JSON.stringify(conflict.clientValue)}</code> •
                      Вариант сервера:{' '}
                      <code>{JSON.stringify(conflict.serverValue)}</code>
                    </div>
                  </div>
                  <div className="queue-item-actions">
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() =>
                        void resolveConflict(conflict.id, 'APPLY_CLIENT')
                      }
                      data-testid={`resolve-client-${conflict.id}`}
                    >
                      Применить мой вариант
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() =>
                        void resolveConflict(conflict.id, 'KEEP_SERVER')
                      }
                      data-testid={`resolve-server-${conflict.id}`}
                    >
                      Оставить вариант сервера
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 7.5 Storage Information */}
      <div className="card">
        <h2 className="card-title">
          <Database
            size={18}
            style={{ verticalAlign: 'text-bottom', marginRight: '6px' }}
          />
          Локальное хранилище устройства (IndexedDB)
        </h2>

        {storageSummary && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: '10px',
              marginBottom: '12px',
            }}
          >
            <div>
              <div className="queue-item-meta">Кэшировано файлов фото:</div>
              <strong data-testid="storage-total-blobs">
                {storageSummary.totalCachedBlobsCount} (
                {formatBytes(storageSummary.totalCachedBytes)})
              </strong>
            </div>
            <div>
              <div className="queue-item-meta">
                Доступно к безопасной очистке (уже в S3):
              </div>
              <strong data-testid="storage-removable-blobs">
                {storageSummary.safelyRemovableBlobsCount} (
                {formatBytes(storageSummary.safelyRemovableBytes)})
              </strong>
            </div>
            <div>
              <div className="queue-item-meta">
                Защищено от удаления (только локальные):
              </div>
              <strong data-testid="storage-protected-blobs">
                {storageSummary.unsyncedBlobsCount} (
                {formatBytes(storageSummary.unsyncedBytes)})
              </strong>
            </div>
          </div>
        )}

        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => void handleSafeCacheCleanup()}
          data-testid="cleanup-local-cache-btn"
        >
          <Trash2 size={17} />
          Очистить локальный кэш уже выгруженных фото
        </button>

        <p className="queue-item-meta" style={{ marginTop: '10px' }}>
          Безопасная очистка удаляет локальные бинарные копии только тех фотографий, чьё сохранение в
          удалённом хранилище S3 уже подтверждено сервером. Единственные копии ещё не выгруженных
          офлайн-фотографий никогда не удаляются. Обратите внимание, что браузер может принудительно
          очистить хранилище при критической нехватке памяти на устройстве, поэтому офлайн-фотографии
          гарантированно защищены только после завершения синхронизации с сервером.
        </p>
      </div>
    </div>
  );
}
