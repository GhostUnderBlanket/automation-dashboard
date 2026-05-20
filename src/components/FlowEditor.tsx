import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Panel,
  useReactFlow,
  useNodesState,
  useEdgesState,
  addEdge,
  getBezierPath,
  BaseEdge,
  type EdgeProps,
  type Node,
  type Edge,
  type Connection,
  type NodeMouseHandler,
} from '@xyflow/react';
import {
  ArrowLeft, Plus, Save, Play, Square, Undo2, Redo2,
  Timer, Globe, Terminal, GitBranch, ChevronDown,
  ZoomIn, ZoomOut, Maximize2, FolderOpen, ExternalLink, Repeat2,
  FileText, Braces,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useFlowStore } from '../store/flowStore';
import { useSettingsStore } from '../store/settingsStore';
import { useRunLogStore } from '../store/runLogStore';
import { runFlow, type RunHandle } from '../lib/executor';
import { nodeTypes } from './nodes';
import { NodePanel } from './NodePanel';
import { LogPanel } from './LogPanel';
import { FlowVarsPanel } from './FlowVarsPanel';
import { InfoPanel } from './InfoPanel';
import type { FlowNode, FlowEdge, LogEntry, NodeKind } from '../types/flow';

/* ─── Helpers ────────────────────────────────── */

type NodeStatus = 'running' | 'success' | 'error';

function toRFNodes(ns: FlowNode[]): Node[] {
  return ns.map(n => ({
    id: n.id, type: n.type, position: n.position,
    data: { label: n.label, ...n.data },
  }));
}

function edgeStyleFor(h: string | null | undefined) {
  if (h === 'false') return { stroke: '#e84040', strokeWidth: 1.5, strokeDasharray: '5 4' };
  if (h === 'true')  return { stroke: '#05c58c', strokeWidth: 1.5, strokeDasharray: '5 4' };
  return { stroke: '#2e2e3c', strokeWidth: 1.5 };
}

function DeletableEdge({
  id, sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition, selected, style,
}: EdgeProps) {
  const { setEdges } = useReactFlow();
  const [hovered, setHovered] = useState(false);
  const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const show = hovered || selected;

  return (
    <g
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Wider invisible hit area */}
      <path d={edgePath} fill="none" stroke="transparent" strokeWidth={12} />
      <BaseEdge path={edgePath} style={style ?? { stroke: '#2e2e3c', strokeWidth: 1.5 }} />
      {show && (
        <foreignObject
          x={labelX - 9} y={labelY - 9} width={18} height={18}
          style={{ overflow: 'visible' }}
        >
          <button
            onClick={() => setEdges(es => es.filter(e => e.id !== id))}
            style={{
              width: 18, height: 18, borderRadius: '50%',
              background: '#e84040', border: 'none', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', fontSize: 10, fontWeight: 700, lineHeight: 1,
              boxShadow: '0 2px 6px rgba(0,0,0,0.5)',
            }}
            title="Disconnect edge"
          >
            ✕
          </button>
        </foreignObject>
      )}
    </g>
  );
}

const EDGE_TYPES = { default: DeletableEdge };

function toRFEdges(es: FlowEdge[]): Edge[] {
  return es.map(e => ({
    id: e.id, source: e.source, target: e.target,
    sourceHandle: e.sourceHandle ?? null,
    style: edgeStyleFor(e.sourceHandle),
  }));
}

function toStoreNodes(ns: Node[]): FlowNode[] {
  return ns.map(n => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { label, _runStatus, ...rest } = (n.data ?? {}) as Record<string, unknown>;
    return {
      id: n.id, type: (n.type ?? 'script') as NodeKind,
      label: (label ?? '') as string, position: n.position, data: rest,
    };
  });
}

function toStoreEdges(es: Edge[]): FlowEdge[] {
  return es.map(e => ({
    id: e.id, source: e.source, target: e.target,
    sourceHandle: e.sourceHandle ?? undefined,
  }));
}

function stripRunStatus(ns: Node[]): Node[] {
  return ns.map(n => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _runStatus, ...rest } = (n.data ?? {}) as Record<string, unknown>;
    return { ...n, data: rest };
  });
}

/* ─── Add-node config ────────────────────────── */

