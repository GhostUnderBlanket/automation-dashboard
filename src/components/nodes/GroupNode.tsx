import { useCallback } from 'react';
import { NodeResizer, useReactFlow, type NodeProps } from '@xyflow/react';
import { useSettingsStore } from '../../store/settingsStore';

const SNAP = 20;

export function GroupNode({ id, data, selected }: NodeProps) {
  const label       = (data.label as string) || 'Group';
  const snapEnabled = useSettingsStore(s => s.settings.snapEnabled);
  const { setNodes } = useReactFlow();

  // Snap final dimensions to the grid on resize end (NodeResizer has no built-in snap prop).
  const handleResizeEnd = useCallback(
    (_evt: unknown, params: { x: number; y: number; width: number; height: number }) => {
      if (!snapEnabled) return;
      const w = Math.round(params.width  / SNAP) * SNAP;
      const h = Math.round(params.height / SNAP) * SNAP;
      if (w === params.width && h === params.height) return;
      setNodes(nds =>
        nds.map(n => n.id === id ? { ...n, style: { ...n.style, width: w, height: h } } : n),
      );
    },
    [snapEnabled, id, setNodes],
  );

  return (
    <>
      <NodeResizer
        isVisible={selected ?? false}
        minWidth={120}
        minHeight={80}
        onResizeEnd={handleResizeEnd}
        lineStyle={{ borderColor: '#6d5bef', borderWidth: 1.5 }}
        handleStyle={{ background: '#6d5bef', borderColor: '#6d5bef', width: 8, height: 8, borderRadius: 2 }}
      />
      <div
        style={{
          width:     '100%',
          height:    '100%',
          borderRadius: 10,
          border:    `2px dashed ${selected ? 'rgba(109,91,239,0.55)' : 'rgba(100,100,160,0.25)'}`,
          background: selected ? 'rgba(109,91,239,0.05)' : 'rgba(100,100,160,0.03)',
          boxSizing: 'border-box',
          position:  'relative',
          // allow clicks on child nodes to pass through the group background
          pointerEvents: selected ? 'all' : 'none',
        }}
      >
        <span
          style={{
            position:   'absolute',
            top:        7,
            left:       11,
            fontSize:   9,
            color:      selected ? 'rgba(157,139,244,0.9)' : 'rgba(120,120,170,0.5)',
            fontFamily: 'monospace',
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            userSelect: 'none',
            pointerEvents: 'none',
          }}
        >
          {label}
        </span>
      </div>
    </>
  );
}
