import { useEffect, useRef, useState } from 'react';
import type { Draft } from 'immer';
import { E } from '../engine';
import { useEditor, selectRoot, relRect } from '../store/editor';
import * as T from '../model/tree';
import type { Anchor, Constraint, Dim, LayoutNode, Paint } from '../model/types';
import { ColorField, NumberField, Row, Section, Segmented, Select, TextField, Toggle, TokenNumberField } from '../ui/fields';
import { I } from '../ui/icons';
import { ThemeEditor } from './Theme';
import { preview } from '../canvas/Canvas';

export function Properties() {
    const selection = useEditor((s) => s.selection);
    const root = useEditor(selectRoot);
    const locs = selection.map((id) => T.find(root, id)).filter((l): l is T.Located => !!l);
    return (
        <aside className="panel panel-right">
            {locs.length === 0 && <ThemeEditor />}
            {locs.length > 1 && <MultiSelection count={locs.length} />}
            {locs.length === 1 && <NodeProperties key={locs[0].node.id} loc={locs[0]} />}
        </aside>
    );
}

function MultiSelection({ count }: { count: number }) {
    const s = useEditor.getState();
    return (
        <div className="props">
            <div className="props-head"><strong>{count} elementos</strong></div>
            <AlignBar />
            <Section title="Organizar">
                <div className="btn-row">
                    <button className="btn" onClick={() => s.wrapSelection('horizontal')}><I.StackH size={14} /> Stack horizontal</button>
                    <button className="btn" onClick={() => s.wrapSelection('vertical')}><I.StackV size={14} /> Stack vertical</button>
                </div>
                <div className="btn-row">
                    <button className="btn" onClick={s.duplicateSelection}><I.Copy size={14} /> Duplicar</button>
                    <button className="btn danger" onClick={s.deleteSelection}><I.Trash size={14} /> Excluir</button>
                </div>
            </Section>
        </div>
    );
}

function AlignBar() {
    const s = useEditor.getState();
    const b = (mode: T.AlignMode, Icon: (p: { size?: number }) => JSX.Element, title: string) => (
        <button title={title} onClick={() => s.alignSelection(mode)}><Icon size={15} /></button>
    );
    return (
        <div className="align-bar">
            {b('left', I.AlignLeft, 'Alinhar à esquerda')}
            {b('hcenter', I.AlignHCenter, 'Centralizar na horizontal')}
            {b('right', I.AlignRight, 'Alinhar à direita')}
            {b('top', I.AlignTop, 'Alinhar ao topo')}
            {b('vcenter', I.AlignVCenter, 'Centralizar na vertical')}
            {b('bottom', I.AlignBottom, 'Alinhar embaixo')}
            <button title="Distribuir na horizontal" onClick={() => s.distributeSelection('h')}><I.DistH size={15} /></button>
            <button title="Distribuir na vertical" onClick={() => s.distributeSelection('v')}><I.DistV size={15} /></button>
        </div>
    );
}

function NodeProperties({ loc }: { loc: T.Located }) {
    const { node, parent } = loc;
    const def = E.registry[node.type];
    const s = useEditor.getState();
    const upd = (key: string, fn: (n: Draft<LayoutNode>) => void) => s.updateNode(node.id, fn, key);
    const absolute = T.isAbsolute(node, parent);
    const inStack = parent?.type === 'stack';
    const isText = node.type === 'text' || node.type === 'button' || node.type === 'clock-text';
    const nameRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        const focus = () => {
            const el = document.querySelector<HTMLTextAreaElement | HTMLInputElement>('.props [data-primary]');
            (el || nameRef.current)?.focus();
        };
        window.addEventListener('fmtv:focus-props', focus);
        return () => window.removeEventListener('fmtv:focus-props', focus);
    }, []);

    return (
        <div className="props">
            <div className="props-head">
                <input ref={nameRef} className="name-field" value={node.name || ''} placeholder={def?.label || node.type} maxLength={80}
                    onChange={(e) => upd('name', (n) => { if (e.target.value) n.name = e.target.value; else delete n.name; })} />
                <span className="type-chip" title={node.type}>{def?.label}</span>
            </div>
            <div className="props-id">id: <code>{node.id}</code>{def?.slot && <span className="badge">widget real</span>}</div>

            {absolute && <AlignBar />}

            {def?.container && <LayoutSection node={node} />}
            {parent && <PositionSection node={node} parent={parent} absolute={absolute} inStack={inStack} />}
            {parent && !absolute && <SizeSection node={node} parent={parent} />}
            <AppearanceSection node={node} />
            {isText && <TypographySection node={node} />}
            <DataSection node={node} />
            {def?.focusable && <FocusSection node={node} />}
            <AnimationSection node={node} />
        </div>
    );
}

/* ---------------- Layout (containers) ---------------- */

