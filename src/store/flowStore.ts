import { create } from 'zustand';
import type { Flow } from '../types/flow';
import {
  loadFlows, saveFlow, deleteFlowFile,
} from '../lib/flowPersistence';

interface FlowStore {
  flows:            Flow[];
  activeFlowId:     string | null;
  view:             'home' | 'editor' | 'settings' | 'runlog';
  targetSessionId:  string | null;
  /** True after the on-disk store has been read into memory. */
  loaded:           boolean;
  setActiveFlow:    (id: string | null) => void;
  setView:          (view: 'home' | 'editor' | 'settings' | 'runlog') => void;
  setTargetSession: (id: string | null) => void;
  addFlow:       (flow: Flow) => void;
  deleteFlow:    (id: string) => void;
  updateFlow:    (id: string, patch: Partial<Flow>) => void;
  duplicateFlow: (id: string) => void;
  bootstrap:     () => Promise<void>;
  reload:        () => Promise<void>;
}

export const useFlowStore = create<FlowStore>((set, get) => ({
  flows:           [],
  activeFlowId:    null,
  view:            'home',
  targetSessionId: null,
  loaded:          false,

  setActiveFlow:    (id)   => set({ activeFlowId: id }),
  setView:          (view) => set({ view }),
  setTargetSession: (id)   => set({ targetSessionId: id }),

  addFlow: (flow) => {
    set((s) => ({ flows: [...s.flows, flow] }));
    saveFlow(flow);
  },

  deleteFlow: (id) => {
    set((s) => ({ flows: s.flows.filter((f) => f.id !== id) }));
    void deleteFlowFile(id);
  },

  duplicateFlow: (id) => {
    const src = get().flows.find(f => f.id === id);
    if (!src) return;
    const now = Date.now();
    const copy: Flow = {
      ...src,
      id:          `flow-${now}-${Math.random().toString(36).slice(2, 6)}`,
      name:        `${src.name} (copy)`,
      status:      'idle',
      lastRun:     undefined,
      createdAt:   now,
      updatedAt:   now,
    };
    set((s) => ({ flows: [...s.flows, copy] }));
    saveFlow(copy);
  },

  updateFlow: (id, patch) => {
    set((s) => ({ flows: s.flows.map((f) => (f.id === id ? { ...f, ...patch } : f)) }));
    const next = get().flows.find((f) => f.id === id);
    if (next) saveFlow(next);
  },

  /**
   * Read every flow from disk into the store. On a fresh install (no `.seeded`
   * marker) the demo flows are written to disk so the user can edit or delete
   * them like any other flow.
   */
  bootstrap: async () => {
    if (get().loaded) return;
    try {
      const onDisk = await loadFlows();
      set({ flows: onDisk, loaded: true });
    } catch (e) {
      console.error('[flowStore] bootstrap failed:', e);
      set({ flows: [], loaded: true });
    }
  },

  /** Re-run bootstrap from disk. Used after the user switches workspace. */
  reload: async () => {
    set({ loaded: false, flows: [] });
    await get().bootstrap();
  },
}));
