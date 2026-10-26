import React, { useEffect } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  Calendar,
  CheckCircle2,
  CloudOff,
  RefreshCw,
  Settings,
  Sun,
  Upload,
  AlertTriangle,
} from 'lucide-react';
import { PostponementDurationSchema } from '@publish-calendar/shared';
import { useApp } from '../context/AppContext.js';

export function AppLayout({ children }: { children: React.ReactNode }) {
  const { state, isOnline, syncing, triggerSync, postponeReminder } = useApp();
  const navigate = useNavigate();

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return;
    }
    const handleMessage = (event: MessageEvent) => {
      const data = event.data as
        | {
            type?: string;
            url?: string;
            photoId?: string | null;
            postponeDuration?: string | null;
          }
        | undefined;
      if (!data || data.type !== 'SW_NOTIFICATION_CLICK') {
        return;
      }
      if (data.photoId && data.postponeDuration) {
        const parsed = PostponementDurationSchema.safeParse(
          data.postponeDuration
        );
        if (parsed.success) {
          void postponeReminder(data.photoId, parsed.data);
        }
      }
      if (data.url) {
        void navigate(data.url);
      }
    };

    navigator.serviceWorker.addEventListener('message', handleMessage);
    return () => {
      navigator.serviceWorker.removeEventListener('message', handleMessage);
    };
  }, [navigate, postponeReminder]);

  const pendingOpsCount = state?.pendingOperations.length ?? 0;
  const pendingUploadsCount = state?.pendingUploadsCount ?? 0;
  const unresolvedConflictsCount =
    state?.conflicts.filter((c) => !c.resolved).length ?? 0;
  const totalPendingSync = pendingOpsCount + pendingUploadsCount;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-block">
          <span className="brand-title">ФотоПлан</span>
          <span className="brand-subtitle">Очередь публикаций</span>
        </div>

        <div className="status-strip" role="status" aria-live="polite">
          {!isOnline ? (
            <span className="badge badge-offline" data-testid="offline-badge">
              <CloudOff size={14} />
              Офлайн-режим
            </span>
          ) : syncing ? (
            <span className="badge badge-syncing">
              <RefreshCw size={14} className="spin" />
              Синхронизация...
            </span>
          ) : totalPendingSync > 0 ? (
            <button
              type="button"
              className="badge badge-pending"
              onClick={() => void triggerSync()}
              title="Нажмите для синхронизации"
              data-testid="pending-sync-badge"
            >
              <RefreshCw size={14} />
              Ожидает синхр.: {totalPendingSync}
            </button>
          ) : (
            <span className="badge badge-online" data-testid="synced-badge">
              <CheckCircle2 size={14} />
              Синхронизировано
            </span>
          )}

          {unresolvedConflictsCount > 0 && (
            <NavLink
              to="/settings"
              className="badge badge-conflict"
              data-testid="conflict-badge"
            >
              <AlertTriangle size={14} />
              Конфликты: {unresolvedConflictsCount}
            </NavLink>
          )}
        </div>
      </header>

      <main className="app-main">{children}</main>

      <nav className="app-nav" aria-label="Основная навигация">
        <NavLink
          to="/"
          end
          className={({ isActive }) =>
            `nav-item ${isActive ? 'nav-item-active' : ''}`
          }
        >
          <Sun size={20} />
          <span>Сегодня</span>
        </NavLink>

        <NavLink
          to="/upload"
          className={({ isActive }) =>
            `nav-item ${isActive ? 'nav-item-active' : ''}`
          }
        >
          <Upload size={20} />
          <span>Загрузка</span>
        </NavLink>

        <NavLink
          to="/calendar"
          className={({ isActive }) =>
            `nav-item ${isActive ? 'nav-item-active' : ''}`
          }
        >
          <Calendar size={20} />
          <span>Календарь</span>
        </NavLink>

        <NavLink
          to="/settings"
          className={({ isActive }) =>
            `nav-item ${isActive ? 'nav-item-active' : ''}`
          }
        >
          <Settings size={20} />
          <span>Настройки</span>
        </NavLink>
      </nav>
    </div>
  );
}
