import { useMemo, useState } from 'react';
import { E } from '../engine';
import { useEditor, selectRoot, type LeftTab } from '../store/editor';
import * as T from '../model/tree';
import type { LayoutNode } from '../model/types';
import { I, iconForType } from '../ui/icons';
import { bytesToBase64, sha256Hex } from '../lib/bytes';
import { pickFiles } from '../lib/storage';
import { BUILTIN_BLOCKS, type Block } from '../model/blocks';
import { PAGE_HINTS } from '../model/pages';

const TABS: { id: LeftTab; label: string; icon: JSX.Element }[] = [
    { id: 'pages', label: 'Páginas', icon: <I.Page /> },
    { id: 'layers', label: 'Camadas', icon: <I.Layers /> },
    { id: 'components', label: 'Componentes', icon: <I.Components /> },
    { id: 'assets', label: 'Assets', icon: <I.Image /> },
];

export function LeftPanel() {
    const tab = useEditor((s) => s.leftTab);
    const setTab = useEditor((s) => s.setLeftTab);
    return (
        <aside className="panel panel-left">
            <nav className="panel-tabs" role="tablist">
                {TABS.map((t) => (
                    <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)} title={t.label}>
                        {t.icon}<span>{t.label}</span>
                    </button>
                ))}
            </nav>
            <div className="panel-body">
                {tab === 'pages' && <Pages />}
                {tab === 'layers' && <Layers />}
                {tab === 'components' && <Components />}
                {tab === 'assets' && <Assets />}
            </div>
        </aside>
    );
}

/* ---------------- Pages ---------------- */

function Pages() {
    const page = useEditor((s) => s.page);
    const custom = useEditor((s) => Object.keys(s.project.layout.pages));
    const s = useEditor.getState;
    return (
        <div className="list">
            {Object.entries(E.PAGES).map(([id, p]) => {
                const isCustom = custom.includes(id);
                return (
                    <div key={id} className={'list-item page-item' + (id === page ? ' on' : '')} role="button" tabIndex={0}
                        onClick={() => s().setPage(id)} onKeyDown={(e) => e.key === 'Enter' && s().setPage(id)}>
                        <I.Page />
                        <span className="grow">
                            <span className="page-name">{p.label}</span>
                            <span className="page-hint">{id === 'home' ? 'Tela principal do launcher' : PAGE_HINTS[id]}</span>
                        </span>
                        {id !== 'home' && <span className={'badge' + (isCustom ? ' custom' : '')}>{isCustom ? 'personalizada' : 'original'}</span>}
                    </div>
                );
            })}
            <p className="panel-note">Telas "originais" usam o visual do launcher. Abra uma e clique em "Personalizar esta tela" para editá-la. As funções (salvar, clima, fechar) continuam as do launcher.</p>
        </div>
    );
}

/* ---------------- Layers ---------------- */

type DropPos = 'before' | 'after' | 'inside';

