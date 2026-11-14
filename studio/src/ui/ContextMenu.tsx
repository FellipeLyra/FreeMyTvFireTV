import { useEffect, useRef } from 'react';

export type MenuItem =
    | { separator: true }
    | { label: string; shortcut?: string; action: () => void; disabled?: boolean; danger?: boolean; separator?: false };

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const close = (e: Event) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
        const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('pointerdown', close, true);
        window.addEventListener('keydown', esc);
        return () => { window.removeEventListener('pointerdown', close, true); window.removeEventListener('keydown', esc); };
    }, [onClose]);
    return (
        <div ref={ref} className="ctx-menu" style={{ left: x, top: y }} role="menu">
            {items.map((it, i) => it.separator
                ? <div key={i} className="ctx-sep" />
                : (
                    <button key={i} role="menuitem" className={'ctx-item' + (it.danger ? ' danger' : '')} disabled={it.disabled}
                        onClick={() => { it.action(); onClose(); }}>
                        <span>{it.label}</span>
                        {it.shortcut && <kbd>{it.shortcut}</kbd>}
                    </button>
                ))}
        </div>
    );
}
