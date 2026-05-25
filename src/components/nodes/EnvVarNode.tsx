import { type NodeProps } from '@xyflow/react';
import { Cpu } from 'lucide-react';
import { BaseNode } from './BaseNode';

const COLOR = '#22d3ee';

export function EnvVarNode({ data, selected, isConnectable }: NodeProps) {
  const d   = data as Record<string, unknown>;
  const op  = (d.op as string) || 'get';
  const name = ((d.name as string) || '').trim();
  return (
    <BaseNode
      color={COLOR} typeLabel="env var" icon={<Cpu size={10} />}
      selected={selected} isConnectable={isConnectable}
      runStatus={d._runStatus as 'running' | 'success' | 'error' | undefined}
    >
      <div className="text-[12px] font-medium text-ink truncate font-mono leading-snug">
        {(d.label as string) || 'env var'}
      </div>
      <div className="text-[10px] text-ink-dim font-mono mt-0.5 truncate opacity-80">
        {op === 'get' ? '← ' : '→ '}
        {name ? `$${name}` : 'no var set'}
      </div>
    </BaseNode>
  );
}