function Layers() {
    const root = useEditor(selectRoot);
    const [query, setQuery] = useState('');
    const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
    const [drop, setDrop] = useState<{ id: string; pos: DropPos } | null>(null);
    const [dragId, setDragId] = useState<string | null>(null);

    const onDrop = () => {
        const s = useEditor.getState();
        if (!drop || !dragId || drop.id === dragId) { setDrop(null); return; }
        const r = selectRoot(s);
        const target = T.find(r, drop.id);
        if (!target) return;
        if (drop.pos === 'inside') {
            const rect = s.rects[dragId];
            const pr = s.rects[target.node.id];
            s.moveNode(dragId, {
                parentId: target.node.id, index: (target.node.children || []).length,
                rect: target.node.type === 'frame' && rect && pr ? { x: rect.x - pr.x, y: rect.y - pr.y, w: rect.w, h: rect.h } : undefined,
                parentSize: pr ? { w: pr.w, h: pr.h } : undefined,
            });
        } else if (target.parent) {
            const rect = s.rects[dragId];
            const pr = s.rects[target.parent.id];
            // Free containers are listed topmost-first ("before" in the list = later in the array);
            // stacks are listed in flow order.
            const inStack = target.parent.type === 'stack';
            s.moveNode(dragId, {
                parentId: target.parent.id, index: target.index + (inStack ? (drop.pos === 'after' ? 1 : 0) : (drop.pos === 'before' ? 1 : 0)),
                rect: target.parent.type === 'frame' && rect && pr ? { x: rect.x - pr.x, y: rect.y - pr.y, w: rect.w, h: rect.h } : undefined,
                parentSize: pr ? { w: pr.w, h: pr.h } : undefined,
            });
        }
        setDrop(null);
        setDragId(null);
    };

    return (
        <div className="layers">
            <input className="text-field search" placeholder="Buscar camada…" value={query} onChange={(e) => setQuery(e.target.value)} />
            <div className="tree" role="tree" onDragEnd={() => { setDrop(null); setDragId(null); }}>
                <LayerRow node={root} parent={null} depth={0} query={query.toLowerCase()} collapsed={collapsed}
                    setCollapsed={setCollapsed} drop={drop} setDrop={setDrop} dragId={dragId} setDragId={setDragId} onDrop={onDrop} />
            </div>
            <p className="panel-note">Arraste para reordenar ou mover para outro container. Clique duplo renomeia.</p>
        </div>
    );
}

function matches(n: LayoutNode, q: string): boolean {
    if (!q) return true;
    const label = (n.name || '') + ' ' + n.id + ' ' + (E.registry[n.type]?.label || '');
    if (label.toLowerCase().includes(q)) return true;
    return (n.children || []).some((c) => matches(c, q));
}

