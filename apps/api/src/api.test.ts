import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { ConfigurationError } from '@publish-calendar/shared';
import { loadApiConfig } from './config/env.js';
import { buildServer, type BuiltServer } from './server.js';
import { startFromEnv } from './index.js';
import type { PushNotificationPayload } from './scheduler/notificationWorker.js';

function createValidTestEnv(
  overrides: Record<string, string | undefined> = {}
): Record<string, string | undefined> {
  const base: Record<string, string | undefined> = {
    API_HOST: '127.0.0.1',
    API_PORT: '4010',
    PUBLIC_WEB_ORIGIN: 'http://localhost:8080',
    PUBLIC_API_ORIGIN: 'http://localhost:4010',
    CORS_ALLOWED_ORIGINS: 'http://localhost:8080,http://localhost:5173',
    LOG_LEVEL: 'error',
    AUTH_SECRET: 'test-auth-secret-key-with-at-least-32-chars!!',
    AUTH_DEFAULT_USER_ID: '00000000-0000-4000-8000-000000000001',
    AUTH_DEFAULT_ACCESS_CODE: 'super-secret-code-123',
    AUTH_TOKEN_TTL_SECONDS: '3600',
    RATE_LIMIT_MAX_REQUESTS: '1000',
    RATE_LIMIT_WINDOW_MS: '60000',
    DATABASE_URL: 'pglite://memory',
    DATABASE_POOL_MAX: '5',
    DATABASE_CONNECT_TIMEOUT_MS: '5000',
    S3_ENDPOINT: 'http://127.0.0.1:9000',
    S3_REGION: 'us-east-1',
    S3_BUCKET: 'publish-calendar-test',
    S3_ACCESS_KEY_ID: 'test-access-key',
    S3_SECRET_ACCESS_KEY: 'test-secret-key',
    S3_FORCE_PATH_STYLE: 'true',
    S3_PRESIGNED_URL_TTL_SECONDS: '900',
    S3_OPERATION_TIMEOUT_MS: '5000',
    MAX_UPLOAD_FILE_BYTES: '10485760',
    MAX_BATCH_FILES: '50',
    MAX_BATCH_TOTAL_BYTES: '52428800',
    MAX_ZIP_EXPANSION_RATIO: '25',
    MAX_ZIP_EXTRACTED_BYTES: '31457280',
    MAX_ZIP_ENTRIES: '100',
    VAPID_PUBLIC_KEY:
      'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U',
    VAPID_PRIVATE_KEY: 'UUxI4O8-FbRouAevSmBQ6o18hgE4nSG3qwvJTfKc-ls',
    VAPID_SUBJECT: 'mailto:test@example.com',
    NOTIFICATION_POLL_INTERVAL_MS: '60000',
    NOTIFICATION_MAX_RETRIES: '3',
    DEFAULT_TIMEZONE: 'Europe/Moscow',
    DEFAULT_REMINDER_TIME: '09:30',
  };
  return { ...base, ...overrides };
}

function makeValidJpeg(seed = 1): Uint8Array {
  const buf = new Uint8Array(64);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[2] = 0xff;
  buf[3] = 0xe0;
  buf[4] = seed & 0xff;
  buf[62] = 0xff;
  buf[63] = 0xd9;
  return buf;
}

