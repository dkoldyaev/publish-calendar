import type { PhotoRecord } from '@publish-calendar/shared';
import type { WebConfig } from '../config/env.js';
import { getLocalPhotoBlob, putLocalPhotoBlob } from '../db/localDb.js';
import { ensureAuthenticatedToken } from '../sync/syncEngine.js';

export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export async function requestPersistentBrowserStorage(): Promise<boolean> {
  if (
    typeof navigator !== 'undefined' &&
    'storage' in navigator &&
    typeof navigator.storage.persist === 'function'
  ) {
    try {
      return await navigator.storage.persist();
    } catch {
      return false;
    }
  }
  return false;
}

export async function registerAppServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return null;
  }
  try {
    return await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch {
    return null;
  }
}

export interface BrowserNotificationCapabilities {
  supported: boolean;
  permission: NotificationPermission | 'unsupported';
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  isSubscribed: boolean;
  subscriptionEndpoint: string | null;
}

export async function inspectNotificationCapabilities(): Promise<BrowserNotificationCapabilities> {
  const hasNotification = typeof window !== 'undefined' && 'Notification' in window;
  const hasServiceWorker =
    typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
  const hasPushManager = typeof window !== 'undefined' && 'PushManager' in window;

  if (!hasNotification || !hasServiceWorker || !hasPushManager) {
    return {
      supported: false,
      permission: hasNotification ? Notification.permission : 'unsupported',
      hasServiceWorker,
      hasPushManager,
      isSubscribed: false,
      subscriptionEndpoint: null,
    };
  }

  let isSubscribed = false;
  let subscriptionEndpoint: string | null = null;

  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg && 'pushManager' in reg) {
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        isSubscribed = true;
        subscriptionEndpoint = sub.endpoint;
      }
    }
  } catch {
    // ignore
  }

  return {
    supported: true,
    permission: Notification.permission,
    hasServiceWorker,
    hasPushManager,
    isSubscribed,
    subscriptionEndpoint,
  };
}

export async function enablePushNotifications(
  config: WebConfig
): Promise<BrowserNotificationCapabilities> {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    throw new Error('Браузер не поддерживает Web Notifications API.');
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(
      'Разрешение на показ уведомлений отклонено в настройках браузера.'
    );
  }

  const reg =
    (await navigator.serviceWorker.getRegistration()) ??
    (await registerAppServiceWorker());
  if (!reg) {
    throw new Error(
      'Service Worker или PushManager недоступны в текущем окружении.'
    );
  }

  const appServerKey = urlBase64ToUint8Array(config.vapidPublicKey);
  const keyBuffer = new ArrayBuffer(appServerKey.byteLength);
  new Uint8Array(keyBuffer).set(appServerKey);

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: keyBuffer,
  });

  const subJson = sub.toJSON();
  const token = await ensureAuthenticatedToken(config);

  const res = await fetch(`${config.apiOrigin}/api/v1/notifications/subscriptions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      endpoint: sub.endpoint,
      expirationTime: sub.expirationTime,
      keys: {
        p256dh: subJson.keys?.['p256dh'] ?? '',
        auth: subJson.keys?.['auth'] ?? '',
      },
      userAgent: navigator.userAgent,
    }),
  });

  if (!res.ok) {
    throw new Error(
      `Не удалось сохранить подписку на сервере (HTTP ${res.status}).`
    );
  }

  return await inspectNotificationCapabilities();
}

export async function disablePushNotifications(
  config: WebConfig
): Promise<BrowserNotificationCapabilities> {
  let endpoint: string | undefined;
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        endpoint = sub.endpoint;
        await sub.unsubscribe();
      }
    } catch {
      // ignore local unsubscribe failure
    }
  }

  try {
    const token = await ensureAuthenticatedToken(config);
    await fetch(`${config.apiOrigin}/api/v1/notifications/subscriptions`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ endpoint }),
    });
  } catch {
    // ignore if offline
  }

  return await inspectNotificationCapabilities();
}

export async function triggerServerTestNotification(
  config: WebConfig
): Promise<{ deliveredCount: number }> {
  const token = await ensureAuthenticatedToken(config);
  const res = await fetch(`${config.apiOrigin}/api/v1/notifications/test`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    throw new Error(`Ошибка отправки тестового уведомления (HTTP ${res.status})`);
  }
  return (await res.json()) as { deliveredCount: number };
}

/**
 * Resolves a Blob URL for displaying or downloading a photograph.
 * Checks IndexedDB first; if not cached locally, fetches from the backend API and caches locally.
 */
export async function resolvePhotoBinaryBytes(
  photo: PhotoRecord,
  config: WebConfig
): Promise<Uint8Array | null> {
  const localBlob = await getLocalPhotoBlob(photo.id);
  if (localBlob) {
    return localBlob.bytes;
  }

  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return null;
  }

  try {
    const token = await ensureAuthenticatedToken(config);
    const res = await fetch(
      `${config.apiOrigin}/api/v1/photos/${photo.id}/binary`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );
    if (!res.ok) {
      return null;
    }
    const arrayBuffer = await res.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    await putLocalPhotoBlob({
      photoId: photo.id,
      bytes,
      mimeType: photo.mimeType,
      fileName: photo.fileName,
      sizeBytes: bytes.byteLength,
      cachedAt: new Date().toISOString(),
    });
    return bytes;
  } catch {
    return null;
  }
}

export async function downloadOriginalPhoto(
  photo: PhotoRecord,
  config: WebConfig
): Promise<void> {
  const bytes = await resolvePhotoBinaryBytes(photo, config);
  if (!bytes) {
    throw new Error(
      'Бинарный файл фотографии недоступен офлайн (локальная копия была очищена).'
    );
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy.buffer], { type: photo.mimeType });
  const objectUrl = URL.createObjectURL(blob);

  try {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = photo.fileName;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 5000);
  }
}

export async function copyTextToClipboard(text: string): Promise<void> {
  if (
    typeof navigator !== 'undefined' &&
    'clipboard' in navigator &&
    typeof navigator.clipboard.writeText === 'function'
  ) {
    await navigator.clipboard.writeText(text);
  }
}
