import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CheckCircle2,
  Clock,
  Copy,
  Download,
  ExternalLink,
  Upload,
} from 'lucide-react';
import type { PostponementDuration } from '@publish-calendar/shared';
import { useApp } from '../context/AppContext.js';
import { PhotoPreview } from '../components/PhotoPreview.js';
import {
  copyTextToClipboard,
  downloadOriginalPhoto,
} from '../services/browserServices.js';

const POSTPONEMENT_OPTIONS: Array<{
  duration: PostponementDuration;
  label: string;
  hint: string;
}> = [
  { duration: '15m', label: '+15 мин', hint: 'Сдвинет только напоминание' },
  { duration: '1h', label: '+1 час', hint: 'Сдвинет только напоминание' },
  { duration: '3h', label: '+3 часа', hint: 'Сдвинет только напоминание' },
  { duration: '6h', label: '+6 часов', hint: 'Сдвинет только напоминание' },
  {
    duration: 'tomorrow',
    label: 'На завтра',
    hint: 'Перенесёт дату публикации этой и следующих фотографий на 1 день вперёд',
  },
];

export function TodayPage() {
  const {
    state,
    config,
    loading,
    markPublished,
    postponeReminder,
  } = useApp();
  const [feedback, setFeedback] = useState<string | null>(null);

  if (loading || !state) {
    return (
      <div className="card" role="status">
        Загрузка расписания публикаций...
      </div>
    );
  }

  const { schedule, settings } = state;
  const todayStr = schedule.todayLocalDate;
  const publishedToday = schedule.publishedByDate[todayStr] ?? [];
  const nextPending = schedule.nextPendingPhoto;
  const nextScheduledDate = schedule.effectiveNextPublicationDate;
  const isAssignedToday = nextPending && nextScheduledDate === todayStr;

  const handleCopyDescription = async (text: string) => {
    await copyTextToClipboard(text);
    setFeedback('Описание скопировано в буфер обмена.');
    setTimeout(() => setFeedback(null), 3000);
  };

  const handleDownload = async () => {
    const target = isAssignedToday
      ? nextPending
      : (publishedToday[0] ?? nextPending);
    if (!target) {
      return;
    }
    try {
      await downloadOriginalPhoto(target, config);
      setFeedback(`Файл «${target.fileName}» скачан.`);
    } catch (err) {
      setFeedback(
        err instanceof Error ? err.message : 'Ошибка скачивания файла.'
      );
    }
  };

  const handleMarkPublished = async (photoId: string) => {
    await markPublished(photoId);
    setFeedback('Публикация подтверждена! Расписание обновлено.');
  };

  const handlePostpone = async (
    photoId: string,
    duration: PostponementDuration
  ) => {
    await postponeReminder(photoId, duration);
    setFeedback(
      duration === 'tomorrow'
        ? 'Публикация перенесена на завтра. Очередь пересчитана.'
        : 'Напоминание отложено.'
    );
  };

  return (
    <div>
      {feedback && (
        <div className="alert alert-success" role="status">
          {feedback}
        </div>
      )}

      <div className="card">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '8px',
            marginBottom: '12px',
          }}
        >
          <h1 className="card-title" style={{ margin: 0 }}>
            Публикация на сегодня ({todayStr})
          </h1>
          <span className="queue-item-meta">
            Часовой пояс: {settings.timeZone} • Напоминание: {settings.reminderTime}
          </span>
        </div>

        {publishedToday[0] && (
          <div
            className="alert alert-success"
            data-testid="today-published-banner"
          >
            <strong>Опубликовано сегодня:</strong>{' '}
            {publishedToday.map((p) => p.fileName).join(', ')} (подтверждено в{' '}
            {publishedToday[0].publishedAt
              ? new Date(publishedToday[0].publishedAt).toLocaleTimeString('ru-RU')
              : '—'})
          </div>
        )}

        {!nextPending && publishedToday.length === 0 ? (
          <div data-testid="empty-queue-state" style={{ textAlign: 'center', padding: '24px 0' }}>
            <p style={{ fontSize: '1.05rem', fontWeight: 600 }}>
              В очереди нет ожидающих фотографий
            </p>
            <p className="queue-item-meta" style={{ marginBottom: '16px' }}>
              Добавьте фотографии или ZIP-архивы, чтобы сформировать ежедневный график публикаций.
            </p>
            <Link to="/upload" className="btn btn-primary">
              <Upload size={18} />
              Загрузить фотографии
            </Link>
          </div>
        ) : nextPending ? (
          <div data-testid="today-active-card">
            <div style={{ marginBottom: '12px' }}>
              {isAssignedToday ? (
                <span className="badge badge-pending">
                  Назначено на сегодня ({todayStr})
                </span>
              ) : (
                <span className="badge badge-online">
                  Следующая публикация по графику: {nextScheduledDate}
                </span>
              )}
              {schedule.rolledOverFromByPhotoId[nextPending.id] && (
                <span
                  className="badge badge-offline"
                  style={{ marginLeft: '8px' }}
                >
                  Перенесено с пропущенного дня (
                  {schedule.rolledOverFromByPhotoId[nextPending.id]})
                </span>
              )}
            </div>

            <PhotoPreview photo={nextPending} className="photo-hero" />

            <div style={{ marginTop: '14px' }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <strong style={{ fontSize: '1.05rem' }}>
                  {nextPending.fileName}
                </strong>
                <Link
                  to={`/photo/${nextPending.id}`}
                  className="btn btn-secondary btn-sm"
                >
                  <ExternalLink size={15} />
                  Открыть карточку
                </Link>
              </div>

              <div
                style={{
                  marginTop: '10px',
                  padding: '12px',
                  background: 'var(--surface-alt)',
                  borderRadius: '10px',
                  whiteSpace: 'pre-wrap',
                }}
                data-testid="today-photo-description"
              >
                {nextPending.description || 'Описание отсутствует'}
              </div>

              <div className="action-grid">
                <button
                  type="button"
                  className="btn btn-success"
                  onClick={() => void handleMarkPublished(nextPending.id)}
                  data-testid="mark-published-btn"
                >
                  <CheckCircle2 size={18} />
                  Отметить опубликованным
                </button>

                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void handleDownload()}
                  data-testid="download-photo-btn"
                >
                  <Download size={18} />
                  Скачать фотографию
                </button>

                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() =>
                    void handleCopyDescription(nextPending.description)
                  }
                  data-testid="copy-description-btn"
                >
                  <Copy size={18} />
                  Скопировать описание
                </button>
              </div>

              <div
                style={{
                  marginTop: '18px',
                  borderTop: '1px solid var(--border)',
                  paddingTop: '14px',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    fontWeight: 600,
                    fontSize: '0.9rem',
                  }}
                >
                  <Clock size={16} />
                  Отложить публикацию или напоминание
                </div>
                {schedule.nextReminderInstant && (
                  <p className="queue-item-meta" style={{ margin: '4px 0 8px' }}>
                    Следующее напоминание:{' '}
                    {new Date(schedule.nextReminderInstant).toLocaleString(
                      'ru-RU',
                      { timeZone: settings.timeZone }
                    )}
                  </p>
                )}
                <div className="postpone-row">
                  {POSTPONEMENT_OPTIONS.map((opt) => (
                    <button
                      key={opt.duration}
                      type="button"
                      className="btn btn-secondary btn-sm"
                      title={opt.hint}
                      onClick={() =>
                        void handlePostpone(nextPending.id, opt.duration)
                      }
                      data-testid={`postpone-${opt.duration}-btn`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <p className="queue-item-meta" style={{ marginTop: '8px' }}>
                  Короткая отсрочка (+15 мин, +1 ч, +3 ч, +6 ч) переносит только время
                  уведомления. «На завтра» переносит саму публикацию и сдвигает очередь на 1 день.
                </p>
              </div>
            </div>
          </div>
        ) : (
          publishedToday[0] && (
            <div>
              <PhotoPreview photo={publishedToday[0]} className="photo-hero" />
              <div style={{ marginTop: '12px' }}>
                <Link
                  to={`/photo/${publishedToday[0].id}`}
                  className="btn btn-secondary btn-sm"
                >
                  Открыть карточку опубликованного фото
                </Link>
              </div>
            </div>
          )
        )}
      </div>
    </div>
  );
}