describe('Scenario 10: Backend Configuration Validation (Fail-Fast Policy)', () => {
  it('Fails with exact ConfigurationError when S3_BUCKET or other S3 variables are missing', async () => {
    expect(() =>
      loadApiConfig(createValidTestEnv({ S3_BUCKET: undefined }))
    ).toThrow('ConfigurationError: S3_BUCKET is required.');

    expect(() =>
      loadApiConfig(createValidTestEnv({ S3_ENDPOINT: '' }))
    ).toThrow('ConfigurationError: S3_ENDPOINT is required.');

    expect(() =>
      loadApiConfig(createValidTestEnv({ S3_ACCESS_KEY_ID: undefined }))
    ).toThrow('ConfigurationError: S3_ACCESS_KEY_ID is required.');

    await expect(
      startFromEnv(createValidTestEnv({ S3_BUCKET: undefined }))
    ).rejects.toThrow(ConfigurationError);
  });

  it('Fails when DATABASE_URL or database pool settings are missing or malformed', () => {
    expect(() =>
      loadApiConfig(createValidTestEnv({ DATABASE_URL: undefined }))
    ).toThrow('ConfigurationError: DATABASE_URL is required.');

    expect(() =>
      loadApiConfig(createValidTestEnv({ DATABASE_URL: 'mysql://localhost/db' }))
    ).toThrow(/ConfigurationError: DATABASE_URL/);

    expect(() =>
      loadApiConfig(createValidTestEnv({ DATABASE_POOL_MAX: '0' }))
    ).toThrow(/ConfigurationError: DATABASE_POOL_MAX/);
  });

  it('Fails when Web Push / Notification configuration is missing or invalid', () => {
    expect(() =>
      loadApiConfig(createValidTestEnv({ VAPID_PUBLIC_KEY: undefined }))
    ).toThrow('ConfigurationError: VAPID_PUBLIC_KEY is required.');

    expect(() =>
      loadApiConfig(createValidTestEnv({ VAPID_PRIVATE_KEY: 'short' }))
    ).toThrow(/ConfigurationError: VAPID_PRIVATE_KEY/);

    expect(() =>
      loadApiConfig(createValidTestEnv({ VAPID_SUBJECT: 'invalid-subject' }))
    ).toThrow(/ConfigurationError: VAPID_SUBJECT/);
  });

  it('Fails when security secrets or numeric limits or timezones are invalid', () => {
    expect(() =>
      loadApiConfig(createValidTestEnv({ AUTH_SECRET: 'too-short' }))
    ).toThrow(/ConfigurationError: AUTH_SECRET/);

    expect(() =>
      loadApiConfig(createValidTestEnv({ MAX_UPLOAD_FILE_BYTES: '-100' }))
    ).toThrow(/ConfigurationError: MAX_UPLOAD_FILE_BYTES/);

    expect(() =>
      loadApiConfig(createValidTestEnv({ DEFAULT_TIMEZONE: 'Mars/Phobos' }))
    ).toThrow(/ConfigurationError: DEFAULT_TIMEZONE/);

    expect(() =>
      loadApiConfig(createValidTestEnv({ DEFAULT_REMINDER_TIME: '25:99' }))
    ).toThrow(/ConfigurationError: DEFAULT_REMINDER_TIME/);
  });

  it('Scenario 14: Validates Dockerfiles, base docker-compose.yml, docker-compose.override.yml.example, and .env.example completeness', () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const envExample = fs.readFileSync(
      path.join(repoRoot, '.env.example'),
      'utf-8'
    );
    const gitignore = fs.readFileSync(
      path.join(repoRoot, '.gitignore'),
      'utf-8'
    );
    const baseCompose = fs.readFileSync(
      path.join(repoRoot, 'docker-compose.yml'),
      'utf-8'
    );
    const overrideExampleCompose = fs.readFileSync(
      path.join(repoRoot, 'docker-compose.override.yml.example'),
      'utf-8'
    );
    const apiDockerfile = fs.readFileSync(
      path.join(repoRoot, 'apps/api/Dockerfile'),
      'utf-8'
    );
    const webDockerfile = fs.readFileSync(
      path.join(repoRoot, 'apps/web/Dockerfile'),
      'utf-8'
    );

    // docker-compose.override.yml must be gitignored and absent from repository
    expect(gitignore).toContain('docker-compose.override.yml');
    expect(
      fs.existsSync(path.join(repoRoot, 'docker-compose.override.yml'))
    ).toBe(false);

    // Clean up any obsolete local nginx template directory if present
    const obsoleteDockerDir = path.join(repoRoot, 'docker');
    if (fs.existsSync(obsoleteDockerDir)) {
      fs.rmSync(obsoleteDockerDir, { recursive: true, force: true });
    }

    // Base Compose (for Dokploy + built-in Traefik) must define api and web,
    // exclude postgres, exclude traefik, and have NO ports: sections
    expect(baseCompose).toContain('api:');
    expect(baseCompose).toContain('web:');
    expect(baseCompose).not.toMatch(/^\s{2}postgres:/m);
    expect(baseCompose).not.toMatch(/^\s{2}traefik:/m);
    expect(baseCompose).not.toMatch(/^\s{2}nginx:/m);
    expect(baseCompose).not.toMatch(/^\s+ports:/m);
    expect(baseCompose).toContain('${DATABASE_URL:?DATABASE_URL is required}');
    expect(baseCompose).toContain('${S3_BUCKET:?S3_BUCKET is required}');
    expect(baseCompose).toContain('healthcheck:');

    // Override Example Compose (for local runs) must define traefik, postgres, and ports:
    expect(overrideExampleCompose).toMatch(/^\s{2}traefik:/m);
    expect(overrideExampleCompose).toMatch(/^\s{2}postgres:/m);
    expect(overrideExampleCompose).not.toMatch(/^\s{2}nginx:/m);
    expect(overrideExampleCompose).toMatch(/^\s+ports:/m);
    expect(overrideExampleCompose).toContain(
      'postgres_data:/var/lib/postgresql/data'
    );
    expect(overrideExampleCompose).toContain('pg_isready');
    expect(overrideExampleCompose).toContain(
      '${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}'
    );
    expect(overrideExampleCompose).toContain(
      '${TRAEFIK_PORT:?TRAEFIK_PORT is required}'
    );

    // Dockerfiles must use multi-stage builds and healthchecks (no nginx inside apps/web/Dockerfile)
    expect(apiDockerfile).toContain('FROM node:22-alpine AS builder');
    expect(apiDockerfile).toContain('HEALTHCHECK');
    expect(webDockerfile).toContain('FROM node:22-alpine AS builder');
    expect(webDockerfile).not.toContain('nginx');
    expect(webDockerfile).toContain('HEALTHCHECK');

    // Every ${VAR:?...} referenced in docker-compose.yml and docker-compose.override.yml.example must exist in .env.example
    const varRegex = /\$\{([A-Z0-9_]+):\?/g;
    const referencedVars = new Set<string>();
    for (const content of [baseCompose, overrideExampleCompose]) {
      let match: RegExpExecArray | null;
      while ((match = varRegex.exec(content)) !== null) {
        if (match[1]) {
          referencedVars.add(match[1]);
        }
      }
    }
    expect(referencedVars.size).toBeGreaterThan(30);
    for (const varName of referencedVars) {
      expect(envExample).toMatch(new RegExp(`^${varName}=`, 'm'));
    }
  });
});

