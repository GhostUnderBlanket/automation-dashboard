import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { clsx } from 'clsx';
import type { NodeKind } from '../types/flow';

export interface PaletteItem {
  type:     NodeKind;
  icon:     React.ReactNode;
  label:    string;
  color:    string;
  disabled?: boolean;
}

interface NodePaletteProps {
  open:        boolean;
  items:       PaletteItem[];
  onSelect:    (type: NodeKind) => void;
  onClose:     () => void;
}

export function NodePalette({ open, items, onSelect, onClose }: NodePaletteProps) {
  const [query,     setQuery]     = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef  = useRef<HTMLInputElement>(null);
  const listRef   = useRef<HTMLUListElement>(null);

  // Reset state when opening
  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIdx(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const filtered = items.filter(item =>
    !item.disabled &&
    (item.label.toLowerCase().includes(query.toLowerCase()) ||
     item.type.toLowerCase().includes(query.toLowerCase()))
  );

  // Clamp active index whenever the filtered list changes
  useEffect(() => {
    setActiveIdx(i => Math.min(i, Math.max(0, filtered.length - 1)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // Scroll active item into view
  useEffect(() => {
    const el = listRef.current?.children[activeIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx(i => Math.min(i + 1, filtered.length - 1));
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx(i => Math.max(i - 1, 0));
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const item = filtered[activeIdx];
      if (item) { onSelect(item.type); onClose(); }
    }
  }

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
      />

      {/* Palette card */}
      <div
        className="fixed left-1/2 top-[18%] -translate-x-1/2 z-50 w-[340px] rounded-xl border border-wire bg-surface shadow-2xl shadow-black/60 overflow-hidden"
        style={{ animation: 'fade-up 0.14s ease both' }}
      >
        {/* Search row */}
        <div className="flex items-center gap-2.5 px-3.5 py-3 border-b border-wire">
          <Search size={14} className="text-ink-ghost shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Add node…"
            className="flex-1 bg-transparent text-[13px] text-ink placeholder-ink-ghost outline-none"
            spellCheck={false}
          />
          <kbd className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-raised border border-wire text-ink-ghost">
            Esc
          </kbd>
        </div>

        {/* Node list */}
        <ul
          ref={listRef}
          className="max-h-[320px] overflow-y-auto py-1"
        >
          {filtered.length === 0 && (
            <li className="px-4 py-3 text-[12px] text-ink-ghost text-center">
              No nodes match "{query}"
            </li>
          )}
          {filtered.map((item, i) => (
            <li key={item.type}>
              <button
                onClick={() => { onSelect(item.type); onClose(); }}
                onMouseEnter={() => setActiveIdx(i)}
                className={clsx(
                  'flex items-center gap-3 w-full px-3.5 py-2.5 text-left transition-colors',
                  i === activeIdx ? 'bg-raised' : 'hover:bg-raised/60',
                )}
              >
                <span
                  className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
                  style={{ background: `${item.color}18`, color: item.color }}
                >
                  {item.icon}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="text-[13px] font-medium text-ink">{item.label}</span>
                </span>
                <span
                  className="text-[9px] font-mono px-1.5 py-0.5 rounded shrink-0"
                  style={{ color: item.color, background: `${item.color}18` }}
                >
                  {item.type}
                </span>
              </button>
            </li>
          ))}
        </ul>

        {/* Footer hint */}
        <div className="px-3.5 py-2 border-t border-wire flex items-center gap-3">
          <span className="text-[10px] text-ink-ghost flex items-center gap-1">
            <kbd className="font-mono px-1 py-0.5 rounded bg-raised border border-wire text-[9px]">↑↓</kbd>
            navigate
          </span>
          <span className="text-[10px] text-ink-ghost flex items-center gap-1">
            <kbd className="font-mono px-1 py-0.5 rounded bg-raised border border-wire text-[9px]">↵</kbd>
            add
          </span>
        </div>
      </div>
    </>
  );
}
