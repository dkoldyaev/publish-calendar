# Implementation Plan & Architecture Log — Offline-First Photo Publishing Scheduler

## 1. Architectural Overview

The system is a production-ready, offline-first Progressive Web Application (PWA) and backend service monorepo written in strict TypeScript (`strict: true`, type-aware ESLint).

### Monorepo Structure
- `packages/shared`: Pure TypeScript domain package shared across frontend and backend.
  - Deterministic publication scheduling algorithm (`scheduler.ts`) with full IANA time zone and DST support.
  - Domain conflict detection and resolution logic (`conflict.ts`).
  - Shared validation schemas (`schemas.ts`) and ZIP/image validation constraints (`zipValidator.ts`).
- `apps/api`: Node.js + Fastify TypeScript backend API and notification scheduler worker.
  - Strict startup configuration validation (`config/env.ts`) — zero fallback values, immediate `ConfigurationError` on missing or invalid env vars before server/worker startup.
  - PostgreSQL relational persistence (`db/`) with transactional migrations, optimistic concurrency revisions, idempotency log (`sync_operations`), and publication/postponement history.
  - S3-compatible binary object storage (`storage/s3.ts`) via `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`.
  - Web Push notification scheduler & dispatcher (`scheduler/notificationWorker.ts`) using `web-push` with VAPID authentication, idempotent execution, postponement handling, and automatic invalidation of obsolete reminders.
- `apps/web`: React 19 + Vite TypeScript Offline-First PWA (Russian UI).
  - Strict frontend configuration validation (`config/env.ts`).
  - Service Worker (`sw.ts`) providing app-shell caching, offline navigation fallback, Web Push display, notification click deep-linking, and notification action buttons (`15m`, `1h`, `3h`, `6h`, `tomorrow`).
  - IndexedDB storage (`db/localDb.ts`) with separate object stores for photo metadata, binary image blobs, durable sync operation queue, settings, notification state, and sync conflicts.
  - Client-side ZIP archive extraction and per-file validation (`zipValidator.ts`) supporting offline batch imports.
  - Durable synchronization engine (`sync/syncEngine.ts`) with idempotency keys, revision tracking, S3 binary upload state machine (`local_only` -> `upload_pending` -> `uploading` -> `uploaded` / `upload_failed`), retry backoff, and explicit conflict handling.
  - Responsive mobile-first Russian UI covering Today's Dashboard, Batch Upload (Photos + ZIPs), Monthly Calendar (with drag-and-drop and accessible keyboard/touch reordering), Photo Detail, and Settings.

## 2. Recorded Architectural & Product Decisions (Categories A & B)

1. **Authentication & Multi-User Isolation**:
   - Token-based authentication (`Bearer` HMAC-SHA256 session token signed with `AUTH_SECRET` and issued via `/api/v1/auth/session` with configured `AUTH_DEFAULT_ACCESS_CODE`).
   - Every database table scopes data by `user_id` to guarantee strict tenant/user isolation while supporting seamless personal operation and offline access for previously authenticated sessions.
2. **Authoritative Queue & Deterministic Scheduling**:
   - Scheduled dates are pure projections computed by `calculateSchedule()` from:
     - Ordered pending photos (`status = 'pending'`, sorted by `queuePosition ASC, createdAt ASC, id ASC`).
     - Confirmed publications (`status = 'published'`, recording `publishedAt` and local confirmation date).
     - Explicit date postponement (`postponedUntilDate` in `user_settings`).
     - Current instant and configured IANA `timeZone`.
   - If a photo is already confirmed published on `todayLocal`, `todayLocal` is occupied and the next pending photo is projected onto `todayLocal + 1 day` (or `postponedUntilDate`, whichever is later).
   - If a day passes without confirmation, `todayLocal` advances and the unconfirmed head of the queue automatically shifts to the new `todayLocal`. Past dates where pending photos existed in the queue (`createdAtLocalDate <= date`) but no publication occurred are surfaced as missed publication days (`missed`).
3. **Conflict Resolution Policy**:
   - Optimistic concurrency via monotonically increasing `revision` per photo and `queueRevision` per user settings/queue.
   - Terminal states (`published`, `deleted`) dominate `pending` state modifications.
   - If one device marks a photo `published` and another marks it `deleted`, `published` wins (to preserve historical publication records) and a conflict notice is recorded so the user is informed.
   - If two devices concurrently edit a photo's description at the same base revision, the conflict is flagged in `sync_conflicts` (`DESCRIPTION_CONFLICT`, `MANUAL_REQUIRED`) with both versions preserved so the user can pick or merge without silent data loss.
   - If two devices concurrently reorder the queue, deterministic position merging preserves all pending photos without duplicating or dropping any item, and recalculates dense `0..N-1` positions.
4. **Supported Image Formats**:
   - `image/jpeg` (`.jpg`, `.jpeg`), `image/png` (`.png`), `image/webp` (`.webp`), `image/gif` (`.gif`), `image/avif` (`.avif`). Verified by both extension and binary magic bytes.

## 3. Execution Stages & Progress Log

- [x] Stage 1: Inspect repository and environment.
- [x] Stage 2: Initialize monorepo, TypeScript, ESLint, and shared domain package (`packages/shared`) with unit tests.
- [x] Stage 3: Implement backend (`apps/api`) — config validation, PostgreSQL migrations, S3 storage service, ZIP processor, sync & REST endpoints, Web Push notification scheduler, and backend unit/integration tests.
- [x] Stage 4: Implement frontend PWA (`apps/web`) — config validation, IndexedDB persistence, offline ZIP/photo import, sync engine, Service Worker, and Russian UI screens (Today, Upload, Calendar, Photo Detail, Settings).
- [x] Stage 5: Implement Dockerfiles (`apps/api/Dockerfile`, `apps/web/Dockerfile`), `docker-compose.yml`, `docker-compose.override.yml`, and `.env.example`.
- [x] Stage 6: Run complete unit, integration, and acceptance scenario tests (Scenarios 1–15), lint, typecheck, and production builds.
- [x] Stage 7: Final documentation (`README.md`) and implementation report.