function LayerRow(props: {
    node: LayoutNode; parent: LayoutNode | null; depth: number; query: string;
    collapsed: Record<string, boolean>; setCollapsed: (c: Record<string, boolean>) => void;
    drop: { id: string; pos: DropPos } | null; setDrop: (d: { id: string; pos: DropPos } | null) => void;
    dragId: string | null; setDragId: (id: string | null) => void; onDrop: () => void;
}) {
    const { node, parent, depth, query, collapsed, setCollapsed, drop, setDrop, dragId, setDragId, onDrop } = props;
    const selected = useEditor((s) => s.selection.includes(node.id));
    const hovered = useEditor((s) => s.hover === node.id);
    const [renaming, setRenaming] = useState(false);
    if (!matches(node, query)) return null;
    const def = E.registry[node.type];
    const isCont = !!def?.container;
    const Icon = node.type === 'stack' && node.layout?.direction === 'vertical' ? I.StackV : iconForType(node.type);
    // Stacks list children in flow order (the first in the list comes first on screen);
    // free containers list them by stacking order (topmost first), like design tools.
    const kids = node.type === 'stack' ? [...(node.children || [])] : [...(node.children || [])].reverse();
    const open = !collapsed[node.id] || !!query;
    const absolute = T.isAbsolute(node, parent);
    const s = useEditor.getState;

    const onDragOver = (e: React.DragEvent) => {
        if (!dragId || dragId === node.id) return;
        const r = selectRoot(s());
        if (T.isDescendant(r, dragId, node.id)) return;
        e.preventDefault();
        const b = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const f = (e.clientY - b.top) / b.height;
        const pos: DropPos = isCont && f > 0.25 && f < 0.75 ? 'inside' : f < 0.5 ? 'before' : 'after';
        if (!parent && pos !== 'inside') return;
        if (drop?.id !== node.id || drop.pos !== pos) setDrop({ id: node.id, pos });
    };

    return (
        <div role="treeitem" aria-selected={selected} aria-expanded={isCont ? open : undefined}>
            <div className={'layer' + (selected ? ' on' : '') + (hovered ? ' hover' : '') + (node.visible === false ? ' hidden' : '')
                + (drop?.id === node.id ? ' drop-' + drop.pos : '')}
                style={{ paddingLeft: 6 + depth * 14 }}
                draggable={!!parent && !node.locked}
                onDragStart={(e) => { e.dataTransfer.setData('text/plain', node.id); e.dataTransfer.effectAllowed = 'move'; setDragId(node.id); }}
                onDragOver={onDragOver}
                onDrop={(e) => { e.preventDefault(); onDrop(); }}
                onMouseEnter={() => s().setHover(node.id)} onMouseLeave={() => s().setHover(null)}
                onClick={(e) => {
                    const sel = s().selection;
                    if (e.shiftKey || e.ctrlKey || e.metaKey) s().select(sel.includes(node.id) ? sel.filter((i) => i !== node.id) : [...sel, node.id]);
                    else s().select([node.id]);
                }}
                onDoubleClick={() => setRenaming(true)}>
                <button className={'twisty' + (isCont && kids.length ? '' : ' empty')} onClick={(e) => { e.stopPropagation(); setCollapsed({ ...collapsed, [node.id]: open }); }} aria-label={open ? 'Recolher' : 'Expandir'}>
                    {isCont && kids.length ? (open ? <I.ChevronDown size={12} /> : <I.Chevron size={12} />) : null}
                </button>
                <Icon size={14} className={'layer-icon' + (def?.slot ? ' widget' : '')} />
                {renaming
                    ? <input autoFocus className="rename" defaultValue={node.name || ''} placeholder={def?.label}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={(e) => { const v = e.target.value.trim().slice(0, 80); s().updateNode(node.id, (n) => { if (v) n.name = v; else delete n.name; }); setRenaming(false); }}
                        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(false); }} />
                    : <span className="layer-name">{node.name || def?.label || node.type}{absolute && <span className="abs-mark" title="Posição absoluta">⌖</span>}</span>}
                {parent && (
                    <span className="layer-actions">
                        <button title={node.locked ? 'Desbloquear' : 'Bloquear'} className={node.locked ? 'pinned' : ''} onClick={(e) => { e.stopPropagation(); s().toggleLocked(node.id); }}>
                            {node.locked ? <I.Lock size={13} /> : <I.Unlock size={13} />}
                        </button>
                        <button title={node.visible === false ? 'Mostrar' : 'Ocultar'} className={node.visible === false ? 'pinned' : ''} onClick={(e) => { e.stopPropagation(); s().toggleVisible(node.id); }}>
                            {node.visible === false ? <I.EyeOff size={13} /> : <I.Eye size={13} />}
                        </button>
                    </span>
                )}
            </div>
            {isCont && open && kids.map((c) => (
                <LayerRow key={c.id} {...props} node={c} parent={node} depth={depth + 1} />
            ))}
        </div>
    );
}

/* ---------------- Components ---------------- */

const CATEGORY_LABEL: Record<string, string> = { layout: 'Layout', basic: 'Básicos', data: 'Conteúdo e dados', launcher: 'Widgets do launcher' };

