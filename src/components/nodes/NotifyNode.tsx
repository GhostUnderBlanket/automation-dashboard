import { type NodeProps } from '@xyflow/react';
import { Bell } from 'lucide-react';
import { BaseNode } from './BaseNode';

const COLOR = '#eab308';

export function NotifyNode({ data, selected, isConnectable }: NodeProps) {
  const d = data as Record<string, unknown>;
  const title = ((d.title as string) || '').trim();
  return (
    <BaseNode
      color={COLOR} typeLabel="notify" icon={<Bell size={10} />}
      selected={selected} isConnectable={isConnectable}
      runStatus={d._runStatus as 'running' | 'success' | 'error' | undefined}
    >
      <div className="text-[12px] font-medium text-ink truncate font-mono leading-snug">
        {(d.label as string) || 'notify'}
      </div>
      <div className="text-[10px] text-ink-dim font-mono mt-0.5 truncate opacity-80">
        {title ? `🔔 ${title}` : '🔔 no title set'}
      </div>
    </BaseNode>
  );
}