const ADD_ITEMS = [
  { type: 'trigger'   as NodeKind, icon: <Timer size={13} />,       label: 'Trigger',   color: '#6d5bef', defaults: { mode: 'manual' }                                               },
  { type: 'condition' as NodeKind, icon: <GitBranch size={13} />,   label: 'Condition', color: '#00bfff', defaults: { source: '${prev}', op: 'nonempty' }                             },
  { type: 'loop'      as NodeKind, icon: <Repeat2 size={13} />,     label: 'Loop',      color: '#05c58c', defaults: { mode: 'repeat', count: 3 }                                     },
  { type: 'file'      as NodeKind, icon: <FolderOpen size={13} />,  label: 'File',      color: '#f59e0b', defaults: { operation: 'read', path: '', content: '' }                     },
  { type: 'script'    as NodeKind, icon: <Terminal size={13} />,    label: 'Script',    color: '#f97316', defaults: { shell: 'cmd', script: '', workDir: '' }                         },
  { type: 'rest'      as NodeKind, icon: <Globe size={13} />,       label: 'REST API',  color: '#ec4899', defaults: { method: 'POST', endpoint: '', bodyMode: 'form', bodyRows: [] }  },
  { type: 'openurl'   as NodeKind, icon: <ExternalLink size={13} />,label: 'Open URL',  color: '#a78bfa', defaults: { url: '' }                                                       },
];

function mkLog(message: string, level: LogEntry['level'] = 'info'): LogEntry {
  return { id: Math.random().toString(36).slice(2), timestamp: Date.now(), level, message };
}

/* ─── History ────────────────────────────────── */

interface Snapshot { nodes: Node[]; edges: Edge[] }
const MAX_HIST = 50;

/* ─── Toolbar ────────────────────────────────── */

interface ToolbarProps {
  flowName: string; isRunning: boolean; isDirty: boolean;
  canUndo: boolean; canRedo: boolean; hasTrigger: boolean;
  onBack: () => void; onNameChange: (v: string) => void;
  onAddNode: (t: NodeKind) => void;
  onSave: () => void; onRun: () => void; onStop: () => void;
  onUndo: () => void; onRedo: () => void;
}