function LayoutSection({ node }: { node: LayoutNode }) {
    const s = useEditor.getState();
    const L = node.layout || {};
    const set = (key: string, fn: (l: NonNullable<LayoutNode['layout']>) => void) =>
        s.updateNode(node.id, (n) => { n.layout = n.layout || {}; fn(n.layout); }, 'layout.' + key);
    const isStack = node.type === 'stack';
    const horizontal = L.direction !== 'vertical';
    const pad = Array.isArray(L.padding) ? L.padding : [L.padding ?? 0, L.padding ?? 0, L.padding ?? 0, L.padding ?? 0];
    const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
    const [sides, setSides] = useState(Array.isArray(L.padding) && !(pad[0] === pad[2] && pad[1] === pad[3]));
    const setPad = (next: (number | string)[]) => set('padding', (l) => {
        if (next.every((x) => x === next[0])) { if (!next[0]) delete l.padding; else l.padding = next[0]; } else l.padding = next;
    });
    const auto = isStack && L.justify === 'space-between';

    if (!isStack) {
        return (
            <Section title="Auto layout" actions={<button className="icon-btn" title="Adicionar auto layout (Shift+A)" onClick={() => s.addAutoLayout(node.id)}><I.Plus size={14} /></button>}>
                <p className="panel-note">Container livre: os filhos ficam onde você colocar. Adicione auto layout (Shift+A) para que se organizem sozinhos; direção, espaçamento e padding são calculados das posições atuais.</p>
                <button className="btn" onClick={() => s.addAutoLayout(node.id)}><I.StackV size={14} /> Adicionar auto layout</button>
                <Row label="Cortar conteúdo"><Toggle value={!!L.clip} onChange={(v) => set('clip', (l) => { if (v) l.clip = true; else delete l.clip; })} /></Row>
            </Section>
        );
    }

    return (
        <Section title="Auto layout" actions={<button className="icon-btn" title="Remover auto layout" onClick={() => s.removeAutoLayout(node.id)}><I.Minus size={14} /></button>}>
            <div className="al-row">
                <Segmented value={L.wrap ? 'wrap' : (L.direction || 'horizontal')} onChange={(v) => set('direction', (l) => {
                    if (v === 'wrap') { l.direction = 'horizontal'; l.wrap = true; } else { l.direction = v as 'horizontal' | 'vertical'; delete l.wrap; }
                })} options={[
                    { value: 'vertical', icon: <I.ArrowDown size={14} />, title: 'Vertical' },
                    { value: 'horizontal', icon: <I.ArrowRight size={14} />, title: 'Horizontal' },
                    { value: 'wrap', icon: <I.Wrap size={14} />, title: 'Quebrar linha' },
                ]} />
            </div>
            <div className="al-main">
                <AlignGrid horizontal={horizontal} justify={L.justify || 'start'} align={L.align || 'start'}
                    onChange={(justify, align) => set('align', (l) => { l.justify = justify; l.align = align; })} />
                <div className="al-fields">
                    <label className="al-field" title={horizontal ? 'Espaço entre os itens (horizontal)' : 'Espaço entre os itens (vertical)'}>
                        {horizontal ? <I.GapH size={14} /> : <I.GapV size={14} />}
                        {auto
                            ? <span className="al-auto">Auto</span>
                            : <TokenNumberField group="spacing" value={L.gap} min={0} max={2000} onChange={(v) => set('gap', (l) => { if (v === undefined) delete l.gap; else l.gap = v; })} />}
                        <button className={'al-auto-btn' + (auto ? ' on' : '')} title="Espaçamento automático: distribui os itens com o espaço que sobra"
                            onClick={(e) => { e.preventDefault(); set('justify', (l) => { l.justify = auto ? 'start' : 'space-between'; }); }}>Auto</button>
                    </label>
                    {!sides ? (
                        <div className="al-pads">
                            <label className="al-field" title="Padding horizontal (esquerda e direita)"><I.PadH size={14} />
                                <NumberField value={num(pad[1])} min={0} max={2000} placeholder="0" onChange={(v) => setPad([pad[0], v ?? 0, pad[2], v ?? 0])} /></label>
                            <label className="al-field" title="Padding vertical (cima e baixo)"><I.PadV size={14} />
                                <NumberField value={num(pad[0])} min={0} max={2000} placeholder="0" onChange={(v) => setPad([v ?? 0, pad[1], v ?? 0, pad[3]])} /></label>
                        </div>
                    ) : (
                        <div className="quad">
                            {[0, 1, 2, 3].map((i) => (
                                <NumberField key={i} value={num(pad[i])} min={0} max={2000} placeholder={['↑', '→', '↓', '←'][i]}
                                    onChange={(v) => { const next = [...pad] as (number | string)[]; next[i] = v ?? 0; setPad(next); }} />
                            ))}
                        </div>
                    )}
                    <button className="al-link" onClick={(e) => { e.preventDefault(); setSides(!sides); }}>{sides ? 'Padding por eixo' : 'Padding por lado'}</button>
                </div>
            </div>
            <Row label="Esticar filhos" hint="Os filhos ocupam toda a altura (stack horizontal) ou largura (vertical)">
                <Toggle value={L.align === 'stretch'} onChange={(v) => set('stretch', (l) => { l.align = v ? 'stretch' : 'start'; })} />
            </Row>
            {horizontal && (
                <Row label="Linha de base" hint="Alinha os textos pela linha de base">
                    <Toggle value={L.align === 'baseline'} onChange={(v) => set('baseline', (l) => { l.align = v ? 'baseline' : 'start'; })} />
                </Row>
            )}
            <Row label="Cortar conteúdo"><Toggle value={!!L.clip} onChange={(v) => set('clip', (l) => { if (v) l.clip = true; else delete l.clip; })} /></Row>
            <p className="panel-note">Nos filhos: "Ignorar auto layout" em Posição; Fixo, Hug ou Fill em Tamanho. Shift+A agrupa a seleção numa stack.</p>
        </Section>
    );
}

