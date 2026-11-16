// Reads the TV runtime inside the canvas (same page the Fire TV draws) and
// produces the focus map and the accessibility alerts for the current screen.
import { E } from '../engine';
import * as T from '../model/tree';
import type { LayoutNode, Rect } from '../model/types';
import {
    type A11yIssue, type FocusGraph, type Layer, type Rgba, type TvRes,
    backgroundCandidates, focusGraph, gradientColors, minContrast, onScreen, outsideSafeArea, parseColor,
    luminance as luminanceOf, resScale, toHex, worstContrast, MIN_REAL_LINE_PX, MIN_REAL_TEXT_PX, MIN_TEXT_PX, TV_RES,
} from '../model/a11y';
import type { PreviewFrame } from './preview';

export interface FocusItem {
    rect: Rect;
    /** Layout element the item belongs to (a carousel card belongs to its carousel). */
    nodeId: string | null;
    label: string;
    /** Scrolls inside a carousel or grid: may be off screen until focused. */
    inTrack: boolean;
}

export interface FocusMap {
    items: FocusItem[];
    start: number;
    graph: FocusGraph;
}

export interface Audit {
    focus: FocusMap | null;
    issues: A11yIssue[];
}

const TEXTUAL = new Set(['text', 'clock-text', 'button']);
const EDGE = '48 px nas laterais, 27 px em cima e embaixo';
/** Number in Brazilian Portuguese: at most `d` decimals, comma separator. */
const num = (n: number, d = 1) => String(+n.toFixed(d)).replace('.', ',');
const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };

const rectOf = (el: Element): Rect => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
};

