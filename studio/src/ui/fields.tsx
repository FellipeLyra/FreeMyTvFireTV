// Small, consistent form controls for the properties panel.
import { useEffect, useState, type ReactNode } from 'react';
import { E } from '../engine';
import { useEditor } from '../store/editor';
import { I } from './icons';

export function Section({ title, children, defaultOpen = true, actions }: { title: string; children: ReactNode; defaultOpen?: boolean; actions?: ReactNode }) {
    const [open, setOpen] = useState(defaultOpen);
    return (
        <section className="prop-section">
            <header>
                <button className="prop-section-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
                    {open ? <I.ChevronDown size={14} /> : <I.Chevron size={14} />}
                    <span>{title}</span>
                </button>
                {actions}
            </header>
            {open && <div className="prop-section-body">{children}</div>}
        </section>
    );
}

export function Row({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
    return (
        <label className="prop-row" title={hint}>
            <span className="prop-label">{label}</span>
            <span className="prop-control">{children}</span>
        </label>
    );
}

/** Number input that commits on Enter/blur and steps with arrow keys (Shift = ×10). */
export function NumberField({ value, onChange, min, max, step = 1, suffix, placeholder, disabled }: {
    value: number | undefined; onChange: (v: number | undefined) => void; min?: number; max?: number; step?: number;
    suffix?: string; placeholder?: string; disabled?: boolean;
}) {
    const [text, setText] = useState(value === undefined ? '' : String(round(value)));
    useEffect(() => { setText(value === undefined ? '' : String(round(value))); }, [value]);
    const commit = (t: string) => {
        if (t.trim() === '') { onChange(undefined); return; }
        let v = Number(t.replace(',', '.'));
        if (!isFinite(v)) { setText(value === undefined ? '' : String(round(value))); return; }
        if (min !== undefined) v = Math.max(min, v);
        if (max !== undefined) v = Math.min(max, v);
        onChange(v);
    };
    return (
        <span className="num-field">
            <input type="text" inputMode="decimal" value={text} placeholder={placeholder} disabled={disabled}
                onChange={(e) => setText(e.target.value)}
                onBlur={(e) => commit(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') commit((e.target as HTMLInputElement).value);
                    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                        e.preventDefault();
                        const base = Number(text) || 0;
                        const next = base + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
                        setText(String(round(next)));
                        commit(String(next));
                    }
                }} />
            {suffix && <span className="num-suffix">{suffix}</span>}
        </span>
    );
}

const round = (v: number) => Math.round(v * 100) / 100;

export function TextField({ value, onChange, placeholder, multiline, maxLength }: {
    value: string | undefined; onChange: (v: string) => void; placeholder?: string; multiline?: boolean; maxLength?: number;
}) {
    return multiline
        ? <textarea className="text-field" value={value || ''} placeholder={placeholder} maxLength={maxLength} rows={3} onChange={(e) => onChange(e.target.value)} />
        : <input className="text-field" type="text" value={value || ''} placeholder={placeholder} maxLength={maxLength} onChange={(e) => onChange(e.target.value)} />;
}

