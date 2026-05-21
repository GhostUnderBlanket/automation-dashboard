import { Zap, LayoutGrid, ScrollText, Settings2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { clsx } from 'clsx';
import { useFlowStore } from '../store/flowStore';

interface NavItemProps {
  icon:    ReactNode;
  label:   string;
  active?: boolean;
  onClick: () => void;
}

function NavItem({ icon, label, active, onClick }: NavItemProps) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-[13.5px] font-medium transition-all duration-150',
        active
          ? 'bg-accent/10 text-accent-soft'
          : 'text-ink-dim hover:text-ink hover:bg-raised',
      )}
    >
      <span className="shrink-0">{icon}</span>
      {label}
    </button>
  );
}

export function Sidebar() {
  const view         = useFlowStore(s => s.view);
  const editorDirty  = useFlowStore(s => s.editorDirty);
  const setView      = useFlowStore(s => s.setView);
  const requestNav   = useFlowStore(s => s.requestNav);

  function navTo(target: 'home' | 'runlog' | 'settings') {
    if (view === 'editor' && editorDirty) {
      requestNav(target);
    } else {
      setView(target);
    }
  }

  return (
    <aside
      className="w-[200px] shrink-0 flex flex-col border-r border-wire bg-surface h-full"
      style={{ animation: 'slide-in 0.35s ease both' }}
    >
      {/* Logo ─────────────────────────── */}
      <div className="px-4 pt-5 pb-4">
        <div className="flex items-center gap-2.5">
          <div className="w-[28px] h-[28px] rounded-lg bg-accent flex items-center justify-center shrink-0 shadow-lg shadow-accent/30">
            <Zap size={14} strokeWidth={2.5} className="text-white" fill="white" />
          </div>
          <span className="text-ink text-[15px] font-bold tracking-tight font-display">
            autoflow
          </span>
        </div>
      </div>

      <div className="mx-4 h-px bg-wire mb-3" />

      {/* Primary navigation ──────────── */}
      <nav className="flex-1 px-2 space-y-0.5">
        <NavItem
          icon={<LayoutGrid size={15} />}
          label="Flows"
          active={view === 'home'}
          onClick={() => navTo('home')}
        />
        <NavItem
          icon={<ScrollText size={15} />}
          label="Run Log"
          active={view === 'runlog'}
          onClick={() => navTo('runlog')}
        />
      </nav>

      {/* Footer ───────────────────────── */}
      <div className="px-2 pt-2 pb-3 border-t border-wire">
        <NavItem
          icon={<Settings2 size={15} />}
          label="Settings"
          active={view === 'settings'}
          onClick={() => navTo('settings')}
        />
        <div className="flex items-center gap-2 px-3 pt-3 pb-1">
          <span className="w-1.5 h-1.5 rounded-full bg-success" />
          <span className="text-[11px] text-ink-ghost font-mono tracking-wide">ready</span>
        </div>
      </div>
    </aside>
  );
}
