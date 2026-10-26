import { BrowserRouter, Route, Routes } from 'react-router-dom';
import type { WebConfig } from './config/env.js';
import { AppProvider } from './context/AppContext.js';
import { AppLayout } from './components/AppLayout.js';
import { TodayPage } from './pages/TodayPage.js';
import { UploadPage } from './pages/UploadPage.js';
import { CalendarPage } from './pages/CalendarPage.js';
import { PhotoDetailPage } from './pages/PhotoDetailPage.js';
import { SettingsPage } from './pages/SettingsPage.js';

export function App({ config }: { config: WebConfig }) {
  return (
    <AppProvider config={config}>
      <BrowserRouter>
        <AppLayout>
          <Routes>
            <Route path="/" element={<TodayPage />} />
            <Route path="/upload" element={<UploadPage />} />
            <Route path="/calendar" element={<CalendarPage />} />
            <Route path="/photo/:photoId" element={<PhotoDetailPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </AppLayout>
      </BrowserRouter>
    </AppProvider>
  );
}
