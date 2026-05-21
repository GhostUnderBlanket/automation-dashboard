import { useState, useEffect, useCallback } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { Check, RotateCcw, Globe, AlertTriangle, FolderOpen, Eye, EyeOff, RefreshCw, Download, BookOpen } from 'lucide-react';
import { check as checkForUpdate, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { clsx } from 'clsx';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { openPath } from '@tauri-apps/plugin-opener';
import { useSettingsStore } from '../store/settingsStore';
import { useWorkspaceStore } from '../store/workspaceStore';
import { useFlowStore } from '../store/flowStore';
import { getExampleFlows } from '../lib/exampleFlows';
import type { AppSettings } from '../types/settings';
import type { ReactNode } from 'react';

/* ─── Category nav ───────────────────────────── */

type Category = 'workspace' | 'rest' | 'shell' | 'window' | 'runlog' | 'about';

const CATEGORIES: { id: Category; label: string; sub: string }[] = [
  { id: 'workspace', label: 'Workspace',         sub: 'where files live' },
  { id: 'window',    label: 'Window & Tray',     sub: '3 settings'  },
  { id: 'rest',      label: 'REST API',          sub: '2 settings'  },
  { id: 'shell',     label: 'Shell & Execution', sub: '3 settings'  },
  { id: 'runlog',    label: 'Run Log',           sub: '1 setting'   },
  { id: 'about',     label: 'About',             sub: 'info & keys' },
];

/* ─── Primitives ─────────────────────────────── */

function SettingRow({
  index, label, description, children,
}: {
  index: number; label: string; description: ReactNode; children: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-8 py-5 border-b border-wire last:border-0">
      <div className="flex gap-4 items-start min-w-0">
        <span className="text-[10.5px] font-mono text-ink-ghost mt-[3px] shrink-0 tabular-nums w-5 text-right">
          {String(index).padStart(2, '0')}
        </span>
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-ink leading-snug">{label}</p>
          <div className="text-[12px] text-ink-dim mt-1 leading-relaxed max-w-sm">
            {description}
          </div>
        </div>
      </div>
      <div className="shrink-0 flex items-start justify-end" style={{ minWidth: 240 }}>
        {children}
      </div>
    </div>
  );
}

function TextInput({
  value, onChange, placeholder, mono = false, type = 'text',
}: { value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean; type?: 'text' | 'password' }) {
  return (
    <input
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      type={type}
      spellCheck={false}
      className={clsx(
        'w-full px-2.5 py-[7px] rounded-md bg-raised border border-wire text-ink',
        'text-[12px] placeholder-ink-ghost leading-none',
        'focus:outline-none focus:border-wire-lit transition-colors',
        mono && 'font-mono',
      )}
    />
  );
}

function ShellToggle({
  value, onChange,
}: { value: AppSettings['defaultShell']; onChange: (v: AppSettings['defaultShell']) => void }) {
  const shells: AppSettings['defaultShell'][] = ['cmd', 'powershell', 'bash'];
  return (
    <div className="flex gap-1">
      {shells.map(s => (
        <button
          key={s}
          onClick={() => onChange(s)}
          className={clsx(
            'px-2.5 py-[6px] rounded-md text-[11px] font-mono font-medium transition-all',
            value === s
              ? 'bg-accent/14 text-accent-soft border border-accent/28'
              : 'bg-raised text-ink-dim border border-wire hover:text-ink hover:border-wire-lit',
          )}
        >
          {s}
        </button>
      ))}
    </div>
  );
}

function Toggle({
  value, onChange, disabled = false,
}: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={value}
      onClick={() => !disabled && onChange(!value)}
      className={clsx(
        'relative inline-flex items-center rounded-full transition-colors duration-200',
        'w-[38px] h-[22px] focus:outline-none',
        value ? 'bg-accent' : 'bg-wire-lit',
        disabled && 'opacity-50 cursor-not-allowed',
      )}
    >
      <span
        className={clsx(
          'absolute w-[16px] h-[16px] rounded-full bg-canvas shadow transition-transform duration-200',
          value ? 'translate-x-[19px]' : 'translate-x-[3px]',
        )}
      />
    </button>
  );
}

