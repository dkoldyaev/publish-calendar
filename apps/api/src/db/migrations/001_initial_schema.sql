CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  reminder_time TEXT NOT NULL CHECK (reminder_time ~ '^([01][0-9]|2[0-3]):([0-5][0-9])$'),
  time_zone TEXT NOT NULL,
  postponed_until_date TEXT,
  active_postponed_remind_at TIMESTAMPTZ,
  active_postponed_photo_id UUID,
  queue_revision INTEGER NOT NULL CHECK (queue_revision >= 1),
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS photographs (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'published', 'deleted')),
  queue_position INTEGER CHECK (
    (status = 'pending' AND queue_position IS NOT NULL AND queue_position >= 0) OR
    (status <> 'pending' AND queue_position IS NULL)
  ),
  upload_state TEXT NOT NULL CHECK (upload_state IN ('local_only', 'upload_pending', 'uploading', 'uploaded', 'upload_failed')),
  s3_key TEXT,
  checksum_sha256 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  published_at TIMESTAMPTZ,
  scheduled_date_at_publication TEXT,
  deleted_at TIMESTAMPTZ,
  revision INTEGER NOT NULL CHECK (revision >= 1)
);

CREATE INDEX IF NOT EXISTS idx_photographs_user_status_pos
  ON photographs (user_id, status, queue_position);

CREATE INDEX IF NOT EXISTS idx_photographs_user_published_at
  ON photographs (user_id, published_at)
  WHERE status = 'published';

CREATE TABLE IF NOT EXISTS publication_history (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  photo_id UUID NOT NULL REFERENCES photographs(id) ON DELETE CASCADE,
  scheduled_date TEXT,
  published_at TIMESTAMPTZ NOT NULL,
  published_local_date TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  idempotency_key UUID NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (user_id, photo_id)
);

CREATE TABLE IF NOT EXISTS postponement_history (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  photo_id UUID NOT NULL REFERENCES photographs(id) ON DELETE CASCADE,
  duration TEXT NOT NULL CHECK (duration IN ('15m', '1h', '3h', '6h', 'tomorrow')),
  previous_remind_at TIMESTAMPTZ,
  next_remind_at TIMESTAMPTZ,
  postponed_until_date TEXT,
  requested_at TIMESTAMPTZ NOT NULL,
  idempotency_key UUID NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS upload_records (
  photo_id UUID PRIMARY KEY REFERENCES photographs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  s3_bucket TEXT NOT NULL,
  s3_key TEXT NOT NULL,
  upload_state TEXT NOT NULL CHECK (upload_state IN ('local_only', 'upload_pending', 'uploading', 'uploaded', 'upload_failed')),
  etag TEXT,
  size_bytes INTEGER NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh_key TEXT NOT NULL,
  auth_key TEXT NOT NULL,
  expiration_time BIGINT,
  user_agent TEXT,
  active BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_active
  ON push_subscriptions (user_id, active);

CREATE TABLE IF NOT EXISTS notification_schedules (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  photo_id UUID NOT NULL REFERENCES photographs(id) ON DELETE CASCADE,
  scheduled_for TIMESTAMPTZ NOT NULL,
  occurrence_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'invalidated', 'failed')),
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  sent_at TIMESTAMPTZ,
  invalidated_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notification_schedules_due
  ON notification_schedules (status, scheduled_for);

CREATE TABLE IF NOT EXISTS sync_operations (
  idempotency_key UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_type TEXT NOT NULL,
  request_payload JSONB NOT NULL,
  response_result JSONB NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_conflicts (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_id UUID NOT NULL,
  photo_id UUID,
  conflict_type TEXT NOT NULL,
  resolution TEXT NOT NULL,
  message TEXT NOT NULL,
  client_value JSONB NOT NULL,
  server_value JSONB NOT NULL,
  resolved BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_conflicts_user_resolved
  ON sync_conflicts (user_id, resolved, created_at DESC);