function Components() {
    const root = useEditor(selectRoot);
    const used = useMemo(() => {
        const set = new Set<string>();
        E.walk(root, (n) => { set.add(n.type); });
        return set;
    }, [root]);
    const userBlocks = useEditor((s) => s.project.blocks || []);
    const [renaming, setRenaming] = useState<string | null>(null);
    const groups: Record<string, string[]> = {};
    const page = useEditor((st) => st.page);
    // Launcher widgets are listed for the screen they belong to.
    for (const [type, def] of Object.entries(E.registry)) {
        if (def.slot && (def.page || 'home') !== page) continue;
        (groups[def.category] ||= []).push(type);
    }
    const s = useEditor.getState;
    const blockRow = (b: Block, user: boolean) => (
        <div key={b.id} className="block-item" draggable
            title={(b.description ? b.description + '. ' : '') + 'Clique para inserir ou arraste para o canvas'}
            onDragStart={(e) => { e.dataTransfer.setData('application/x-fmtv-block', b.id); e.dataTransfer.effectAllowed = 'copy'; }}
            onClick={() => renaming !== b.id && s().insertBlock(b)}>
            {(() => { const Icon = b.fill ? I.Palette : iconForType(b.node.type === 'stack' && b.node.children?.[1] ? b.node.children[1].type : b.node.type); return <Icon size={16} />; })()}
            <span className="block-text">
                {renaming === b.id
                    ? <input autoFocus className="rename" defaultValue={b.name} onClick={(e) => e.stopPropagation()}
                        onBlur={(e) => { s().renameBlock(b.id, e.target.value); setRenaming(null); }}
                        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(null); }} />
                    : <span className="block-name">{b.name}</span>}
                {b.description && <span className="block-desc">{b.description}</span>}
            </span>
            {user && (
                <span className="layer-actions">
                    <button title="Renomear" onClick={(e) => { e.stopPropagation(); setRenaming(b.id); }}><I.Edit size={13} /></button>
                    <button title="Excluir bloco" onClick={(e) => { e.stopPropagation(); s().removeBlock(b.id); }}><I.Trash size={13} /></button>
                </span>
            )}
        </div>
    );
    const primitives = (cats: readonly ('layout' | 'basic' | 'data' | 'launcher')[]) => cats.map((cat) => groups[cat] && (
        <div key={cat} className="comp-group">
            <h4>{CATEGORY_LABEL[cat]}</h4>
            <div className="comp-grid">
                {cat === 'layout' && (['horizontal', 'vertical'] as const).map((dir) => {
                    const Icon = dir === 'horizontal' ? I.StackH : I.StackV;
                    return (
                        <button key={'stack-' + dir} className="comp" draggable
                            title="Clique para adicionar (com elementos selecionados, agrupa-os) ou arraste para o canvas"
                            onDragStart={(e) => { e.dataTransfer.setData('application/x-fmtv-component', 'stack'); e.dataTransfer.setData('application/x-fmtv-direction', dir); e.dataTransfer.effectAllowed = 'copy'; }}
                            onClick={() => useEditor.getState().createStack(dir)}>
                            <Icon size={20} />
                            <span>{dir === 'horizontal' ? 'Stack horizontal' : 'Stack vertical'}</span>
                        </button>
                    );
                })}
                {groups[cat].filter((type) => type !== 'stack').map((type) => {
                    const def = E.registry[type];
                    const Icon = iconForType(type);
                    const taken = !!def.slot && used.has(type);
                    return (
                        <button key={type} className={'comp' + (taken ? ' taken' : '')} draggable={!taken} disabled={taken}
                            title={taken ? 'Já está na tela (cada widget aparece uma vez)' : 'Clique para adicionar ou arraste para o canvas'}
                            onDragStart={(e) => { e.dataTransfer.setData('application/x-fmtv-component', type); e.dataTransfer.effectAllowed = 'copy'; }}
                            onClick={() => useEditor.getState().addNode(type)}>
                            <Icon size={20} />
                            <span>{def.label}</span>
                        </button>
                    );
                })}
            </div>
        </div>
    ));
    return (
        <div className="components">
            {primitives(['layout', 'basic'])}
            <div className="comp-group">
                <h4>Blocos prontos</h4>
                <div className="block-list">{BUILTIN_BLOCKS.map((b) => blockRow(b, false))}</div>
            </div>
            <div className="comp-group">
                <h4>Meus blocos</h4>
                {userBlocks.length
                    ? <div className="block-list">{userBlocks.map((b) => blockRow(b, true))}</div>
                    : <p className="panel-note">Selecione um elemento e use "Salvar como bloco" (botão direito) para reutilizá-lo. Os blocos ficam salvos no projeto.</p>}
            </div>
            {primitives(['data', 'launcher'])}
            <p className="panel-note">Os widgets do launcher são os de verdade: clima, apps e filmes funcionam na prévia e na TV.</p>
        </div>
    );
}

