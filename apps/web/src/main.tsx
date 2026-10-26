import React from 'react';
import { createRoot } from 'react-dom/client';
import { loadWebConfig } from './config/env.js';
import { App } from './App.js';
import './styles/app.css';

const rawEnv: Record<string, string | undefined> = {
  VITE_API_ORIGIN: import.meta.env.VITE_API_ORIGIN as string | undefined,
  VITE_PUBLIC_ORIGIN: import.meta.env.VITE_PUBLIC_ORIGIN as string | undefined,
  VITE_VAPID_PUBLIC_KEY: import.meta.env.VITE_VAPID_PUBLIC_KEY as
    | string
    | undefined,
  VITE_DEFAULT_ACCESS_CODE: import.meta.env.VITE_DEFAULT_ACCESS_CODE as
    | string
    | undefined,
  VITE_DEFAULT_TIMEZONE: import.meta.env.VITE_DEFAULT_TIMEZONE as
    | string
    | undefined,
  VITE_DEFAULT_REMINDER_TIME: import.meta.env.VITE_DEFAULT_REMINDER_TIME as
    | string
    | undefined,
  VITE_MAX_UPLOAD_FILE_BYTES: import.meta.env.VITE_MAX_UPLOAD_FILE_BYTES as
    | string
    | undefined,
  VITE_MAX_BATCH_FILES: import.meta.env.VITE_MAX_BATCH_FILES as
    | string
    | undefined,
  VITE_MAX_BATCH_TOTAL_BYTES: import.meta.env.VITE_MAX_BATCH_TOTAL_BYTES as
    | string
    | undefined,
  VITE_MAX_ZIP_EXPANSION_RATIO: import.meta.env.VITE_MAX_ZIP_EXPANSION_RATIO as
    | string
    | undefined,
  VITE_MAX_ZIP_EXTRACTED_BYTES: import.meta.env.VITE_MAX_ZIP_EXTRACTED_BYTES as
    | string
    | undefined,
  VITE_MAX_ZIP_ENTRIES: import.meta.env.VITE_MAX_ZIP_ENTRIES as
    | string
    | undefined,
  VITE_SYNC_INTERVAL_MS: import.meta.env.VITE_SYNC_INTERVAL_MS as
    | string
    | undefined,
  VITE_SYNC_MAX_RETRIES: import.meta.env.VITE_SYNC_MAX_RETRIES as
    | string
    | undefined,
  VITE_SYNC_RETRY_BASE_MS: import.meta.env.VITE_SYNC_RETRY_BASE_MS as
    | string
    | undefined,
};

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root element #root not found');
}

const config = loadWebConfig(rawEnv);
createRoot(rootEl).render(
  <React.StrictMode>
    <App config={config} />
  </React.StrictMode>
);