type Justify = NonNullable<LayoutNode['layout']>['justify'];
type Align = NonNullable<LayoutNode['layout']>['align'];

/** 3x3 alignment picker: rows/columns map to the main and cross axes, like design tools. */
function AlignGrid({ horizontal, justify, align, onChange }: {
    horizontal: boolean; justify: Justify; align: Align; onChange: (justify: Justify, align: Align) => void;
}) {
    const spaced = justify === 'space-between' || justify === 'space-around' || justify === 'space-evenly';
    const pos = ['start', 'center', 'end'] as const;
    const cross = align === 'center' || align === 'end' ? align : 'start';
    return (
        <div className={'align-grid' + (horizontal ? ' h' : ' v')} role="grid" aria-label="Alinhamento">
            {pos.map((row) => pos.map((col) => {
                // Horizontal stack: columns = main axis, rows = cross axis. Vertical: the opposite.
                const main = horizontal ? col : row;
                const crs = horizontal ? row : col;
                const active = crs === cross && (spaced || main === justify);
                return (
                    <button key={row + col} className={'ag-cell' + (active ? ' on' : '')} title={`${horizontal ? 'Horizontal' : 'Vertical'}: ${LBL[main]} · cruzado: ${LBL[crs]}`}
                        onClick={(e) => { e.preventDefault(); onChange(spaced ? justify : main, crs); }}>
                        {active ? <span className="ag-bars"><i /><i /><i /></span> : <span className="ag-dot" />}
                    </button>
                );
            }))}
        </div>
    );
}
const LBL: Record<string, string> = { start: 'início', center: 'centro', end: 'fim' };

/* ---------------- Position ---------------- */

const ANCHORS_H: { value: Anchor; label: string }[] = [
    { value: 'start', label: 'Esquerda' }, { value: 'end', label: 'Direita' }, { value: 'center', label: 'Centro' },
    { value: 'stretch', label: 'Esquerda e direita' }, { value: 'scale', label: 'Escala (%)' }];
const ANCHORS_V: { value: Anchor; label: string }[] = [
    { value: 'start', label: 'Topo' }, { value: 'end', label: 'Base' }, { value: 'center', label: 'Centro' },
    { value: 'stretch', label: 'Topo e base' }, { value: 'scale', label: 'Escala (%)' }];

function PositionSection({ node, parent, absolute, inStack }: { node: LayoutNode; parent: LayoutNode; absolute: boolean; inStack: boolean }) {
    const s = useEditor.getState();
    const project = useEditor((st) => st.project);
    const rects = useEditor((st) => st.rects);
    const page = useEditor((st) => st.page);
    const rr = relRect(rects, project, page, node.id);
    const setRect = (patch: Partial<{ x: number; y: number; w: number; h: number }>) => {
        if (!rr) return;
        const pr = rects[parent.id];
        const next = { ...rr.rect, ...patch };
        s.setNodeRect(node.id, { x: next.x + pr.x, y: next.y + pr.y, w: next.w, h: next.h });
    };
    return (
        <Section title="Posição">
            {inStack && (
                <Row label="Ignorar auto layout" hint="Ligado: o elemento sai do fluxo da stack e fica numa posição livre, por cima dos outros.">
                    <Toggle value={absolute} onChange={(v) => s.setPositionMode(node.id, v ? 'absolute' : 'flow')} />
                </Row>
            )}
            {absolute && node.constraints && (
                <>
                    <div className="xywh four">
                        <label><span>X</span><NumberField value={rr?.rect.x} onChange={(v) => v !== undefined && setRect({ x: v })} /></label>
                        <label><span>Y</span><NumberField value={rr?.rect.y} onChange={(v) => v !== undefined && setRect({ y: v })} /></label>
                        <label><span>L</span><NumberField value={rr?.rect.w} min={1} onChange={(v) => v !== undefined && setRect({ w: v })} /></label>
                        <label><span>A</span><NumberField value={rr?.rect.h} min={1} onChange={(v) => v !== undefined && setRect({ h: v })} /></label>
                    </div>
                    <Row label="Fixar horizontal" hint="Como o elemento acompanha o container quando ele muda de tamanho">
                        <Select value={node.constraints.h.anchor} options={ANCHORS_H} onChange={(v) => s.setAnchor(node.id, 'h', v)} />
                    </Row>
                    <Row label="Fixar vertical">
                        <Select value={node.constraints.v.anchor} options={ANCHORS_V} onChange={(v) => s.setAnchor(node.id, 'v', v)} />
                    </Row>
                    <ConstraintPreview h={node.constraints.h} v={node.constraints.v} />
                </>
            )}
            {!absolute && <p className="panel-note">Posicionado pela stack "{parent.name || parent.id}". Arraste no canvas para mudar a ordem.</p>}
        </Section>
    );
}

