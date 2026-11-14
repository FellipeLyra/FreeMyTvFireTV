// Pure operations on a layout tree. They mutate the tree they are given (the
// store calls them inside immer drafts) and never touch the DOM. Geometry comes
// in as rectangles measured on the canvas (layout pixels, 1920x1080 space).
import { E, isContainer } from '../engine';
import type { Anchor, Constraint, LayoutNode, Rect } from './types';

export interface Located {
    node: LayoutNode;
    parent: LayoutNode | null;
    index: number;
}

export function find(root: LayoutNode, id: string): Located | null {
    if (root.id === id) return { node: root, parent: null, index: 0 };
    const stack: LayoutNode[] = [root];
    while (stack.length) {
        const n = stack.pop()!;
        const kids = n.children || [];
        for (let i = 0; i < kids.length; i++) {
            if (kids[i].id === id) return { node: kids[i], parent: n, index: i };
            stack.push(kids[i]);
        }
    }
    return null;
}

export function allIds(root: LayoutNode): Set<string> {
    const ids = new Set<string>();
    E.walk(root, (n) => { ids.add(n.id); });
    return ids;
}

export function isDescendant(root: LayoutNode, ancestorId: string, id: string): boolean {
    const a = find(root, ancestorId);
    if (!a) return false;
    let found = false;
    E.walk(a.node, (n) => { if (n.id === id && n !== a.node) found = true; });
    return found;
}

/** Path of ids from the root down to `id` (inclusive). */
export function pathTo(root: LayoutNode, id: string): string[] {
    const out: string[] = [];
    function go(n: LayoutNode): boolean {
        out.push(n.id);
        if (n.id === id) return true;
        for (const c of n.children || []) if (go(c)) return true;
        out.pop();
        return false;
    }
    return go(root) ? out : [];
}

export function isAbsolute(node: LayoutNode, parent: LayoutNode | null): boolean {
    return !!parent && (node.position === 'absolute' || parent.type === 'frame');
}

/** A readable, unique id such as "text-3". */
export function newId(base: string, taken: Set<string>): string {
    const stem = base.replace(/^launcher\./, '').replace(/[^A-Za-z0-9_-]/g, '-').replace(/^[^A-Za-z]+/, '') || 'node';
    let i = 1;
    while (taken.has(`${stem}-${i}`)) i++;
    const id = `${stem}-${i}`;
    taken.add(id);
    return id;
}

/** Deep copy with fresh ids; launcher widgets are dropped (each can exist once). */
export function cloneWithNewIds(node: LayoutNode, taken: Set<string>): LayoutNode | null {
    if (E.registry[node.type]?.slot) return null;
    const copy: LayoutNode = JSON.parse(JSON.stringify(node));
    function renew(n: LayoutNode) {
        n.id = newId(n.type, taken);
        if (n.focus?.initial) delete n.focus.initial;
        if (n.children) n.children = n.children.filter((c) => !E.registry[c.type]?.slot);
        (n.children || []).forEach(renew);
    }
    renew(copy);
    return copy;
}

export function remove(root: LayoutNode, id: string): LayoutNode | null {
    const loc = find(root, id);
    if (!loc || !loc.parent) return null;
    loc.parent.children!.splice(loc.index, 1);
    return loc.node;
}

export function insert(parent: LayoutNode, node: LayoutNode, index: number) {
    if (!parent.children) parent.children = [];
    const i = Math.max(0, Math.min(index, parent.children.length));
    parent.children.splice(i, 0, node);
}

/* ------------------------------------------------------------------ */
/* Constraints                                                         */
/* ------------------------------------------------------------------ */

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** One axis constraint that reproduces [pos, pos+size] inside a parent of `parentSize`, keeping `anchor`. */
export function axisConstraint(anchor: Anchor, pos: number, size: number, parentSize: number): Constraint {
    switch (anchor) {
        case 'end': return { anchor, offset: r1(parentSize - pos - size), size: r1(size) };
        case 'center': return { anchor, offset: r1(pos + size / 2 - parentSize / 2), size: r1(size) };
        case 'stretch': return { anchor, start: r1(pos), end: r1(parentSize - pos - size) };
        // Percentages need 0.01 precision: 0.1% of a 1920px screen is almost 2px.
        case 'scale': return parentSize > 0
            ? { anchor, start: r2((pos / parentSize) * 100), size: r2((size / parentSize) * 100) }
            : { anchor, start: 0, size: 100 };
        default: return { anchor: 'start', offset: r1(pos), size: r1(size) };
    }
}

