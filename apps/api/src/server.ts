import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import {
  BatchSyncRequestSchema,
  PostponementDurationSchema,
  PushSubscriptionInputSchema,
  validateImageBinary,
  validateUploadBatch,
  type RawUploadCandidate,
} from '@publish-calendar/shared';
import type { ApiConfig } from './config/env.js';
import { createDatabasePool, type DatabasePool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import {
  AwsS3StorageService,
  type S3StorageService,
} from './storage/s3.js';
import {
  createAuthPreHandler,
  issueSessionToken,
  verifyAccessCodeConstantTime,
  verifySessionToken,
} from './services/authService.js';
import {
  ensureUserExists,
  getFullUserState,
  getPhotoById,
  normalizeAndReconcileUserQueue,
  upsertPhotoRow,
} from './services/repository.js';
import {
  processSyncBatch,
  resolveUserConflictManually,
} from './services/syncService.js';
import {
  NotificationSchedulerWorker,
  type PushSenderFn,
} from './scheduler/notificationWorker.js';

export interface ServerDependencies {
  config: ApiConfig;
  pool?: DatabasePool;
  s3?: S3StorageService;
  pushSender?: PushSenderFn;
  startWorker?: boolean;
}

export interface BuiltServer {
  app: FastifyInstance;
  pool: DatabasePool;
  s3: S3StorageService;
  worker: NotificationSchedulerWorker;
}

export async function buildServer(
  deps: ServerDependencies
): Promise<BuiltServer> {
  const { config } = deps;
  const pool = deps.pool ?? createDatabasePool(config);
  const s3 = deps.s3 ?? new AwsS3StorageService(config);

  await runMigrations(pool, config);

  const worker = new NotificationSchedulerWorker(pool, config, deps.pushSender);
  if (deps.startWorker !== false) {
    worker.start();
  }

  const app = Fastify({
    logger: {
      level: config.logLevel,
    },
    bodyLimit: config.maxBatchTotalBytes + 5 * 1024 * 1024,
  });

  app.addContentTypeParser(
    ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'application/octet-stream'],
    { parseAs: 'buffer' },
    (_req, body, done) => {
      done(null, body);
    }
  );

  await app.register(helmet, {
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });

  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || config.corsAllowedOrigins.includes(origin)) {
        cb(null, true);
        return;
      }
      cb(new Error('Origin not allowed by CORS'), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Access-Code',
      'X-Idempotency-Key',
    ],
  });

  await app.register(rateLimit, {
    max: config.rateLimitMaxRequests,
    timeWindow: config.rateLimitWindowMs,
  });

  await app.register(multipart, {
    limits: {
      fileSize: Math.max(config.maxUploadFileBytes, config.maxZipExtractedBytes),
      files: config.maxBatchFiles + 10,
    },
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.status(400).send({
        error: 'VALIDATION_ERROR',
        message: 'Некорректные входные данные запроса.',
        issues: error.issues,
      });
    }
    const statusCode =
      typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : 500;
    const message =
      error instanceof Error ? error.message : 'Внутренняя ошибка сервера.';
    return reply.status(statusCode).send({
      error: statusCode === 400 ? 'BAD_REQUEST' : 'INTERNAL_ERROR',
      message,
    });
  });

  const authenticate = createAuthPreHandler(config);

  app.get('/api/v1/health', async (_request, reply) => {
    try {
      await pool.query('SELECT 1');
      return await reply.status(200).send({
        status: 'ok',
        database: 'connected',
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      return await reply.status(503).send({
        status: 'degraded',
        database: 'disconnected',
        message: err instanceof Error ? err.message : 'Database check failed',
      });
    }
  });

  app.post('/api/v1/auth/session', async (request, reply) => {
    const schema = z.object({
      accessCode: z.string().min(1),
    });
    const body = schema.parse(request.body);

    if (
      !verifyAccessCodeConstantTime(
        config.authDefaultAccessCode,
        body.accessCode
      )
    ) {
      return await reply.status(401).send({
        error: 'INVALID_CREDENTIALS',
        message: 'Неверный код доступа.',
      });
    }

    const nowIso = new Date().toISOString();
    await ensureUserExists(
      pool,
      config.authDefaultUserId,
      config.defaultTimezone,
      config.defaultReminderTime,
      nowIso
    );

    const session = issueSessionToken(config, config.authDefaultUserId);
    return await reply.status(200).send({
      ...session,
      vapidPublicKey: config.vapidPublicKey,
    });
  });

  app.get(
    '/api/v1/state',
    { preHandler: authenticate },
    async (request, reply) => {
      const nowIso = new Date().toISOString();
      const state = await getFullUserState(pool, request.userId, nowIso);
      return await reply.status(200).send({
        ...state,
        serverTimestamp: nowIso,
      });
    }
  );

  app.post(
    '/api/v1/sync',
    { preHandler: authenticate },
    async (request, reply) => {
      const parsed = BatchSyncRequestSchema.parse(request.body);
      const result = await processSyncBatch({
        pool,
        userId: request.userId,
        operations: parsed.operations,
        s3,
      });
      return await reply.status(200).send(result);
    }
  );

  app.post(
    '/api/v1/conflicts/:conflictId/resolve',
    { preHandler: authenticate },
    async (request, reply) => {
      const paramsSchema = z.object({ conflictId: z.string().uuid() });
      const bodySchema = z.object({
        choice: z.enum(['KEEP_SERVER', 'APPLY_CLIENT']),
      });
      const { conflictId } = paramsSchema.parse(request.params);
      const { choice } = bodySchema.parse(request.body);

      const state = await resolveUserConflictManually({
        pool,
        userId: request.userId,
        conflictId,
        choice,
      });
      return await reply.status(200).send(state);
    }
  );

  app.post(
    '/api/v1/photos/:photoId/upload-url',
    { preHandler: authenticate },
    async (request, reply) => {
      const paramsSchema = z.object({ photoId: z.string().uuid() });
      const { photoId } = paramsSchema.parse(request.params);

      const photo = await getPhotoById(pool, request.userId, photoId);
      if (!photo) {
        return await reply.status(404).send({
          error: 'NOT_FOUND',
          message: 'Фотография не найдена.',
        });
      }

      const s3Key = photo.s3Key ?? s3.buildPhotoKey(request.userId, photo.id);
      const presigned = await s3.createPresignedPutUrl({
        key: s3Key,
        contentType: photo.mimeType,
        contentLength: photo.sizeBytes,
      });

      const nowIso = new Date().toISOString();
      await pool.query(
        `UPDATE photographs
         SET upload_state = CASE WHEN upload_state = 'uploaded' THEN 'uploaded' ELSE 'uploading' END,
             s3_key = $3,
             updated_at = $4
         WHERE id = $1 AND user_id = $2`,
        [photo.id, request.userId, s3Key, nowIso]
      );

      await pool.query(
        `UPDATE upload_records
         SET upload_state = CASE WHEN upload_state = 'uploaded' THEN 'uploaded' ELSE 'uploading' END,
             attempts = attempts + 1,
             updated_at = $3
         WHERE photo_id = $1 AND user_id = $2`,
        [photo.id, request.userId, nowIso]
      );

      return await reply.status(200).send({
        photoId: photo.id,
        s3Key,
        uploadUrl: presigned.uploadUrl,
        expiresInSeconds: presigned.expiresInSeconds,
      });
    }
  );

  app.put(
    '/api/v1/photos/:photoId/binary',
    { preHandler: authenticate },
    async (request, reply) => {
      const paramsSchema = z.object({ photoId: z.string().uuid() });
      const { photoId } = paramsSchema.parse(request.params);

      const photo = await getPhotoById(pool, request.userId, photoId);
      if (!photo) {
        return await reply.status(404).send({
          error: 'NOT_FOUND',
          message: 'Фотография не найдена.',
        });
      }

      const rawBody = request.body;
      let bytes: Uint8Array;
      if (Buffer.isBuffer(rawBody)) {
        bytes = new Uint8Array(rawBody);
      } else if (rawBody instanceof Uint8Array) {
        bytes = rawBody;
      } else {
        return await reply.status(400).send({
          error: 'INVALID_BODY',
          message: 'Ожидались бинарные данные изображения.',
        });
      }

      if (bytes.byteLength > config.maxUploadFileBytes) {
        return await reply.status(413).send({
          error: 'FILE_TOO_LARGE',
          message: `Размер файла превышает лимит ${config.maxUploadFileBytes} байт.`,
        });
      }

      const validation = validateImageBinary(photo.fileName, bytes);
      if (!validation.ok) {
        return await reply.status(400).send({
          error: 'INVALID_IMAGE',
          message: validation.reason,
        });
      }

      const sha256Hex = crypto
        .createHash('sha256')
        .update(bytes)
        .digest('hex');

      const s3Key = photo.s3Key ?? s3.buildPhotoKey(request.userId, photo.id);
      const nowIso = new Date().toISOString();

      try {
        const { etag } = await s3.putObject({
          key: s3Key,
          body: bytes,
          contentType: photo.mimeType,
          sha256Hex,
        });

        await pool.withTransaction(async (tx) => {
          await tx.query(
            `UPDATE photographs
             SET upload_state = 'uploaded',
                 s3_key = $3,
                 size_bytes = $4,
                 checksum_sha256 = $5,
                 updated_at = $6
             WHERE id = $1 AND user_id = $2`,
            [
              photo.id,
              request.userId,
              s3Key,
              bytes.byteLength,
              sha256Hex,
              nowIso,
            ]
          );

          await tx.query(
            `INSERT INTO upload_records (
               photo_id, user_id, s3_bucket, s3_key, upload_state,
               etag, size_bytes, attempts, last_error, updated_at
             )
             VALUES ($1, $2, $3, $4, 'uploaded', $5, $6, 1, NULL, $7)
             ON CONFLICT (photo_id) DO UPDATE SET
               upload_state = 'uploaded',
               s3_key = EXCLUDED.s3_key,
               etag = EXCLUDED.etag,
               size_bytes = EXCLUDED.size_bytes,
               attempts = upload_records.attempts + 1,
               last_error = NULL,
               updated_at = EXCLUDED.updated_at`,
            [
              photo.id,
              request.userId,
              s3.bucket,
              s3Key,
              etag,
              bytes.byteLength,
              nowIso,
            ]
          );
        });

        const updatedPhoto = await getPhotoById(pool, request.userId, photo.id);
        return await reply.status(200).send({
          photo: updatedPhoto,
          uploadState: 'uploaded',
          s3Key,
          etag,
        });
      } catch (err) {
        const errMsg =
          err instanceof Error ? err.message : 'S3 upload failed';
        await pool.query(
          `UPDATE photographs
           SET upload_state = 'upload_failed', updated_at = $3
           WHERE id = $1 AND user_id = $2`,
          [photo.id, request.userId, nowIso]
        );
        await pool.query(
          `UPDATE upload_records
           SET upload_state = 'upload_failed',
               attempts = attempts + 1,
               last_error = $3,
               updated_at = $4
           WHERE photo_id = $1 AND user_id = $2`,
          [photo.id, request.userId, errMsg, nowIso]
        );
        throw err;
      }
    }
  );

  app.post(
    '/api/v1/photos/:photoId/confirm-upload',
    { preHandler: authenticate },
    async (request, reply) => {
      const paramsSchema = z.object({ photoId: z.string().uuid() });
      const { photoId } = paramsSchema.parse(request.params);

      const photo = await getPhotoById(pool, request.userId, photoId);
      if (!photo) {
        return await reply.status(404).send({
          error: 'NOT_FOUND',
          message: 'Фотография не найдена.',
        });
      }

      const s3Key = photo.s3Key ?? s3.buildPhotoKey(request.userId, photo.id);
      const head = await s3.headObject(s3Key);
      const nowIso = new Date().toISOString();

      if (!head.exists) {
        await pool.query(
          `UPDATE photographs
           SET upload_state = 'upload_failed', updated_at = $3
           WHERE id = $1 AND user_id = $2`,
          [photo.id, request.userId, nowIso]
        );
        return await reply.status(409).send({
          error: 'OBJECT_NOT_IN_S3',
          message: 'Файл ещё не найден в хранилище S3.',
        });
      }

      await pool.withTransaction(async (tx) => {
        await tx.query(
          `UPDATE photographs
           SET upload_state = 'uploaded', s3_key = $3, updated_at = $4
           WHERE id = $1 AND user_id = $2`,
          [photo.id, request.userId, s3Key, nowIso]
        );
        await tx.query(
          `UPDATE upload_records
           SET upload_state = 'uploaded',
               etag = $3,
               last_error = NULL,
               updated_at = $4
           WHERE photo_id = $1 AND user_id = $2`,
          [photo.id, request.userId, head.etag, nowIso]
        );
      });

      const updatedPhoto = await getPhotoById(pool, request.userId, photo.id);
      return await reply.status(200).send({
        photo: updatedPhoto,
        uploadState: 'uploaded',
      });
    }
  );

  app.get('/api/v1/photos/:photoId/binary', async (request, reply) => {
    const paramsSchema = z.object({ photoId: z.string().uuid() });
    const querySchema = z.object({ token: z.string().optional() });
    const { photoId } = paramsSchema.parse(request.params);
    const { token } = querySchema.parse(request.query);

    let userId: string | null = null;
    const authHeader = request.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const verified = verifySessionToken(
        config,
        authHeader.slice('Bearer '.length).trim()
      );
      if (verified) {
        userId = verified.sub;
      }
    } else if (token) {
      const verified = verifySessionToken(config, token);
      if (verified) {
        userId = verified.sub;
      }
    } else if (
      typeof request.headers['x-access-code'] === 'string' &&
      verifyAccessCodeConstantTime(
        config.authDefaultAccessCode,
        request.headers['x-access-code']
      )
    ) {
      userId = config.authDefaultUserId;
    }

    if (!userId) {
      return await reply.status(401).send({
        error: 'UNAUTHORIZED',
        message: 'Требуется авторизация для загрузки файла.',
      });
    }

    const photo = await getPhotoById(pool, userId, photoId);
    if (!photo || !photo.s3Key || photo.uploadState !== 'uploaded') {
      return await reply.status(404).send({
        error: 'NOT_FOUND',
        message: 'Файл фотографии не найден в удалённом хранилище.',
      });
    }

    const obj = await s3.getObject(photo.s3Key);
    const encodedName = encodeURIComponent(photo.fileName);
    reply.header('Content-Type', photo.mimeType);
    reply.header(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodedName}`
    );
    return await reply.status(200).send(Buffer.from(obj.bytes));
  });

  app.get(
    '/api/v1/photos/:photoId/download-url',
    { preHandler: authenticate },
    async (request, reply) => {
      const paramsSchema = z.object({ photoId: z.string().uuid() });
      const { photoId } = paramsSchema.parse(request.params);

      const photo = await getPhotoById(pool, request.userId, photoId);
      if (!photo || !photo.s3Key || photo.uploadState !== 'uploaded') {
        return await reply.status(404).send({
          error: 'NOT_FOUND',
          message: 'Файл фотографии не найден в удалённом хранилище.',
        });
      }

      const presigned = await s3.createPresignedGetUrl({
        key: photo.s3Key,
        fileName: photo.fileName,
      });
      return await reply.status(200).send({
        ...presigned,
        fileName: photo.fileName,
      });
    }
  );

  app.post(
    '/api/v1/upload/batch',
    { preHandler: authenticate },
    async (request, reply) => {
      const schema = z.object({
        description: z.string().max(10000),
        files: z.array(
          z.object({
            fileName: z.string().min(1),
            base64Data: z.string().min(1),
          })
        ),
      });
      const body = schema.parse(request.body);

      const rawCandidates: RawUploadCandidate[] = body.files.map((f) => ({
        fileName: f.fileName,
        bytes: new Uint8Array(Buffer.from(f.base64Data, 'base64')),
      }));

      const validation = validateUploadBatch(
        rawCandidates,
        {
          maxUploadFileBytes: config.maxUploadFileBytes,
          maxBatchFiles: config.maxBatchFiles,
          maxBatchTotalBytes: config.maxBatchTotalBytes,
          maxZipExpansionRatio: config.maxZipExpansionRatio,
          maxZipExtractedBytes: config.maxZipExtractedBytes,
          maxZipEntries: config.maxZipEntries,
        },
        () => crypto.randomUUID()
      );

      const nowIso = new Date().toISOString();
      const importedIds: string[] = [];

      for (const item of validation.validItems) {
        const sha256Hex = crypto
          .createHash('sha256')
          .update(item.bytes)
          .digest('hex');
        const s3Key = s3.buildPhotoKey(request.userId, item.id);
        await s3.putObject({
          key: s3Key,
          body: item.bytes,
          contentType: item.mimeType,
          sha256Hex,
        });

        await pool.withTransaction(async (tx) => {
          const currentPosRes = await tx.query<{ max_pos: number | null }>(
            `SELECT MAX(queue_position) AS max_pos
             FROM photographs
             WHERE user_id = $1 AND status = 'pending'`,
            [request.userId]
          );
          const nextPos = (currentPosRes.rows[0]?.max_pos ?? -1) + 1;

          await upsertPhotoRow(tx, {
            id: item.id,
            userId: request.userId,
            fileName: item.fileName,
            mimeType: item.mimeType,
            sizeBytes: item.sizeBytes,
            description: body.description,
            status: 'pending',
            queuePosition: nextPos,
            uploadState: 'uploaded',
            s3Key,
            checksumSha256: sha256Hex,
            createdAt: nowIso,
            updatedAt: nowIso,
            publishedAt: null,
            scheduledDateAtPublication: null,
            deletedAt: null,
            revision: 1,
          });

          await tx.query(
            `INSERT INTO upload_records (
               photo_id, user_id, s3_bucket, s3_key, upload_state,
               etag, size_bytes, attempts, last_error, updated_at
             )
             VALUES ($1, $2, $3, $4, 'uploaded', NULL, $5, 1, NULL, $6)
             ON CONFLICT (photo_id) DO NOTHING`,
            [item.id, request.userId, s3.bucket, s3Key, item.sizeBytes, nowIso]
          );
        });

        importedIds.push(item.id);
      }

      const state = await pool.withTransaction(async (tx) => {
        return await normalizeAndReconcileUserQueue(tx, request.userId, nowIso);
      });

      return await reply.status(200).send({
        importedIds,
        issues: validation.issues,
        photos: state.photos,
        settings: state.settings,
        schedule: state.schedule,
      });
    }
  );

  app.get(
    '/api/v1/notifications/status',
    { preHandler: authenticate },
    async (request, reply) => {
      const subsRes = await pool.query<{
        id: string;
        endpoint: string;
        user_agent: string | null;
        created_at: Date | string;
      }>(
        `SELECT id, endpoint, user_agent, created_at
         FROM push_subscriptions
         WHERE user_id = $1 AND active = true
         ORDER BY created_at DESC`,
        [request.userId]
      );
      const state = await getFullUserState(pool, request.userId);
      return await reply.status(200).send({
        activeSubscriptionCount: subsRes.rows.length,
        subscriptions: subsRes.rows.map((r) => ({
          id: r.id,
          endpoint: r.endpoint,
          userAgent: r.user_agent,
        })),
        nextReminderInstant: state.schedule.nextReminderInstant,
        nextPendingPhotoId: state.schedule.nextPendingPhoto?.id ?? null,
        vapidPublicKey: config.vapidPublicKey,
      });
    }
  );

  app.post(
    '/api/v1/notifications/subscriptions',
    { preHandler: authenticate },
    async (request, reply) => {
      const input = PushSubscriptionInputSchema.parse(request.body);
      const nowIso = new Date().toISOString();

      await pool.query(
        `INSERT INTO push_subscriptions (
           id, user_id, endpoint, p256dh_key, auth_key,
           expiration_time, user_agent, active, created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $8)
         ON CONFLICT (endpoint) DO UPDATE SET
           user_id = EXCLUDED.user_id,
           p256dh_key = EXCLUDED.p256dh_key,
           auth_key = EXCLUDED.auth_key,
           expiration_time = EXCLUDED.expiration_time,
           user_agent = EXCLUDED.user_agent,
           active = true,
           updated_at = EXCLUDED.updated_at`,
        [
          crypto.randomUUID(),
          request.userId,
          input.endpoint,
          input.keys.p256dh,
          input.keys.auth,
          input.expirationTime ?? null,
          input.userAgent ?? null,
          nowIso,
        ]
      );

      await getFullUserState(pool, request.userId, nowIso);

      return await reply.status(200).send({
        subscribed: true,
        endpoint: input.endpoint,
      });
    }
  );

  app.delete(
    '/api/v1/notifications/subscriptions',
    { preHandler: authenticate },
    async (request, reply) => {
      const schema = z.object({ endpoint: z.string().url().optional() });
      const body = request.body ? schema.parse(request.body) : {};
      const nowIso = new Date().toISOString();

      if (body.endpoint) {
        await pool.query(
          `UPDATE push_subscriptions
           SET active = false, updated_at = $3
           WHERE user_id = $1 AND endpoint = $2`,
          [request.userId, body.endpoint, nowIso]
        );
      } else {
        await pool.query(
          `UPDATE push_subscriptions
           SET active = false, updated_at = $2
           WHERE user_id = $1`,
          [request.userId, nowIso]
        );
      }

      return await reply.status(200).send({
        subscribed: false,
      });
    }
  );

  app.post(
    '/api/v1/notifications/test',
    { preHandler: authenticate },
    async (request, reply) => {
      const res = await worker.sendTestNotification(request.userId);
      return await reply.status(200).send(res);
    }
  );

  app.post(
    '/api/v1/notifications/postpone',
    { preHandler: authenticate },
    async (request, reply) => {
      const schema = z.object({
        idempotencyKey: z.string().uuid(),
        photoId: z.string().uuid(),
        duration: PostponementDurationSchema,
        requestedAt: z.string().datetime().optional(),
      });
      const body = schema.parse(request.body);
      const nowIso = body.requestedAt ?? new Date().toISOString();
      const currentState = await getFullUserState(pool, request.userId, nowIso);

      const syncRes = await processSyncBatch({
        pool,
        userId: request.userId,
        s3,
        nowIso,
        operations: [
          {
            idempotencyKey: body.idempotencyKey,
            type: 'POSTPONE_REMINDER',
            payload: {
              photoId: body.photoId,
              duration: body.duration,
              requestedAt: nowIso,
              baseQueueRevision: currentState.settings.queueRevision,
            },
          },
        ],
      });

      return await reply.status(200).send(syncRes);
    }
  );

  app.addHook('onClose', async () => {
    worker.stop();
    await pool.close();
  });

  return { app, pool, s3, worker };
}
