# syntax=docker/dockerfile:1
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json

RUN npm install

COPY packages/shared ./packages/shared
COPY apps/web ./apps/web

ARG VITE_API_ORIGIN
ARG VITE_PUBLIC_ORIGIN
ARG VITE_VAPID_PUBLIC_KEY
ARG VITE_DEFAULT_ACCESS_CODE
ARG VITE_DEFAULT_TIMEZONE
ARG VITE_DEFAULT_REMINDER_TIME
ARG VITE_MAX_UPLOAD_FILE_BYTES
ARG VITE_MAX_BATCH_FILES
ARG VITE_MAX_BATCH_TOTAL_BYTES
ARG VITE_MAX_ZIP_EXPANSION_RATIO
ARG VITE_MAX_ZIP_EXTRACTED_BYTES
ARG VITE_MAX_ZIP_ENTRIES
ARG VITE_SYNC_INTERVAL_MS
ARG VITE_SYNC_MAX_RETRIES
ARG VITE_SYNC_RETRY_BASE_MS

RUN for var in \
      VITE_API_ORIGIN \
      VITE_PUBLIC_ORIGIN \
      VITE_VAPID_PUBLIC_KEY \
      VITE_DEFAULT_ACCESS_CODE \
      VITE_DEFAULT_TIMEZONE \
      VITE_DEFAULT_REMINDER_TIME \
      VITE_MAX_UPLOAD_FILE_BYTES \
      VITE_MAX_BATCH_FILES \
      VITE_MAX_BATCH_TOTAL_BYTES \
      VITE_MAX_ZIP_EXPANSION_RATIO \
      VITE_MAX_ZIP_EXTRACTED_BYTES \
      VITE_MAX_ZIP_ENTRIES \
      VITE_SYNC_INTERVAL_MS \
      VITE_SYNC_MAX_RETRIES \
      VITE_SYNC_RETRY_BASE_MS; do \
      eval val=\$$var; \
      if [ -z "$val" ]; then \
        echo "ConfigurationError: $var is required." >&2; \
        exit 1; \
      fi; \
    done

RUN npm run build --workspace=@publish-calendar/shared \
 && npm run build --workspace=@publish-calendar/web

FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/apps/web/server.mjs ./server.mjs
COPY --from=builder /app/apps/web/dist ./dist

USER node

HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "const port = process.env.WEB_PORT; if (!port) process.exit(1); fetch('http://127.0.0.1:' + port + '/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));"

CMD ["node", "server.mjs"]
