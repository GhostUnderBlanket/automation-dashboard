import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  Plus, Workflow, Clock, Play, Pencil, Timer, Globe, Terminal, GitBranch,
  Download, Upload, Trash2, AlertCircle, CalendarClock, Check, Copy, Search, X, Zap, ZapOff,
  Sun, CloudSun, Cloud, CloudRain, CloudLightning, FolderOpen, ExternalLink, Repeat2, AppWindow, Group,
} from 'lucide-react';
import { useRunLogStore } from '../store/runLogStore';
import { Select } from './ui/Select';
import type { ReactNode } from 'react';
import { clsx } from 'clsx';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { useFlowStore } from '../store/flowStore';
import { exportFlow, importFlows, parseFlowsFile } from '../lib/flowIO';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { ask } from '@tauri-apps/plugin-dialog';
import { fetchSchedulerState, type FlowJobState } from '../lib/cronService';
import { runFlowInBackground } from '../lib/backgroundRunner';
import type { Flow, NodeKind } from '../types/flow';
import { tagColor } from '../lib/tagColor';

/* ─── Helpers ──────────────────────────────────────────────── */

function ago(ts?: number): string {
  if (!ts) return 'never';
  const d = Date.now() - ts;
  if (d < 60_000)        return 'just now';
  if (d < 3_600_000)     return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000)    return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

function fromNow(ts?: number | null): string {
  if (!ts) return '—';
  const d = ts - Date.now();
  if (d < 0)             return 'now';
  if (d < 60_000)        return `${Math.ceil(d / 1_000)}s`;
  if (d < 3_600_000)     return `${Math.floor(d / 60_000)}m`;
  if (d < 86_400_000)    return `${Math.floor(d / 3_600_000)}h`;
  return `${Math.floor(d / 86_400_000)}d`;
}

/* ─── Config maps ─────────────────────────────────────────── */

const STATUS_MAP = {
  idle:    { label: 'Idle',    color: '#3f3f55', dot: 'text-ink-ghost',  pulse: false },
  running: { label: 'Running', color: '#3b82f6', dot: 'text-running',    pulse: true  },
  success: { label: 'Done',    color: '#05c58c', dot: 'text-success',    pulse: false },
  error:   { label: 'Error',   color: '#e84040', dot: 'text-danger',     pulse: false },
} as const;

const NODE_ICON: Record<NodeKind, ReactNode> = {
  trigger:   <Timer        size={10} />,
  rest:      <Globe        size={10} />,
  script:    <Terminal     size={10} />,
  condition: <GitBranch    size={10} />,
  file:      <FolderOpen   size={10} />,
  openurl:   <ExternalLink size={10} />,
  loop:      <Repeat2      size={10} />,
  launchapp: <AppWindow    size={10} />,
  group:     <Group        size={10} />,
};

const NODE_CHIP: Record<NodeKind, string> = {
  trigger:   'bg-accent/[.14] text-accent-soft',
  condition: 'bg-cyan-400/[.14] text-cyan-300',
  loop:      'bg-success/[.14] text-success',
  file:      'bg-amber-400/[.14] text-amber-300',
  script:    'bg-orange-400/[.14] text-orange-300',
  rest:      'bg-pink-400/[.14] text-pink-300',
  openurl:   'bg-violet-400/[.14] text-violet-300',
  launchapp: 'bg-rose-400/[.14] text-rose-300',
  group:     'bg-purple-400/[.14] text-purple-300',
};

/* ─── Weather (run health) ─────────────────────────────────── */

type Weather = 'sunny' | 'partly-cloudy' | 'cloudy' | 'rainy' | 'stormy';

const WEATHER_CFG: Record<Weather, { icon: ReactNode; color: string; label: string }> = {
  'sunny':        { icon: <Sun          size={18} />, color: 'text-yellow-400', label: 'All recent runs succeeded'    },
  'partly-cloudy':{ icon: <CloudSun     size={18} />, color: 'text-yellow-300', label: 'Most recent runs succeeded'   },
  'cloudy':       { icon: <Cloud        size={18} />, color: 'text-ink-dim',    label: 'Mixed recent run results'     },
  'rainy':        { icon: <CloudRain    size={18} />, color: 'text-blue-400',   label: 'Most recent runs failed'      },
  'stormy':       { icon: <CloudLightning size={18} />, color: 'text-danger',   label: 'All recent runs failed'       },
};