function Stepper({
  value, onChange, min = 5, max = 300, step = 5, suffix,
}: {
  value: number; onChange: (v: number) => void;
  min?: number; max?: number; step?: number; suffix?: string;
}) {
  const dec = () => onChange(Math.max(min, value - step));
  const inc = () => onChange(Math.min(max, value + step));
  return (
    <div className="flex items-center gap-1.5">
      <button
        onClick={dec} disabled={value <= min}
        className="w-[26px] h-[26px] rounded-md bg-raised border border-wire text-ink-dim
                   hover:text-ink hover:border-wire-lit transition-colors text-[14px] font-mono
                   disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center"
      >−</button>
      <span className="text-[13px] font-mono text-ink tabular-nums w-10 text-center">{value}</span>
      <button
        onClick={inc} disabled={value >= max}
        className="w-[26px] h-[26px] rounded-md bg-raised border border-wire text-ink-dim
                   hover:text-ink hover:border-wire-lit transition-colors text-[14px] font-mono
                   disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center"
      >+</button>
      {suffix && <span className="text-[11px] font-mono text-ink-ghost">{suffix}</span>}
    </div>
  );
}

/* ─── Section header ─────────────────────────── */

function SectionHead({ title, description }: { title: string; description: string }) {
  return (
    <div className="pb-5 mb-1 border-b border-wire">
      <h2 className="text-[17px] font-bold text-ink tracking-tight font-display">{title}</h2>
      <p className="text-[12.5px] text-ink-dim mt-1.5 leading-relaxed">{description}</p>
    </div>
  );
}

/* ─── Sections ───────────────────────────────── */

