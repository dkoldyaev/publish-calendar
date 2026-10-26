import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  ChevronsUp,
  ExternalLink,
  GripVertical,
  Trash2,
} from 'lucide-react';
import {
  buildMonthDaysProjection,
  sortPendingQueue,
  type CalendarDayProjection,
} from '@publish-calendar/shared';
import { useApp } from '../context/AppContext.js';
import { PhotoPreview } from '../components/PhotoPreview.js';

const MONTH_NAMES_RU = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
];

const WEEKDAYS_RU = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

export function CalendarPage() {
  const { state, loading, deletePhoto, reorderQueue } = useApp();

  const todayParts = useMemo(() => {
    const todayStr = state?.schedule.todayLocalDate ?? '2026-03-01';
    const [y, m] = todayStr.split('-').map(Number);
    return {
      year: y ?? 2026,
      month: m ?? 3,
      todayStr,
    };
  }, [state?.schedule.todayLocalDate]);

  const [viewYear, setViewYear] = useState<number>(() => todayParts.year);
  const [viewMonth, setViewMonth] = useState<number>(() => todayParts.month);
  const [selectedDate, setSelectedDate] = useState<string>(
    () => todayParts.todayStr
  );
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [draggedPhotoId, setDraggedPhotoId] = useState<string | null>(null);

  if (loading || !state) {
    return <div className="card">Загрузка календаря...</div>;
  }

  const { schedule, photos } = state;
  const monthDays = buildMonthDaysProjection(viewYear, viewMonth, schedule);
  const pendingQueue = sortPendingQueue(photos);

  const firstDayUtc = new Date(Date.UTC(viewYear, viewMonth - 1, 1));
  const leadingEmptyCount = (firstDayUtc.getUTCDay() + 6) % 7;

  const selectedProjection: CalendarDayProjection | null =
    monthDays.find((d) => d.date === selectedDate) ?? null;

  const goPrevMonth = () => {
    if (viewMonth === 1) {
      setViewYear((y) => y - 1);
      setViewMonth(12);
    } else {
      setViewMonth((m) => m - 1);
    }
  };

  const goNextMonth = () => {
    if (viewMonth === 12) {
      setViewYear((y) => y + 1);
      setViewMonth(1);
    } else {
      setViewMonth((m) => m + 1);
    }
  };

  const goToday = () => {
    const [y, m] = schedule.todayLocalDate.split('-').map(Number);
    if (y && m) {
      setViewYear(y);
      setViewMonth(m);
    }
    setSelectedDate(schedule.todayLocalDate);
  };

  const handleMoveInQueue = async (index: number, targetIndex: number) => {
    if (
      targetIndex < 0 ||
      targetIndex >= pendingQueue.length ||
      index === targetIndex
    ) {
      return;
    }
    const ids = pendingQueue.map((p) => p.id);
    const [moved] = ids.splice(index, 1);
    if (!moved) {
      return;
    }
    ids.splice(targetIndex, 0, moved);
    await reorderQueue(ids);
  };

  const handleDropOnItem = async (targetPhotoId: string) => {
    if (!draggedPhotoId || draggedPhotoId === targetPhotoId) {
      setDraggedPhotoId(null);
      return;
    }
    const fromIdx = pendingQueue.findIndex((p) => p.id === draggedPhotoId);
    const toIdx = pendingQueue.findIndex((p) => p.id === targetPhotoId);
    setDraggedPhotoId(null);
    if (fromIdx !== -1 && toIdx !== -1) {
      await handleMoveInQueue(fromIdx, toIdx);
    }
  };

  const handleConfirmDelete = async (photoId: string) => {
    await deletePhoto(photoId);
    setConfirmDeleteId(null);
  };

  return (
    <div>
      <div className="card">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '8px',
            marginBottom: '14px',
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={goPrevMonth}
              aria-label="Предыдущий месяц"
              data-testid="calendar-prev-month"
            >
              <ChevronLeft size={16} />
            </button>
            <h1 className="card-title" style={{ margin: 0 }} data-testid="calendar-month-title">
              {MONTH_NAMES_RU[viewMonth - 1]} {viewYear}
            </h1>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={goNextMonth}
              aria-label="Следующий месяц"
              data-testid="calendar-next-month"
            >
              <ChevronRight size={16} />
            </button>
          </div>

          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={goToday}
            data-testid="calendar-today-btn"
          >
            Сегодня ({schedule.todayLocalDate})
          </button>
        </div>

        <div
          style={{
            display: 'flex',
            gap: '12px',
            flexWrap: 'wrap',
            fontSize: '0.8rem',
            marginBottom: '12px',
          }}
        >
          <span className="badge badge-pending">Ожидает публикации</span>
          <span className="badge badge-online">Опубликовано</span>
          <span className="badge badge-offline">Пропущено</span>
        </div>

        <div className="calendar-grid" role="grid" aria-label="Календарь публикаций">
          {WEEKDAYS_RU.map((dayName) => (
            <div key={dayName} className="calendar-weekday">
              {dayName}
            </div>
          ))}

          {Array.from({ length: leadingEmptyCount }).map((_, idx) => (
            <div key={`empty-${idx}`} aria-hidden="true" />
          ))}

          {monthDays.map((dayProj) => {
            const dayNum = Number(dayProj.date.slice(8, 10));
            const isSelected = dayProj.date === selectedDate;
            const kindClass =
              dayProj.kind === 'published'
                ? 'calendar-cell-published'
                : dayProj.kind === 'missed'
                  ? 'calendar-cell-missed'
                  : dayProj.isToday
                    ? 'calendar-cell-today'
                    : '';

            return (
              <button
                key={dayProj.date}
                type="button"
                className={`calendar-cell ${kindClass} ${
                  isSelected ? 'calendar-cell-selected' : ''
                }`}
                onClick={() => setSelectedDate(dayProj.date)}
                data-testid={`calendar-day-${dayProj.date}`}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    width: '100%',
                  }}
                >
                  <span className="calendar-day-num">{dayNum}</span>
                  {dayProj.kind === 'published' && (
                    <span
                      style={{
                        fontSize: '0.65rem',
                        color: 'var(--success)',
                        fontWeight: 700,
                      }}
                    >
                      Опубл.
                    </span>
                  )}
                  {dayProj.kind === 'pending' && (
                    <span
                      style={{
                        fontSize: '0.65rem',
                        color: 'var(--primary)',
                        fontWeight: 700,
                      }}
                    >
                      План
                    </span>
                  )}
                  {dayProj.kind === 'missed' && (
                    <span
                      style={{
                        fontSize: '0.65rem',
                        color: 'var(--warning)',
                        fontWeight: 700,
                      }}
                    >
                      Пропуск
                    </span>
                  )}
                </div>

                {dayProj.photo && (
                  <div style={{ marginTop: '4px', width: '100%' }}>
                    <PhotoPreview
                      photo={dayProj.photo}
                      className="calendar-cell-thumb"
                    />
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {selectedProjection && (
        <div className="card" data-testid="selected-day-panel">
          <h2 className="card-title">
            Выбранная дата: {selectedProjection.date}
          </h2>

          {selectedProjection.kind === 'published' && (
            <div>
              <span className="badge badge-online" style={{ marginBottom: '10px' }}>
                Историческая запись: Опубликовано
              </span>
              {selectedProjection.publishedPhotos.map((pubPhoto) => (
                <div
                  key={pubPhoto.id}
                  className="queue-item"
                  style={{ marginTop: '8px' }}
                >
                  <div className="queue-item-main">
                    <PhotoPreview photo={pubPhoto} className="photo-thumb" />
                    <div className="queue-item-info">
                      <div className="queue-item-title">
                        {pubPhoto.fileName}
                      </div>
                      <div className="queue-item-meta">
                        Фактическое время публикации:{' '}
                        {pubPhoto.publishedAt
                          ? new Date(pubPhoto.publishedAt).toLocaleString(
                              'ru-RU',
                              { timeZone: state.settings.timeZone }
                            )
                          : '—'}
                      </div>
                      {pubPhoto.scheduledDateAtPublication && (
                        <div className="queue-item-meta">
                          Плановая дата: {pubPhoto.scheduledDateAtPublication}
                        </div>
                      )}
                    </div>
                  </div>
                  <Link
                    to={`/photo/${pubPhoto.id}`}
                    className="btn btn-secondary btn-sm"
                  >
                    <ExternalLink size={15} />
                    Открыть
                  </Link>
                </div>
              ))}
            </div>
          )}

          {selectedProjection.kind === 'pending' && selectedProjection.photo && (() => {
            const pendingPhoto = selectedProjection.photo;
            return (
              <div data-testid="selected-day-pending-photo">
                <span className="badge badge-pending" style={{ marginBottom: '10px' }}>
                  Запланировано к публикации
                </span>
                <div className="queue-item">
                  <div className="queue-item-main">
                    <PhotoPreview
                      photo={pendingPhoto}
                      className="photo-thumb"
                    />
                    <div className="queue-item-info">
                      <div className="queue-item-title">
                        {pendingPhoto.fileName}
                      </div>
                      <div className="queue-item-meta">
                        {pendingPhoto.description ||
                          'Описание не указано'}
                      </div>
                    </div>
                  </div>
                  <div className="queue-item-actions">
                    <Link
                      to={`/photo/${pendingPhoto.id}`}
                      className="btn btn-primary btn-sm"
                      data-testid="open-selected-photo-btn"
                    >
                      <ExternalLink size={15} />
                      Открыть
                    </Link>
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      onClick={() =>
                        setConfirmDeleteId(pendingPhoto.id)
                      }
                      data-testid="delete-selected-photo-btn"
                    >
                      <Trash2 size={15} />
                      Удалить
                    </button>
                  </div>
                </div>
              </div>
            );
          })()}

          {selectedProjection.kind === 'missed' && (
            <div className="alert alert-warning" data-testid="selected-day-missed">
              В этот день публикация была пропущена. Назначенная фотография
              автоматически перенесена на следующий доступный день в очереди.
            </div>
          )}

          {selectedProjection.kind === 'empty' && (
            <p className="queue-item-meta" data-testid="selected-day-empty">
              На эту дату нет назначенных или опубликованных фотографий.
            </p>
          )}
        </div>
      )}

      {confirmDeleteId && (
        <div
          className="card"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-delete-heading"
          data-testid="confirm-delete-modal"
          style={{ borderColor: 'var(--danger)' }}
        >
          <h2 id="confirm-delete-heading" className="card-title">
            Подтверждение удаления фотографии
          </h2>
          <p>
            Вы действительно хотите удалить эту фотографию из очереди публикаций?
            Последующие фотографии автоматически сдвинутся и закроют образовавшееся окно.
          </p>
          <div className="action-grid">
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => void handleConfirmDelete(confirmDeleteId)}
              data-testid="confirm-delete-yes-btn"
            >
              Да, удалить фотографию
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setConfirmDeleteId(null)}
              data-testid="confirm-delete-cancel-btn"
            >
              Отмена
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <h2 className="card-title">
          Очередь ожидающих фотографий ({pendingQueue.length})
        </h2>
        <p className="queue-item-meta" style={{ marginBottom: '12px' }}>
          Перетащите элементы мышью или используйте кнопки «Вверх», «Вниз» и «В начало»
          для изменения порядка с клавиатуры или сенсорного экрана.
        </p>

        {pendingQueue.length === 0 ? (
          <p className="queue-item-meta">Очередь публикаций пуста.</p>
        ) : (
          <div className="queue-list" data-testid="pending-queue-list">
            {pendingQueue.map((photo, idx) => {
              const projectedDate =
                schedule.projectedByPhotoId[photo.id] ?? '—';
              return (
                <div
                  key={photo.id}
                  className="queue-item"
                  draggable
                  onDragStart={() => setDraggedPhotoId(photo.id)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => void handleDropOnItem(photo.id)}
                  data-testid={`queue-item-${photo.id}`}
                >
                  <div className="queue-item-main">
                    <GripVertical
                      size={18}
                      style={{ color: 'var(--text-muted)', cursor: 'grab' }}
                      aria-hidden="true"
                    />
                    <PhotoPreview photo={photo} className="photo-thumb" />
                    <div className="queue-item-info">
                      <div className="queue-item-title">
                        #{idx + 1} • {photo.fileName}
                      </div>
                      <div className="queue-item-meta">
                        Плановая дата: <strong>{projectedDate}</strong> •{' '}
                        {photo.description || 'Без описания'}
                      </div>
                    </div>
                  </div>

                  <div className="queue-item-actions">
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={idx === 0}
                      onClick={() => void handleMoveInQueue(idx, 0)}
                      title="Переместить в начало очереди"
                      aria-label={`Переместить ${photo.fileName} в начало очереди`}
                      data-testid={`move-first-${photo.id}`}
                    >
                      <ChevronsUp size={15} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={idx === 0}
                      onClick={() => void handleMoveInQueue(idx, idx - 1)}
                      title="Переместить выше"
                      aria-label={`Переместить ${photo.fileName} выше`}
                      data-testid={`move-up-${photo.id}`}
                    >
                      <ArrowUp size={15} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={idx === pendingQueue.length - 1}
                      onClick={() => void handleMoveInQueue(idx, idx + 1)}
                      title="Переместить ниже"
                      aria-label={`Переместить ${photo.fileName} ниже`}
                      data-testid={`move-down-${photo.id}`}
                    >
                      <ArrowDown size={15} />
                    </button>
                    <Link
                      to={`/photo/${photo.id}`}
                      className="btn btn-secondary btn-sm"
                      data-testid={`detail-link-${photo.id}`}
                    >
                      Открыть
                    </Link>
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      onClick={() => setConfirmDeleteId(photo.id)}
                      aria-label={`Удалить ${photo.fileName}`}
                      data-testid={`delete-queue-${photo.id}`}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