function calcWeather(flowId: string, sessions: { flowId: string; status: string }[]): Weather | null {
  const recent = sessions.filter(s => s.flowId === flowId && s.status !== 'running').slice(0, 5);
  if (recent.length === 0) return null;
  const rate = recent.filter(s => s.status === 'success').length / recent.length;
  if (rate >= 1.0)  return 'sunny';
  if (rate >= 0.8)  return 'partly-cloudy';
  if (rate >= 0.6)  return 'cloudy';
  if (rate >= 0.4)  return 'rainy';
  return 'stormy';
}

/* ─── Tag colors ───────────────────────────────────────────── */


/* ─── Checkbox ─────────────────────────────────────────────── */

function Checkbox({ checked, onChange, className }: {
  checked: boolean; onChange: (v: boolean) => void; className?: string;
}) {
  return (
    <button
      type="button"
      onClick={e => { e.stopPropagation(); onChange(!checked); }}
      className={clsx(
        'w-[16px] h-[16px] rounded border flex items-center justify-center shrink-0 transition-colors',
        checked
          ? 'bg-accent border-accent'
          : 'border-wire-lit bg-raised hover:border-accent/60',
        className,
      )}
    >
      {checked && <Check size={10} className="text-white" strokeWidth={2.5} />}
    </button>
  );
}

/* ─── FlowCard ─────────────────────────────────────────────── */