function WorkspaceSection() {
  const path    = useWorkspaceStore((s) => s.path);
  const setWs   = useWorkspaceStore((s) => s.set);
  const addFlow = useFlowStore((s) => s.addFlow);

  const [busy,       setBusy]       = useState(false);
  const [info,       setInfo]       = useState<string | null>(null);
  const [error,      setError]      = useState<string | null>(null);
  const [exBusy,     setExBusy]     = useState(false);
  const [exFeedback, setExFeedback] = useState<string | null>(null);

  async function pickAndSet() {
    setError(null); setInfo(null);
    try {
      const picked = await openDialog({
        directory:   true,
        multiple:    false,
        defaultPath: path || undefined,
        title:       'Pick a new work directory',
      });
      if (typeof picked !== 'string' || !picked) return;
      setBusy(true);
      await setWs(picked);
      await useFlowStore.getState().reload();
      setInfo(`Switched to ${picked}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function openWorkspace() {
    if (!path) return;
    try { await openPath(path); }
    catch (e) { setError(String(e)); }
  }

  function importExamples() {
    setExBusy(true);
    setExFeedback(null);
    try {
      const flows = getExampleFlows();
      flows.forEach(f => addFlow(f));
      setExFeedback(`${flows.length} example flows added.`);
    } catch (e) {
      setExFeedback(`Error: ${String(e)}`);
    } finally {
      setExBusy(false);
      setTimeout(() => setExFeedback(null), 4000);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-[15px] font-semibold text-ink leading-snug font-display">
          Work Directory
        </h2>
        <p className="text-[12.5px] text-ink-dim mt-1.5 leading-relaxed">
          One folder for your flows. Pick something you can back up, sync, or version-control.
          Machine state (window size, scheduler ticks) stays in appData regardless.
        </p>
      </div>

      <div className="rounded-xl border border-wire bg-raised/40 p-4">
        <label className="block text-[9.5px] font-mono tracking-[0.12em] uppercase text-ink-dim mb-2">
          Current Path
        </label>
        <div className="px-2.5 py-2 rounded-md bg-raised border border-wire text-ink
                        text-[12px] font-mono break-all leading-relaxed"
             title={path ?? '(not set)'}>
          {path ?? '(not set)'}
        </div>
        <div className="flex items-center gap-2 mt-3">
          <button
            onClick={pickAndSet}
            disabled={busy}
            className={clsx(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors',
              busy
                ? 'bg-raised text-ink-ghost cursor-not-allowed'
                : 'border border-accent/30 bg-accent/[.08] text-accent-soft hover:bg-accent/[.16]',
            )}
          >
            <FolderOpen size={13} />
            Change…
          </button>
          <button
            onClick={openWorkspace}
            disabled={!path}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-wire
                       bg-raised text-ink-dim hover:text-ink hover:border-wire-lit
                       transition-colors text-[12px]
                       disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-ink-dim"
          >
            Open
          </button>
        </div>
        {info  && <p className="text-[11px] text-success font-mono leading-relaxed mt-3">{info}</p>}
        {error && <p className="text-[11px] text-danger  font-mono leading-relaxed mt-3">{error}</p>}
      </div>

      <p className="text-[11px] text-ink-ghost leading-relaxed">
        Switching doesn't move existing files. Your flows load from the new location next.
      </p>

      {/* Example Flows */}
      <div>
        <h2 className="text-[15px] font-semibold text-ink leading-snug font-display">
          Example Flows
        </h2>
        <p className="text-[12.5px] text-ink-dim mt-1.5 leading-relaxed">
          Import ready-made flows covering every node type — Trigger, Script, REST API, Condition, Loop, File, and Open URL.
          Each import creates a fresh copy so you can run it multiple times without clobbering the originals.
        </p>
      </div>

      <div className="rounded-xl border border-wire bg-raised/40 p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-[12.5px] font-medium text-ink">{getExampleFlows().length} example flows</p>
            <p className="text-[11.5px] text-ink-dim mt-0.5">Hello World · Cron · REST GET &amp; POST · Condition · Variables · Refs · JSON extraction · File · Open URL · Loop (repeat / retry / forEach) · Launch App</p>
          </div>
          <button
            onClick={importExamples}
            disabled={exBusy}
            className={clsx(
              'shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors',
              exBusy
                ? 'bg-raised text-ink-ghost cursor-not-allowed'
                : 'border border-accent/30 bg-accent/[.08] text-accent-soft hover:bg-accent/[.16]',
            )}
          >
            <BookOpen size={13} />
            Import
          </button>
        </div>
        {exFeedback && (
          <p className="text-[11px] text-success font-mono leading-relaxed mt-3">{exFeedback}</p>
        )}
      </div>
    </div>
  );
}

function RestSection() {
  const { settings, update } = useSettingsStore();
  const [showToken, setShowToken] = useState(false);
  const [test, setTest] = useState<{ kind: 'idle' | 'ok' | 'err' | 'busy'; msg: string }>({ kind: 'idle', msg: '' });

  async function handleTest() {
    setTest({ kind: 'busy', msg: 'sending HEAD request…' });
    const base = settings.restBaseUrl.trim().replace(/\/+$/, '');
    if (!base) { setTest({ kind: 'err', msg: 'Base URL is empty.' }); return; }
    try {
      const headers: Record<string, string> = {};
      if (settings.restToken) headers['Authorization'] = `Bearer ${settings.restToken}`;
      const res = await tauriFetch(base, { method: 'HEAD', headers });
      const ok  = res.status >= 200 && res.status < 500; // 4xx still means the host answered
      setTest({
        kind: ok ? 'ok' : 'err',
        msg:  `${res.status} ${res.statusText || ''}`.trim(),
      });
    } catch (e) {
      setTest({ kind: 'err', msg: String(e) });
    }
  }

  return (
    <div style={{ animation: 'fade-up 0.22s ease both' }}>
      <SectionHead
        title="REST API"
        description="Default base URL and bearer token used by every REST API node. Per-node overrides take precedence."
      />
      <SettingRow
        index={1}
        label="Base URL"
        description="HTTPS root that every REST API node's endpoint is appended to."
      >
        <TextInput
          value={settings.restBaseUrl}
          onChange={v => update({ restBaseUrl: v })}
          placeholder="https://…"
          mono
        />
      </SettingRow>
      <SettingRow
        index={2}
        label="Bearer Token"
        description={
          <div className="space-y-1.5">
            <p>
              Sent as <span className="font-mono text-[11px]">Authorization: Bearer &lt;token&gt;</span> on every request.
              Stored in <span className="font-mono text-[11px]">localStorage</span> on this machine only.
            </p>
            <p className="text-[10.5px] text-ink-ghost">Individual REST API nodes can override this in the node panel.</p>
            {test.kind === 'busy' && <p className="text-[11px] text-ink-dim font-mono">{test.msg}</p>}
            {test.kind === 'ok'   && <p className="text-[11px] text-success font-mono">✓ host reachable — {test.msg}</p>}
            {test.kind === 'err'  && <p className="text-[11px] text-danger  font-mono">✗ {test.msg}</p>}
          </div>
        }
      >
        <div className="flex flex-col gap-1.5 w-full">
          <div className="flex gap-1.5">
            <TextInput
              value={settings.restToken}
              onChange={v => update({ restToken: v })}
              placeholder="Bearer token…"
              type={showToken ? 'text' : 'password'}
              mono
            />
            <button
              onClick={() => setShowToken(s => !s)}
              className="p-1.5 rounded-md text-ink-ghost hover:text-ink hover:bg-raised transition-colors shrink-0"
              title={showToken ? 'Hide token' : 'Show token'}
            >
              {showToken ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
          </div>
          <button
            onClick={handleTest}
            className={clsx(
              'flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-[11.5px] font-medium transition-all',
              test.kind === 'ok'
                ? 'bg-success/12 text-success border border-success/25'
                : test.kind === 'err'
                ? 'bg-danger/12 text-danger border border-danger/25'
                : 'bg-raised border border-wire text-ink-dim hover:text-ink hover:border-wire-lit',
            )}
          >
            {test.kind === 'ok'  ? <><Check size={12} /> Reachable</>
            : test.kind === 'err' ? <><AlertTriangle size={12} /> Failed</>
            : <><Globe size={12} /> Test connection</>}
          </button>
        </div>
      </SettingRow>
    </div>
  );
}

function ShellSection() {
  const { settings, update } = useSettingsStore();
  return (
    <div style={{ animation: 'fade-up 0.22s ease both' }}>
      <SectionHead
        title="Shell & Execution"
        description="Default environment for running script nodes and controlling flow execution behaviour."
      />
      <SettingRow
        index={1}
        label="Default Shell"
        description="Shell used by script nodes that don't specify their own. Can be overridden per-node."
      >
        <ShellToggle value={settings.defaultShell} onChange={v => update({ defaultShell: v })} />
      </SettingRow>
      <SettingRow
        index={2}
        label="Node Timeout"
        description="Maximum time in seconds a single node may run before it is force-killed."
      >
        <Stepper
          value={settings.nodeTimeout}
          onChange={v => update({ nodeTimeout: v })}
          min={5} max={300} step={5} suffix="sec"
        />
      </SettingRow>
      <SettingRow
        index={3}
        label="Stop Flow on Error"
        description="Abort remaining nodes when any node exits with a non-zero status code."
      >
        <Toggle value={settings.stopOnError} onChange={v => update({ stopOnError: v })} />
      </SettingRow>
    </div>
  );
}

function RunLogSection() {
  const { settings, update } = useSettingsStore();
  return (
    <div style={{ animation: 'fade-up 0.22s ease both' }}>
      <SectionHead
        title="Run Log"
        description="Controls how execution history is stored and displayed."
      />
      <SettingRow
        index={1}
        label="Session Limit"
        description="Maximum number of run sessions kept in history. Oldest entries are evicted automatically when the limit is reached."
      >
        <Stepper
          value={settings.runLogLimit}
          onChange={v => update({ runLogLimit: v })}
          min={10} max={500} step={10} suffix="sessions"
        />
      </SettingRow>
    </div>
  );
}

function WindowSection() {
  const { settings, update } = useSettingsStore();
  const [autostart,    setAutostart]    = useState(false);
  const [autostartBusy, setAutostartBusy] = useState(false);

  useEffect(() => {
    invoke<boolean>('autostart_is_enabled').then(setAutostart).catch(() => {});
  }, []);

  const toggleAutostart = useCallback(async (v: boolean) => {
    setAutostartBusy(true);
    try {
      if (v) await invoke('autostart_enable'); else await invoke('autostart_disable');
      setAutostart(v);
    } catch (e) {
      console.warn('[autostart] toggle failed:', e);
    } finally {
      setAutostartBusy(false);
    }
  }, []);

  return (
    <div style={{ animation: 'fade-up 0.22s ease both' }}>
      <SectionHead
        title="Window & Tray"
        description="Behaviour of the application window and system tray icon."
      />
      <SettingRow
        index={1}
        label="Theme"
        description="Switch between dark and light appearance."
      >
        <div className="flex gap-1">
          {(['dark', 'light'] as const).map(t => (
            <button
              key={t}
              onClick={() => update({ theme: t })}
              className={clsx(
                'px-3 py-[6px] rounded-md text-[11px] font-mono font-medium capitalize transition-all',
                settings.theme === t
                  ? 'bg-accent/14 text-accent-soft border border-accent/28'
                  : 'bg-raised text-ink-dim border border-wire hover:text-ink hover:border-wire-lit',
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </SettingRow>
      <SettingRow
        index={2}
        label="Close to Tray"
        description="Closing the window hides it to the system tray so scheduled flows keep firing. Quit from the tray menu to fully exit."
      >
        <Toggle value={settings.closeToTray} onChange={v => update({ closeToTray: v })} />
      </SettingRow>
      <SettingRow
        index={3}
        label="Launch at Login"
        description="Start Autoflow automatically when you log in to Windows. Cron flows begin firing immediately in the background."
      >
        <Toggle value={autostart} onChange={toggleAutostart} disabled={autostartBusy} />
      </SettingRow>
    </div>
  );
}

const SHORTCUTS = [
  { keys: ['Ctrl', 'Z'],        action: 'Undo'                           },
  { keys: ['Ctrl', 'Y'],        action: 'Redo'                           },
  { keys: ['Ctrl', 'S'],        action: 'Save current flow'              },
  { keys: ['Backspace'],        action: 'Delete selected node'           },
  { keys: ['Esc'],              action: 'Deselect / close config panel'  },
  { keys: ['Scroll'],           action: 'Zoom in / out on canvas'        },
  { keys: ['Middle', 'Drag'],   action: 'Pan the canvas'                 },
] as const;

type UpdateCheckState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'uptodate' }
  | { kind: 'available'; version: string; update: Update }
  | { kind: 'downloading' }
  | { kind: 'error'; msg: string };

function AboutSection() {
  const { reset } = useSettingsStore();
  const [upd, setUpd] = useState<UpdateCheckState>({ kind: 'idle' });
  const [appVersion, setAppVersion] = useState<string>('…');

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion('?'));
  }, []);

  async function handleCheck() {
    setUpd({ kind: 'checking' });
    try {
      const update = await checkForUpdate();
      if (!update?.available) {
        setUpd({ kind: 'uptodate' });
        setTimeout(() => setUpd({ kind: 'idle' }), 4000);
      } else {
        setUpd({ kind: 'available', version: update.version, update });
      }
    } catch (e) {
      setUpd({ kind: 'error', msg: String(e) });
      setTimeout(() => setUpd({ kind: 'idle' }), 6000);
    }
  }

  async function handleInstall() {
    if (upd.kind !== 'available') return;
    const { update } = upd;
    setUpd({ kind: 'downloading' });
    try {
      await update.downloadAndInstall();
      await relaunch();
    } catch (e) {
      setUpd({ kind: 'error', msg: String(e) });
    }
  }

  return (
    <div style={{ animation: 'fade-up 0.22s ease both' }}>
      <SectionHead
        title="About"
        description={`autoflow v${appVersion} · Tauri v2 · React 19 · @xyflow/react · Tailwind CSS v4`}
      />

      {/* Update checker */}
      <div className="mb-8 rounded-xl border border-wire bg-raised/30 p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[13px] font-semibold text-ink">Check for Updates</p>
            <p className="text-[12px] text-ink-dim mt-0.5">
              {upd.kind === 'uptodate'   && <span className="text-success">✓ You're on the latest version.</span>}
              {upd.kind === 'available'  && <span className="text-accent-soft">v{upd.version} is available.</span>}
              {upd.kind === 'error'      && <span className="text-danger font-mono">{upd.msg}</span>}
              {upd.kind === 'idle'       && `Current version: ${appVersion}`}
              {upd.kind === 'checking'   && <span className="text-ink-ghost">Checking…</span>}
              {upd.kind === 'downloading'&& <span className="text-ink-ghost">Downloading and installing…</span>}
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {upd.kind === 'available' && (
              <button
                onClick={handleInstall}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg
                           bg-accent text-white text-[12px] font-semibold
                           hover:bg-accent/90 active:scale-[.97] transition-all shadow-md shadow-accent/20"
              >
                <Download size={12} />
                Install & restart
              </button>
            )}
            <button
              onClick={handleCheck}
              disabled={upd.kind === 'checking' || upd.kind === 'downloading'}
              className={clsx(
                'flex items-center gap-1.5 px-3 py-2 rounded-lg border text-[12px] font-medium transition-all',
                'disabled:opacity-40 disabled:cursor-not-allowed',
                upd.kind === 'uptodate'
                  ? 'border-success/30 text-success bg-success/[.06]'
                  : 'border-wire text-ink-dim hover:text-ink hover:border-wire-lit',
              )}
            >
              <RefreshCw size={12} className={upd.kind === 'checking' ? 'animate-spin' : ''} />
              {upd.kind === 'checking' ? 'Checking…' : 'Check'}
            </button>
          </div>
        </div>
      </div>

      <div className="mb-8">
        <p className="text-[9.5px] font-mono text-ink-ghost tracking-[0.14em] uppercase mb-3">
          Keyboard Shortcuts
        </p>
        <div className="rounded-xl border border-wire overflow-hidden">
          {SHORTCUTS.map((s, i) => (
            <div
              key={i}
              className={clsx(
                'flex items-center justify-between px-4 py-[10px]',
                i < SHORTCUTS.length - 1 && 'border-b border-wire',
                'hover:bg-raised/60 transition-colors',
              )}
            >
              <span className="text-[12px] text-ink-dim">{s.action}</span>
              <div className="flex items-center gap-1">
                {s.keys.map((k, j) => (
                  <span key={j} className="flex items-center gap-1">
                    <kbd className="px-1.5 py-[3px] rounded bg-raised border border-wire
                                    text-[10px] font-mono text-ink-dim leading-none">
                      {k}
                    </kbd>
                    {j < s.keys.length - 1 && (
                      <span className="text-ink-ghost text-[9px] font-mono">+</span>
                    )}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between py-4 border-t border-wire">
        <div>
          <p className="text-[13px] font-semibold text-ink">Reset All Settings</p>
          <p className="text-[12px] text-ink-dim mt-0.5">
            Restore every preference to its factory default.
          </p>
        </div>
        <button
          onClick={reset}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-wire
                     text-ink-dim text-[12px] font-medium
                     hover:text-danger hover:border-danger/35 hover:bg-danger/5
                     transition-all"
        >
          <RotateCcw size={12} />
          Reset
        </button>
      </div>
    </div>
  );
}

/* ─── SettingsPage ────────────────────────────── */

export function SettingsPage() {
  const [active, setActive] = useState<Category>('workspace');

  return (
    <div className="h-full flex flex-col dot-grid overflow-hidden">

      <div
        className="flex items-center justify-between px-8 pt-8 pb-6"
        style={{ animation: 'fade-up 0.3s ease both' }}
      >
        <div>
          <h1 className="text-[21px] font-bold text-ink tracking-tight leading-none font-display">
            Settings
          </h1>
          <p className="text-[12.5px] text-ink-dim mt-1.5 font-mono">preferences</p>
        </div>
      </div>

      <div className="mx-8 h-px bg-wire" />

      <div className="flex flex-1 overflow-hidden">

        <nav
          className="w-[180px] shrink-0 border-r border-wire pt-5 pb-4 px-3 flex flex-col gap-1"
          style={{ animation: 'slide-in 0.3s ease both' }}
        >
          <p className="text-[9px] font-mono text-ink-ghost tracking-[0.18em] uppercase px-3 mb-1.5">
            Preferences
          </p>

          {CATEGORIES.map(cat => (
            <button
              key={cat.id}
              onClick={() => setActive(cat.id)}
              className={clsx(
                'group flex flex-col w-full text-left px-3 py-2.5 rounded-lg transition-all border-l-2',
                active === cat.id
                  ? 'bg-raised text-ink border-accent'
                  : 'text-ink-dim hover:text-ink hover:bg-raised/40 border-transparent',
              )}
            >
              <span className="text-[12.5px] font-semibold leading-snug">{cat.label}</span>
              <span className={clsx(
                'text-[10px] font-mono mt-0.5 transition-colors',
                active === cat.id ? 'text-ink-dim' : 'text-ink-ghost group-hover:text-ink-dim',
              )}>
                {cat.sub}
              </span>
            </button>
          ))}
        </nav>

        <div
          key={active}
          className="flex-1 overflow-auto px-10 py-6 max-w-3xl"
          style={{ animation: 'fade-up 0.2s ease both' }}
        >
          {active === 'workspace' && <WorkspaceSection />}
          {active === 'rest'      && <RestSection      />}
          {active === 'shell'     && <ShellSection     />}
          {active === 'window'    && <WindowSection    />}
          {active === 'runlog'    && <RunLogSection    />}
          {active === 'about'     && <AboutSection     />}
        </div>
      </div>
    </div>
  );
}