/** Position [pos, size] that a constraint produces in a parent of `parentSize`. */
export function axisRange(c: Constraint, parentSize: number): [number, number] {
    switch (c.anchor) {
        case 'start': return [c.offset, c.size];
        case 'end': return [parentSize - c.offset - c.size, c.size];
        case 'center': return [parentSize / 2 + c.offset - c.size / 2, c.size];
        case 'stretch': return [c.start, parentSize - c.start - c.end];
        case 'scale': return [(c.start / 100) * parentSize, (c.size / 100) * parentSize];
    }
}

/** Set a node's constraints so it occupies `rect` (relative to its parent), keeping its anchors. */
export function placeAbsolute(node: LayoutNode, rect: Rect, parentSize: { w: number; h: number }) {
    const h = node.constraints?.h.anchor || 'start';
    const v = node.constraints?.v.anchor || 'start';
    node.constraints = {
        h: axisConstraint(h, rect.x, Math.max(1, rect.w), parentSize.w),
        v: axisConstraint(v, rect.y, Math.max(1, rect.h), parentSize.h),
    };
}

/** Change an anchor without moving the element. */
export function setAnchor(node: LayoutNode, axis: 'h' | 'v', anchor: Anchor, rect: Rect, parentSize: { w: number; h: number }) {
    if (!node.constraints) placeAbsolute(node, rect, parentSize);
    const c = node.constraints!;
    if (axis === 'h') c.h = axisConstraint(anchor, rect.x, rect.w, parentSize.w);
    else c.v = axisConstraint(anchor, rect.y, rect.h, parentSize.h);
}

/* ------------------------------------------------------------------ */
/* Flow <-> absolute                                                   */
/* ------------------------------------------------------------------ */

/** Take a stack child out of the flow, at the same place and size. */
export function makeAbsolute(node: LayoutNode, parent: LayoutNode, rect: Rect, parentSize: { w: number; h: number }) {
    if (parent.type !== 'frame') node.position = 'absolute';
    delete node.constraints;
    placeAbsolute(node, rect, parentSize);
}

/** Put an absolute element back in its stack's flow, with its current size fixed. */
export function makeFlow(node: LayoutNode, rect: Rect | null) {
    delete node.position;
    delete node.constraints;
    if (rect) {
        node.size = { ...(node.size || {}), width: { mode: 'fixed', value: Math.round(rect.w) }, height: { mode: 'fixed', value: Math.round(rect.h) } };
    }
}

/* ------------------------------------------------------------------ */
/* Moving                                                              */
/* ------------------------------------------------------------------ */

export interface MoveTarget {
    parentId: string;
    index: number;
    /** When the new parent is a frame (or `absolute` is requested): where to put it, relative to the parent. */
    rect?: Rect;
    parentSize?: { w: number; h: number };
}

/**
 * Move a node to another place in the tree, converting between flow and absolute
 * as the destination requires. Returns a note when the move changed how the node
 * is positioned (shown to the user), or throws on an impossible move.
 */
export function move(root: LayoutNode, id: string, target: MoveTarget, currentRect: Rect | null): string | null {
    const loc = find(root, id);
    if (!loc || !loc.parent) throw new Error('a raiz da tela não pode ser movida');
    const dest = find(root, target.parentId);
    if (!dest || !isContainer(dest.node.type)) throw new Error('destino não é um container');
    if (target.parentId === id || isDescendant(root, id, target.parentId)) throw new Error('não dá para mover um elemento para dentro dele mesmo');

    const wasAbsolute = isAbsolute(loc.node, loc.parent);
    let index = target.index;
    if (loc.parent === dest.node && loc.index < index) index--; // removal shifts the slot
    loc.parent.children!.splice(loc.index, 1);
    insert(dest.node, loc.node, index);

    const toFrame = dest.node.type === 'frame';
    if (toFrame) {
        delete loc.node.position;
        if (target.rect && target.parentSize) placeAbsolute(loc.node, target.rect, target.parentSize);
        else if (!loc.node.constraints && currentRect) placeAbsolute(loc.node, { ...currentRect, x: 0, y: 0 }, target.parentSize || { w: 1920, h: 1080 });
        return wasAbsolute ? null : 'agora tem posição absoluta dentro do container';
    }
    // Into a stack
    if (wasAbsolute && loc.node.position !== 'absolute') {
        makeFlow(loc.node, currentRect);
        return 'entrou no fluxo da stack (tamanho atual fixado)';
    }
    if (loc.node.position === 'absolute') {
        makeFlow(loc.node, currentRect);
        return 'entrou no fluxo da stack (tamanho atual fixado)';
    }
    return null;
}

/* ------------------------------------------------------------------ */
/* Grouping                                                            */
/* ------------------------------------------------------------------ */

