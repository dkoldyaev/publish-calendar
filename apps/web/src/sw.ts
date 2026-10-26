/// <reference lib="webworker" />

declare const self: ServiceWorkerGlobalScope;

const CACHE_NAME = 'publish-calendar-shell-v1';
const APP_SHELL_URLS = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const clone = response.clone();
          void caches
            .open(CACHE_NAME)
            .then((cache) => cache.put('/index.html', clone));
          return response;
        })
        .catch(async () => {
          const cached = await caches.match('/index.html');
          if (cached) {
            return cached;
          }
          return new Response('Офлайн-режим: оболочка приложения недоступна.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
        })
    );
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const networkFetch = fetch(request)
          .then((response) => {
            if (response.ok) {
              const clone = response.clone();
              void caches
                .open(CACHE_NAME)
                .then((cache) => cache.put(request, clone));
            }
            return response;
          })
          .catch(() => cached);

        return cached ?? networkFetch.then((res) => res ?? new Response('', { status: 404 }));
      })
    );
  }
});

interface IncomingPushData {
  title?: string;
  body?: string;
  photoId?: string | null;
  url?: string;
  occurrenceKey?: string;
  actions?: Array<{ action: string; title: string }>;
}

self.addEventListener('push', (event) => {
  let payload: IncomingPushData = {
    title: 'Пора опубликовать фото дня',
    body: 'Откройте приложение, чтобы скачать фото и подтвердить публикацию.',
    photoId: null,
    url: '/',
    occurrenceKey: 'default-reminder',
    actions: [
      { action: 'postpone:15m', title: '+15 мин' },
      { action: 'postpone:1h', title: '+1 час' },
      { action: 'postpone:3h', title: '+3 часа' },
      { action: 'postpone:6h', title: '+6 часов' },
      { action: 'postpone:tomorrow', title: 'На завтра' },
    ],
  };

  if (event.data) {
    try {
      payload = {
        ...payload,
        ...(event.data.json() as IncomingPushData),
      };
    } catch {
      payload.body = event.data.text();
    }
  }

  const options: NotificationOptions & {
    actions?: Array<{ action: string; title: string }>;
  } = {
    body: payload.body,
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: payload.occurrenceKey ?? 'publish-reminder',
    data: {
      url: payload.url ?? '/',
      photoId: payload.photoId ?? null,
    },
    actions: payload.actions ?? [],
  };

  event.waitUntil(
    self.registration.showNotification(
      payload.title ?? 'Календарь публикаций',
      options
    )
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = (event.notification.data ?? {}) as {
    url?: string;
    photoId?: string | null;
  };
  const photoId = data.photoId ?? null;
  const action = event.action;

  let targetUrl = data.url ?? (photoId ? `/photo/${photoId}?from=notification` : '/');
  let postponeDuration: string | null = null;

  if (action && action.startsWith('postpone:')) {
    postponeDuration = action.slice('postpone:'.length);
    if (photoId) {
      targetUrl = `/photo/${photoId}?from=notification&postponeAction=${encodeURIComponent(postponeDuration)}`;
    }
  }

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(async (clientList) => {
        for (const client of clientList) {
          if ('focus' in client) {
            await client.focus();
            client.postMessage({
              type: 'SW_NOTIFICATION_CLICK',
              url: targetUrl,
              photoId,
              postponeDuration,
            });
            return;
          }
        }
        if (typeof self.clients.openWindow === 'function') {
          await self.clients.openWindow(targetUrl);
        }
      })
  );
});

export {};