function ConstraintPreview({ h, v }: { h: Constraint; v: Constraint }) {
    const on = (side: 'l' | 'r' | 't' | 'b') =>
        (side === 'l' && (h.anchor === 'start' || h.anchor === 'stretch')) || (side === 'r' && (h.anchor === 'end' || h.anchor === 'stretch')) ||
        (side === 't' && (v.anchor === 'start' || v.anchor === 'stretch')) || (side === 'b' && (v.anchor === 'end' || v.anchor === 'stretch'));
    return (
        <div className="constraint-box" aria-hidden="true">
            <div className="cb-inner" />
            {(['l', 'r', 't', 'b'] as const).map((sd) => <span key={sd} className={'cb-' + sd + (on(sd) ? ' on' : '')} />)}
            {h.anchor === 'center' && <span className="cb-ch on" />}
            {v.anchor === 'center' && <span className="cb-cv on" />}
        </div>
    );
}

/* ---------------- Size (flow) ---------------- */

function DimField({ dim, onChange, horizontalAxis }: { dim: Dim | undefined; onChange: (d: Dim | undefined) => void; horizontalAxis: boolean }) {
    const mode = dim?.mode || 'hug';
    return (
        <span className="dim-field">
            <Select value={mode} onChange={(m) => onChange(m === 'hug' ? undefined : m === 'fill' ? { mode: 'fill' } : { mode: m, value: m === 'percent' ? 50 : (dim && 'value' in dim ? dim.value : 200) } as Dim)}
                options={[{ value: 'fixed', label: 'Fixo' }, { value: 'hug', label: 'Hug (ajustar ao conteúdo)' }, { value: 'fill', label: horizontalAxis ? 'Fill (preencher largura)' : 'Fill (preencher altura)' }, { value: 'percent', label: 'Percentual' }]} />
            {(mode === 'fixed' || mode === 'percent') && dim && 'value' in dim && (
                <NumberField value={dim.value} min={0} max={mode === 'percent' ? 100 : 8000} suffix={mode === 'percent' ? '%' : 'px'}
                    onChange={(v) => onChange({ mode, value: v ?? 0 } as Dim)} />
            )}
        </span>
    );
}

function SizeSection({ node, parent }: { node: LayoutNode; parent: LayoutNode }) {
    const s = useEditor.getState();
    const size = node.size || {};
    const set = (key: string, fn: (sz: NonNullable<LayoutNode['size']>) => void) =>
        s.updateNode(node.id, (n) => { n.size = n.size || {}; fn(n.size); if (!Object.keys(n.size).length) delete n.size; }, 'size.' + key);
    const horizontal = parent.type === 'stack' && parent.layout?.direction !== 'vertical';
    return (
        <Section title="Redimensionamento">
            <Row label="Largura"><DimField horizontalAxis dim={size.width} onChange={(d) => set('width', (sz) => { if (d) sz.width = d; else delete sz.width; })} /></Row>
            <Row label="Altura"><DimField horizontalAxis={false} dim={size.height} onChange={(d) => set('height', (sz) => { if (d) sz.height = d; else delete sz.height; })} /></Row>
            <div className="xywh">
                {(['minWidth', 'maxWidth', 'minHeight', 'maxHeight'] as const).map((k) => (
                    <label key={k}><span>{{ minWidth: 'L mín', maxWidth: 'L máx', minHeight: 'A mín', maxHeight: 'A máx' }[k]}</span>
                        <NumberField value={size[k]} min={0} max={8000} placeholder="–" onChange={(v) => set(k, (sz) => { if (v === undefined) delete sz[k]; else sz[k] = v; })} /></label>
                ))}
            </div>
            <p className="panel-note">{horizontal ? '"Preencher" na largura divide o espaço livre da stack horizontal; na altura, estica.' : '"Preencher" na altura divide o espaço livre da stack vertical; na largura, estica.'}</p>
        </Section>
    );
}

/* ---------------- Appearance ---------------- */

