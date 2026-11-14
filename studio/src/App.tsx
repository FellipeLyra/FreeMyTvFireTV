import { useEffect, useState } from 'react';
import { useEditor } from './store/editor';
import { TopBar, doOpen, doSave } from './TopBar';
import { LeftPanel } from './panels/LeftPanel';
import { Properties } from './panels/Properties';
import { BottomBar, RemotePanel } from './panels/BottomBar';
import { Canvas, isTyping, preview } from './canvas/Canvas';
import { readAutosave, writeAutosave } from './lib/storage';
import { I } from './ui/icons';
import type { Project } from './model/types';
import { TEMPLATES } from './model/project';

export function App() {
    const mode = useEditor((s) => s.mode);
    const toasts = useEditor((s) => s.toasts);
    const [recover, setRecover] = useState<{ project: Project; name: string; savedAt: number } | null>(null);

    // ?template=cinema opens a template directly (demos, UI tests); otherwise offer
    // the last autosave when it holds unsaved work (crash recovery).
    useEffect(() => {
        const params = new URLSearchParams(location.search);
        const t = TEMPLATES.find((x) => x.id === params.get('template'));
        if (t) {
            t.create().then((p) => {
                useEditor.getState().load(p, p.layout.name);
                const sel = params.get('select');
                if (sel) useEditor.getState().select(sel.split(','));
                const tab = params.get('tab');
                if (tab) useEditor.getState().setLeftTab(tab as never);
                window.dispatchEvent(new Event('fmtv:fit'));
            });
            return;
        }
        readAutosave().then((r) => { if (r) setRecover(r); });
    }, []);

    // Autosave a second after the last change.
    useEffect(() => {
        let t: ReturnType<typeof setTimeout> | null = null;
        return useEditor.subscribe((s, prev) => {
            if (s.project === prev.project || !s.dirty) return;
            if (t) clearTimeout(t);
            t = setTimeout(() => writeAutosave(s.project, s.fileName), 1000);
        });
    }, []);

    // Warn before closing with unsaved changes.
    useEffect(() => {
        const h = (e: BeforeUnloadEvent) => { if (useEditor.getState().dirty) { e.preventDefault(); e.returnValue = ''; } };
        window.addEventListener('beforeunload', h);
        return () => window.removeEventListener('beforeunload', h);
    }, []);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const s = useEditor.getState();
            const mod = e.ctrlKey || e.metaKey;
            if (s.mode === 'preview') {
                const keys: Record<string, 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Enter' | 'Escape'> =
                    { ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', Enter: 'Enter', Backspace: 'Escape' };
                if (keys[e.key] && !isTyping(e)) { e.preventDefault(); preview?.key(keys[e.key]); preview?.releaseFocus(); return; }
                if (e.key === 'Escape' || (e.key.toLowerCase() === 'p' && !mod && !isTyping(e))) { e.preventDefault(); s.setMode('edit'); }
                return;
            }
            if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); doSave(e.shiftKey); return; }
            if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); doOpen(); return; }
            if (isTyping(e)) return;
            const k = e.key.toLowerCase();
            if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); s.undo(); }
            else if ((mod && k === 'z' && e.shiftKey) || (mod && k === 'y')) { e.preventDefault(); s.redo(); }
            else if (mod && k === 'd') { e.preventDefault(); s.duplicateSelection(); }
            else if (mod && k === 'c') { e.preventDefault(); s.copySelection(); }
            else if (mod && k === 'x') { e.preventDefault(); s.cutSelection(); }
            else if (mod && k === 'v') { e.preventDefault(); s.paste(); }
            else if (mod && k === 'g' && e.shiftKey) { e.preventDefault(); s.unwrapSelection(); }
            else if (mod && k === 'g') { e.preventDefault(); s.wrapSelection(e.altKey ? 'vertical' : 'horizontal'); }
            else if (mod && e.shiftKey && k === 'h') { e.preventDefault(); s.selection.forEach((id) => s.toggleVisible(id)); }
            else if (mod && e.shiftKey && k === 'l') { e.preventDefault(); s.selection.forEach((id) => s.toggleLocked(id)); }
            else if (mod && e.key === ']') { e.preventDefault(); s.reorderSelection(e.shiftKey ? 'forward' : 'front'); }
            else if (mod && e.key === '[') { e.preventDefault(); s.reorderSelection(e.shiftKey ? 'backward' : 'back'); }
            else if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); s.setZoom(s.zoom * 1.25); }
            else if (mod && e.key === '-') { e.preventDefault(); s.setZoom(s.zoom / 1.25); }
            else if ((mod && e.key === '0') || (e.shiftKey && e.code === 'Digit1')) { e.preventDefault(); window.dispatchEvent(new Event('fmtv:fit')); }
            else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); s.deleteSelection(); }
            else if (e.key === 'Escape') { s.select([]); }
            else if (k === 'p' && !mod) { s.setMode('preview'); }
            else if (e.key.startsWith('Arrow') && s.selection.length) {
                e.preventDefault();
                const d = e.shiftKey ? 10 : 1;
                const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0;
                const dy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0;
                s.moveAbsolute(s.selection, dx, dy);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    return (
        <div className={'app mode-' + mode}>
            <TopBar />
            <div className="workspace">
                <LeftPanel />
                <main className="center">
                    <Canvas />
                    {mode === 'preview' && <RemotePanel />}
                </main>
                <Properties />
            </div>
            <BottomBar />
            {recover && (
                <div className="banner" role="alert">
                    <I.Warning size={16} />
                    <span>Há um projeto não salvo de {new Date(recover.savedAt).toLocaleString('pt-BR')} ({recover.project.layout.name}). Recuperar?</span>
                    <button className="btn primary" onClick={() => { useEditor.getState().load(recover.project, recover.name); useEditor.setState({ dirty: true }); setRecover(null); }}>Recuperar</button>
                    <button className="btn" onClick={() => setRecover(null)}>Descartar</button>
                </div>
            )}
            <div className="toasts" aria-live="polite">
                {toasts.map((t) => <div key={t.id} className={'toast ' + t.kind} onClick={() => useEditor.getState().dismissToast(t.id)}>{t.text}</div>)}
            </div>
        </div>
    );
}
