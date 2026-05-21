import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { readTextFile, writeTextFile, exists as fsExists } from '@tauri-apps/plugin-fs';
import { openUrl, openPath } from '@tauri-apps/plugin-opener';
import type { Node, Edge } from '@xyflow/react';
import type { AppSettings } from '../types/settings';
import type { LogEntry } from '../types/flow';
import { interpolate, type NodeRunResult } from './interpolate';
import { useWorkspaceStore } from '../store/workspaceStore';

export interface BodyRow { key: string; value: string }

export type AddLog = (message: string, level?: LogEntry['level']) => void;

/* ─── Topological sort ─────────────────────────────────────── */

function topSort(nodes: Node[], edges: Edge[]): Node[] {
  const degree = new Map(nodes.map(n => [n.id, 0]));
  const adj    = new Map(nodes.map(n => [n.id, [] as string[]]));

  for (const e of edges) {
    adj.get(e.source)?.push(e.target);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }

  const queue = nodes.filter(n => (degree.get(n.id) ?? 0) === 0);
  const out: Node[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    out.push(node);
    for (const next of (adj.get(node.id) ?? [])) {
      const d = (degree.get(next) ?? 0) - 1;
      degree.set(next, d);
      if (d === 0) { const n = nodes.find(n => n.id === next); if (n) queue.push(n); }
    }
  }
  for (const n of nodes) { if (!out.find(o => o.id === n.id)) out.push(n); }
  return out;
}

function parentsOf(nodeId: string, edges: Edge[]): string[] {
  return edges.filter(e => e.target === nodeId).map(e => e.source);
}

/* ─── Condition evaluation ─────────────────────────────────── */

function evalCondition(
  node: Node,
  results: Map<string, NodeRunResult>,
  parents: string[],
): boolean {
  const d   = (node.data ?? {}) as Record<string, unknown>;
  const op  = (d.op as string) || 'nonempty';
  const ctx = { results, parents };

  if (op === 'exitZero') {
    const last = parents.length > 0 ? results.get(parents[parents.length - 1]) : undefined;
    return last?.exitCode === 0;
  }

  const sourceTpl = (d.source as string) ?? '${prev}';
  const subject   = interpolate(sourceTpl, ctx).trim();

  switch (op) {
    case 'equals':    return subject === interpolate((d.value as string) ?? '', ctx).trim();
    case 'notEquals': return subject !== interpolate((d.value as string) ?? '', ctx).trim();
    case 'contains':  return subject.includes(interpolate((d.value as string) ?? '', ctx).trim());
    case 'matches':   {
      const pat = interpolate((d.value as string) ?? '', ctx).trim();
      if (!pat) return false;
      try { return new RegExp(pat).test(subject); } catch { return false; }
    }
    case 'empty':     return subject.length === 0;
    case 'nonempty':  return subject.length > 0;
    default:          return subject.length > 0;
  }
}

/* ─── Subprocess execution ─────────────────────────────────── */

interface SpawnHandle {
  result: Promise<{ exitCode: number | null; stdout: string }>;
  kill:   () => Promise<void>;
}

function spawnSubprocess(
  id: string,
  program: string,
  args: string[],
  cwd: string | undefined,
  onLog: AddLog,
): SpawnHandle {
  const captured: string[] = [];

  const result = (async (): Promise<{ exitCode: number | null; stdout: string }> => {
    const unlisten = await Promise.all([
      listen<string>(`exec-out-${id}`, e => {
        const line = e.payload.trimEnd();
        if (!line) return;
        captured.push(line);
        onLog(line, 'info');
      }),
      listen<string>(`exec-err-${id}`, e => {
        const line = e.payload.trimEnd();
        if (line) onLog(line, 'warn');
      }),
    ]);

    try {
      const exitCode = await invoke<number>('exec_node', {
        opts: { id, program, args, cwd: cwd ?? null },
      });
      return { exitCode, stdout: captured.join('\n') };
    } catch (e) {
      onLog(`Error: ${String(e)}`, 'error');
      return { exitCode: -1, stdout: captured.join('\n') };
    } finally {
      unlisten.forEach(u => u());
    }
  })();

  return {
    result,
    kill: async () => {
      try { await invoke('kill_exec', { id }); } catch { /* ignore */ }
    },
  };
}

