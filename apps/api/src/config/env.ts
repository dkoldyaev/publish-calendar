import {
  ConfigurationError,
  isValidIanaTimeZone,
  isValidReminderTime,
  requireBooleanEnv,
  requireNonEmptyEnvString,
  requirePositiveIntEnv,
  requirePositiveNumberEnv,
  requireUrlEnv,
} from '@publish-calendar/shared';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ApiConfig {
  apiHost: string;
  apiPort: number;
  publicWebOrigin: string;
  publicApiOrigin: string;
  corsAllowedOrigins: string[];
  logLevel: LogLevel;

  authSecret: string;
  authDefaultUserId: string;
  authDefaultAccessCode: string;
  authTokenTtlSeconds: number;
  rateLimitMaxRequests: number;
  rateLimitWindowMs: number;

  databaseUrl: string;
  databasePoolMax: number;
  databaseConnectTimeoutMs: number;

  s3Endpoint: string;
  s3Region: string;
  s3Bucket: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
  s3ForcePathStyle: boolean;
  s3PresignedUrlTtlSeconds: number;
  s3OperationTimeoutMs: number;

  maxUploadFileBytes: number;
  maxBatchFiles: number;
  maxBatchTotalBytes: number;
  maxZipExpansionRatio: number;
  maxZipExtractedBytes: number;
  maxZipEntries: number;

  vapidPublicKey: string;
  vapidPrivateKey: string;
  vapidSubject: string;
  notificationPollIntervalMs: number;
  notificationMaxRetries: number;
  defaultTimezone: string;
  defaultReminderTime: string;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BUCKET_REGEX = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const BASE64URL_REGEX = /^[A-Za-z0-9_-]+$/;

export function loadApiConfig(
  env: Record<string, string | undefined>
): ApiConfig {
  const apiHost = requireNonEmptyEnvString(env, 'API_HOST');
  const apiPort = requirePositiveIntEnv(env, 'API_PORT', { min: 1, max: 65535 });
  const publicWebOrigin = requireUrlEnv(env, 'PUBLIC_WEB_ORIGIN', [
    'http:',
    'https:',
  ]);
  const publicApiOrigin = requireUrlEnv(env, 'PUBLIC_API_ORIGIN', [
    'http:',
    'https:',
  ]);

  const corsRaw = requireNonEmptyEnvString(env, 'CORS_ALLOWED_ORIGINS');
  const corsAllowedOrigins = corsRaw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (corsAllowedOrigins.length === 0) {
    throw new ConfigurationError(
      'CORS_ALLOWED_ORIGINS',
      'must contain at least one valid origin URL.'
    );
  }
  for (const origin of corsAllowedOrigins) {
    try {
      const u = new URL(origin);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new Error('bad protocol');
      }
    } catch {
      throw new ConfigurationError(
        'CORS_ALLOWED_ORIGINS',
        `contains invalid origin URL "${origin}".`
      );
    }
  }

  const logLevelRaw = requireNonEmptyEnvString(env, 'LOG_LEVEL');
  if (
    logLevelRaw !== 'debug' &&
    logLevelRaw !== 'info' &&
    logLevelRaw !== 'warn' &&
    logLevelRaw !== 'error'
  ) {
    throw new ConfigurationError(
      'LOG_LEVEL',
      `must be one of debug, info, warn, error (got "${logLevelRaw}").`
    );
  }

  const authSecret = requireNonEmptyEnvString(env, 'AUTH_SECRET');
  if (authSecret.length < 32) {
    throw new ConfigurationError(
      'AUTH_SECRET',
      'must be at least 32 characters long.'
    );
  }

  const authDefaultUserId = requireNonEmptyEnvString(
    env,
    'AUTH_DEFAULT_USER_ID'
  );
  if (!UUID_REGEX.test(authDefaultUserId)) {
    throw new ConfigurationError(
      'AUTH_DEFAULT_USER_ID',
      `must be a valid UUID (got "${authDefaultUserId}").`
    );
  }

  const authDefaultAccessCode = requireNonEmptyEnvString(
    env,
    'AUTH_DEFAULT_ACCESS_CODE'
  );
  if (authDefaultAccessCode.length < 8) {
    throw new ConfigurationError(
      'AUTH_DEFAULT_ACCESS_CODE',
      'must be at least 8 characters long.'
    );
  }

  const authTokenTtlSeconds = requirePositiveIntEnv(
    env,
    'AUTH_TOKEN_TTL_SECONDS',
    { min: 60 }
  );
  const rateLimitMaxRequests = requirePositiveIntEnv(
    env,
    'RATE_LIMIT_MAX_REQUESTS',
    { min: 1 }
  );
  const rateLimitWindowMs = requirePositiveIntEnv(env, 'RATE_LIMIT_WINDOW_MS', {
    min: 100,
  });

  const databaseUrl = requireNonEmptyEnvString(env, 'DATABASE_URL');
  try {
    const dbParsed = new URL(databaseUrl);
    if (
      dbParsed.protocol !== 'postgresql:' &&
      dbParsed.protocol !== 'postgres:' &&
      dbParsed.protocol !== 'pglite:'
    ) {
      throw new Error('invalid protocol');
    }
  } catch {
    throw new ConfigurationError(
      'DATABASE_URL',
      `must be a valid PostgreSQL connection string (got "${databaseUrl}").`
    );
  }

  const databasePoolMax = requirePositiveIntEnv(env, 'DATABASE_POOL_MAX', {
    min: 1,
    max: 100,
  });
  const databaseConnectTimeoutMs = requirePositiveIntEnv(
    env,
    'DATABASE_CONNECT_TIMEOUT_MS',
    { min: 100 }
  );

  const s3Endpoint = requireUrlEnv(env, 'S3_ENDPOINT', ['http:', 'https:']);
  const s3Region = requireNonEmptyEnvString(env, 'S3_REGION');
  const s3Bucket = requireNonEmptyEnvString(env, 'S3_BUCKET');
  if (!BUCKET_REGEX.test(s3Bucket)) {
    throw new ConfigurationError(
      'S3_BUCKET',
      `must be a valid S3 bucket name (got "${s3Bucket}").`
    );
  }

  const s3AccessKeyId = requireNonEmptyEnvString(env, 'S3_ACCESS_KEY_ID');
  const s3SecretAccessKey = requireNonEmptyEnvString(
    env,
    'S3_SECRET_ACCESS_KEY'
  );
  const s3ForcePathStyle = requireBooleanEnv(env, 'S3_FORCE_PATH_STYLE');
  const s3PresignedUrlTtlSeconds = requirePositiveIntEnv(
    env,
    'S3_PRESIGNED_URL_TTL_SECONDS',
    { min: 60, max: 86400 }
  );
  const s3OperationTimeoutMs = requirePositiveIntEnv(
    env,
    'S3_OPERATION_TIMEOUT_MS',
    { min: 500 }
  );

  const maxUploadFileBytes = requirePositiveIntEnv(
    env,
    'MAX_UPLOAD_FILE_BYTES',
    { min: 1024 }
  );
  const maxBatchFiles = requirePositiveIntEnv(env, 'MAX_BATCH_FILES', {
    min: 1,
    max: 5000,
  });
  const maxBatchTotalBytes = requirePositiveIntEnv(
    env,
    'MAX_BATCH_TOTAL_BYTES',
    { min: maxUploadFileBytes }
  );
  const maxZipExpansionRatio = requirePositiveNumberEnv(
    env,
    'MAX_ZIP_EXPANSION_RATIO'
  );
  const maxZipExtractedBytes = requirePositiveIntEnv(
    env,
    'MAX_ZIP_EXTRACTED_BYTES',
    { min: 1024 }
  );
  const maxZipEntries = requirePositiveIntEnv(env, 'MAX_ZIP_ENTRIES', {
    min: 1,
  });

  const vapidPublicKey = requireNonEmptyEnvString(env, 'VAPID_PUBLIC_KEY');
  if (!BASE64URL_REGEX.test(vapidPublicKey) || vapidPublicKey.length < 40) {
    throw new ConfigurationError(
      'VAPID_PUBLIC_KEY',
      'must be a valid URL-safe Base64 VAPID public key.'
    );
  }

  const vapidPrivateKey = requireNonEmptyEnvString(env, 'VAPID_PRIVATE_KEY');
  if (!BASE64URL_REGEX.test(vapidPrivateKey) || vapidPrivateKey.length < 20) {
    throw new ConfigurationError(
      'VAPID_PRIVATE_KEY',
      'must be a valid URL-safe Base64 VAPID private key.'
    );
  }

  const vapidSubject = requireUrlEnv(env, 'VAPID_SUBJECT', [
    'mailto:',
    'https:',
  ]);

  const notificationPollIntervalMs = requirePositiveIntEnv(
    env,
    'NOTIFICATION_POLL_INTERVAL_MS',
    { min: 100 }
  );
  const notificationMaxRetries = requirePositiveIntEnv(
    env,
    'NOTIFICATION_MAX_RETRIES',
    { min: 1, max: 20 }
  );

  const defaultTimezone = requireNonEmptyEnvString(env, 'DEFAULT_TIMEZONE');
  if (!isValidIanaTimeZone(defaultTimezone)) {
    throw new ConfigurationError(
      'DEFAULT_TIMEZONE',
      `must be a valid IANA time zone (got "${defaultTimezone}").`
    );
  }

  const defaultReminderTime = requireNonEmptyEnvString(
    env,
    'DEFAULT_REMINDER_TIME'
  );
  if (!isValidReminderTime(defaultReminderTime)) {
    throw new ConfigurationError(
      'DEFAULT_REMINDER_TIME',
      `must be in 24-hour HH:MM format (got "${defaultReminderTime}").`
    );
  }

  return {
    apiHost,
    apiPort,
    publicWebOrigin,
    publicApiOrigin,
    corsAllowedOrigins,
    logLevel: logLevelRaw,
    authSecret,
    authDefaultUserId,
    authDefaultAccessCode,
    authTokenTtlSeconds,
    rateLimitMaxRequests,
    rateLimitWindowMs,
    databaseUrl,
    databasePoolMax,
    databaseConnectTimeoutMs,
    s3Endpoint,
    s3Region,
    s3Bucket,
    s3AccessKeyId,
    s3SecretAccessKey,
    s3ForcePathStyle,
    s3PresignedUrlTtlSeconds,
    s3OperationTimeoutMs,
    maxUploadFileBytes,
    maxBatchFiles,
    maxBatchTotalBytes,
    maxZipExpansionRatio,
    maxZipExtractedBytes,
    maxZipEntries,
    vapidPublicKey,
    vapidPrivateKey,
    vapidSubject,
    notificationPollIntervalMs,
    notificationMaxRetries,
    defaultTimezone,
    defaultReminderTime,
  };
}
