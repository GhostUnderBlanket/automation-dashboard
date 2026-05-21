import { type NodeProps } from '@xyflow/react';
import { AppWindow } from 'lucide-react';
import { BaseNode } from './BaseNode';

const COLOR = '#f43f5e';

export function LaunchAppNode({ data, selected, isConnectable }: NodeProps) {
  const d       = data as Record<string, unknown>;
  const program = ((d.program as string) ?? '').trim();
  const preview = program.split(/[\\/]/).pop()?.slice(0, 28) ?? '';
  return (
    <BaseNode
      color={COLOR} typeLabel="launch app" icon={<AppWindow size={10} />}
      selected={selected} isConnectable={isConnectable}
      runStatus={d._runStatus as 'running' | 'success' | 'error' | undefined}
    >
      <div className="text-[12px] font-medium text-ink truncate font-mono leading-snug">
        {(d.label as string) || 'launch app'}
      </div>
      {preview
        ? <div className="text-[10px] text-ink-dim font-mono mt-0.5 truncate opacity-80">{preview}</div>
        : <div className="text-[10px] text-ink-ghost mt-0.5 italic">no program set</div>
      }
    </BaseNode>
  );
}