function PaintField({ paint, onChange }: { paint: Paint | undefined; onChange: (p: Paint | undefined) => void }) {
    const assets = useEditor((s) => s.project.layout.assets || []);
    const type = paint?.type || 'none';
    return (
        <div className="paint">
            <Segmented value={type} onChange={(t) => {
                if (t === 'none') onChange(undefined);
                else if (t === 'solid') onChange({ type: 'solid', color: paint?.type === 'linear' ? paint.stops[0].color : '#1c2233' });
                else if (t === 'linear') onChange({ type: 'linear', angle: 180, stops: [{ color: paint?.type === 'solid' ? paint.color : '#1c2233', pos: 0 }, { color: '#04060a', pos: 100 }] });
                else if (assets.length) onChange({ type: 'image', asset: assets[0].id, fit: 'cover' });
                else useEditor.getState().toast('importe uma imagem na aba Assets primeiro', 'error');
            }} options={[{ value: 'none', label: 'Nenhum' }, { value: 'solid', label: 'Cor' }, { value: 'linear', label: 'Gradiente' }, { value: 'image', label: 'Imagem' }]} />
            {paint?.type === 'solid' && <ColorField value={paint.color} onChange={(c) => c && onChange({ type: 'solid', color: c })} />}
            {paint?.type === 'linear' && (
                <div className="gradient">
                    <div className="gradient-bar" style={{ background: `linear-gradient(90deg, ${paint.stops.map((st) => (E.resolveToken(st.color, E.mergeTokens(useEditor.getState().project.layout.tokens || {}), 'color') || '#000') + ' ' + st.pos + '%').join(', ')})` }} />
                    <Row label="Ângulo"><NumberField value={paint.angle ?? 180} min={-360} max={360} suffix="°" onChange={(v) => onChange({ ...paint, angle: v ?? 180 })} /></Row>
                    {paint.stops.map((st, i) => (
                        <div key={i} className="stop-row">
                            <ColorField value={st.color} onChange={(c) => c && onChange({ ...paint, stops: paint.stops.map((x, j) => (j === i ? { ...x, color: c } : x)) })} />
                            <NumberField value={st.pos} min={0} max={100} suffix="%" onChange={(v) => onChange({ ...paint, stops: paint.stops.map((x, j) => (j === i ? { ...x, pos: v ?? 0 } : x)) })} />
                            <button className="icon-btn" title="Remover parada" disabled={paint.stops.length <= 2} onClick={() => onChange({ ...paint, stops: paint.stops.filter((_, j) => j !== i) })}><I.Minus size={13} /></button>
                        </div>
                    ))}
                    {paint.stops.length < 8 && <button className="btn btn-small" onClick={() => onChange({ ...paint, stops: [...paint.stops, { color: '#ffffff', pos: 50 }].sort((a, b) => a.pos - b.pos) })}><I.Plus size={13} /> Parada</button>}
                </div>
            )}
            {paint?.type === 'image' && (
                <>
                    <Row label="Imagem"><Select value={paint.asset} options={assets.map((a) => ({ value: a.id, label: a.file }))} onChange={(v) => onChange({ ...paint, asset: v })} /></Row>
                    <Row label="Encaixe"><Select value={paint.fit || 'cover'} onChange={(v) => onChange({ ...paint, fit: v })} options={[{ value: 'cover', label: 'Cobrir' }, { value: 'contain', label: 'Conter' }, { value: 'fill', label: 'Esticar' }]} /></Row>
                </>
            )}
        </div>
    );
}

function AppearanceSection({ node }: { node: LayoutNode }) {
    const s = useEditor.getState();
    const S = node.style || {};
    const set = (key: string, fn: (st: NonNullable<LayoutNode['style']>) => void) =>
        s.updateNode(node.id, (n) => { n.style = n.style || {}; fn(n.style); if (!Object.keys(n.style).length) delete n.style; }, 'style.' + key);
    return (
        <Section title="Aparência">
            <Row label="Fundo"><span /></Row>
            <PaintField paint={S.background} onChange={(p) => set('background', (st) => { if (p) st.background = p; else delete st.background; })} />
            <Row label="Opacidade"><NumberField value={S.opacity === undefined ? 100 : Math.round(S.opacity * 100)} min={0} max={100} suffix="%"
                onChange={(v) => set('opacity', (st) => { if (v === undefined || v === 100) delete st.opacity; else st.opacity = v / 100; })} /></Row>
            <Row label="Cantos"><TokenNumberField group="radius" value={S.radius} min={0} max={2000} suffix="px" onChange={(v) => set('radius', (st) => { if (v === undefined) delete st.radius; else st.radius = v; })} /></Row>
            <Row label="Borda">
                <span className="inline">
                    <NumberField value={typeof S.border?.width === 'number' ? S.border.width : undefined} min={0} max={40} suffix="px" placeholder="0"
                        onChange={(v) => set('border', (st) => { if (!v) delete st.border; else st.border = { width: v, color: st.border?.color || '$colors.border' }; })} />
                </span>
            </Row>
            {S.border && <Row label="Cor da borda"><ColorField value={S.border.color} onChange={(c) => c && set('borderColor', (st) => { st.border = { ...st.border!, color: c }; })} /></Row>}
            <Row label="Sombra"><Toggle value={!!S.shadow} onChange={(v) => set('shadow', (st) => { if (v) st.shadow = { x: 0, y: 12, blur: 30, spread: 0, color: 'rgba(0,0,0,0.45)' }; else delete st.shadow; })} /></Row>
            {S.shadow && (
                <>
                    <div className="xywh">
                        {(['x', 'y', 'blur', 'spread'] as const).map((k) => (
                            <label key={k}><span>{{ x: 'X', y: 'Y', blur: 'Desf.', spread: 'Exp.' }[k]}</span>
                                <NumberField value={S.shadow![k]} min={-200} max={200} onChange={(v) => set('shadow.' + k, (st) => { st.shadow = { ...st.shadow!, [k]: v ?? 0 }; })} /></label>
                        ))}
                    </div>
                    <Row label="Cor da sombra"><ColorField value={S.shadow.color} onChange={(c) => c && set('shadowColor', (st) => { st.shadow = { ...st.shadow!, color: c }; })} /></Row>
                </>
            )}
            <Row label="Desfoque do fundo" hint="Efeito vidro; mais pesado em aparelhos fracos"><NumberField value={S.blur} min={0} max={60} suffix="px" placeholder="0"
                onChange={(v) => set('blur', (st) => { if (!v) delete st.blur; else st.blur = v; })} /></Row>
        </Section>
    );
}