/**
 * Wrap sibling nodes in a new stack placed where the first of them was.
 * `rects` are the nodes' current rectangles relative to their parent.
 */
export function wrapInStack(root: LayoutNode, ids: string[], direction: 'horizontal' | 'vertical', rects: Record<string, Rect>,
    parentSize: { w: number; h: number }, taken: Set<string>): string {
    const locs = ids.map((id) => find(root, id)).filter((l): l is Located => !!l && !!l.parent);
    if (!locs.length) throw new Error('selecione elementos para agrupar');
    const parent = locs[0].parent!;
    if (locs.some((l) => l.parent !== parent)) throw new Error('só dá para agrupar elementos do mesmo container');
    locs.sort((a, b) => a.index - b.index);
    // Order children of the new stack by their position on screen.
    const ordered = [...locs].sort((a, b) => {
        const ra = rects[a.node.id], rb = rects[b.node.id];
        if (!ra || !rb) return a.index - b.index;
        return direction === 'horizontal' ? ra.x - rb.x : ra.y - rb.y;
    });
    const anyAbsolute = locs.some((l) => isAbsolute(l.node, parent));
    const stack: LayoutNode = {
        id: newId('stack', taken), type: 'stack', name: 'Stack',
        layout: { direction, gap: 16, align: 'start' }, children: [],
    };
    const insertAt = locs[0].index;
    for (const l of [...locs].reverse()) parent.children!.splice(l.index, 1);
    for (const l of ordered) {
        if (isAbsolute(l.node, parent)) makeFlow(l.node, rects[l.node.id] || null);
        stack.children!.push(l.node);
    }
    insert(parent, stack, insertAt);
    if (anyAbsolute) {
        const rs = ids.map((id) => rects[id]).filter(Boolean);
        if (rs.length) {
            const x = Math.min(...rs.map((r) => r.x)), y = Math.min(...rs.map((r) => r.y));
            const w = Math.max(...rs.map((r) => r.x + r.w)) - x, h = Math.max(...rs.map((r) => r.y + r.h)) - y;
            if (parent.type !== 'frame') stack.position = 'absolute';
            placeAbsolute(stack, { x, y, w, h }, parentSize);
            stack.size = { width: { mode: 'hug' }, height: { mode: 'hug' } };
        }
    }
    return stack.id;
}

/** Replace a container by its children. `rects` (relative to the container's parent) keep absolute children in place. */
export function unwrap(root: LayoutNode, id: string, rects: Record<string, Rect>, parentSize: { w: number; h: number }): string[] {
    const loc = find(root, id);
    if (!loc || !loc.parent) throw new Error('a raiz da tela não pode ser desagrupada');
    if (!isContainer(loc.node.type)) throw new Error('só containers podem ser desagrupados');
    const kids = loc.node.children || [];
    loc.parent.children!.splice(loc.index, 1, ...kids);
    for (const k of kids) {
        const r = rects[k.id];
        if (loc.parent.type === 'frame') {
            delete k.position;
            if (r) placeAbsolute(k, r, parentSize);
        } else if (isAbsolute(k, loc.node) && !k.position) {
            makeFlow(k, r || null);
        }
    }
    return kids.map((k) => k.id);
}

/* ------------------------------------------------------------------ */
/* Auto layout on / off (like Shift+A in design tools)                 */
/* ------------------------------------------------------------------ */

/**
 * Direction suggested by the arrangement: elements that share a column (one above
 * the other) make a vertical stack, elements that share a row a horizontal one.
 * Only when that is undecided does the overall spread decide.
 */
export function guessDirection(rects: Rect[]): 'horizontal' | 'vertical' {
    if (rects.length < 2) return 'vertical';
    let column = 0, row = 0;
    for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
            const a = rects[i], b = rects[j];
            if (Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0) column++;
            if (Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0) row++;
        }
    }
    if (column !== row) return column > row ? 'vertical' : 'horizontal';
    const xs = rects.map((r) => r.x + r.w / 2), ys = rects.map((r) => r.y + r.h / 2);
    const spread = (v: number[]) => Math.max(...v) - Math.min(...v);
    return spread(xs) >= spread(ys) ? 'horizontal' : 'vertical';
}

/**
 * Turn a container with free (absolute) children into a stack, keeping the look:
 * children are ordered by position, and gap/padding are measured from where they are.
 * `rects` are the children's rectangles relative to the container.
 */
