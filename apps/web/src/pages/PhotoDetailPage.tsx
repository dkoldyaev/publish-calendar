import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  CheckCircle2,
  Clock,
  Copy,
  Download,
  Save,
  Trash2,
} from 'lucide-react';
import {
  PostponementDurationSchema,
  type PostponementDuration,
} from '@publish-calendar/shared';
import { useApp } from '../context/AppContext.js';
import { PhotoPreview } from '../components/PhotoPreview.js';
import {
  copyTextToClipboard,
  downloadOriginalPhoto,
} from '../services/browserServices.js';

const POSTPONEMENT_OPTIONS: Array<{
  duration: PostponementDuration;
  label: string;
}> = [
  { duration: '15m', label: '+15 мин' },
  { duration: '1h', label: '+1 час' },
  { duration: '3h', label: '+3 часа' },
  { duration: '6h', label: '+6 часов' },
  { duration: 'tomorrow', label: 'На завтра' },
];

export function PhotoDetailPage() {
  const { photoId } = useParams<{ photoId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const {
    state,
    config,
    isOnline,
    markPublished,
    deletePhoto,
    updateDescription,
    postponeReminder,
  } = useApp();

  const photo = state?.photos.find((p) => p.id === photoId) ?? null;

  const [descriptionDraft, setDescriptionDraft] = useState<string>('');
  const [feedback, setFeedback] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<boolean>(false);

  useEffect(() => {
    if (photo) {
      setDescriptionDraft(photo.description);
    }
  }, [photo?.id, photo?.description]);

  // Handle postponement action triggered via notification deep-link query param
  useEffect(() => {
    const postponeAction = searchParams.get('postponeAction');
    if (photo && postponeAction) {
      const parsed = PostponementDurationSchema.safeParse(postponeAction);
      if (parsed.success) {
        void postponeReminder(photo.id, parsed.data).then(() => {
          setFeedback(
            parsed.data === 'tomorrow'
              ? 'Публикация перенесена на завтра.'
              : 'Напоминание отложено.'
          );
          searchParams.delete('postponeAction');
          setSearchParams(searchParams, { replace: true });
        });
      }
    }
  }, [photo, postponeReminder, searchParams, setSearchParams]);

  if (!state) {
    return <div className="card">Загрузка карточки фотографии...</div>;
  }

  if (!photo) {
    return (
      <div className="card">
        <h1 className="card-title">Фотография не найдена</h1>
        <Link to="/calendar" className="btn btn-secondary">
          <ArrowLeft size={16} />
          Вернуться в календарь
        </Link>
      </div>
    );
  }

  const projectedDate = state.schedule.projectedByPhotoId[photo.id] ?? null;
  const scheduledDateDisplay =
    photo.status === 'published'
      ? (photo.scheduledDateAtPublication ?? '—')
      : (projectedDate ?? '—');

  const hasPendingLocalSync = state.pendingOperations.some((op) => {
    if (op.type === 'CREATE_PHOTO') {
      return (op.payload as { photo: { id: string } }).photo.id === photo.id;
    }
    if ('photoId' in op.payload) {
      return op.payload.photoId === photo.id;
    }
    return false;
  });

  const handleSaveDescription = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    await updateDescription(photo.id, descriptionDraft);
    setFeedback(
      isOnline
        ? 'Описание сохранено и синхронизировано.'
        : 'Описание сохранено локально (будет синхронизировано при появлении сети).'
    );
  };

  const handleDownload = async () => {
    try {
      await downloadOriginalPhoto(photo, config);
      setFeedback(`Оригинальный файл «${photo.fileName}» скачан.`);
    } catch (err) {
      setFeedback(
        err instanceof Error ? err.message : 'Ошибка скачивания файла.'
      );
    }
  };

  const handleCopy = async () => {
    await copyTextToClipboard(descriptionDraft);
    setFeedback('Описание скопировано в буфер обмена.');
  };

  const handleMarkPublished = async () => {
    await markPublished(photo.id);
    setFeedback(
      isOnline
        ? 'Фотография отмечена как опубликованная!'
        : 'Отмечено опубликованным офлайн (операция поставлена в очередь синхронизации).'
    );
  };

  const handlePostpone = async (duration: PostponementDuration) => {
    await postponeReminder(photo.id, duration);
    setFeedback(
      duration === 'tomorrow'
        ? 'Публикация перенесена на завтра.'
        : 'Напоминание отложено.'
    );
  };

  const handleDeleteConfirmed = async () => {
    await deletePhoto(photo.id);
    void navigate('/calendar');
  };

  return (
    <div>
      <div style={{ marginBottom: '12px' }}>
        <Link to="/calendar" className="btn btn-secondary btn-sm">
          <ArrowLeft size={16} />
          К календарю
        </Link>
      </div>

      {feedback && (
        <div
          className="alert alert-success"
          role="status"
          data-testid="detail-feedback"
        >
          {feedback}
        </div>
      )}

      {(!isOnline || hasPendingLocalSync || photo.uploadState !== 'uploaded') && (
        <div
          className="alert alert-warning"
          data-testid="detail-sync-pending-notice"
        >
          Ожидается синхронизация с сервером (Статус файла: {photo.uploadState}).
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
            {photo.fileName}
          </h1>

          {photo.status === 'pending' && (
            <span className="badge badge-pending" data-testid="detail-status-badge">
              Ожидает публикации
            </span>
          )}
          {photo.status === 'published' && (
            <span className="badge badge-online" data-testid="detail-status-badge">
              Опубликовано
            </span>
          )}
          {photo.status === 'deleted' && (
            <span className="badge badge-conflict" data-testid="detail-status-badge">
              Удалено
            </span>
          )}
        </div>

        <PhotoPreview photo={photo} className="photo-hero" />

        <div
          style={{
            marginTop: '14px',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: '10px',
            padding: '12px',
            background: 'var(--surface-alt)',
            borderRadius: '10px',
          }}
        >
          <div>
            <div className="queue-item-meta">Плановая дата публикации:</div>
            <strong data-testid="detail-scheduled-date">
              {scheduledDateDisplay}
            </strong>
          </div>

          {photo.status === 'published' && photo.publishedAt && (
            <div>
              <div className="queue-item-meta">
                Фактическое время подтверждения:
              </div>
              <strong data-testid="detail-actual-published-at">
                {new Date(photo.publishedAt).toLocaleString('ru-RU', {
                  timeZone: state.settings.timeZone,
                })}
              </strong>
            </div>
          )}

          <div>
            <div className="queue-item-meta">Статус хранения файла:</div>
            <strong>{photo.uploadState}</strong>
          </div>
        </div>

        <form
          onSubmit={(e) => void handleSaveDescription(e)}
          style={{ marginTop: '16px' }}
        >
          <div className="field-group">
            <label htmlFor="detail-description-input" className="field-label">
              Описание фотографии
            </label>
            <textarea
              id="detail-description-input"
              className="textarea"
              value={descriptionDraft}
              onChange={(e) => setDescriptionDraft(e.target.value)}
              disabled={photo.status === 'deleted'}
              data-testid="detail-description-input"
            />
          </div>

          <div className="action-grid">
            {photo.status !== 'deleted' && (
              <button
                type="submit"
                className="btn btn-secondary"
                data-testid="detail-save-description-btn"
              >
                <Save size={17} />
                Сохранить описание
              </button>
            )}

            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void handleDownload()}
              data-testid="detail-download-btn"
            >
              <Download size={17} />
              Скачать оригинал
            </button>

            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void handleCopy()}
              data-testid="detail-copy-btn"
            >
              <Copy size={17} />
              Скопировать описание
            </button>

            {photo.status === 'pending' && (
              <button
                type="button"
                className="btn btn-success"
                onClick={() => void handleMarkPublished()}
                data-testid="detail-mark-published-btn"
              >
                <CheckCircle2 size={17} />
                Подтвердить публикацию
              </button>
            )}

            {photo.status === 'pending' && (
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => setConfirmingDelete(true)}
                data-testid="detail-delete-btn"
              >
                <Trash2 size={17} />
                Удалить
              </button>
            )}
          </div>
        </form>

        {confirmingDelete && (
          <div
            className="alert alert-danger"
            role="dialog"
            aria-label="Подтверждение удаления"
            style={{ marginTop: '14px' }}
            data-testid="detail-confirm-delete-box"
          >
            <p style={{ margin: '0 0 10px', fontWeight: 600 }}>
              Удалить фотографию «{photo.fileName}» из очереди публикаций?
            </p>
            <div className="action-grid" style={{ marginTop: 0 }}>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={() => void handleDeleteConfirmed()}
                data-testid="detail-confirm-delete-yes"
              >
                Подтвердить удаление
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setConfirmingDelete(false)}
              >
                Отмена
              </button>
            </div>
          </div>
        )}

        {photo.status === 'pending' && (
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
              Варианты отсрочки напоминания или публикации
            </div>
            <div className="postpone-row">
              {POSTPONEMENT_OPTIONS.map((opt) => (
                <button
                  key={opt.duration}
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => void handlePostpone(opt.duration)}
                  data-testid={`detail-postpone-${opt.duration}`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