/* ─── REST API HTTP request ────────────────────────────────── */

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}… (+${s.length - n} chars)`;
}

function coerceFormValue(raw: string): unknown {
  const t = raw.trim();
  if (t === '')      return '';
  if (t === 'true')  return true;
  if (t === 'false') return false;
  if (t === 'null')  return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return raw;
}

function restRequest(
  d: Record<string, unknown>,
  settings: AppSettings,
  interp: (s: string) => string,
  onLog: AddLog,
): SpawnHandle {
  const urlOverride = interp(((d.urlOverride as string) ?? '').trim());
  let url: string;
  if (urlOverride) {
    url = urlOverride;
  } else {
    const baseUrl  = (settings.restBaseUrl || '').replace(/\/+$/, '');
    const endpoint = interp(((d.endpoint as string) ?? '')).trim().replace(/^\/+/, '');
    if (!baseUrl) {
      onLog('   ✗ REST API base URL not configured (Settings → REST API)', 'error');
      return { result: Promise.resolve({ exitCode: 1, stdout: '' }), kill: async () => {} };
    }
    if (!endpoint) {
      onLog('   ✗ endpoint is empty', 'error');
      return { result: Promise.resolve({ exitCode: 1, stdout: '' }), kill: async () => {} };
    }
    url = `${baseUrl}/${endpoint}`;
  }
  const method   = (((d.method as string) || 'POST').toUpperCase());
  const override = ((d.tokenOverride as string) ?? '').trim();
  const token    = override || settings.restToken;

  // Build body
  let bodyText: string | undefined;
  const hasBody = method !== 'GET' && method !== 'HEAD';
  if (hasBody) {
    const bodyMode = (d.bodyMode as string) === 'json' ? 'json' : 'form';
    if (bodyMode === 'form') {
      const rows = ((d.bodyRows as BodyRow[]) ?? []).filter(r => (r.key ?? '').trim() !== '');
      const obj: Record<string, unknown> = {};
      for (const r of rows) {
        const key = (r.key ?? '').trim();
        const raw = interp(String(r.value ?? ''));
        obj[key]  = coerceFormValue(raw);
      }
      bodyText = JSON.stringify(obj);
    } else {
      const raw = interp(((d.body as string) ?? '')).trim();
      if (raw) {
        try { JSON.parse(raw); }
        catch (e) {
          onLog(`   ✗ body is not valid JSON: ${String(e)}`, 'error');
          return { result: Promise.resolve({ exitCode: 1, stdout: '' }), kill: async () => {} };
        }
        bodyText = raw;
      }
    }
  }

  onLog(`   ${method} ${url}`, 'info');
  if (bodyText) onLog(`   body: ${truncate(bodyText, 200)}`, 'info');
  if (!token) onLog('   ⚠ no bearer token set — request will be unauthenticated', 'warn');

  const aborter = new AbortController();
  const result = (async (): Promise<{ exitCode: number | null; stdout: string }> => {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await tauriFetch(url, {
        method,
        headers,
        body: bodyText,
        signal: aborter.signal,
      });
      const text = await res.text();
      const ok   = res.status >= 200 && res.status < 300;
      onLog(`   ← ${res.status} ${res.statusText || ''}`.trimEnd(), ok ? 'success' : 'error');
      if (text) onLog(truncate(text, 500), ok ? 'info' : 'warn');
      return { exitCode: ok ? 0 : 1, stdout: text };
    } catch (e) {
      onLog(`   ✗ request failed: ${String(e)}`, 'error');
      return { exitCode: -1, stdout: '' };
    }
  })();

  return {
    result,
    kill: async () => { aborter.abort(); },
  };
}

/* ─── Build the execution handle for a node ────────────────── */

function execNode(
  node: Node,
  settings: AppSettings,
  onLog: AddLog,
  results: Map<string, NodeRunResult>,
  parents: string[],
  variables: Record<string, string>,
  loopItem?: string,
): SpawnHandle | null {
  const d    = node.data as Record<string, unknown>;
  const type = node.type ?? 'script';

  if (type === 'trigger' || type === 'condition' || type === 'loop') return null;

  const ctx = { results, parents, variables, loopItem };
  const interp = (s: string) => interpolate(s, ctx);

  const workspacePath = useWorkspaceStore.getState().path ?? '';
  const cwd = ((d.workDir as string) || workspacePath) || undefined;
  const id  = `r-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  if (type === 'rest') {
    return restRequest(d, settings, interp, onLog);
  }

  if (type === 'file') {
    return fileNode(d, interp, onLog);
  }

  if (type === 'openurl') {
    return openUrlNode(d, interp, onLog);
  }

  if (type === 'launchapp') {
    return launchAppNode(d, settings, interp, onLog, id, cwd);
  }

  // Script node
  const shell  = (d.shell as string) || settings.defaultShell;
  const script = interp((d.script as string) ?? '');

  let program: string, args: string[];
  if (shell === 'powershell') { program = 'powershell'; args = ['-NonInteractive', '-Command', script]; }
  else if (shell === 'bash')  { program = 'bash';        args = ['-c', script]; }
  else                        { program = 'cmd';         args = ['/c', script]; }

  return spawnSubprocess(id, program, args, cwd ? interp(cwd) : cwd, onLog);
}