export function addAutoLayout(node: LayoutNode, rects: Record<string, Rect>, size: { w: number; h: number }) {
    if (node.type !== 'frame') throw new Error('este elemento já tem auto layout');
    const kids = node.children || [];
    const measured = kids.filter((k) => rects[k.id]);
    const direction = guessDirection(measured.map((k) => rects[k.id]));
    const horizontal = direction === 'horizontal';
    const ordered = [...kids].sort((a, b) => {
        const ra = rects[a.id], rb = rects[b.id];
        if (!ra || !rb) return 0;
        return horizontal ? ra.x - rb.x : ra.y - rb.y;
    });
    let gap = 16;
    const gaps: number[] = [];
    for (let i = 1; i < ordered.length; i++) {
        const a = rects[ordered[i - 1].id], b = rects[ordered[i].id];
        if (a && b) gaps.push(horizontal ? b.x - (a.x + a.w) : b.y - (a.y + a.h));
    }
    if (gaps.length) gap = Math.min(2000, Math.max(0, Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length)));
    let padding: number | number[] = 0;
    if (measured.length) {
        const rs = measured.map((k) => rects[k.id]);
        const top = Math.max(0, Math.round(Math.min(...rs.map((r) => r.y))));
        const left = Math.max(0, Math.round(Math.min(...rs.map((r) => r.x))));
        const right = Math.max(0, Math.round(size.w - Math.max(...rs.map((r) => r.x + r.w))));
        const bottom = Math.max(0, Math.round(size.h - Math.max(...rs.map((r) => r.y + r.h))));
        padding = top === right && right === bottom && bottom === left ? top : [top, right, bottom, left];
    }
    node.type = 'stack';
    node.layout = { ...(node.layout?.clip ? { clip: true } : {}), direction, gap, align: 'start', ...(padding ? { padding } : {}) };
    node.children = ordered;
    for (const k of ordered) {
        if (k.position === 'absolute') continue; // already "ignoring auto layout"
        const c = k.constraints;
        makeFlow(k, rects[k.id] || null);
        // What stretched with the container keeps doing so: "Fill" (scale becomes a percentage).
        if (c && k.size) {
            if (c.h.anchor === 'stretch') k.size.width = { mode: 'fill' };
            if (c.v.anchor === 'stretch') k.size.height = { mode: 'fill' };
            if (c.h.anchor === 'scale') k.size.width = { mode: 'percent', value: c.h.size };
            if (c.v.anchor === 'scale') k.size.height = { mode: 'percent', value: c.v.size };
        }
    }
}

/** Turn a stack into a free container, every child staying where it is. */
export function removeAutoLayout(node: LayoutNode, rects: Record<string, Rect>, size: { w: number; h: number }) {
    if (node.type !== 'stack') throw new Error('este elemento não tem auto layout');
    node.type = 'frame';
    node.layout = node.layout?.clip ? { clip: true } : undefined;
    if (!node.layout) delete node.layout;
    for (const k of node.children || []) {
        const r = rects[k.id];
        delete k.position;
        if (r) {
            dropFlowSize(k);
            delete k.constraints;
            placeAbsolute(k, r, size);
        }
    }
}

/* ------------------------------------------------------------------ */
/* Alignment                                                           */
/* ------------------------------------------------------------------ */

export type AlignMode = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';

/** New rectangles that align `rects` to their common bounds (or to the parent for a single item). */
export function alignRects(rects: Rect[], mode: AlignMode, bounds?: Rect): Rect[] {
    const b = bounds || {
        x: Math.min(...rects.map((r) => r.x)), y: Math.min(...rects.map((r) => r.y)),
        w: Math.max(...rects.map((r) => r.x + r.w)) - Math.min(...rects.map((r) => r.x)),
        h: Math.max(...rects.map((r) => r.y + r.h)) - Math.min(...rects.map((r) => r.y)),
    };
    return rects.map((r) => {
        switch (mode) {
            case 'left': return { ...r, x: b.x };
            case 'hcenter': return { ...r, x: b.x + (b.w - r.w) / 2 };
            case 'right': return { ...r, x: b.x + b.w - r.w };
            case 'top': return { ...r, y: b.y };
            case 'vcenter': return { ...r, y: b.y + (b.h - r.h) / 2 };
            case 'bottom': return { ...r, y: b.y + b.h - r.h };
        }
    });
}

/** Even spacing between 3+ rectangles along an axis (order by position). */
export function distributeRects(rects: Rect[], axis: 'h' | 'v'): Rect[] {
    if (rects.length < 3) return rects;
    const key = axis === 'h' ? 'x' : 'y';
    const size = axis === 'h' ? 'w' : 'h';
    const order = rects.map((r, i) => ({ r, i })).sort((a, b) => a.r[key] - b.r[key]);
    const first = order[0].r, last = order[order.length - 1].r;
    const total = order.reduce((s, o) => s + o.r[size], 0);
    const gap = (last[key] + last[size] - first[key] - total) / (order.length - 1);
    const out = rects.slice();
    let pos = first[key];
    for (const o of order) {
        out[o.i] = { ...o.r, [key]: pos };
        pos += o.r[size] + gap;
    }
    return out;
}