/* ---------------- Typography ---------------- */

function TypographySection({ node }: { node: LayoutNode }) {
    const s = useEditor.getState();
    const t = node.text || {};
    const set = (key: string, fn: (x: NonNullable<LayoutNode['text']>) => void) =>
        s.updateNode(node.id, (n) => { n.text = n.text || {}; fn(n.text); if (!Object.keys(n.text).length) delete n.text; }, 'text.' + key);
    return (
        <Section title="Tipografia">
            <Row label="Fonte"><Select value={t.family || ''} placeholder="Do tema" onChange={(v) => set('family', (x) => { if (v) x.family = v; else delete x.family; })}
                options={Object.keys(E.FONT_FAMILIES).map((f) => ({ value: f, label: { system: 'Sistema', rounded: 'Arredondada', serif: 'Serifada', mono: 'Monoespaçada' }[f] || f }))} /></Row>
            <Row label="Tamanho"><TokenNumberField group="fontSizes" value={t.size} min={6} max={400} suffix="px" onChange={(v) => set('size', (x) => { if (v === undefined) delete x.size; else x.size = v; })} /></Row>
            <Row label="Peso"><Select value={String(t.weight || '') as string} placeholder="Normal" onChange={(v) => set('weight', (x) => { if (v) x.weight = Number(v); else delete x.weight; })}
                options={[100, 200, 300, 400, 500, 600, 700, 800, 900].map((w) => ({ value: String(w), label: String(w) }))} /></Row>
            <Row label="Cor"><ColorField allowEmpty value={t.color} onChange={(c) => set('color', (x) => { if (c) x.color = c; else delete x.color; })} /></Row>
            <Row label="Alinhamento"><Segmented value={t.align || 'left'} onChange={(v) => set('align', (x) => { x.align = v; })}
                options={[{ value: 'left', label: 'Esq.' }, { value: 'center', label: 'Centro' }, { value: 'right', label: 'Dir.' }]} /></Row>
            <div className="xywh">
                <label><span>Altura linha</span><NumberField value={t.lineHeight} min={0.5} max={4} step={0.1} placeholder="–" onChange={(v) => set('lineHeight', (x) => { if (v === undefined) delete x.lineHeight; else x.lineHeight = v; })} /></label>
                <label><span>Espaçam.</span><NumberField value={t.letterSpacing} min={-10} max={40} placeholder="0" onChange={(v) => set('letterSpacing', (x) => { if (v === undefined) delete x.letterSpacing; else x.letterSpacing = v; })} /></label>
                <label><span>Máx. linhas</span><NumberField value={t.maxLines} min={1} max={20} placeholder="–" onChange={(v) => set('maxLines', (x) => { if (v === undefined) delete x.maxLines; else x.maxLines = v; })} /></label>
            </div>
            <Row label="Caixa"><Select value={t.transform || 'none'} onChange={(v) => set('transform', (x) => { if (v === 'none') delete x.transform; else x.transform = v; })}
                options={[{ value: 'none', label: 'Normal' }, { value: 'uppercase', label: 'MAIÚSCULAS' }, { value: 'lowercase', label: 'minúsculas' }]} /></Row>
        </Section>
    );
}

/* ---------------- Data / component props ---------------- */

