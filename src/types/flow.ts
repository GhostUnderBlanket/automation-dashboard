export type FlowStatus = 'idle' | 'running' | 'success' | 'error';
export type NodeKind  = 'trigger' | 'rest' | 'script' | 'condition' | 'file' | 'openurl' | 'loop' | 'launchapp' | 'group' | 'delay' | 'subflow' | 'notify' | 'envvar';

export interface FlowNode {
  id:        string;
  type:      NodeKind;
  label:     string;
  position:  { x: number; y: number };
  data:      Record<string, unknown>;
  /** Set when this node lives inside a group node. */
  parentId?: string;
  /** Constrains node to stay within its parent bounds. */
  extent?:   'parent';
  /** For group nodes: pixel dimensions of the container. */
  style?:    { width?: number; height?: number };
}

export interface FlowEdge {
  id:           string;
  source:       string;
  target:       string;
  /** Set when the source node has multiple output handles (e.g. condition: "true" / "false"). */
  sourceHandle?: string | null;
}

export interface Flow {
  id:          string;
  name:        string;
  description: string;
  variables?:  Record<string, string>;
  tags?:       string[];
  nodes:       FlowNode[];
  edges:       FlowEdge[];
  status:      FlowStatus;
  lastRun?:    number;
  createdAt:   number;
  updatedAt:   number;
}

export interface LogEntry {
  id:        string;
  timestamp: number;
  level:     'info' | 'success' | 'error' | 'warn';
  message:   string;
}
