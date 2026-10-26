import {
  ConfigurationError,
  isValidIanaTimeZone,
  isValidReminderTime,
  requireNonEmptyEnvString,
  requirePositiveIntEnv,
  requirePositiveNumberEnv,
  requireUrlEnv,
  type UploadValidationLimits,
} from '@publish-calendar/shared';

export interface WebConfig {
  apiOrigin: string;
  publicOrigin: string;
  vapidPublicKey: string;
  defaultAccessCode: string;
  defaultTimezone: string;
  defaultReminderTime: string;
  uploadLimits: UploadValidationLimits;
  syncIntervalMs: number;
  syncMaxRetries: number;
  syncRetryBaseMs: number;
}

export function loadWebConfig(
  env: Record<string, string | undefined>
): WebConfig {
  const apiOrigin = requireUrlEnv(env, 'VITE_API_ORIGIN', ['http:', 'https:']);
  const publicOrigin = requireUrlEnv(env, 'VITE_PUBLIC_ORIGIN', [
    'http:',
    'https:',
  ]);
  const vapidPublicKey = requireNonEmptyEnvString(
    env,
    'VITE_VAPID_PUBLIC_KEY'
  );
  if (vapidPublicKey.length < 40) {
    throw new ConfigurationError(
      'VITE_VAPID_PUBLIC_KEY',
      'must be a valid URL-safe Base64 VAPID public key.'
    );
  }

  const defaultAccessCode = requireNonEmptyEnvString(
    env,
    'VITE_DEFAULT_ACCESS_CODE'
  );
  if (defaultAccessCode.length < 8) {
    throw new ConfigurationError(
      'VITE_DEFAULT_ACCESS_CODE',
      'must be at least 8 characters long.'
    );
  }

  const defaultTimezone = requireNonEmptyEnvString(
    env,
    'VITE_DEFAULT_TIMEZONE'
  );
  if (!isValidIanaTimeZone(defaultTimezone)) {
    throw new ConfigurationError(
      'VITE_DEFAULT_TIMEZONE',
      `must be a valid IANA time zone (got "${defaultTimezone}").`
    );
  }

  const defaultReminderTime = requireNonEmptyEnvString(
    env,
    'VITE_DEFAULT_REMINDER_TIME'
  );
  if (!isValidReminderTime(defaultReminderTime)) {
    throw new ConfigurationError(
      'VITE_DEFAULT_REMINDER_TIME',
      `must be in 24-hour HH:MM format (got "${defaultReminderTime}").`
    );
  }

  const maxUploadFileBytes = requirePositiveIntEnv(
    env,
    'VITE_MAX_UPLOAD_FILE_BYTES',
    { min: 1024 }
  );
  const maxBatchFiles = requirePositiveIntEnv(env, 'VITE_MAX_BATCH_FILES', {
    min: 1,
    max: 5000,
  });
  const maxBatchTotalBytes = requirePositiveIntEnv(
    env,
    'VITE_MAX_BATCH_TOTAL_BYTES',
    { min: maxUploadFileBytes }
  );
  const maxZipExpansionRatio = requirePositiveNumberEnv(
    env,
    'VITE_MAX_ZIP_EXPANSION_RATIO'
  );
  const maxZipExtractedBytes = requirePositiveIntEnv(
    env,
    'VITE_MAX_ZIP_EXTRACTED_BYTES',
    { min: 1024 }
  );
  const maxZipEntries = requirePositiveIntEnv(env, 'VITE_MAX_ZIP_ENTRIES', {
    min: 1,
  });

  const syncIntervalMs = requirePositiveIntEnv(env, 'VITE_SYNC_INTERVAL_MS', {
    min: 100,
  });
  const syncMaxRetries = requirePositiveIntEnv(env, 'VITE_SYNC_MAX_RETRIES', {
    min: 1,
    max: 50,
  });
  const syncRetryBaseMs = requirePositiveIntEnv(
    env,
    'VITE_SYNC_RETRY_BASE_MS',
    { min: 50 }
  );

  return {
    apiOrigin,
    publicOrigin,
    vapidPublicKey,
    defaultAccessCode,
    defaultTimezone,
    defaultReminderTime,
    uploadLimits: {
      maxUploadFileBytes,
      maxBatchFiles,
      maxBatchTotalBytes,
      maxZipExpansionRatio,
      maxZipExtractedBytes,
      maxZipEntries,
    },
    syncIntervalMs,
    syncMaxRetries,
    syncRetryBaseMs,
  };
}