export function Select<T extends string>({ value, options, onChange, placeholder }: {
    value: T | undefined; options: { value: T; label: string }[]; onChange: (v: T) => void; placeholder?: string;
}) {
    return (
        <select className="select-field" value={value ?? ''} onChange={(e) => onChange(e.target.value as T)}>
            {placeholder !== undefined && <option value="">{placeholder}</option>}
            {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
    );
}

export function Segmented<T extends string>({ value, options, onChange }: {
    value: T | undefined; options: { value: T; label?: string; icon?: ReactNode; title?: string }[]; onChange: (v: T) => void;
}) {
    return (
        <span className="segmented" role="radiogroup">
            {options.map((o) => (
                <button key={o.value} role="radio" aria-checked={value === o.value} title={o.title || o.label}
                    className={value === o.value ? 'on' : ''} onClick={(e) => { e.preventDefault(); onChange(o.value); }}>
                    {o.icon}{o.label && <span>{o.label}</span>}
                </button>
            ))}
        </span>
    );
}

export function Toggle({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label?: string }) {
    return (
        <button className={'toggle' + (value ? ' on' : '')} role="switch" aria-checked={value} onClick={(e) => { e.preventDefault(); onChange(!value); }}>
            <span className="toggle-knob" />{label && <span className="toggle-label">{label}</span>}
        </button>
    );
}

/** Colour: swatch + text, accepting literals (#hex, rgba) or tokens ($colors.accent). */
export function ColorField({ value, onChange, allowEmpty }: { value: string | undefined; onChange: (v: string | undefined) => void; allowEmpty?: boolean }) {
    const tokens = useEditor((s) => s.project.layout.tokens);
    const merged = E.mergeTokens(tokens || {});
    const resolved = value ? (E.resolveToken(value, merged, 'color') as string | undefined) : undefined;
    const [text, setText] = useState(value || '');
    useEffect(() => { setText(value || ''); }, [value]);
    const valid = !text || E.resolveToken(text, merged, 'color') !== undefined;
    const commit = (t: string) => {
        if (!t) { if (allowEmpty) onChange(undefined); else setText(value || ''); return; }
        if (E.resolveToken(t, merged, 'color') !== undefined) onChange(t);
    };
    return (
        <span className="color-field">
            <span className="swatch" style={{ background: resolved || 'transparent' }}>
                <input type="color" aria-label="Escolher cor" value={toHex(resolved)} onChange={(e) => { setText(e.target.value); onChange(e.target.value); }} />
            </span>
            <input type="text" className={'text-field' + (valid ? '' : ' invalid')} value={text} spellCheck={false}
                onChange={(e) => setText(e.target.value)} onBlur={(e) => commit(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') commit((e.target as HTMLInputElement).value); }} />
            <select className="token-pick" value="" title="Usar um token de cor" onChange={(e) => { if (e.target.value) { setText(e.target.value); onChange(e.target.value); } }}>
                <option value="">$</option>
                {Object.keys(merged.colors).map((k) => <option key={k} value={'$colors.' + k}>{k}</option>)}
            </select>
        </span>
    );
}

/** Best-effort #rrggbb for the native colour picker. */
function toHex(c: string | undefined): string {
    if (!c) return '#000000';
    if (/^#[0-9a-f]{6}/i.test(c)) return c.slice(0, 7);
    if (/^#[0-9a-f]{3}$/i.test(c) || /^#[0-9a-f]{4}$/i.test(c)) return '#' + c.slice(1, 4).split('').map((x) => x + x).join('');
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
    if (m) return '#' + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('');
    return '#000000';
}

/** Number or token ($spacing.md) field. */
export function TokenNumberField({ value, onChange, group, min, max, suffix }: {
    value: number | string | undefined; onChange: (v: number | string | undefined) => void; group: 'spacing' | 'radius' | 'fontSizes';
    min?: number; max?: number; suffix?: string;
}) {
    const tokens = useEditor((s) => s.project.layout.tokens);
    const merged = E.mergeTokens(tokens || {});
    const isToken = typeof value === 'string';
    return (
        <span className="token-number">
            {isToken
                ? <span className="token-chip" title={String(E.resolveToken(value, merged, 'number'))}>{String(value).replace(/^\$\w+\./, '')}<button onClick={(e) => { e.preventDefault(); onChange(E.resolveToken(value, merged, 'number') as number); }} title="Desvincular do token">×</button></span>
                : <NumberField value={value} onChange={onChange} min={min} max={max} suffix={suffix} />}
            <select className="token-pick" value="" title="Usar um token" onChange={(e) => e.target.value && onChange(e.target.value)}>
                <option value="">$</option>
                {Object.entries(merged[group]).map(([k, v]) => <option key={k} value={`$${group}.${k}`}>{k} ({v})</option>)}
            </select>
        </span>
    );
}