function DataSection({ node }: { node: LayoutNode }) {
    const def = E.registry[node.type];
    const s = useEditor.getState();
    const assets = useEditor((st) => st.project.layout.assets || []);
    const entries = Object.entries(def?.props || {});
    if (!entries.length) {
        if (def?.slot) return <Section title="Dados"><p className="panel-note">Conteúdo vindo do launcher (apps instalados, clima, TMDB/TVMaze). Configure-o no Personalizar da TV.</p></Section>;
        return null;
    }
    const setProp = (k: string, v: unknown) => s.updateNode(node.id, (n) => { n.props = { ...(n.props || {}), [k]: v }; }, 'props.' + k);
    const p = node.props || {};
    return (
        <Section title={node.type === 'button' ? 'Interação' : 'Conteúdo'}>
            {entries.map(([k, spec]) => {
                if (spec.type === 'string') return (
                    <Row key={k} label={{ text: 'Texto', label: 'Rótulo' }[k] || k}>
                        <span data-primary="" style={{ display: 'contents' }}>
                            <TextField multiline={k === 'text'} value={p[k]} maxLength={spec.max} onChange={(v) => setProp(k, v)} />
                        </span>
                    </Row>
                );
                if (spec.type === 'number') return <Row key={k} label={PROP_LABEL[k] || k}><NumberField value={p[k] ?? (spec.def as number)} min={spec.min} max={spec.max} step={k === 'strokeWidth' ? 0.5 : 1} onChange={(v) => setProp(k, v ?? spec.def)} /></Row>;
                if (spec.type === 'boolean') return <Row key={k} label={PROP_LABEL[k] || k}><Toggle value={p[k] ?? (spec.def as boolean)} onChange={(v) => setProp(k, v)} /></Row>;
                if (spec.type === 'enum' && node.type === 'icon' && k === 'name') return (
                    <div key={k} className="prop-row" style={{ gridTemplateColumns: '1fr' }}>
                        <span className="prop-label">Ícone</span>
                        <div className="icon-picker" role="radiogroup">
                            {spec.values!.map((name) => (
                                <button key={name} role="radio" aria-checked={(p[k] ?? spec.def) === name} title={name}
                                    className={(p[k] ?? spec.def) === name ? 'on' : ''} onClick={() => setProp(k, name)}>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d={E.ICONS[name]} /></svg>
                                </button>
                            ))}
                        </div>
                    </div>
                );
                if (spec.type === 'enum') return <Row key={k} label={PROP_LABEL[k] || k}><Select value={p[k] ?? spec.def} options={spec.values!.map((v) => ({ value: v, label: ENUM_LABEL[v] || v }))} onChange={(v) => setProp(k, v)} /></Row>;
                if (spec.type === 'color') return <Row key={k} label="Cor"><ColorField value={p[k] ?? (spec.def as string)} onChange={(v) => v && setProp(k, v)} /></Row>;
                if (spec.type === 'asset') return <Row key={k} label="Imagem"><Select value={p[k]} placeholder="Escolha…" options={assets.map((a) => ({ value: a.id, label: a.file }))} onChange={(v) => setProp(k, v)} /></Row>;
                if (spec.type === 'action') {
                    const a = p[k] || { type: 'open-settings' };
                    return (
                        <div key={k}>
                            <Row label="Ao apertar OK"><Select value={a.type} options={Object.entries(E.ACTIONS).map(([v, d]) => ({ value: v, label: d.label }))}
                                onChange={(v) => setProp(k, E.ACTIONS[v].needsApp ? { type: v, appId: a.appId || 'com.netflix.ninja' } : { type: v })} /></Row>
                            {E.ACTIONS[a.type]?.needsApp && <Row label="Pacote do app" hint="Ex.: com.netflix.ninja"><TextField value={a.appId} onChange={(v) => setProp(k, { ...a, appId: v.trim() })} /></Row>}
                        </div>
                    );
                }
                return null;
            })}
        </Section>
    );
}

const ENUM_LABEL: Record<string, string> = {
    cover: 'Cobrir', contain: 'Conter', fill: 'Esticar', auto: 'Do launcher', '24h': '24 horas', '12h': '12 horas',
    movies: 'Filmes em alta', shows: 'Séries em alta', apps: 'Apps instalados', favorites: 'Apps favoritos',
    poster: 'Pôster (vertical)', wide: 'Paisagem', app: 'App (logo)',
};
const PROP_LABEL: Record<string, string> = {
    thickness: 'Espessura', fit: 'Encaixe', format: 'Formato', source: 'Conteúdo', cardStyle: 'Cartão', maxItems: 'Máx. de itens',
    showTitles: 'Mostrar títulos', columns: 'Colunas', rotateSeconds: 'Trocar a cada (s)', buttonLabel: 'Texto do botão',
    hours: 'Próximas horas', showSun: 'Nascer e pôr do sol', opensDrawer: 'OK abre o clima', color: 'Cor', strokeWidth: 'Traço',
};

/* ---------------- Focus ---------------- */