/* ---------------- Assets ---------------- */

const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.(png|jpg|jpeg|webp)$/;

function Assets() {
    const assets = useEditor((s) => s.project.layout.assets || []);
    const data = useEditor((s) => s.project.assetData);
    const s = useEditor.getState;

    const importFiles = async () => {
        const files = await pickFiles('image/png,image/jpeg,image/webp');
        for (const f of files) {
            try {
                if (!/^image\/(png|jpeg|webp)$/.test(f.type)) throw new Error(`${f.name}: use PNG, JPG ou WebP`);
                if (f.size > E.LIMITS.assetBytes) throw new Error(`${f.name}: maior que ${Math.round(E.LIMITS.assetBytes / 1048576)} MB`);
                const bytes = new Uint8Array(await f.arrayBuffer());
                const ext = f.type === 'image/png' ? 'png' : f.type === 'image/webp' ? 'webp' : 'jpg';
                const existing = new Set((s().project.layout.assets || []).map((a) => a.id));
                const files = new Set((s().project.layout.assets || []).map((a) => a.file));
                let stem = f.name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[^A-Za-z]+/, '').slice(0, 40) || 'imagem';
                let id = stem, i = 2;
                while (existing.has(id) || files.has(`${id}.${ext}`)) id = `${stem}-${i++}`;
                stem = id;
                const file = `${stem}.${ext}`;
                if (!FILE_RE.test(file)) throw new Error(`${f.name}: nome inválido`);
                let width: number | undefined, height: number | undefined;
                try {
                    const bmp = await createImageBitmap(new Blob([bytes], { type: f.type }));
                    width = bmp.width; height = bmp.height; bmp.close();
                } catch { /* size is optional */ }
                s().addAsset({ id, file, bytes: bytes.length, sha256: await sha256Hex(bytes), width, height }, bytesToBase64(bytes));
                s().toast(`imagem ${file} importada`, 'success');
            } catch (e) {
                s().toast((e as Error).message, 'error');
            }
        }
    };

    const useAsBackground = (id: string) => {
        const st = s();
        const target = st.selection[0] || selectRoot(st).id;
        st.updateNode(target, (n) => { n.style = { ...(n.style || {}), background: { type: 'image', asset: id, fit: 'cover' } }; });
    };

    return (
        <div className="assets">
            <button className="btn btn-block" onClick={importFiles}><I.Upload size={15} /> Importar imagens</button>
            {!assets.length && <p className="panel-note">Nenhuma imagem ainda. PNG, JPG ou WebP, até 8 MB cada.</p>}
            <div className="asset-grid">
                {assets.map((a) => (
                    <div key={a.id} className="asset" draggable onDragStart={(e) => { e.dataTransfer.setData('application/x-fmtv-asset', a.id); e.dataTransfer.effectAllowed = 'copy'; }}>
                        <div className="asset-thumb" style={{ backgroundImage: data[a.id] ? `url(data:image/${a.file.endsWith('png') ? 'png' : a.file.endsWith('webp') ? 'webp' : 'jpeg'};base64,${data[a.id]})` : undefined }} />
                        <div className="asset-meta">
                            <span className="asset-name" title={a.file}>{a.file}</span>
                            <span className="asset-size">{a.width ? `${a.width}×${a.height} · ` : ''}{Math.round(a.bytes / 1024)} KB</span>
                        </div>
                        <div className="asset-actions">
                            <button title="Usar como fundo do elemento selecionado" onClick={() => useAsBackground(a.id)}><I.Palette size={13} /></button>
                            <button title="Remover imagem" onClick={() => s().removeAsset(a.id)}><I.Trash size={13} /></button>
                        </div>
                    </div>
                ))}
            </div>
            {!!assets.length && <p className="panel-note">Arraste uma imagem para o canvas para criar um elemento Imagem.</p>}
        </div>
    );
}