/* ─── File node ────────────────────────────────────────────── */

function fileNode(
  d: Record<string, unknown>,
  interp: (s: string) => string,
  onLog: AddLog,
): SpawnHandle {
  const op      = (d.operation as string) || 'read';
  const path    = interp((d.path as string) ?? '').trim();
  const content = interp((d.content as string) ?? '');

  const result = (async (): Promise<{ exitCode: number | null; stdout: string }> => {
    if (!path) {
      onLog('   ✗ file path is empty', 'error');
      return { exitCode: 1, stdout: '' };
    }
    try {
      if (op === 'read') {
        onLog(`   read: ${path}`, 'info');
        const text = await readTextFile(path);
        onLog(truncate(text, 300), 'info');
        return { exitCode: 0, stdout: text };
      }
      if (op === 'write') {
        onLog(`   write: ${path}`, 'info');
        await writeTextFile(path, content);
        onLog('   ✓ written', 'success');
        return { exitCode: 0, stdout: path };
      }
      if (op === 'append') {
        onLog(`   append: ${path}`, 'info');
        await writeTextFile(path, content, { append: true });
        onLog('   ✓ appended', 'success');
        return { exitCode: 0, stdout: path };
      }
      if (op === 'exists') {
        const e = await fsExists(path);
        onLog(`   exists: ${path} → ${e}`, 'info');
        return { exitCode: e ? 0 : 1, stdout: String(e) };
      }
      return { exitCode: 1, stdout: '' };
    } catch (e) {
      onLog(`   ✗ ${String(e)}`, 'error');
      return { exitCode: 1, stdout: '' };
    }
  })();

  return { result, kill: async () => {} };
}

/* ─── Open URL node ────────────────────────────────────────── */

function openUrlNode(
  d: Record<string, unknown>,
  interp: (s: string) => string,
  onLog: AddLog,
): SpawnHandle {
  const url = interp((d.url as string) ?? '').trim();

  const result = (async (): Promise<{ exitCode: number | null; stdout: string }> => {
    if (!url) {
      onLog('   ✗ URL is empty', 'error');
      return { exitCode: 1, stdout: '' };
    }
    try {
      onLog(`   opening: ${url}`, 'info');
      if (/^https?:\/\//i.test(url)) {
        await openUrl(url);
      } else {
        await openPath(url);
      }
      return { exitCode: 0, stdout: url };
    } catch (e) {
      onLog(`   ✗ ${String(e)}`, 'error');
      return { exitCode: 1, stdout: '' };
    }
  })();

  return { result, kill: async () => {} };
}

/* ─── Launch App node ──────────────────────────────────────── */

