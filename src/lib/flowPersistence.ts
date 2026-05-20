/**
 * Flow ↔ disk plumbing.
 *
 * - `loadFlows()` reads every flow file at boot.
 * - `saveFlow()` writes one flow, debounced per-id so a burst of UI edits
 *   collapses into a single fsync.
 * - `deleteFlowFile()` removes the file when a flow is deleted in the UI.
 *
 * Each on-disk file is the same envelope used by Export, so flows can be
 * round-tripped through Import/Export without conversion.
 */

import { invoke } from '@tauri-apps/api/core';
import type { Flow } from '../types/flow';

const FILE_FORMAT_VERSION = 1;

interface FlowFileEnvelope {
  $schema: 'autoflow.flow';
  version: number;
  savedAt: number;
  flow:    Flow;
}

function envelope(flow: Flow): FlowFileEnvelope {
  return { $schema: 'autoflow.flow', version: FILE_FORMAT_VERSION, savedAt: Date.now(), flow };
}

function unwrap(text: string): Flow | null {
  try {
    const raw = JSON.parse(text);
    const candidate =
      raw && typeof raw === 'object' && 'flow' in raw && (raw as { flow: unknown }).flow
        ? (raw as { flow: Flow }).flow
        : (raw as Flow);
    if (!candidate || typeof candidate !== 'object') return null;
    if (!Array.isArray(candidate.nodes) || !Array.isArray(candidate.edges)) return null;
    return migrateLegacyNodes(candidate);
  } catch {
    return null;
  }
}

/**
 * Convert legacy `claude` nodes (from when this was a Claude-CLI runner) into
 * placeholder script nodes so the graph still loads. Users need to manually
 * rebuild them as REST API nodes.
 */
function migrateLegacyNodes(flow: Flow): Flow {
  let touched = false;
  const nodes = flow.nodes.map(n => {
    if ((n.type as string) !== 'claude') return n;
    touched = true;
    const d = (n.data as Record<string, unknown>) ?? {};
    const slash  = (d.slash   as string) ?? (d.command as string) ?? '';
    const args   = (d.args    as string) ?? '';
    const banner = `# Legacy Claude node — reconfigure as a REST API node.\n# Original command: ${slash} ${args}`.trim();
    return {
      ...n,
      type:  'script' as const,
      label: `${n.label} (legacy)`,
      data:  { shell: 'powershell', script: `Write-Output "${banner.replace(/"/g, '`"').replace(/\n/g, '`n')}"; exit 1` },
    };
  });
  if (!touched) return flow;
  console.warn(`[flowPersistence] flow ${flow.id}: converted legacy claude nodes to script placeholders`);
  return { ...flow, nodes };
}

export async function loadFlows(): Promise<Flow[]> {
  const texts = await invoke<string[]>('list_flow_files');
  const out: Flow[] = [];
  for (const t of texts) {
    const f = unwrap(t);
    if (f) out.push(f);
  }
  out.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  return out;
}

const pending = new Map<string, number>();

/** Debounced write. Bursts of edits collapse into one fsync after 250 ms. */
export function saveFlow(flow: Flow): void {
  const id = flow.id;
  const prev = pending.get(id);
  if (prev !== undefined) window.clearTimeout(prev);
  const timer = window.setTimeout(() => {
    pending.delete(id);
    const content = JSON.stringify(envelope(flow), null, 2);
    void invoke('save_flow_file', { opts: { id, content } })
      .catch((e: unknown) => console.warn(`[flowPersistence] save ${id} failed:`, e));
  }, 250);
  pending.set(id, timer);
}

/** Synchronously flush a pending save (used at boot for the seed write). */
export async function saveFlowNow(flow: Flow): Promise<void> {
  const pendingTimer = pending.get(flow.id);
  if (pendingTimer !== undefined) {
    window.clearTimeout(pendingTimer);
    pending.delete(flow.id);
  }
  const content = JSON.stringify(envelope(flow), null, 2);
  await invoke('save_flow_file', { opts: { id: flow.id, content } });
}

export async function deleteFlowFile(id: string): Promise<void> {
  const pendingTimer = pending.get(id);
  if (pendingTimer !== undefined) {
    window.clearTimeout(pendingTimer);
    pending.delete(id);
  }
  try { await invoke('delete_flow_file', { id }); }
  catch (e) { console.warn(`[flowPersistence] delete ${id} failed:`, e); }
}
