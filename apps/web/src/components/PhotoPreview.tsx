import { useEffect, useState } from 'react';
import type { PhotoRecord } from '@publish-calendar/shared';
import { useApp } from '../context/AppContext.js';
import { resolvePhotoBinaryBytes } from '../services/browserServices.js';

export function PhotoPreview({
  photo,
  className = '',
  alt,
}: {
  photo: PhotoRecord;
  className?: string;
  alt?: string;
}) {
  const { config } = useApp();
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const stateRef = { active: true, createdUrl: null as string | null };

    void (async () => {
      const bytes = await resolvePhotoBinaryBytes(photo, config);
      if (!stateRef.active) {
        return;
      }
      if (!bytes) {
        setFailed(true);
        return;
      }
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      const blob = new Blob([copy.buffer], { type: photo.mimeType });
      stateRef.createdUrl = URL.createObjectURL(blob);
      setObjectUrl(stateRef.createdUrl);
      setFailed(false);
    })();

    return () => {
      stateRef.active = false;
      if (stateRef.createdUrl) {
        URL.revokeObjectURL(stateRef.createdUrl);
      }
    };
  }, [photo, config]);

  if (failed) {
    return (
      <div
        className={`photo-placeholder ${className}`}
        aria-label={alt ?? photo.fileName}
      >
        <span>{photo.fileName}</span>
      </div>
    );
  }

  if (!objectUrl) {
    return (
      <div
        className={`photo-skeleton ${className}`}
        aria-label="Загрузка превью..."
      />
    );
  }

  return (
    <img
      src={objectUrl}
      alt={alt ?? photo.fileName}
      className={className}
      loading="lazy"
    />
  );
}