function FlowCard({ flow, index, schedule, weather, selected, onToggleSelect, onEdit, onRun, onToggleArm, onTagClick }: {
  flow: Flow; index: number;
  schedule?: FlowJobState;
  weather?: Weather | null;
  selected:       boolean;
  onToggleSelect: () => void;
  onEdit:         () => void;
  onRun:          () => void;
  onToggleArm:    () => void;
  onTagClick:     (tag: string) => void;
}) {
  const s = STATUS_MAP[flow.status];
  const types = [...new Set(flow.nodes.map((n) => n.type))];
  const cronTrigger = flow.nodes.find(n => n.type === 'trigger' && (n.data as { mode?: string }).mode === 'cron');
  const isCron  = !!cronTrigger;
  const isArmed = cronTrigger ? (cronTrigger.data as { enabled?: boolean }).enabled !== false : false;

  return (
    <div
      onClick={onToggleSelect}
      className={clsx(
        'group flex overflow-hidden rounded-xl border bg-surface',
        'hover:-translate-y-[2px] hover:shadow-xl hover:shadow-black/40',
        'transition-all duration-200 cursor-pointer',
        selected
          ? 'border-accent/50 bg-accent/[.03]'
          : 'border-wire hover:border-wire-lit',
      )}
      style={{
        animation:      'fade-up 0.4s ease both',
        animationDelay: `${index * 65}ms`,
      }}
    >
      {/* Status strip */}
      <div
        className="w-[3px] shrink-0"
        style={{
          background: selected ? '#6d5bef' : s.color,
          animation:  flow.status === 'running' ? 'bar-breathe 2s ease-in-out infinite' : undefined,
        }}
      />

      {/* Card body */}
      <div className="flex-1 min-w-0 p-5 flex flex-col gap-3">

        {/* Row 1: checkbox + status */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Checkbox
              checked={selected}
              onChange={onToggleSelect}
              className={selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}
            />
            <span className="text-[11px] font-mono text-ink-ghost tracking-widest">
              {String(index + 1).padStart(2, '0')}
            </span>
          </div>
          <span className={clsx('flex items-center gap-1.5 text-[11px] font-mono', s.dot)}>
            <span
              className="w-[6px] h-[6px] rounded-full bg-current"
              style={s.pulse ? { animation: 'pulse-dot 1.4s ease-in-out infinite' } : undefined}
            />
            {s.label}
          </span>
        </div>

        {/* Row 2: name + description */}
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1.5 min-w-0">
            {weather && (() => {
              const cfg = WEATHER_CFG[weather];
              return <span className={clsx('shrink-0', cfg.color)} title={cfg.label}>{cfg.icon}</span>;
            })()}
            <h3 className="text-[14.5px] font-semibold text-ink leading-snug truncate font-display">
              {flow.name}
            </h3>
          </div>
          <p className="text-[12px] text-ink-dim leading-relaxed line-clamp-2">
            {flow.description || 'No description.'}
          </p>
        </div>

        {/* Row 3: node type chips (max 3 visible) */}
        {types.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {types.slice(0, 3).map((type) => (
              <span
                key={type}
                className={clsx(
                  'inline-flex items-center gap-1 px-2 py-[3px] rounded-md text-[10.5px] font-medium font-mono',
                  NODE_CHIP[type],
                )}
              >
                {NODE_ICON[type]}
                {type}
              </span>
            ))}
            {types.length > 3 && (
              <span className="inline-flex items-center px-2 py-[3px] rounded-md text-[10.5px] font-mono bg-ink-ghost/10 text-ink-ghost">
                +{types.length - 3} more
              </span>
            )}
          </div>
        )}

        {/* Tags */}
        {(flow.tags ?? []).length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {(flow.tags ?? []).map(tag => (
              <button
                key={tag}
                onClick={e => { e.stopPropagation(); onTagClick(tag); }}
                className={clsx(
                  'inline-flex items-center px-2 py-[2px] rounded-full text-[10px] font-mono border transition-opacity hover:opacity-80',
                  tagColor(tag),
                )}
              >
                {tag}
              </button>
            ))}
          </div>
        )}

        {/* Row 4: footer stats + Edit/Run */}
        <div className="flex items-center justify-between pt-2.5 border-t border-wire mt-auto">
          <div className="flex items-center gap-3 text-[11px] font-mono text-ink-ghost">
            <span className="flex items-center gap-1">
              <Clock size={11} />
              {ago(flow.lastRun)}
            </span>
            {schedule?.nextFire && (
              <span
                className="flex items-center gap-1 text-accent-soft"
                title={`Cron: ${schedule.cron} — next fire ${new Date(schedule.nextFire).toLocaleString()}`}
              >
                <CalendarClock size={11} />
                in {fromNow(schedule.nextFire)}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            {isCron && (
              <button
                onClick={e => { e.stopPropagation(); onToggleArm(); }}
                title={isArmed ? 'Disarm schedule' : 'Arm schedule'}
                className={clsx(
                  'p-1.5 rounded-md transition-colors',
                  isArmed
                    ? 'text-success hover:text-success/70 hover:bg-raised'
                    : 'text-ink-ghost/50 hover:text-ink-ghost hover:bg-raised',
                )}
              >
                {isArmed ? <Zap size={12} fill="currentColor" /> : <ZapOff size={12} />}
              </button>
            )}
            <button
              onClick={e => { e.stopPropagation(); onEdit(); }}
              className="p-1.5 rounded-md text-ink-ghost hover:text-ink hover:bg-raised transition-colors"
              title="Edit"
            >
              <Pencil size={12} />
            </button>
            <button
              onClick={e => { e.stopPropagation(); onRun(); }}
              disabled={flow.status === 'running'}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md
                         bg-accent/[.12] text-accent-soft hover:bg-accent/[.22]
                         text-[11px] font-medium transition-colors
                         disabled:opacity-50 disabled:cursor-not-allowed"
              title="Run"
            >
              <Play size={10} fill="currentColor" />
              Run
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── EmptyState ───────────────────────────────────────────── */

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full pb-16">
      <div
        className="w-[52px] h-[52px] rounded-2xl bg-surface border border-wire
                   flex items-center justify-center mb-5"
        style={{ animation: 'fade-up 0.4s ease both' }}
      >
        <Workflow size={22} className="text-ink-ghost" />
      </div>
      <h3
        className="text-[15px] font-semibold text-ink mb-2 font-display"
        style={{ animation: 'fade-up 0.4s ease 80ms both' }}
      >
        No flows yet
      </h3>
      <p
        className="text-[13px] text-ink-dim text-center max-w-[256px] leading-relaxed mb-7"
        style={{ animation: 'fade-up 0.4s ease 140ms both' }}
      >
        Build your first automation flow to schedule tasks, run scripts, or call REST APIs.
      </p>
      <button
        onClick={onNew}
        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-white
                   text-[13px] font-semibold hover:bg-accent/90 active:scale-[.97]
                   transition-all shadow-lg shadow-accent/25"
        style={{ animation: 'fade-up 0.4s ease 200ms both' }}
      >
        <Plus size={14} strokeWidth={2.5} />
        Create Flow
      </button>
    </div>
  );
}

/* ─── Bulk helpers ─────────────────────────────────────────── */

async function exportFlows(flows: Flow[], setError: (e: string | null) => void) {
  setError(null);
  if (flows.length === 0) return;

  const includeVars = await ask(
    'Include flow variables in the export?',
    { title: 'Export options', kind: 'info' },
  );

  if (flows.length === 1) {
    try { await exportFlow(flows[0], includeVars); }
    catch (e) { setError(`Export failed: ${String(e)}`); }
    return;
  }

  // Multiple: bundle into one file.
  try {
    const target = await saveDialog({
      title:       `Export ${flows.length} flows`,
      defaultPath: `autoflow-flows-${new Date().toISOString().slice(0, 10)}.json`,
      filters:     [{ name: 'JSON', extensions: ['json'] }],
    });
    if (!target) return;
    const processedFlows = includeVars ? flows : flows.map(f => ({ ...f, variables: Object.fromEntries(Object.keys(f.variables ?? {}).map(k => [k, ''])) }));
    const payload = JSON.stringify({
      $schema:    'autoflow.flows',
      version:    1,
      exportedAt: Date.now(),
      count:      processedFlows.length,
      flows:      processedFlows,
    }, null, 2);
    await invoke('write_text_file', { opts: { path: target, content: payload } });
  } catch (e) {
    setError(`Export failed: ${String(e)}`);
  }
}

/* ─── HomePage ─────────────────────────────────────────────── */

export function HomePage() {
  const { flows, addFlow, updateFlow, setActiveFlow, setView, deleteFlow, duplicateFlow } = useFlowStore();
  const sessions = useRunLogStore(s => s.sessions);
  const [opError,      setOpError]    = useState<string | null>(null);
  const [dragOver,     setDragOver]   = useState(false);
  const [schedules,    setSchedules]  = useState<Map<string, FlowJobState>>(new Map());
  const [selectedIds,  setSelected]   = useState<Set<string>>(new Set());
  const [search,         setSearch]        = useState('');
  const [statusFilter,   setStatusFilter]  = useState('all');
  const [triggerFilter,  setTriggerFilter] = useState('all');
  const [tagFilter,      setTagFilter]     = useState('all');

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const list = await fetchSchedulerState();
      if (!alive) return;
      setSchedules(new Map(list.map(s => [s.flowId, s])));
    };
    void tick();
    const id = setInterval(tick, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, [flows]);

  // Tauri drag-and-drop: listen for .flow.json files dropped onto the window.
  useEffect(() => {
    const win = getCurrentWebviewWindow();
    let unlisten: (() => void) | undefined;
    win.onDragDropEvent(async event => {
      const p = event.payload as { type: string; paths?: string[] };
      if (p.type === 'over' || p.type === 'enter') {
        setDragOver(true);
      } else if (p.type === 'cancel' || p.type === 'leave') {
        setDragOver(false);
      } else if (p.type === 'drop') {
        setDragOver(false);
        const jsonPaths = (p.paths ?? []).filter(path => path.toLowerCase().endsWith('.json'));
        if (jsonPaths.length === 0) return;
        setOpError(null);
        let imported = 0;
        for (const path of jsonPaths) {
          try {
            const text = await invoke<string>('read_text_file', { path });
            const flows = parseFlowsFile(text);
            for (const flow of flows) addFlow(flow);
            imported += flows.length;
          } catch { /* skip unreadable or invalid files */ }
        }
        if (imported === 0) setOpError('No valid flow files found in dropped files.');
      }
    }).then(fn => { unlisten = fn; });
    return () => { unlisten?.(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Drop stale selections when flows are removed.
  useEffect(() => {
    const validIds = new Set(flows.map(f => f.id));
    setSelected(prev => {
      const next = new Set([...prev].filter(id => validIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [flows]);

  const toggleSelect = useCallback((id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const selectAll   = () => setSelected(new Set(filteredFlows.map(f => f.id)));
  const selectNone  = () => setSelected(new Set());
  const allTags = useMemo(() => {
    const s = new Set<string>();
    for (const f of flows) for (const t of f.tags ?? []) s.add(t);
    return [...s].sort();
  }, [flows]);

  const filteredFlows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return flows.filter(f => {
      if (statusFilter !== 'all' && f.status !== statusFilter) return false;
      if (triggerFilter !== 'all') {
        const hasCron = f.nodes.some(n => n.type === 'trigger' && (n.data as { mode?: string }).mode === 'cron');
        if (triggerFilter === 'cron'   && !hasCron) return false;
        if (triggerFilter === 'manual' &&  hasCron) return false;
      }
      if (tagFilter !== 'all' && !(f.tags ?? []).includes(tagFilter)) return false;
      if (q && !f.name.toLowerCase().includes(q) && !(f.description ?? '').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [flows, search, statusFilter, triggerFilter, tagFilter]);

  const weatherMap = useMemo(() => {
    const map = new Map<string, Weather>();
    for (const flow of flows) {
      const w = calcWeather(flow.id, sessions);
      if (w) map.set(flow.id, w);
    }
    return map;
  }, [sessions, flows]);

  const allSelected = filteredFlows.length > 0 && filteredFlows.every(f => selectedIds.has(f.id));
  const nSelected   = selectedIds.size;

  function handleNewFlow() {
    const id = `flow-${Date.now()}`;
    addFlow({
      id, name: 'New Flow', description: '',
      variables: {},
      nodes: [{ id: 'trigger-1', type: 'trigger', label: 'Manual', position: { x: 80, y: 80 }, data: { mode: 'manual' } }],
      edges: [], status: 'idle',
      createdAt: Date.now(), updatedAt: Date.now(),
    });
    setActiveFlow(id);
    setView('editor');
  }

  function handleEdit(id: string) {
    setActiveFlow(id);
    setView('editor');
  }

  function handleQuickRun(id: string) {
    runFlowInBackground(id, 'manual');
  }

  function handleToggleArm(id: string) {
    const flow = flows.find(f => f.id === id);
    if (!flow) return;
    const nodes = flow.nodes.map(n => {
      if (n.type !== 'trigger' || (n.data as { mode?: string }).mode !== 'cron') return n;
      const currentEnabled = (n.data as { enabled?: boolean }).enabled !== false;
      return { ...n, data: { ...n.data, enabled: !currentEnabled } };
    });
    updateFlow(id, { nodes, updatedAt: Date.now() });
  }

  async function handleImportFlow() {
    setOpError(null);
    try {
      const imported = await importFlows();
      for (const flow of imported) addFlow(flow);
    } catch (e) {
      setOpError(`Import failed: ${String(e)}`);
    }
  }

  function handleDuplicateSelected() {
    for (const id of selectedIds) duplicateFlow(id);
    selectNone();
  }

  function handleDeleteSelected() {
    const names = flows.filter(f => selectedIds.has(f.id)).map(f => `"${f.name}"`).join(', ');
    if (!confirm(`Delete ${nSelected} flow${nSelected !== 1 ? 's' : ''}: ${names}?\n\nThis cannot be undone.`)) return;
    for (const id of selectedIds) deleteFlow(id);
    selectNone();
  }

  function handleExportSelected() {
    const selected = flows.filter(f => selectedIds.has(f.id));
    void exportFlows(selected, setOpError);
  }

  return (
    <div className="h-full flex flex-col dot-grid overflow-hidden relative">

      {dragOver && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center pointer-events-none"
             style={{ background: 'rgba(109,91,239,0.08)', border: '2px dashed rgba(109,91,239,0.5)' }}>
          <Download size={32} className="text-accent mb-3" />
          <p className="text-[14px] font-semibold text-ink">Drop to import flow</p>
          <p className="text-[11.5px] text-ink-dim mt-1 font-mono">.flow.json files</p>
        </div>
      )}

      {/* Header */}
      <div
        className="flex items-end justify-between px-8 pt-8 pb-6"
        style={{ animation: 'fade-up 0.35s ease both' }}
      >
        <div className="flex items-end gap-4">
          <div>
            <h1 className="text-[21px] font-bold text-ink tracking-tight leading-none font-display">
              Flows
            </h1>
            <p className="text-[12.5px] text-ink-dim mt-1.5 font-mono">
              {flows.length}&nbsp;automation{flows.length !== 1 ? 's' : ''}
            </p>
          </div>

          {/* Select-all checkbox */}
          {flows.length > 0 && (
            <div className="flex items-center gap-2 mb-[3px]">
              <Checkbox
                checked={allSelected}
                onChange={v => v ? selectAll() : selectNone()}
              />
              <span className="text-[11.5px] font-mono text-ink-ghost">
                {nSelected > 0 ? `${nSelected} selected` : 'select all'}
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Contextual bulk actions — visible only when something is selected */}
          {nSelected > 0 && (
            <>
              <button
                onClick={handleDuplicateSelected}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-wire
                           bg-surface text-ink hover:bg-raised hover:border-wire-lit
                           transition-colors text-[12.5px] font-medium"
                title={`Duplicate ${nSelected} flow${nSelected !== 1 ? 's' : ''}`}
              >
                <Copy size={13} />
                Duplicate{nSelected > 1 && <span className="ml-0.5 font-mono text-ink-dim">({nSelected})</span>}
              </button>
              <button
                onClick={handleExportSelected}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-wire
                           bg-surface text-ink hover:bg-raised hover:border-wire-lit
                           transition-colors text-[12.5px] font-medium"
                title={`Export ${nSelected} flow${nSelected !== 1 ? 's' : ''}`}
              >
                <Upload size={13} />
                Export{nSelected > 1 && <span className="ml-0.5 text-accent-soft font-mono">({nSelected})</span>}
              </button>
              <button
                onClick={handleDeleteSelected}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-danger/30
                           bg-danger/[.06] text-danger hover:bg-danger/[.14]
                           transition-colors text-[12.5px] font-medium"
                title={`Delete ${nSelected} flow${nSelected !== 1 ? 's' : ''}`}
              >
                <Trash2 size={13} />
                Delete{nSelected > 1 && <span className="ml-0.5 font-mono">({nSelected})</span>}
              </button>
              <div className="w-px h-5 bg-wire mx-1" />
            </>
          )}

          <button
            onClick={handleImportFlow}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-wire
                       bg-surface text-ink hover:bg-raised hover:border-wire-lit
                       transition-colors text-[12.5px] font-medium"
            title="Import flow from .json file"
          >
            <Download size={13} />
            Import
          </button>
          <button
            onClick={handleNewFlow}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-white
                       text-[13px] font-semibold hover:bg-accent/90 active:scale-[.97]
                       transition-all shadow-lg shadow-accent/25"
          >
            <Plus size={14} strokeWidth={2.5} />
            New Flow
          </button>
        </div>
      </div>

      {opError && (
        <div className="mx-8 mb-2 rounded-lg border border-danger/40 bg-danger/10 px-4 py-2.5 flex items-start gap-2.5">
          <AlertCircle size={13} className="text-danger mt-[2px] shrink-0" />
          <pre className="text-[11.5px] font-mono text-danger whitespace-pre-wrap leading-relaxed flex-1 min-w-0">
            {opError}
          </pre>
          <button onClick={() => setOpError(null)} className="text-danger/70 hover:text-danger text-[11px] shrink-0">
            dismiss
          </button>
        </div>
      )}

      <div className="mx-8 h-px bg-wire" />

      {/* Filter bar */}
      {flows.length > 0 && (
        <div className="px-8 py-3 flex items-center gap-3 border-b border-wire/60">
          <div className="w-[150px]">
            <Select
              value={statusFilter}
              options={[
                { value: 'all',     label: 'All statuses' },
                { value: 'idle',    label: 'Idle'         },
                { value: 'running', label: 'Running'      },
                { value: 'success', label: 'Done'         },
                { value: 'error',   label: 'Error'        },
              ]}
              onChange={setStatusFilter}
            />
          </div>
          <div className="w-[150px]">
            <Select
              value={triggerFilter}
              options={[
                { value: 'all',    label: 'All triggers' },
                { value: 'manual', label: 'Manual'       },
                { value: 'cron',   label: 'Cron'         },
              ]}
              onChange={setTriggerFilter}
            />
          </div>
          {allTags.length > 0 && (
            <div className="w-[150px]">
              <Select
                value={tagFilter}
                options={[
                  { value: 'all', label: 'All tags' },
                  ...allTags.map(t => ({ value: t, label: t })),
                ]}
                onChange={setTagFilter}
              />
            </div>
          )}
          <div className="relative ml-auto">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-ghost pointer-events-none" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search flows…"
              spellCheck={false}
              className="pl-8 pr-8 py-[5px] rounded-md bg-raised border border-wire text-ink
                         text-[11.5px] placeholder-ink-ghost w-[220px]
                         focus:outline-none focus:border-wire-lit transition-colors"
            />
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-ghost hover:text-ink">
                <X size={11} />
              </button>
            )}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-auto px-8 py-6">
        {flows.length === 0 ? (
          <EmptyState onNew={handleNewFlow} />
        ) : filteredFlows.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full pb-16">
            <p className="text-[13px] text-ink-dim font-mono">No flows match the current filters.</p>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-4">
            {filteredFlows.map((flow, i) => (
              <FlowCard
                key={flow.id}
                flow={flow}
                index={i}
                schedule={schedules.get(flow.id)}
                weather={weatherMap.get(flow.id)}
                selected={selectedIds.has(flow.id)}
                onToggleSelect={() => toggleSelect(flow.id)}
                onEdit={() => handleEdit(flow.id)}
                onRun={() => handleQuickRun(flow.id)}
                onToggleArm={() => handleToggleArm(flow.id)}
                onTagClick={tag => setTagFilter(tag)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
