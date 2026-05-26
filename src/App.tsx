import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { check as checkUpdate } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { ask } from '@tauri-apps/plugin-dialog';
import { Sidebar }      from './components/Sidebar';
import { ToastContainer } from './components/ToastContainer';
import { HomePage }     from './components/HomePage';
import { FlowEditor }   from './components/FlowEditor';
import { SettingsPage } from './components/SettingsPage';
import { RunLogPage }   from './components/RunLogPage';
import { WelcomeScreen } from './components/WelcomeScreen';
import { useFlowStore }      from './store/flowStore';
import { useWorkspaceStore } from './store/workspaceStore';
import { useSettingsStore }  from './store/settingsStore';
import { initCronService } from './lib/cronService';
import { ensureNotificationPermission } from './lib/backgroundRunner';

export default function App() {
  const view      = useFlowStore((s) => s.view);
  const loaded    = useFlowStore((s) => s.loaded);
  const bootstrap = useFlowStore((s) => s.bootstrap);

  const wsPath    = useWorkspaceStore((s) => s.path);
  const wsLoaded  = useWorkspaceStore((s) => s.loaded);
  const wsRefresh = useWorkspaceStore((s) => s.refresh);

  const closeToTray = useSettingsStore((s) => s.settings.closeToTray);
  const theme       = useSettingsStore((s) => s.settings.theme);

  // Show the main window once React has rendered its first frame.
  // The window starts hidden (visible:false in tauri.conf.json) so it never
  // appears blank. For --minimized autostart launches we stay hidden in tray.
  useEffect(() => {
    invoke<boolean>('was_launched_minimized')
      .then(minimized => { if (!minimized) invoke('show_main_window').catch(() => {}); })
      .catch(() => { invoke('show_main_window').catch(() => {}); }); // fallback: always show
  }, []);

  // 1) Read the workspace marker at launch. 2) Once we have a workspace,
  // load flows from disk.
  useEffect(() => { void wsRefresh(); }, [wsRefresh]);
  useEffect(() => {
    if (wsPath) void bootstrap();
  }, [wsPath, bootstrap]);

  // Start the cron service once flows are loaded.
  useEffect(() => {
    if (loaded) void initCronService();
  }, [loaded]);

  // Ask once for notification permission at startup so cron-fired toasts work.
  useEffect(() => { void ensureNotificationPermission(); }, []);

  // Mirror the close-to-tray setting to the backend.
  useEffect(() => {
    invoke('set_close_to_tray', { on: closeToTray }).catch(() => {});
  }, [closeToTray]);

  // Apply theme class to <html> so CSS variables cascade everywhere.
  useEffect(() => {
    document.documentElement.classList.toggle('light', theme === 'light');
  }, [theme]);

  // Silent update check after app has loaded — only prompts if a new version exists.
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(async () => {
      try {
        const update = await checkUpdate();
        if (!update?.available) return;
        const yes = await ask(
          `Version ${update.version} is available.\n\n${update.body ?? ''}\n\nInstall now and restart?`.trim(),
          { title: 'Update available', kind: 'info' },
        );
        if (!yes) return;
        await update.downloadAndInstall();
        await relaunch();
      } catch {
        // Endpoint unreachable in dev or when not yet configured — silent.
      }
    }, 3000);
    return () => clearTimeout(t);
  }, [loaded]);

  // While we resolve the workspace marker, show nothing.
  if (!wsLoaded) {
    return (
      <div className="flex items-center justify-center h-full bg-canvas text-ink-dim text-[12px] font-mono">
        Starting…
      </div>
    );
  }

  // No workspace yet — show welcome.
  if (!wsPath) {
    return <WelcomeScreen onDone={() => void wsRefresh()} />;
  }

  // Workspace configured but flows are still being read.
  if (!loaded) {
    return (
      <div className="flex items-center justify-center h-full bg-canvas text-ink-dim text-[12px] font-mono">
        Loading flows…
      </div>
    );
  }

  return (
    <div className="flex h-full bg-canvas text-ink select-none">
      <Sidebar />
      <div className="flex-1 overflow-hidden">
        {view === 'home'     && <HomePage />}
        {view === 'editor'   && <FlowEditor />}
        {view === 'settings' && <SettingsPage />}
        {view === 'runlog'   && <RunLogPage />}
      </div>
      <ToastContainer />
    </div>
  );
}