/* ------------------------------------------------------------------ */
/* New components                                                      */
/* ------------------------------------------------------------------ */

const LABELS: Record<string, string> = {
    stack: 'Stack', frame: 'Container', text: 'Texto', image: 'Imagem', spacer: 'Espaçador',
    divider: 'Divisor', button: 'Botão', 'clock-text': 'Relógio', icon: 'Ícone',
    'content-row': 'Carrossel', 'content-grid': 'Grade', banner: 'Banner', 'weather-full': 'Clima completo',
};

/** A new node of `type` with the registry defaults and sensible editor sizes. */
export function createNode(type: string, taken: Set<string>, opts: { horizontalParent?: boolean } = {}): LayoutNode {
    const def = E.registry[type];
    if (!def) throw new Error('componente desconhecido: ' + type);
    const node: LayoutNode = { id: newId(type, taken), type };
    if (LABELS[type]) node.name = LABELS[type];
    const props: Record<string, unknown> = {};
    for (const [k, spec] of Object.entries(def.props)) {
        if (spec.def !== undefined && spec.def !== '') props[k] = JSON.parse(JSON.stringify(spec.def));
    }
    if (Object.keys(props).length) node.props = props;
    switch (type) {
        case 'stack':
            node.layout = { direction: opts.horizontalParent ? 'vertical' : 'horizontal', gap: 16, padding: 16, align: 'start' };
            node.style = { background: { type: 'solid', color: 'rgba(255,255,255,0.06)' }, radius: 16 };
            node.children = [];
            node.size = { width: { mode: 'fixed', value: 480 }, height: { mode: 'fixed', value: 200 } };
            break;
        case 'frame':
            node.style = { background: { type: 'solid', color: 'rgba(255,255,255,0.06)' }, radius: 16 };
            node.children = [];
            node.size = { width: { mode: 'fixed', value: 480 }, height: { mode: 'fixed', value: 270 } };
            break;
        case 'text':
            node.text = { size: 34, weight: 600 };
            break;
        case 'image':
            node.size = { width: { mode: 'fixed', value: 320 }, height: { mode: 'fixed', value: 180 } };
            break;
        case 'spacer':
            node.size = { width: { mode: 'fixed', value: 40 }, height: { mode: 'fixed', value: 40 } };
            break;
        case 'button':
            node.text = { size: 24, weight: 600 };
            break;
        case 'clock-text':
            node.text = { size: 96, weight: 200 };
            break;
        case 'icon':
            node.size = { width: { mode: 'fixed', value: 64 }, height: { mode: 'fixed', value: 64 } };
            break;
        case 'content-row':
            node.size = { width: { mode: 'fixed', value: 1600 }, height: { mode: 'fixed', value: 380 } };
            break;
        case 'content-grid':
            node.size = { width: { mode: 'fixed', value: 1300 }, height: { mode: 'fixed', value: 480 } };
            break;
        case 'banner':
            node.size = { width: { mode: 'fixed', value: 1200 }, height: { mode: 'fixed', value: 400 } };
            break;
        case 'weather-full':
            node.size = { width: { mode: 'fixed', value: 580 }, height: { mode: 'fixed', value: 380 } };
            break;
    }
    return node;
}

/** Default rectangle for a node dropped into a frame at (x, y). */
export function defaultDropRect(node: LayoutNode, x: number, y: number): Rect {
    const w = node.size?.width?.mode === 'fixed' ? node.size.width.value
        : node.type === 'text' ? 360 : node.type === 'button' ? 220 : node.type === 'clock-text' ? 420
            : node.type.startsWith('launcher.') ? 600 : 240;
    const h = node.size?.height?.mode === 'fixed' ? node.size.height.value
        : node.type === 'text' ? 50 : node.type === 'button' ? 64 : node.type === 'clock-text' ? 120
            : node.type === 'launcher.app-shelf' ? 300 : node.type === 'launcher.trending' ? 180 : 80;
    return { x: Math.round(x - w / 2), y: Math.round(y - h / 2), w, h };
}

/** Clean up a node's `size` once it lives inside a frame (sizes come from constraints there). */
export function dropFlowSize(node: LayoutNode) {
    if (!node.size) return;
    delete node.size.width;
    delete node.size.height;
    if (!Object.keys(node.size).length) delete node.size;
}