function Toolbar({ flowName, isRunning, isDirty, canUndo, canRedo, hasTrigger, onBack, onNameChange, onAddNode, onSave, onRun, onStop, onUndo, onRedo }: ToolbarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const h = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as HTMLElement)) setMenuOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [menuOpen]);

  return (
    <div className="h-[44px] shrink-0 flex items-center gap-2 px-4 border-b border-wire bg-surface">
      <button onClick={onBack} className="flex items-center gap-1.5 text-ink-dim hover:text-ink transition-colors">
        <ArrowLeft size={14} />
        <span className="text-[12px] font-mono">flows</span>
      </button>
      <span className="text-ink-ghost text-[12px] select-none">/</span>
      <input
        value={flowName}
        onChange={e => onNameChange(e.target.value)}
        className="bg-transparent text-ink text-[14px] font-semibold font-display border-0 outline-none min-w-0 flex-1 max-w-[280px]"
        spellCheck={false}
      />
      <div className="flex-1" />

      <div className="flex items-center gap-0.5">
        <button onClick={onUndo} disabled={!canUndo || isRunning} title="Undo (Ctrl+Z)"
          className="p-1.5 rounded-md text-ink-ghost hover:text-ink hover:bg-raised disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
          <Undo2 size={13} />
        </button>
        <button onClick={onRedo} disabled={!canRedo || isRunning} title="Redo (Ctrl+Y)"
          className="p-1.5 rounded-md text-ink-ghost hover:text-ink hover:bg-raised disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
          <Redo2 size={13} />
        </button>
      </div>
      <div className="w-px h-4 bg-wire mx-0.5" />

      <div className="relative" ref={menuRef}>
        <button
          onClick={() => setMenuOpen(v => !v)}
          className={clsx('flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[12px] font-medium transition-all',
            menuOpen ? 'border-wire-lit text-ink bg-raised' : 'border-wire text-ink-dim hover:text-ink hover:border-wire-lit')}
        >
          <Plus size={13} strokeWidth={2.5} />
          Add Node
          <ChevronDown size={11} className={clsx('transition-transform', menuOpen && 'rotate-180')} />
        </button>
        {menuOpen && (
          <div className="absolute right-0 top-full mt-1.5 w-[176px] bg-surface border border-wire rounded-xl overflow-hidden shadow-xl shadow-black/50 z-50" style={{ animation: 'fade-up 0.15s ease both' }}>
            {ADD_ITEMS.map(item => {
              const disabled = item.type === 'trigger' && hasTrigger;
              return (
                <button key={item.type}
                  onClick={() => { if (!disabled) { onAddNode(item.type); setMenuOpen(false); } }}
                  disabled={disabled}
                  title={disabled ? 'A flow can only have one trigger' : undefined}
                  className={clsx(
                    'flex items-center gap-2.5 w-full px-3 py-2.5 transition-colors text-left',
                    disabled ? 'opacity-35 cursor-not-allowed' : 'hover:bg-raised',
                  )}>
                  <span style={{ color: item.color }}>{item.icon}</span>
                  <span className="text-[12.5px] text-ink font-medium">{item.label}</span>
                  <span className="ml-auto text-[9px] font-mono px-1.5 py-0.5 rounded" style={{ color: item.color, background: `${item.color}18` }}>{item.type}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <button onClick={onSave}
        className={clsx('flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[12px] font-medium transition-all',
          isDirty ? 'border-accent/40 text-accent-soft hover:border-accent bg-accent/8' : 'border-wire text-ink-dim hover:text-ink hover:border-wire-lit')}>
        <Save size={13} />
        Save
        {isDirty && <span className="w-1.5 h-1.5 rounded-full bg-accent ml-0.5" />}
      </button>

      {isRunning ? (
        <button onClick={onStop} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-danger/15 text-danger border border-danger/25 text-[12px] font-medium hover:bg-danger/25 transition-all">
          <Square size={11} fill="currentColor" />Stop
        </button>
      ) : (
        <button onClick={onRun} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-white text-[12px] font-semibold hover:bg-accent/90 active:scale-[.97] transition-all shadow-md shadow-accent/20">
          <Play size={12} fill="currentColor" />Run
        </button>
      )}
    </div>
  );
}

/* ─── Custom Controls ────────────────────────── */

function CustomControls({ theme }: { theme: 'dark' | 'light' }) {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const bg        = theme === 'light' ? '#ffffff' : '#1e1e1e';
  const border    = theme === 'light' ? '#e0e0ec' : '#2e3033';
  const text      = theme === 'light' ? '#58588a' : '#888888';
  const textHover = theme === 'light' ? '#1a1a2e' : '#e2e2e2';
  const hoverBg   = theme === 'light' ? '#ededf4' : '#282828';

  const btn = (onClick: () => void, label: string, icon: React.ReactNode) => (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className="w-[26px] h-[26px] flex items-center justify-center transition-colors first:rounded-t-[7px] last:rounded-b-[7px]"
      style={{ background: bg, color: text }}
      onMouseEnter={e => { e.currentTarget.style.background = hoverBg; e.currentTarget.style.color = textHover; }}
      onMouseLeave={e => { e.currentTarget.style.background = bg; e.currentTarget.style.color = text; }}
    >
      {icon}
    </button>
  );

  return (
    <Panel position="bottom-left">
      <div
        className="flex flex-col rounded-lg overflow-hidden border"
        style={{
          background: bg,
          borderColor: border,
          boxShadow: theme === 'light' ? '0 4px 16px rgba(0,0,0,0.1)' : '0 8px 24px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{ borderBottom: `1px solid ${border}` }}>
          {btn(() => zoomIn(),  'Zoom in',  <ZoomIn size={14} />)}
        </div>
        <div style={{ borderBottom: `1px solid ${border}` }}>
          {btn(() => zoomOut(), 'Zoom out', <ZoomOut size={14} />)}
        </div>
        {btn(() => fitView({ padding: 0.4, duration: 300 }), 'Fit view', <Maximize2 size={14} />)}
      </div>
    </Panel>
  );
}

function FitViewOnOpen({ flowId }: { flowId: string | null }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (!flowId) return;
    const t = setTimeout(() => fitView({ padding: 0.4, duration: 300 }), 50);
    return () => clearTimeout(t);
  }, [flowId, fitView]);
  return null;
}

function CanvasControls({ theme, rightPanel, onToggle }: {
  theme: 'dark' | 'light';
  rightPanel: 'info' | 'vars' | null;
  onToggle: (panel: 'info' | 'vars') => void;
}) {
  const bg        = theme === 'light' ? '#ffffff' : '#1e1e1e';
  const border    = theme === 'light' ? '#e0e0ec' : '#2e3033';
  const text      = theme === 'light' ? '#58588a' : '#888888';
  const textHover = theme === 'light' ? '#1a1a2e' : '#e2e2e2';
  const hoverBg   = theme === 'light' ? '#ededf4' : '#282828';

  const btn = (id: 'info' | 'vars', label: string, icon: React.ReactNode) => {
    const active = rightPanel === id;
    return (
      <button
        onClick={() => onToggle(id)}
        aria-label={label} title={label}
        className="w-[26px] h-[26px] flex items-center justify-center transition-colors first:rounded-t-[7px] last:rounded-b-[7px]"
        style={{ background: active ? hoverBg : bg, color: active ? textHover : text }}
        onMouseEnter={e => { e.currentTarget.style.background = hoverBg; e.currentTarget.style.color = textHover; }}
        onMouseLeave={e => { e.currentTarget.style.background = active ? hoverBg : bg; e.currentTarget.style.color = active ? textHover : text; }}
      >
        {icon}
      </button>
    );
  };

  return (
    <Panel position="top-right">
      <div
        className="flex flex-col rounded-lg overflow-hidden border"
        style={{
          background: bg,
          borderColor: border,
          boxShadow: theme === 'light' ? '0 4px 16px rgba(0,0,0,0.1)' : '0 8px 24px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{ borderBottom: `1px solid ${border}` }}>
          {btn('info', 'Info & Tags', <FileText size={14} />)}
        </div>
        {btn('vars', 'Flow Variables', <Braces size={14} />)}
      </div>
    </Panel>
  );
}

/* ─── FlowEditor ─────────────────────────────── */

const DEFAULT_EDGE_OPTIONS = {};

export function FlowEditor() {
  const { flows, activeFlowId, setView, updateFlow } = useFlowStore();
  const navRequest     = useFlowStore(s => s.navRequest);
  const clearNavRequest= useFlowStore(s => s.clearNavRequest);
  const setEditorDirty = useFlowStore(s => s.setEditorDirty);
  const flow = flows.find(f => f.id === activeFlowId);
  const theme = useSettingsStore(s => s.settings.theme);
  const canvasBg  = theme === 'light' ? '#f5f5fa' : '#111214';
  const dotColor  = theme === 'light' ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.06)';

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(flow ? toRFNodes(flow.nodes) : []);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(flow ? toRFEdges(flow.edges) : []);

  const [flowName,     setFlowName]    = useState(flow?.name ?? 'New Flow');
  const [description,  setDescription] = useState(flow?.description ?? '');
  const [rightPanel,   setRightPanel]  = useState<'info' | 'vars' | null>(null);
  const [variables,    setVariables]   = useState<{ key: string; value: string }[]>(
    Object.entries(flow?.variables ?? {}).map(([key, value]) => ({ key, value }))
  );
  const [tags,         setTags]        = useState<string[]>(flow?.tags ?? []);
  const [selectedId,   setSelectedId]  = useState<string | null>(null);
  const [logOpen,      setLogOpen]     = useState(false);
  const [logs,         setLogs]        = useState<LogEntry[]>([]);
  const [isRunning,    setIsRunning]   = useState(false);
  const [isDirty,      setIsDirty]     = useState(false);
  const [showExitDlg,  setShowExitDlg] = useState(false);
  const [exitTarget,   setExitTarget]  = useState<'home' | 'editor' | 'settings' | 'runlog'>('home');
  const [nodeStatuses, setNodeStatuses]= useState<Map<string, NodeStatus>>(new Map());

  // ── History ──────────────────────────────────────────────────────────────
  // All history state lives in a single ref so pushHistory / undo / redo
  // never suffer from stale closures, regardless of how they're called.
  const hist = useRef<{ snaps: Snapshot[]; idx: number }>({ snaps: [], idx: -1 });
  const [, forceRender] = useState(0);
  const bump = useCallback(() => forceRender(n => n + 1), []);

  const canUndo = hist.current.idx > 0;
  const canRedo = hist.current.idx < hist.current.snaps.length - 1;

  const isUndoRedo  = useRef(false);
  const nodesRef    = useRef(nodes);
  const edgesRef    = useRef(edges);
  const isRunningRef= useRef(false);
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useEffect(() => { edgesRef.current = edges; }, [edges]);
  useEffect(() => { isRunningRef.current = isRunning; }, [isRunning]);

  function pushHistory(ns: Node[], es: Edge[]) {
    if (isUndoRedo.current) return;
    const clean  = stripRunStatus(ns);
    const { snaps, idx } = hist.current;
    const next = snaps.slice(0, idx + 1);
    next.push({ nodes: clean, edges: es });
    if (next.length > MAX_HIST) next.shift();
    hist.current = { snaps: next, idx: next.length - 1 };
    bump();
  }

  const histDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  function pushHistoryDebounced() {
    if (histDebounce.current) clearTimeout(histDebounce.current);
    histDebounce.current = setTimeout(() => pushHistory(nodesRef.current, edgesRef.current), 300);
  }

  // Synchronously fire any pending debounced push, so undo/redo always
  // operate on a committed state — otherwise the user's most recent edit
  // (still waiting in a 300 ms debounce) would be silently dropped.
  function flushHistDebounce() {
    if (histDebounce.current === null) return;
    clearTimeout(histDebounce.current);
    histDebounce.current = null;
    pushHistory(nodesRef.current, edgesRef.current);
  }

  function undo() {
    flushHistDebounce();
    if (hist.current.idx <= 0 || isRunningRef.current) return;
    const nextIdx = hist.current.idx - 1;
    const snap = hist.current.snaps[nextIdx];
    isUndoRedo.current = true;
    hist.current.idx = nextIdx;
    setNodes(snap.nodes);
    setEdges(snap.edges);
    bump();
    setIsDirty(true);
    // Reset guard AFTER the debounce window (300ms) so onNodesChangeTracked
    // cannot re-push the just-restored state.
    setTimeout(() => { isUndoRedo.current = false; }, 350);
  }

  function redo() {
    flushHistDebounce();
    const { snaps, idx } = hist.current;
    if (idx >= snaps.length - 1 || isRunningRef.current) return;
    const nextIdx = idx + 1;
    const snap = snaps[nextIdx];
    isUndoRedo.current = true;
    hist.current.idx = nextIdx;
    setNodes(snap.nodes);
    setEdges(snap.edges);
    bump();
    setIsDirty(true);
    setTimeout(() => { isUndoRedo.current = false; }, 350);
  }

  // Stable refs so the keyboard handler (registered once) always calls the latest version.
  const undoRef      = useRef(undo);
  const redoRef      = useRef(redo);
  const saveRef      = useRef(() => {});
  const clipboardRef = useRef<{ nodes: Node[]; edges: Edge[] } | null>(null);
  undoRef.current = undo;
  redoRef.current = redo;

  // ── Init history ─────────────────────────────────────────────────────────
  const histInited = useRef(false);
  useEffect(() => {
    if (!flow || histInited.current) return;
    histInited.current = true;
    hist.current = { snaps: [{ nodes: toRFNodes(flow.nodes), edges: toRFEdges(flow.edges) }], idx: 0 };
    bump();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Sync dirty state to store so Sidebar can read it ────────────────────
  useEffect(() => { setEditorDirty(isDirty); }, [isDirty, setEditorDirty]);
  useEffect(() => () => { setEditorDirty(false); }, [setEditorDirty]);

  // ── Handle nav requests from Sidebar ─────────────────────────────────────
  useEffect(() => {
    if (!navRequest) return;
    const target = navRequest;
    setExitTarget(target);
    clearNavRequest();
    if (isDirty) { setShowExitDlg(true); }
    else { setView(target); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navRequest]);

  // ── Keyboard shortcuts (registered once; always uses latest via refs) ────
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && e.key === 'z') { e.preventDefault(); undoRef.current(); }
      if (mod && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) { e.preventDefault(); redoRef.current(); }
      if (mod && e.key === 's') { e.preventDefault(); saveRef.current(); }

      if (mod && e.key === 'c') {
        const sel = nodesRef.current.filter(n => n.selected);
        if (sel.length === 0) return;
        const selIds = new Set(sel.map(n => n.id));
        const selEdges = edgesRef.current.filter(
          edge => selIds.has(edge.source) && selIds.has(edge.target),
        );
        clipboardRef.current = { nodes: sel, edges: selEdges };
      }

      if (mod && e.key === 'v') {
        const cb = clipboardRef.current;
        if (!cb || cb.nodes.length === 0) return;
        const OFFSET = 40;
        const idMap  = new Map<string, string>();
        const stamp  = Date.now();
        const newNodes: Node[] = cb.nodes.map((n, i) => {
          const newId = `n-${stamp}-${i}`;
          idMap.set(n.id, newId);
          return {
            ...n,
            id:       newId,
            position: { x: n.position.x + OFFSET, y: n.position.y + OFFSET },
            selected: true,
            data:     { ...n.data },
          };
        });
        const newEdges: Edge[] = cb.edges.map((edge, i) => ({
          ...edge,
          id:     `e-${stamp}-${i}`,
          source: idMap.get(edge.source) ?? edge.source,
          target: idMap.get(edge.target) ?? edge.target,
        }));
        setNodes(prev => [
          ...prev.map(n => ({ ...n, selected: false })),
          ...newNodes,
        ]);
        setEdges(prev => [...prev, ...newEdges]);
        setIsDirty(true);
        setTimeout(() => pushHistory(nodesRef.current, edgesRef.current), 0);
      }
    }
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  // ── RunLog sync ──────────────────────────────────────────────────────────

  const runHandleRef = useRef<RunHandle | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const { settings } = useSettingsStore();
  const { start: startSession, append: appendSession, finish: finishSession } = useRunLogStore();

  // On mount: if a run is in progress, attach to it; otherwise hydrate from
  // the most recent completed session so logs survive navigation away and back.
  useEffect(() => {
    const sessions = useRunLogStore.getState().sessions;
    if (flow?.status === 'running') {
      const running = sessions.find(s => s.flowId === flow.id && s.status === 'running');
      if (running) {
        sessionIdRef.current = running.id;
        setLogs(running.logs.slice());
        setIsRunning(true);
        setLogOpen(true);
      }
    } else {
      const last = sessions.find(s => s.flowId === activeFlowId && s.status !== 'running');
      if (last && last.logs.length > 0) {
        setLogs(last.logs.slice());
        setLogOpen(true);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return useRunLogStore.subscribe(state => {
      if (!sessionIdRef.current) return;
      const session = state.sessions.find(s => s.id === sessionIdRef.current);
      if (!session) return;
      setLogs(session.logs.slice());
      if (session.status !== 'running') {
        setIsRunning(false);
        sessionIdRef.current = null;
      }
    });
  }, []);

  // ── Node status injection ────────────────────────────────────────────────

  useEffect(() => {
    if (nodeStatuses.size === 0) {
      setNodes(prev => prev.map(n => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { _runStatus, ...rest } = (n.data ?? {}) as Record<string, unknown>;
        return { ...n, data: rest };
      }));
    } else {
      setNodes(prev => prev.map(n => ({ ...n, data: { ...n.data, _runStatus: nodeStatuses.get(n.id) } })));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeStatuses]);

  // ── Handlers ─────────────────────────────────────────────────────────────

  const onConnect = useCallback((params: Connection) => {
    setEdges(eds => {
      const next = addEdge({ ...params, style: edgeStyleFor(params.sourceHandle) }, eds);
      // Use refs to read current state — avoids stale closure on histIdx.
      setTimeout(() => pushHistory(nodesRef.current, next), 0);
      return next;
    });
    setIsDirty(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onNodesChangeTracked = useCallback((changes: Parameters<typeof onNodesChange>[0]) => {
    onNodesChange(changes);
    if (changes.some(c => c.type === 'add' || c.type === 'remove')) {
      setIsDirty(true);
      pushHistoryDebounced();
    } else if (changes.some(c => c.type === 'position' && !(c as { dragging?: boolean }).dragging)) {
      setIsDirty(true);
      pushHistoryDebounced();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onNodesChange]);

  const onEdgesChangeTracked = useCallback((changes: Parameters<typeof onEdgesChange>[0]) => {
    onEdgesChange(changes);
    if (changes.some(c => c.type === 'remove')) {
      setIsDirty(true);
      pushHistoryDebounced();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onEdgesChange]);

  const onNodeClick: NodeMouseHandler = useCallback((_e, node) => { setSelectedId(node.id); setRightPanel(null); }, []);
  function handlePaneClick() { setSelectedId(null); setRightPanel(null); }

  function updateNodeData(id: string, data: Record<string, unknown>) {
    setNodes(prev => prev.map(n => (n.id === id ? { ...n, data } : n)));
    setIsDirty(true);
    pushHistoryDebounced();
  }

  function handleAddNode(type: NodeKind) {
    const item = ADD_ITEMS.find(i => i.type === type)!;
    const offset = nodes.length;
    const newNode: Node = {
      id: `n-${Date.now()}`, type,
      position: { x: 80 + (offset % 4) * 220, y: 80 + Math.floor(offset / 4) * 120 },
      data: { label: item.label, ...item.defaults },
    };
    setNodes(prev => {
      const next = [...prev, newNode];
      setTimeout(() => pushHistory(next, edgesRef.current), 0);
      return next;
    });
    setSelectedId(newNode.id);
    setIsDirty(true);
  }

  function handleSave() {
    if (!flow) return;
    const vars = Object.fromEntries(
      variables.filter(v => v.key.trim()).map(v => [v.key.trim(), v.value])
    );
    updateFlow(flow.id, { name: flowName, description, variables: vars, tags, nodes: toStoreNodes(nodes), edges: toStoreEdges(edges), updatedAt: Date.now() });
    setIsDirty(false);
  }
  saveRef.current = handleSave;

  function handleBack() { setExitTarget('home'); if (isDirty) setShowExitDlg(true); else setView('home'); }
  function exitSave()   { handleSave(); setView(exitTarget); setShowExitDlg(false); }
  function exitDiscard(){ setView(exitTarget); setShowExitDlg(false); }
  function exitCancel() { setShowExitDlg(false); }

  // ── Run ───────────────────────────────────────────────────────────────────

  function addLog(message: string, level: LogEntry['level'] = 'info') {
    setLogs(prev => [...prev, mkLog(message, level)]);
    if (sessionIdRef.current) appendSession(sessionIdRef.current, message, level);
  }

  function handleRun() {
    if (!flow || nodes.length === 0) return;
    setIsRunning(true);
    setLogOpen(true);
    setLogs([]);
    setNodeStatuses(new Map());
    updateFlow(flow.id, { status: 'running' });
    sessionIdRef.current = startSession(flow.id, flow.name, 'manual');

    const vars = Object.fromEntries(
      variables.filter(v => v.key.trim()).map(v => [v.key.trim(), v.value])
    );
    const handle = runFlow(nodes, edges, settings, vars, {
      onLog: (msg, lvl = 'info') => addLog(msg, lvl),
      onNodeStart: id => setNodeStatuses(p => new Map(p).set(id, 'running')),
      onNodeDone:  (id, code) => setNodeStatuses(p => new Map(p).set(id, code === 0 || code === null ? 'success' : 'error')),
      onDone: (ok) => {
        updateFlow(flow!.id, { status: ok ? 'success' : 'error', lastRun: Date.now() });
        if (sessionIdRef.current) { finishSession(sessionIdRef.current, ok); sessionIdRef.current = null; }
        setIsRunning(false);
        runHandleRef.current = null;
      },
    });
    runHandleRef.current = handle;
  }

  async function handleStop() {
    if (runHandleRef.current) { await runHandleRef.current.stop(); runHandleRef.current = null; }
    updateFlow(flow!.id, { status: 'idle' });
    setIsRunning(false);
    setNodeStatuses(new Map());
  }

  const selectedNode = nodes.find(n => n.id === selectedId);

  if (!flow) {
    return <div className="flex items-center justify-center h-full text-ink-dim text-sm font-mono">No flow selected.</div>;
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <Toolbar
        flowName={flowName} isRunning={isRunning} isDirty={isDirty}
        canUndo={canUndo} canRedo={canRedo}
        hasTrigger={nodes.some(n => n.type === 'trigger')}
        onBack={handleBack}
        onNameChange={v => { setFlowName(v); setIsDirty(true); }}
        onAddNode={handleAddNode}
        onSave={handleSave} onRun={handleRun} onStop={handleStop}
        onUndo={undo} onRedo={redo}
      />

      {/* Canvas + Panel */}
      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 relative" style={{ background: canvasBg }}>
          <ReactFlow
            nodes={nodes} edges={edges}
            onNodesChange={onNodesChangeTracked}
            onEdgesChange={onEdgesChangeTracked}
            onConnect={onConnect}
            onNodeClick={onNodeClick} onPaneClick={handlePaneClick}
            nodeTypes={nodeTypes} edgeTypes={EDGE_TYPES} defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
            fitView fitViewOptions={{ padding: 0.4 }} minZoom={0.3} maxZoom={2} deleteKeyCode="Backspace"
          >
            <Background variant={BackgroundVariant.Dots} color={dotColor} bgColor={canvasBg} gap={22} size={1.2} />
            <CustomControls theme={theme} />
            <FitViewOnOpen flowId={activeFlowId} />
            <CanvasControls
              theme={theme}
              rightPanel={selectedNode ? null : rightPanel}
              onToggle={p => {
                setSelectedId(null);
                setNodes(nds => nds.map(n => ({ ...n, selected: false })));
                setRightPanel(cur => cur === p ? null : p);
              }}
            />
          </ReactFlow>
          {nodes.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <p className="text-[12px] font-mono text-ink-ghost">Click <span className="text-ink-dim">+ Add Node</span> to start building</p>
            </div>
          )}
        </div>
        {selectedNode
          ? <NodePanel
              node={selectedNode} nodes={nodes} edges={edges}
              onUpdate={updateNodeData} onClose={() => setSelectedId(null)}
              flowVariables={Object.fromEntries(variables.filter(v => v.key.trim()).map(v => [v.key.trim(), v.value]))}
            />
          : rightPanel === 'vars'
            ? <FlowVarsPanel
                variables={variables}
                onChange={v => { setVariables(v); setIsDirty(true); }}
              />
            : rightPanel === 'info'
              ? <InfoPanel
                  description={description}
                  onDescriptionChange={v => { setDescription(v); setIsDirty(true); }}
                  tags={tags}
                  onTagsChange={v => { setTags(v); setIsDirty(true); }}
                  allTags={[...new Set(flows.flatMap(f => f.tags ?? []))].sort()}
                  onClose={() => setRightPanel(null)}
                />
              : null
        }
      </div>

      <LogPanel open={logOpen} onToggle={() => setLogOpen(v => !v)} logs={logs} onClear={() => setLogs([])} />

      {showExitDlg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/70 backdrop-blur-[2px]">
          <div className="w-[360px] bg-surface border border-wire-lit rounded-2xl shadow-2xl shadow-black/60 overflow-hidden" style={{ animation: 'fade-up 0.18s ease both' }}>
            <div className="px-6 pt-6 pb-4">
              <h3 className="text-[15px] font-bold font-display text-ink">Unsaved changes</h3>
              <p className="text-[12.5px] text-ink-dim mt-1.5">Save changes to <span className="text-ink font-medium">"{flowName}"</span> before leaving?</p>
            </div>
            <div className="h-px bg-wire mx-6" />
            <div className="flex items-center justify-between px-6 py-4 gap-2">
              <button onClick={exitCancel} className="px-3 py-2 rounded-lg text-[12.5px] font-medium text-ink-dim hover:text-ink hover:bg-raised border border-transparent hover:border-wire transition-all">Cancel</button>
              <div className="flex items-center gap-2">
                <button onClick={exitDiscard} className="px-3 py-2 rounded-lg text-[12.5px] font-medium text-ink-dim hover:text-danger hover:bg-danger/8 border border-transparent hover:border-danger/30 transition-all">Don't Save</button>
                <button onClick={exitSave} className="px-4 py-2 rounded-lg text-[12.5px] font-semibold bg-accent text-white hover:bg-accent/90 active:scale-[.97] transition-all shadow-md shadow-accent/20">Save & Exit</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
