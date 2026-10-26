import React, { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileArchive, Image as ImageIcon, Trash2, Upload } from 'lucide-react';
import {
  isZipFileName,
  SUPPORTED_IMAGE_EXTENSIONS,
  type PhotoRecord,
  type RawUploadCandidate,
  type ValidationIssue,
} from '@publish-calendar/shared';
import { useApp } from '../context/AppContext.js';
import type { UploadProgressState } from '../sync/syncEngine.js';

interface StagedFileItem {
  id: string;
  fileName: string;
  sizeBytes: number;
  isZip: boolean;
  bytes: Uint8Array;
  previewUrl: string | null;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} Б`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} КБ`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} МБ`;
}

export function UploadPage() {
  const { importBatch, state, isOnline } = useApp();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [stagedFiles, setStagedFiles] = useState<StagedFileItem[]>([]);
  const [batchDescription, setBatchDescription] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [progress, setProgress] = useState<UploadProgressState | null>(null);
  const [lastResult, setLastResult] = useState<{
    importedPhotos: PhotoRecord[];
    issues: ValidationIssue[];
  } | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleFilesSelected = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const fileList = event.target.files;
    if (!fileList || fileList.length === 0) {
      return;
    }

    const added: StagedFileItem[] = [];
    for (let i = 0; i < fileList.length; i++) {
      const file = fileList.item(i);
      if (!file) {
        continue;
      }
      const arrayBuf = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuf);
      const isZip = isZipFileName(file.name);
      let previewUrl: string | null = null;
      if (!isZip) {
        try {
          previewUrl = URL.createObjectURL(file);
        } catch {
          previewUrl = null;
        }
      }
      added.push({
        id: `${Date.now()}-${i}-${file.name}`,
        fileName: file.name,
        sizeBytes: bytes.byteLength,
        isZip,
        bytes,
        previewUrl,
      });
    }

    setStagedFiles((prev) => [...prev, ...added]);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleRemoveStaged = (id: string) => {
    setStagedFiles((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target?.previewUrl) {
        URL.revokeObjectURL(target.previewUrl);
      }
      return prev.filter((item) => item.id !== id);
    });
  };

  const handleSubmitBatch = async (event: React.SyntheticEvent) => {
    event.preventDefault();
    if (stagedFiles.length === 0) {
      return;
    }
    setSubmitting(true);
    setErrorMessage(null);
    setLastResult(null);

    try {
      const candidates: RawUploadCandidate[] = stagedFiles.map((f) => ({
        fileName: f.fileName,
        bytes: f.bytes,
      }));
      const res = await importBatch(
        candidates,
        batchDescription,
        (prog) => setProgress(prog)
      );
      setLastResult(res);

      // Clean up staged previews after import
      for (const f of stagedFiles) {
        if (f.previewUrl) {
          URL.revokeObjectURL(f.previewUrl);
        }
      }
      setStagedFiles([]);
      setBatchDescription('');
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Ошибка импорта пакета файлов.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <div className="card">
        <h1 className="card-title">Пакетная загрузка фотографий и ZIP-архивов</h1>
        <p className="queue-item-meta" style={{ marginBottom: '14px' }}>
          Поддерживаемые форматы изображений:{' '}
          {SUPPORTED_IMAGE_EXTENSIONS.join(', ').toUpperCase()}, а также архивы{' '}
          <code>.ZIP</code>. Новые фотографии добавляются в конец очереди в
          детерминированном порядке. Работает в том числе без подключения к сети.
        </p>

        {errorMessage && (
          <div className="alert alert-danger" role="alert">
            {errorMessage}
          </div>
        )}

        <form onSubmit={(e) => void handleSubmitBatch(e)}>
          <div className="field-group">
            <label htmlFor="file-upload-input" className="field-label">
              Выберите фотографии и/или ZIP-архивы
            </label>
            <input
              ref={fileInputRef}
              id="file-upload-input"
              type="file"
              multiple
              accept=".jpg,.jpeg,.png,.webp,.gif,.avif,.zip,image/*,application/zip"
              onChange={(e) => void handleFilesSelected(e)}
              className="input"
              data-testid="upload-file-input"
            />
          </div>

          {stagedFiles.length > 0 && (
            <div style={{ marginBottom: '16px' }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  marginBottom: '8px',
                }}
              >
                <span className="field-label">
                  Выбрано файлов к загрузке: {stagedFiles.length}
                </span>
                <span className="queue-item-meta">
                  Общий объём:{' '}
                  {formatFileSize(
                    stagedFiles.reduce((acc, f) => acc + f.sizeBytes, 0)
                  )}
                </span>
              </div>

              <div className="queue-list" data-testid="staged-files-list">
                {stagedFiles.map((item) => (
                  <div key={item.id} className="queue-item">
                    <div className="queue-item-main">
                      {item.previewUrl ? (
                        <img
                          src={item.previewUrl}
                          alt={item.fileName}
                          className="photo-thumb"
                        />
                      ) : (
                        <div className="photo-placeholder photo-thumb">
                          {item.isZip ? (
                            <FileArchive size={22} />
                          ) : (
                            <ImageIcon size={22} />
                          )}
                        </div>
                      )}
                      <div className="queue-item-info">
                        <div className="queue-item-title">{item.fileName}</div>
                        <div className="queue-item-meta">
                          {item.isZip ? 'ZIP-архив' : 'Изображение'} •{' '}
                          {formatFileSize(item.sizeBytes)}
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => handleRemoveStaged(item.id)}
                      aria-label={`Удалить ${item.fileName}`}
                      data-testid={`remove-staged-${item.fileName}`}
                    >
                      <Trash2 size={15} />
                      Убрать
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="field-group">
            <label htmlFor="batch-description-input" className="field-label">
              Общее описание для всех загружаемых фотографий
            </label>
            <textarea
              id="batch-description-input"
              className="textarea"
              placeholder="Введите текст описания, хэштеги или заметку (можно отредактировать отдельно для каждого фото после импорта)..."
              value={batchDescription}
              onChange={(e) => setBatchDescription(e.target.value)}
              data-testid="batch-description-input"
            />
          </div>

          <button
            type="submit"
            className="btn btn-primary"
            disabled={stagedFiles.length === 0 || submitting}
            data-testid="submit-batch-btn"
          >
            <Upload size={18} />
            {submitting
              ? 'Обработка и импорт...'
              : `Импортировать пакет (${stagedFiles.length})`}
          </button>
        </form>
      </div>

      {progress && (
        <div className="card" data-testid="upload-progress-card">
          <h2 className="card-title">Статус обработки пакета</h2>
          <p className="queue-item-meta">
            Этап:{' '}
            {progress.phase === 'validating'
              ? 'Проверка файлов и распаковка архивов'
              : progress.phase === 'saving_local'
                ? 'Сохранение в локальную базу IndexedDB'
                : progress.phase === 'syncing_remote'
                  ? 'Выгрузка на сервер и в хранилище S3'
                  : 'Импорт завершён'}{' '}
            ({progress.processedFiles} / {progress.totalFiles})
          </p>
          <p className="queue-item-meta">
            Синхронизация:{' '}
            {!isOnline
              ? 'Офлайн — файлы сохранены локально и будут выгружены при появлении сети'
              : (state?.pendingUploadsCount ?? 0) > 0
                ? `Ожидают выгрузки в S3: ${state?.pendingUploadsCount}`
                : 'Все файлы синхронизированы'}
          </p>
        </div>
      )}

      {lastResult && (
        <div className="card" data-testid="upload-result-card">
          <h2 className="card-title">Результаты импорта</h2>
          <div className="alert alert-info">
            Успешно добавлено в очередь публикаций:{' '}
            <strong>{lastResult.importedPhotos.length}</strong> фото.
          </div>

          {lastResult.issues.length > 0 && (
            <div
              className="alert alert-warning"
              data-testid="upload-issues-list"
            >
              <strong>Ошибки проверки отдельных файлов ({lastResult.issues.length}):</strong>
              <ul style={{ margin: '8px 0 0', paddingLeft: '18px' }}>
                {lastResult.issues.map((issue, idx) => (
                  <li key={`${issue.fileName}-${idx}`}>
                    <strong>{issue.fileName}</strong>: {issue.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {lastResult.importedPhotos.length > 0 && (
            <div className="queue-list">
              {lastResult.importedPhotos.map((photo) => (
                <div key={photo.id} className="queue-item">
                  <div className="queue-item-info">
                    <div className="queue-item-title">{photo.fileName}</div>
                    <div className="queue-item-meta">
                      Позиция в очереди: #{(photo.queuePosition ?? 0) + 1} •
                      Статус выгрузки: {photo.uploadState}
                    </div>
                  </div>
                  <Link
                    to={`/photo/${photo.id}`}
                    className="btn btn-secondary btn-sm"
                  >
                    Открыть
                  </Link>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