export function runAudit(pf: PreviewFrame, page: string, root: LayoutNode, res: TvRes): Audit {
    const doc = pf.doc;
    const scope = pf.pageRoot(page);
    if (!doc || !scope || !doc.defaultView) return { focus: null, issues: [] };
    const getComputedStyle = doc.defaultView.getComputedStyle.bind(doc.defaultView);

    const nameOf = (id: string | null) => {
        const n = id ? T.find(root, id)?.node : null;
        return n ? n.name || E.registry[n.type]?.label || n.id : 'launcher';
    };
    const issues: A11yIssue[] = [];
    const seen = new Set<string>();
    const add = (rule: A11yIssue['rule'], nodeId: string | null, message: string) => {
        const k = rule + '|' + nodeId;
        if (seen.has(k)) return;
        seen.add(k);
        issues.push({ rule, nodeId, message });
    };
    const elOf = (id: string): HTMLElement | null =>
        (scope.getAttribute('data-fmtv-id') === id ? scope : scope.querySelector(`[data-fmtv-id="${CSS.escape(id)}"]`)) as HTMLElement | null;
    const owner = (el: Element): string | null => {
        const o = el.closest('[data-fmtv-id]');
        return o && scope.contains(o) ? o.getAttribute('data-fmtv-id') : null;
    };

    /* ---------- focus map (home screen: the other screens use the launcher's own navigation) ---------- */

    let focus: FocusMap | null = null;
    if (page === 'home') {
        // Same list the launcher builds (refreshMainNavList): every visible .nav-item.
        const els = Array.from(doc.querySelectorAll('.nav-item')).filter((el) => (el as HTMLElement).offsetParent !== null);
        const items: FocusItem[] = els.map((el) => {
            const h = el as HTMLElement;
            const nodeId = owner(el);
            return {
                rect: rectOf(el), nodeId, inTrack: !!el.closest('.fmtv-track'),
                label: (h.dataset.title || h.getAttribute('aria-label') || h.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40) || nameOf(nodeId),
            };
        });
        // Where the TV starts: the element marked "initial focus" (an app tile inside a
        // widget beats its toolbar), otherwise the first app tile, otherwise the first item.
        let start = -1;
        let initialId: string | null = null;
        E.walk(root, (n) => { if (n.focus?.initial) initialId = n.id; });
        const initialEl = initialId ? elOf(initialId) : null;
        if (initialEl) {
            const target = initialEl.classList.contains('nav-item') ? initialEl
                : initialEl.querySelector('.app-tile.nav-item') || initialEl.querySelector('.nav-item');
            start = target ? els.indexOf(target) : -1;
        }
        if (start === -1) start = els.findIndex((el) => el.classList.contains('app-tile'));
        if (start === -1 && els.length) start = 0;
        const graph = focusGraph(items.map((i) => i.rect), start, E.pickNext as never);
        focus = { items, start, graph };

        const lost = new Map<string | null, number>();
        graph.steps.forEach((s, i) => { if (s === -1 && start !== -1) lost.set(items[i].nodeId, (lost.get(items[i].nodeId) || 0) + 1); });
        for (const [id, n] of lost) {
            add('unreachable', id, n === 1
                ? `"${nameOf(id)}" não pode ser alcançado pelas setas a partir do foco inicial (${items[start].label})`
                : `${n} itens de "${nameOf(id)}" não podem ser alcançados pelas setas a partir do foco inicial (${items[start].label})`);
        }
        for (const it of items) {
            if (it.inTrack || !onScreen(it.rect)) continue;
            const out = outsideSafeArea(it.rect);
            if (out > 1) add('safe-area', it.nodeId, `"${nameOf(it.nodeId)}" entra ${Math.round(out)} px na faixa da borda que TVs com overscan cortam (${EDGE}); o item focado pode ficar pela metade`);
        }
    }

    /* ---------- text and lines of the elements the layout draws itself ---------- */

    const scale = resScale(res);
    const resName = TV_RES[res].label.split(' ')[0];
    const textual: { node: LayoutNode; el: HTMLElement }[] = [];
    E.walk(root, (n) => {
        if (n.visible === false) return false;
        const el = elOf(n.id);
        if (!el) return;
        if (TEXTUAL.has(n.type) && (el.textContent || '').trim()) textual.push({ node: n, el });
        const cs = getComputedStyle(el);
        const bw = Math.max(...['Top', 'Right', 'Bottom', 'Left'].map((s) => parseFloat(cs.getPropertyValue(`border-${s.toLowerCase()}-width`)) || 0));
        const thin = n.type === 'divider' ? Math.min(el.getBoundingClientRect().width, el.getBoundingClientRect().height) : bw;
        if (scale < 1 && thin > 0 && thin * scale < MIN_REAL_LINE_PX) {
            add('resolution', n.id, `Em ${resName}, a linha de ${num(thin, 2)} px de "${nameOf(n.id)}" vira ${num(thin * scale, 2)} px reais e pode sumir ou piscar; use ${num(Math.ceil(MIN_REAL_LINE_PX / scale * 2) / 2)} px ou mais`);
        }
    });

    // Paint every element hit-testable for a moment, so elementsFromPoint lists the whole
    // stack under a point, including backgrounds the launcher marks pointer-events:none.
    const probe = doc.createElement('style');
    probe.textContent = '*{pointer-events:auto!important}';
    doc.head.appendChild(probe);
    try {
        for (const { node, el } of textual) {
            const r = rectOf(el);
            if (!onScreen(r)) continue;
            const cs = getComputedStyle(el);
            const size = parseFloat(cs.fontSize) || 16;
            const weight = parseInt(cs.fontWeight, 10) || 400;
            const name = nameOf(node.id);
            if (size < MIN_TEXT_PX) add('text-size', node.id, `Texto de ${Math.round(size)} px em "${name}": pequeno demais para ler do sofá; use ${MIN_TEXT_PX} px ou mais (22 px para texto corrido)`);
            else if (size * scale < MIN_REAL_TEXT_PX) add('resolution', node.id, `Em ${resName}, o texto de ${Math.round(size)} px de "${name}" fica com ${num(size * scale)} px reais e perde nitidez; ${Math.ceil(MIN_REAL_TEXT_PX / scale)} px ou mais fica legível`);
            if (outsideSafeArea(r) > 1) add('safe-area', node.id, `O texto de "${name}" entra ${Math.round(outsideSafeArea(r))} px na faixa da borda que TVs com overscan cortam (${EDGE})`);

            const color = parseColor(cs.color);
            if (!color) continue;
            const shadow = cs.textShadow && cs.textShadow !== 'none';
            let worst: { ratio: number; bg: Rgba } | null = null;
            let overImage = false;
            const cy = r.y + r.h / 2;
            const xs = [r.x + r.w / 2, r.x + Math.min(r.w * 0.15, 24), r.x + r.w - Math.min(r.w * 0.15, 24)];
            for (const px of xs) {
                const x = Math.max(1, Math.min(1919, px)), y = Math.max(1, Math.min(1079, cy));
                const bgs = backgroundCandidates(layersUnder(doc, el, x, y), BLACK);
                const w = worstContrast(color, bgs.colors);
                if (!worst || w.ratio < worst.ratio) { worst = w; overImage = bgs.image; }
            }
            const min = minContrast(size, weight);
            if (worst && worst.ratio < min) {
                // Over a photo the worst case is a guess (black or white under the text): a text
                // shadow is the usual remedy there, so it settles the question.
                if (overImage && !shadow) {
                    add('contrast', node.id, `"${name}" fica sobre uma imagem e só é legível onde a imagem for ${luminanceOf(color) > 0.5 ? 'escura' : 'clara'}. Uma sombra no texto ou um fundo semitransparente por trás garante a leitura`);
                } else if (!overImage) {
                    add('contrast', node.id, `Contraste de ${num(worst.ratio)}:1 em "${name}" (texto ${toHex(color)} sobre ${toHex(worst.bg)}); o mínimo é ${num(min)}:1 para texto ${min === 3 ? 'grande' : 'deste tamanho'}`);
                }
            }
        }
    } finally {
        probe.remove();
    }
    return { focus, issues };
}

/** Painted layers under `el` at (x, y), nearest first: its own background, then what lies below. */
function layersUnder(doc: Document, el: HTMLElement, x: number, y: number): Layer[] {
    const getComputedStyle = doc.defaultView!.getComputedStyle.bind(doc.defaultView);
    const stack = doc.elementsFromPoint(x, y);
    const at = stack.indexOf(el);
    const below = [el, ...(at === -1 ? stack : stack.slice(at + 1)).filter((e) => e !== el && !el.contains(e))];
    const layers: Layer[] = [];
    for (const e of below) {
        const cs = getComputedStyle(e);
        const opacity = effectiveOpacity(e);
        if (opacity < 0.01) continue;
        if (/^(IMG|VIDEO|CANVAS|IFRAME|PICTURE)$/.test(e.tagName)) { layers.push({ unknown: true }); break; }
        const img = cs.backgroundImage;
        if (img && img !== 'none') {
            if (/url\(/.test(img)) { layers.push({ unknown: true }); break; }
            const stops = gradientColors(img);
            if (stops.length) layers.push({ colors: stops, opacity });
        }
        const bg = parseColor(cs.backgroundColor);
        if (bg && bg.a > 0) layers.push({ colors: [bg], opacity });
    }
    return layers;
}

function effectiveOpacity(e: Element): number {
    const view = e.ownerDocument.defaultView!;
    let o = 1;
    for (let p: Element | null = e; p && p.tagName !== 'HTML'; p = p.parentElement) o *= parseFloat(view.getComputedStyle(p).opacity) || 0;
    return o;
}