function launchAppNode(
  d: Record<string, unknown>,
  _settings: AppSettings,
  interp: (s: string) => string,
  onLog: AddLog,
  id: string,
  cwd: string | undefined,
): SpawnHandle {
  const program     = interp((d.program as string) ?? '').trim();
  const argsRaw     = interp((d.args as string) ?? '').trim();
  const waitForExit = !!(d.waitForExit as boolean);

  // Simple arg split: respect quoted strings
  function splitArgs(s: string): string[] {
    if (!s) return [];
    const parts: string[] = [];
    let cur = '';
    let inQ = false;
    let qChar = '';
    for (const ch of s) {
      if (!inQ && (ch === '"' || ch === "'")) { inQ = true; qChar = ch; }
      else if (inQ && ch === qChar) { inQ = false; qChar = ''; }
      else if (!inQ && ch === ' ') { if (cur) { parts.push(cur); cur = ''; } }
      else { cur += ch; }
    }
    if (cur) parts.push(cur);
    return parts;
  }

  const args = splitArgs(argsRaw);

  const result = (async (): Promise<{ exitCode: number | null; stdout: string }> => {
    if (!program) {
      onLog('   ✗ program path is empty', 'error');
      return { exitCode: 1, stdout: '' };
    }
    onLog(`   launching: ${program}${args.length ? ' ' + args.join(' ') : ''}`, 'info');
    if (!waitForExit) {
      try {
        await invoke('launch_app', { program, args, cwd: cwd ?? null });
        onLog('   ✓ launched', 'success');
        return { exitCode: 0, stdout: '' };
      } catch (e) {
        onLog(`   ✗ ${String(e)}`, 'error');
        return { exitCode: 1, stdout: '' };
      }
    } else {
      // wait mode: reuse subprocess infrastructure for stdout capture
      const handle = spawnSubprocess(id, program, args, cwd, onLog);
      return handle.result;
    }
  })();

  return { result, kill: async () => {} };
}

/* ─── Public API ────────────────────────────────────────────── */

export interface RunCallbacks {
  onLog:        AddLog;
  onNodeStart:  (nodeId: string) => void;
  onNodeDone:   (nodeId: string, exitCode: number | null) => void;
  onDone:       (success: boolean) => void;
}

export interface RunHandle {
  stop: () => Promise<void>;
}