function FocusSection({ node }: { node: LayoutNode }) {
    const s = useEditor.getState();
    const root = useEditor(selectRoot);
    const set = (fn: (f: NonNullable<LayoutNode['focus']>) => void) =>
        s.commit('foco', (p) => {
            const r = p.layout.pages[s.page].root as LayoutNode;
            const loc = T.find(r, node.id);
            if (!loc) return;
            const before = !!loc.node.focus?.initial;
            loc.node.focus = loc.node.focus || {};
            fn(loc.node.focus);
            // Only one initial focus per page.
            if (!before && loc.node.focus.initial) E.walk(r, (n) => { if (n !== loc.node && n.focus?.initial) delete n.focus.initial; });
            if (!Object.keys(loc.node.focus).length) delete loc.node.focus;
        });
    let initialElsewhere = '';
    E.walk(root, (n) => { if (n.id !== node.id && n.focus?.initial) initialElsewhere = n.name || n.id; });
    return (
        <Section title="Foco (controle remoto)">
            <Row label="Foco inicial" hint={initialElsewhere ? `Hoje o foco inicial é "${initialElsewhere}"` : ''}>
                <Toggle value={!!node.focus?.initial} onChange={(v) => set((f) => { if (v) f.initial = true; else delete f.initial; })} />
            </Row>
            <Row label="Pular na navegação"><Toggle value={!!node.focus?.skip} onChange={(v) => set((f) => { if (v) f.skip = true; else delete f.skip; })} /></Row>
        </Section>
    );
}

/* ---------------- Animation ---------------- */

function AnimationSection({ node }: { node: LayoutNode }) {
    const s = useEditor.getState();
    const A = node.animation || {};
    const enter = A.enter || {};
    const set = (key: string, fn: (a: NonNullable<LayoutNode['animation']>) => void) =>
        s.updateNode(node.id, (n) => { n.animation = n.animation || {}; fn(n.animation); if (n.animation.enter && !Object.keys(n.animation.enter).length) delete n.animation.enter; if (!Object.keys(n.animation).length) delete n.animation; }, 'anim.' + key);
    const play = () => {
        const st = useEditor.getState();
        preview?.render(st.project.layout, st.project.assetData, { animate: true });
    };
    const def = E.registry[node.type];
    return (
        <Section title="Animação" defaultOpen={!!node.animation} actions={<button className="icon-btn" title="Reproduzir as animações" onClick={play}><I.Play size={13} /></button>}>
            <Row label="Entrada"><Select value={enter.preset || 'none'} onChange={(v) => set('preset', (a) => { if (v === 'none') delete a.enter; else a.enter = { ...(a.enter || {}), preset: v }; })}
                options={E.ENTER_PRESETS.map((p) => ({ value: p, label: { none: 'Nenhuma', fade: 'Surgir', 'slide-up': 'Subir', 'slide-down': 'Descer', 'slide-left': 'Da direita', 'slide-right': 'Da esquerda', scale: 'Crescer' }[p] || p }))} /></Row>
            {enter.preset && enter.preset !== 'none' && (
                <>
                    <div className="xywh">
                        <label><span>Duração</span><NumberField value={enter.duration ?? 400} min={0} max={2000} suffix="ms" onChange={(v) => set('duration', (a) => { a.enter = { ...a.enter!, duration: v ?? 400 }; })} /></label>
                        <label><span>Atraso</span><NumberField value={enter.delay ?? 0} min={0} max={5000} suffix="ms" onChange={(v) => set('delay', (a) => { a.enter = { ...a.enter!, delay: v ?? 0 }; })} /></label>
                        <label><span>Distância</span><NumberField value={enter.distance ?? 40} min={0} max={400} suffix="px" onChange={(v) => set('distance', (a) => { a.enter = { ...a.enter!, distance: v ?? 40 }; })} /></label>
                    </div>
                    <Row label="Curva"><Select value={enter.easing || 'smooth'} onChange={(v) => set('easing', (a) => { a.enter = { ...a.enter!, easing: v }; })}
                        options={Object.keys(E.EASINGS).map((e) => ({ value: e, label: { smooth: 'Suave', spring: 'Mola', ease: 'Padrão', linear: 'Linear', 'ease-in': 'Acelerar', 'ease-out': 'Desacelerar', 'ease-in-out': 'Acelerar e desacelerar' }[e] || e }))} /></Row>
                </>
            )}
            {node.type === 'button' && (
                <div className="xywh">
                    <label><span>Escala no foco</span><NumberField value={A.focus?.scale ?? 1.06} min={1} max={1.3} step={0.01} onChange={(v) => set('fscale', (a) => { a.focus = { ...(a.focus || {}), scale: v ?? 1.06 }; })} /></label>
                    <label><span>Subir no foco</span><NumberField value={A.focus?.lift ?? 4} min={0} max={30} suffix="px" onChange={(v) => set('flift', (a) => { a.focus = { ...(a.focus || {}), lift: v ?? 4 }; })} /></label>
                </div>
            )}
            {def?.slot && <p className="panel-note">O efeito de foco dos widgets do launcher segue o estilo original.</p>}
            <p className="panel-note">Na TV, as animações respeitam a opção de movimento reduzido.</p>
        </Section>
    );
}
