import { useState } from 'react';
import { useEditor, selectRoot } from '../store/editor';
import * as T from '../model/tree';
import { I } from '../ui/icons';
import { preview } from '../canvas/Canvas';

/** Validation problems (from the shared engine) and canvas status. */
export function BottomBar() {
    const v = useEditor((s) => s.validation);
    const renderErrors = useEditor((s) => s.renderErrors);
    const selection = useEditor((s) => s.selection);
    const [open, setOpen] = useState(false);
    const root = useEditor(selectRoot);
    const issues = [
        ...renderErrors.map((m) => ({ kind: 'error' as const, path: '', message: 'canvas: ' + m })),
        ...v.errors.map((e) => ({ kind: 'error' as const, ...e })),
        ...v.warnings.map((e) => ({ kind: 'warning' as const, ...e })),
    ];
    const nErr = v.errors.length + renderErrors.length;
    const crumbs = selection.length === 1 ? T.pathTo(root, selection[0]).map((id) => T.find(root, id)!.node) : [];

    const goto = (path: string) => {
        const st = useEditor.getState();
        // Errors can belong to another screen: go there first.
        const pageMatch = /^pages\.([a-z]+)/.exec(path);
        if (pageMatch && pageMatch[1] !== st.page) st.setPage(pageMatch[1]);
        const ids = Array.from(path.matchAll(/<([^>]+)>/g)).map((m) => m[1]);
        const id = ids[ids.length - 1];
        const r = useEditor.getState().project.layout.pages[useEditor.getState().page]?.root;
        if (id && r && T.find(r, id)) useEditor.getState().select([id]);
    };

    return (
        <footer className="bottombar">
            {open && (
                <div className="problems">
                    {!issues.length && <div className="problem ok"><I.Check size={14} /> Nenhum problema. O layout pode ser exportado.</div>}
                    {issues.map((p, i) => (
                        <button key={i} className={'problem ' + p.kind} onClick={() => goto(p.path)}>
                            {p.kind === 'error' ? <I.Error size={14} /> : <I.Warning size={14} />}
                            <span className="problem-msg">{p.message}</span>
                            {p.path && <code>{p.path.replace(/^pages\.home\.root/, 'tela').replace(/\.children\[\d+\]/g, ' ›').slice(0, 120)}</code>}
                        </button>
                    ))}
                </div>
            )}
            <div className="status">
                <button className={'status-btn' + (nErr ? ' err' : v.warnings.length ? ' warn' : ' ok')} onClick={() => setOpen(!open)}>
                    {nErr ? <I.Error size={14} /> : v.warnings.length ? <I.Warning size={14} /> : <I.Check size={14} />}
                    {nErr ? `${nErr} erro(s)` : 'Válido'}{v.warnings.length ? ` · ${v.warnings.length} aviso(s)` : ''}
                </button>
                <nav className="crumbs" aria-label="Caminho do elemento">
                    {crumbs.map((n, i) => (
                        <span key={n.id}>
                            {i > 0 && <I.Chevron size={11} />}
                            <button onClick={() => useEditor.getState().select([n.id])}>{n.name || n.id}</button>
                        </span>
                    ))}
                </nav>
                <span className="status-hint">Espaço+arrastar move a vista · Ctrl+roda dá zoom · Ctrl+arrastar leva um elemento absoluto para outro container</span>
            </div>
        </footer>
    );
}

/** On-screen remote for the preview mode; the keyboard arrows work too. */
export function RemotePanel() {
    const send = (k: Parameters<NonNullable<typeof preview>['key']>[0]) => preview?.key(k);
    return (
        <div className="remote" aria-label="Controle remoto virtual">
            <div className="remote-title"><I.Remote size={14} /> Controle</div>
            <div className="dpad">
                <button className="up" onClick={() => send('ArrowUp')} aria-label="Cima">▲</button>
                <button className="left" onClick={() => send('ArrowLeft')} aria-label="Esquerda">◀</button>
                <button className="ok" onClick={() => send('Enter')}>OK</button>
                <button className="right" onClick={() => send('ArrowRight')} aria-label="Direita">▶</button>
                <button className="down" onClick={() => send('ArrowDown')} aria-label="Baixo">▼</button>
            </div>
            <div className="remote-row">
                <button onClick={() => send('Escape')}>Voltar</button>
            </div>
            <p className="panel-note">Mesma navegação da TV. Abrir apps vira um aviso aqui.</p>
        </div>
    );
}