export function runFlow(
  nodes: Node[],
  edges: Edge[],
  settings: AppSettings,
  variables: Record<string, string>,
  cbs: RunCallbacks,
): RunHandle {
  const signal = { stopped: false };
  let stopCurrent: (() => Promise<void>) | null = null;

  const stop = async () => {
    signal.stopped = true;
    if (stopCurrent) await stopCurrent();
  };

  void (async () => {
    // Group nodes are visual containers only — exclude from execution.
    const execNodes = nodes.filter(n => n.type !== 'group');
    const ordered = topSort(execNodes, edges);
    cbs.onLog(`▶  ${ordered.length} node${ordered.length !== 1 ? 's' : ''} queued`, 'info');

    let flowOk = true;
    const results = new Map<string, NodeRunResult>();

    /**
     * A node is "skipped" when every incoming edge is dead.
     *  - An edge is dead if its source is skipped, or
     *  - the source is a condition node whose evaluated branch ≠ the edge's sourceHandle.
     * Nodes with no incoming edges (root triggers) are always live.
     */
    const skipped       = new Set<string>();
    const liveBranches  = new Map<string, 'true' | 'false'>(); // condition id → branch that's alive
    const loopManaged   = new Set<string>();                    // nodes run inside a loop body

    function edgeIsDead(e: Edge): boolean {
      if (skipped.has(e.source)) return true;
      const branch = liveBranches.get(e.source);
      if (!branch) return false;            // source isn't a condition; just a regular link
      const handle = (e.sourceHandle ?? 'true') as 'true' | 'false';
      return handle !== branch;
    }

    function shouldSkip(nodeId: string): boolean {
      const incoming = edges.filter(e => e.target === nodeId);
      if (incoming.length === 0) return false;
      return incoming.every(edgeIsDead);
    }

    for (const node of ordered) {
      if (signal.stopped) break;

      // Already executed as the body of a loop — skip normal processing.
      if (loopManaged.has(node.id)) continue;

      const d     = node.data as Record<string, unknown>;
      const label = (d.label as string) || node.type || node.id;
      const type  = node.type ?? 'script';
      const parents = parentsOf(node.id, edges);

      if (shouldSkip(node.id)) {
        skipped.add(node.id);
        cbs.onLog(`○  [${type}] ${label} — skipped`, 'info');
        results.set(node.id, { id: node.id, label, stdout: '', exitCode: null });
        cbs.onNodeDone(node.id, null);
        continue;
      }

      cbs.onLog(`→  [${type}] ${label}`, 'info');
      cbs.onNodeStart(node.id);

      // Condition: evaluate now, decide branch, log, then fall through with no subprocess.
      if (type === 'condition') {
        const branch = evalCondition(node, results, parents) ? 'true' : 'false';
        liveBranches.set(node.id, branch);
        cbs.onLog(`   ↳ ${branch === 'true' ? '✓ true branch' : '✗ false branch'}`, branch === 'true' ? 'success' : 'warn');
        const condUpstream = parents.map(pid => results.get(pid)?.stdout?.trim() ?? '').filter(Boolean).join('\n');
        results.set(node.id, { id: node.id, label, stdout: condUpstream, exitCode: 0 });
        cbs.onNodeDone(node.id, 0);
        continue;
      }

      // Loop: run the directly connected body node N times.
      if (type === 'loop') {
        const loopMode  = (d.mode as string) || 'repeat';
        const loopCount = Math.max(1, Number(d.count) || 3);
        const loopDelay = Math.max(0, Number(d.delay) || 0);
        const loopSep   = (d.separator as string) || 'newline';
        const sleep     = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

        const bodyEdge = edges.find(e => e.source === node.id && !edgeIsDead(e));
        const bodyNode = bodyEdge ? nodes.find(n => n.id === bodyEdge.target) : undefined;

        if (!bodyNode) {
          cbs.onLog('   ⚠ no node connected — nothing to loop', 'warn');
          results.set(node.id, { id: node.id, label, stdout: '', exitCode: 0 });
          cbs.onNodeDone(node.id, 0);
          continue;
        }

        const bodyD     = bodyNode.data as Record<string, unknown>;
        const bodyLabel = (bodyD.label as string) || bodyNode.type || bodyNode.id;
        loopManaged.add(bodyNode.id);

        const execBody = async (loopItem?: string) => {
          cbs.onLog(`   → [${bodyNode.type}] ${bodyLabel}`, 'info');
          cbs.onNodeStart(bodyNode.id);
          const h = execNode(bodyNode, settings, cbs.onLog, results, [node.id], variables, loopItem);
          if (!h) {
            results.set(bodyNode.id, { id: bodyNode.id, label: bodyLabel, stdout: '', exitCode: 0 });
            cbs.onNodeDone(bodyNode.id, 0);
            return { exitCode: 0 as number | null, stdout: '' };
          }
          stopCurrent = h.kill;
          const r = await h.result;
          stopCurrent = null;
          results.set(bodyNode.id, { id: bodyNode.id, label: bodyLabel, stdout: r.stdout, exitCode: r.exitCode });
          cbs.onNodeDone(bodyNode.id, r.exitCode);
          const ok = r.exitCode === 0 || r.exitCode === null;
          cbs.onLog(ok ? `   ✓ exit ${r.exitCode ?? 'ok'}` : `   ✗ exit ${r.exitCode}`, ok ? 'success' : 'error');
          return r;
        };

        const outputs: string[] = [];
        let loopOk = true;

        if (loopMode === 'repeat') {
          for (let i = 0; i < loopCount; i++) {
            if (signal.stopped) break;
            cbs.onLog(`   iteration ${i + 1}/${loopCount}`, 'info');
            const r = await execBody();
            if (r.stdout.trim()) outputs.push(r.stdout.trim());
            if (r.exitCode !== 0 && settings.stopOnError) { loopOk = false; break; }
            if (loopDelay > 0 && i < loopCount - 1 && !signal.stopped) {
              cbs.onLog(`   waiting ${loopDelay}ms…`, 'info');
              await sleep(loopDelay);
            }
          }
        } else if (loopMode === 'retry') {
          for (let attempt = 0; attempt < loopCount; attempt++) {
            if (signal.stopped) break;
            if (attempt > 0) cbs.onLog(`   retry attempt ${attempt + 1}/${loopCount}`, 'warn');
            const r = await execBody();
            if (r.stdout.trim()) outputs.push(r.stdout.trim());
            if (r.exitCode === 0) break;
            if (attempt === loopCount - 1) { loopOk = false; cbs.onLog(`   all ${loopCount} attempts failed`, 'error'); break; }
            if (loopDelay > 0 && !signal.stopped) {
              cbs.onLog(`   waiting ${loopDelay}ms before retry…`, 'info');
              await sleep(loopDelay);
            }
          }
        } else if (loopMode === 'forEach') {
          const upstream = parents.map(pid => results.get(pid)?.stdout?.trim() ?? '').filter(Boolean).join('\n');
          let items: string[] = [];
          if (loopSep === 'json-array') {
            try {
              const parsed = JSON.parse(upstream);
              if (Array.isArray(parsed)) items = parsed.map(it => (typeof it === 'string' ? it : JSON.stringify(it)));
            } catch { /* not a JSON array */ }
          } else {
            items = upstream.split('\n').filter(l => l.trim());
          }
          cbs.onLog(`   ${items.length} item(s) to process`, 'info');
          for (let i = 0; i < items.length; i++) {
            if (signal.stopped) break;
            const item    = items[i];
            const preview = item.length > 50 ? `${item.slice(0, 50)}…` : item;
            cbs.onLog(`   [${i + 1}/${items.length}] ${preview}`, 'info');
            const r = await execBody(item);
            if (r.stdout.trim()) outputs.push(r.stdout.trim());
            if (loopDelay > 0 && i < items.length - 1 && !signal.stopped) {
              cbs.onLog(`   waiting ${loopDelay}ms…`, 'info');
              await sleep(loopDelay);
            }
          }
        }

        const loopStdout = outputs.join('\n');
        const loopExit   = loopOk ? 0 : 1;
        results.set(node.id, { id: node.id, label, stdout: loopStdout, exitCode: loopExit });
        cbs.onNodeDone(node.id, loopExit);
        cbs.onLog(loopOk ? `   ✓ loop complete` : `   ✗ loop failed`, loopOk ? 'success' : 'error');
        if (!loopOk && settings.stopOnError) { flowOk = false; break; }
        continue;
      }

      const handle = execNode(node, settings, cbs.onLog, results, parents, variables);

      if (!handle) {
        if (type === 'trigger') cbs.onLog('   fired', 'info');
        results.set(node.id, { id: node.id, label, stdout: '', exitCode: 0 });
        cbs.onNodeDone(node.id, 0);
        continue;
      }

      stopCurrent = handle.kill;
      const { exitCode, stdout } = await handle.result;
      stopCurrent = null;
      results.set(node.id, { id: node.id, label, stdout, exitCode });
      cbs.onNodeDone(node.id, exitCode);

      if (signal.stopped) break;

      const ok = exitCode === 0 || exitCode === null;
      cbs.onLog(ok ? `   ✓ exit ${exitCode ?? 'ok'}` : `   ✗ exit ${exitCode}`, ok ? 'success' : 'error');

      if (!ok && settings.stopOnError) { flowOk = false; break; }
    }

    if (signal.stopped)  { cbs.onLog('■  Stopped', 'warn');         cbs.onDone(false); }
    else if (flowOk)     { cbs.onLog('✓  Flow complete', 'success'); cbs.onDone(true);  }
    else                 { cbs.onLog('✗  Flow failed', 'error');     cbs.onDone(false); }
  })();

  return { stop };
}