describe('Full Backend Integration: PostgreSQL + S3 HTTP Server + Sync + Notifications', () => {
  let s3HttpServer: http.Server;
  let s3EndpointUrl = '';
  const s3Objects = new Map<string, { bytes: Buffer; contentType: string }>();
  let built: BuiltServer;
  let authToken = '';
  const sentNotifications: Array<{
    endpoint: string;
    payload: PushNotificationPayload;
  }> = [];

  beforeAll(async () => {
    s3HttpServer = http.createServer((req, res) => {
      const urlObj = new URL(req.url ?? '/', 'http://127.0.0.1');
      const key = decodeURIComponent(urlObj.pathname.replace(/^\/+/, ''));

      if (req.method === 'PUT') {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          const buf = Buffer.concat(chunks);
          const contentTypeHeader = req.headers['content-type'];
          s3Objects.set(key, {
            bytes: buf,
            contentType:
              typeof contentTypeHeader === 'string'
                ? contentTypeHeader
                : 'application/octet-stream',
          });
          res.setHeader('ETag', `"etag-${buf.length}"`);
          res.statusCode = 200;
          res.end();
        });
        return;
      }

      if (req.method === 'HEAD') {
        const found = s3Objects.get(key);
        if (!found) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader('Content-Length', String(found.bytes.length));
        res.setHeader('Content-Type', found.contentType);
        res.setHeader('ETag', `"etag-${found.bytes.length}"`);
        res.statusCode = 200;
        res.end();
        return;
      }

      if (req.method === 'GET') {
        const found = s3Objects.get(key);
        if (!found) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader('Content-Length', String(found.bytes.length));
        res.setHeader('Content-Type', found.contentType);
        res.setHeader('ETag', `"etag-${found.bytes.length}"`);
        res.statusCode = 200;
        res.end(found.bytes);
        return;
      }

      if (req.method === 'DELETE') {
        s3Objects.delete(key);
        res.statusCode = 204;
        res.end();
        return;
      }

      res.statusCode = 405;
      res.end();
    });

    await new Promise<void>((resolve) => {
      s3HttpServer.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = s3HttpServer.address();
    const port = typeof addr === 'object' && addr ? addr.port : 9000;
    s3EndpointUrl = `http://127.0.0.1:${port}`;

    const config = loadApiConfig(
      createValidTestEnv({
        S3_ENDPOINT: s3EndpointUrl,
      })
    );

    built = await buildServer({
      config,
      startWorker: false,
      pushSender: (sub, payloadJson) => {
        if (sub.endpoint.includes('expired-410')) {
          const err = new Error('Gone') as Error & { statusCode: number };
          err.statusCode = 410;
          return Promise.reject(err);
        }
        sentNotifications.push({
          endpoint: sub.endpoint,
          payload: JSON.parse(payloadJson) as PushNotificationPayload,
        });
        return Promise.resolve({ statusCode: 201 });
      },
    });
  });

  afterAll(async () => {
    await built.app.close();
    await new Promise<void>((resolve) => s3HttpServer.close(() => resolve()));
  });

  it('Authenticates session and checks health endpoint', async () => {
    const healthRes = await built.app.inject({
      method: 'GET',
      url: '/api/v1/health',
    });
    expect(healthRes.statusCode).toBe(200);
    expect(healthRes.json()).toMatchObject({
      status: 'ok',
      database: 'connected',
    });

    const badAuth = await built.app.inject({
      method: 'POST',
      url: '/api/v1/auth/session',
      payload: { accessCode: 'wrong-code' },
    });
    expect(badAuth.statusCode).toBe(401);

    const goodAuth = await built.app.inject({
      method: 'POST',
      url: '/api/v1/auth/session',
      payload: { accessCode: 'super-secret-code-123' },
    });
    expect(goodAuth.statusCode).toBe(200);
    const body = goodAuth.json<{ token: string; userId: string }>();
    expect(body.token).toBeTruthy();
    authToken = body.token;
  });

  it('Scenario 1 (API): Batch upload of 5 photos + 1 ZIP with 5 photos stores all 10 in PostgreSQL and S3', async () => {
    const zipBytes = zipSync({
      'z1.jpg': makeValidJpeg(11),
      'z2.jpg': makeValidJpeg(12),
      'sub/z3.jpg': makeValidJpeg(13),
      'z4.jpg': makeValidJpeg(14),
      'z5.jpg': makeValidJpeg(15),
    });

    const files = [
      {
        fileName: 'p1.jpg',
        base64Data: Buffer.from(makeValidJpeg(1)).toString('base64'),
      },
      {
        fileName: 'p2.jpg',
        base64Data: Buffer.from(makeValidJpeg(2)).toString('base64'),
      },
      {
        fileName: 'p3.jpg',
        base64Data: Buffer.from(makeValidJpeg(3)).toString('base64'),
      },
      {
        fileName: 'archive.zip',
        base64Data: Buffer.from(zipBytes).toString('base64'),
      },
      {
        fileName: 'p4.jpg',
        base64Data: Buffer.from(makeValidJpeg(4)).toString('base64'),
      },
      {
        fileName: 'p5.jpg',
        base64Data: Buffer.from(makeValidJpeg(5)).toString('base64'),
      },
    ];

    const res = await built.app.inject({
      method: 'POST',
      url: '/api/v1/upload/batch',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        description: 'Общее описание партии',
        files,
      },
    });

    expect(res.statusCode).toBe(200);
    const data = res.json<{
      importedIds: string[];
      issues: unknown[];
      photos: Array<{
        id: string;
        fileName: string;
        description: string;
        status: string;
        uploadState: string;
        queuePosition: number;
      }>;
    }>();

    expect(data.issues).toEqual([]);
    expect(data.importedIds).toHaveLength(10);
    expect(data.photos).toHaveLength(10);
    expect(
      data.photos.every((p) => p.description === 'Общее описание партии')
    ).toBe(true);
    expect(data.photos.every((p) => p.uploadState === 'uploaded')).toBe(true);
    expect(data.photos.map((p) => p.queuePosition)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);

    // Verify binary download from S3 works and preserves original content
    const firstPhotoId = data.importedIds[0] ?? '';
    const binRes = await built.app.inject({
      method: 'GET',
      url: `/api/v1/photos/${firstPhotoId}/binary`,
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(binRes.statusCode).toBe(200);
    expect(binRes.rawPayload.length).toBe(64);
    expect(binRes.headers['content-disposition']).toContain('p1.jpg');
  });

  it('Scenario 6 & Scenario 7: Offline import + binary upload + idempotent offline publication confirmation', async () => {
    const offlinePhotoId = '11111111-2222-4333-8444-555555555555';
    const createOpId = 'aaaaaaaa-1111-4222-8333-444444444441';
    const nowIso = '2026-03-10T09:00:00.000Z';

    // 1. Synchronize offline-imported photo metadata
    const syncCreateRes = await built.app.inject({
      method: 'POST',
      url: '/api/v1/sync',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        operations: [
          {
            idempotencyKey: createOpId,
            type: 'CREATE_PHOTO',
            payload: {
              photo: {
                id: offlinePhotoId,
                userId: '00000000-0000-4000-8000-000000000001',
                fileName: 'offline_import.jpg',
                mimeType: 'image/jpeg',
                sizeBytes: 64,
                description: 'Импортировано офлайн',
                status: 'pending',
                queuePosition: 10,
                uploadState: 'upload_pending',
                s3Key: null,
                checksumSha256: '0123456789abcdef',
                createdAt: nowIso,
                updatedAt: nowIso,
                publishedAt: null,
                scheduledDateAtPublication: null,
                deletedAt: null,
                revision: 1,
              },
            },
          },
        ],
      },
    });
    expect(syncCreateRes.statusCode).toBe(200);

    // 2. Upload binary to S3 via authenticated endpoint
    const uploadBinRes = await built.app.inject({
      method: 'PUT',
      url: `/api/v1/photos/${offlinePhotoId}/binary`,
      headers: {
        authorization: `Bearer ${authToken}`,
        'content-type': 'image/jpeg',
      },
      payload: Buffer.from(makeValidJpeg(99)),
    });
    expect(uploadBinRes.statusCode).toBe(200);
    expect(uploadBinRes.json<{ uploadState: string }>().uploadState).toBe(
      'uploaded'
    );

    // 3. Confirm publication with idempotency key and retry the exact same request
    const publishOpId = 'aaaaaaaa-1111-4222-8333-444444444442';
    const pubPayload = {
      operations: [
        {
          idempotencyKey: publishOpId,
          type: 'MARK_PUBLISHED',
          payload: {
            photoId: offlinePhotoId,
            publishedAt: '2026-03-10T10:00:00.000Z',
            scheduledDateAtPublication: '2026-03-10',
            baseRevision: 1,
          },
        },
      ],
    };

    const pubRes1 = await built.app.inject({
      method: 'POST',
      url: '/api/v1/sync',
      headers: { authorization: `Bearer ${authToken}` },
      payload: pubPayload,
    });
    expect(pubRes1.statusCode).toBe(200);
    expect(
      pubRes1.json<{ outcomes: Array<{ applied: boolean; deduplicated: boolean }> }>()
        .outcomes[0]
    ).toMatchObject({
      applied: true,
      deduplicated: false,
    });

    // Retry with same idempotencyKey -> deduplicated
    const pubRes2 = await built.app.inject({
      method: 'POST',
      url: '/api/v1/sync',
      headers: { authorization: `Bearer ${authToken}` },
      payload: pubPayload,
    });
    expect(pubRes2.statusCode).toBe(200);
    expect(
      pubRes2.json<{ outcomes: Array<{ applied: boolean; deduplicated: boolean }> }>()
        .outcomes[0]
    ).toMatchObject({
      applied: true,
      deduplicated: true,
    });
  });

  it('Scenario 15: Notification lifecycle dispatches due reminders, cleans up 410 subscriptions, and invalidates obsolete reminders on publish/delete', async () => {
    // Register one active subscription and one expired (410) subscription
    await built.app.inject({
      method: 'POST',
      url: '/api/v1/notifications/subscriptions',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        endpoint: 'https://push.example.com/sub-valid-1',
        keys: { p256dh: 'key-p256dh', auth: 'key-auth' },
      },
    });
    await built.app.inject({
      method: 'POST',
      url: '/api/v1/notifications/subscriptions',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        endpoint: 'https://push.example.com/expired-410',
        keys: { p256dh: 'key-p256dh', auth: 'key-auth' },
      },
    });

    const stateRes = await built.app.inject({
      method: 'GET',
      url: '/api/v1/state',
      headers: { authorization: `Bearer ${authToken}` },
    });
    const state = stateRes.json<{
      schedule: {
        nextPendingPhoto: { id: string } | null;
        nextReminderInstant: string | null;
      };
    }>();
    const frontPhotoId = state.schedule.nextPendingPhoto?.id;
    expect(frontPhotoId).toBeTruthy();

    // Run worker tick after the scheduled reminder time
    const futureTickIso = '2099-01-01T12:00:00.000Z';
    const tick1 = await built.worker.runTick(futureTickIso);
    expect(tick1.sentCount).toBe(1);
    expect(sentNotifications.length).toBe(1);
    expect(sentNotifications[0]?.payload.photoId).toBe(frontPhotoId);

    // Running the same tick again does NOT send duplicate notification for same occurrence
    const tick2 = await built.worker.runTick(futureTickIso);
    expect(tick2.sentCount).toBe(0);

    // Expired 410 subscription was automatically deactivated
    const statusRes = await built.app.inject({
      method: 'GET',
      url: '/api/v1/notifications/status',
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(
      statusRes.json<{ activeSubscriptionCount: number }>()
        .activeSubscriptionCount
    ).toBe(1);

    // Delete the front photo -> its reminder is invalidated and next photo gets scheduled
    const delRes = await built.app.inject({
      method: 'POST',
      url: '/api/v1/sync',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        operations: [
          {
            idempotencyKey: 'bbbbbbbb-1111-4222-8333-444444444449',
            type: 'DELETE_PHOTO',
            payload: {
              photoId: frontPhotoId,
              deletedAt: '2026-03-11T08:00:00.000Z',
              baseRevision: 1,
            },
          },
        ],
      },
    });
    expect(delRes.statusCode).toBe(200);

    // Verify in DB that no 'pending' notification_schedules exist for the deleted photo
    const dbCheck = await built.pool.query<{ status: string }>(
      `SELECT status FROM notification_schedules WHERE photo_id = $1 AND status = 'pending'`,
      [frontPhotoId]
    );
    expect(dbCheck.rows).toHaveLength(0);
  });
});
