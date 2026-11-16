// Phase 6: what a person on the sofa actually gets. Pure helpers (no DOM) for
// the focus map and the accessibility alerts, so they can be unit-tested; the
// canvas collects the measurements from the TV runtime and calls these.
import type { Rect } from './types';

/* ------------------------------------------------------------------ */
/* TV resolutions                                                      */
/* ------------------------------------------------------------------ */

// The launcher page declares width=1920, so a layout is always 1920×1080 layout
// pixels; the TV only scales it. Resolution changes sharpness, not proportions.
export type TvRes = '720p' | '1080p' | '4k';
export const TV_RES: Record<TvRes, { label: string; w: number; h: number }> = {
    '720p': { label: '720p (1280×720)', w: 1280, h: 720 },
    '1080p': { label: '1080p (1920×1080)', w: 1920, h: 1080 },
    '4k': { label: '4K (3840×2160)', w: 3840, h: 2160 },
};
/** Real TV pixels per layout pixel. */
export const resScale = (res: TvRes) => TV_RES[res].w / 1920;

/* ------------------------------------------------------------------ */
/* Colour and contrast (WCAG 2.x)                                      */
/* ------------------------------------------------------------------ */

export interface Rgba { r: number; g: number; b: number; a: number }

/** Parse a computed CSS colour: rgb()/rgba() (what getComputedStyle returns), #hex or "transparent". */
export function parseColor(s: string): Rgba | null {
    const t = s.trim().toLowerCase();
    if (t === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(t);
    if (m) {
        let a = m[4] === undefined ? 1 : parseFloat(m[4]);
        if (m[4]?.endsWith('%')) a /= 100;
        return { r: +m[1], g: +m[2], b: +m[3], a: Math.max(0, Math.min(1, a)) };
    }
    const h = /^#([0-9a-f]{3,8})$/.exec(t);
    if (h) {
        let x = h[1];
        if (x.length === 3 || x.length === 4) x = x.split('').map((c) => c + c).join('');
        if (x.length !== 6 && x.length !== 8) return null;
        return { r: parseInt(x.slice(0, 2), 16), g: parseInt(x.slice(2, 4), 16), b: parseInt(x.slice(4, 6), 16), a: x.length === 8 ? parseInt(x.slice(6, 8), 16) / 255 : 1 };
    }
    return null;
}

/** Every colour mentioned in a computed background-image gradient (its stops). */
export function gradientColors(s: string): Rgba[] {
    return (s.match(/rgba?\([^)]*\)/g) || []).map(parseColor).filter((c): c is Rgba => !!c);
}

/** `top` painted over an opaque `bottom`. */
export function blend(top: Rgba, bottom: Rgba): Rgba {
    const a = top.a;
    return { r: top.r * a + bottom.r * (1 - a), g: top.g * a + bottom.g * (1 - a), b: top.b * a + bottom.b * (1 - a), a: 1 };
}

export function luminance(c: Rgba): number {
    const ch = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}

export function contrastRatio(a: Rgba, b: Rgba): number {
    const la = luminance(a), lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** WCAG "large text": 24 px, or 18.66 px when bold. Large text needs 3:1 instead of 4.5:1. */
export const isLargeText = (sizePx: number, weight: number) => sizePx >= 24 || (sizePx >= 18.66 && weight >= 700);
export const minContrast = (sizePx: number, weight: number) => (isLargeText(sizePx, weight) ? 3 : 4.5);

/**
 * One painted layer under the text: a solid colour, a gradient (any of its stops
 * may end up behind a letter) or something whose colours are unknown (photo, video).
 */
export type Layer = { colors: Rgba[]; opacity: number } | { unknown: true };

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };
const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };

/**
 * Possible background colours behind the text, given the layers under it from the
 * nearest down. Stops at the first fully opaque layer; `base` shows when nothing is.
 * An image or video can be any colour: it counts as both black and white (worst
 * case), so text over a photo passes only when the layers above it make it readable
 * whatever the photo shows; `image` tells the two cases apart.
 */
export function backgroundCandidates(layers: Layer[], base: Rgba): { colors: Rgba[]; image: boolean } {
    const used: Rgba[][] = [];
    let bottom: Rgba[] = [{ ...base, a: 1 }];
    let image = false;
    for (const l of layers) {
        if ('unknown' in l) { bottom = [BLACK, WHITE]; image = true; break; }
        const colors = l.colors.map((c) => ({ ...c, a: c.a * l.opacity })).filter((c) => c.a > 0.01);
        if (!colors.length) continue;
        used.push(colors);
        if (colors.every((c) => c.a >= 0.999)) break;
    }
    let cands = bottom;
    for (let i = used.length - 1; i >= 0; i--) {
        const next: Rgba[] = [];
        for (const top of used[i]) for (const b of cands) next.push(blend(top, b));
        // Keep the set small: the darkest and lightest are what matter for contrast.
        cands = extremes(next);
    }
    return { colors: cands, image };
}

function extremes(cs: Rgba[]): Rgba[] {
    if (cs.length <= 4) return cs;
    const sorted = [...cs].sort((a, b) => luminance(a) - luminance(b));
    return [sorted[0], sorted[1], sorted[sorted.length - 2], sorted[sorted.length - 1]];
}

/** Worst contrast of `text` (possibly translucent) against any of the backgrounds. */
export function worstContrast(text: Rgba, backgrounds: Rgba[]): { ratio: number; bg: Rgba } {
    let worst = { ratio: Infinity, bg: backgrounds[0] };
    for (const bg of backgrounds) {
        const ratio = contrastRatio(blend(text, bg), bg);
        if (ratio < worst.ratio) worst = { ratio, bg };
    }
    return worst;
}

export const toHex = (c: Rgba) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

/* ------------------------------------------------------------------ */
/* Focus map                                                           */
/* ------------------------------------------------------------------ */

export const DIRS = ['left', 'right', 'up', 'down'] as const;
export type Dir = (typeof DIRS)[number];
type PickNext = (items: Rect[], from: number, dir: Dir) => number;

export interface FocusGraph {
    /** For each item, the item each arrow leads to (-1: nothing that way). */
    next: Record<Dir, number>[];
    /** Arrow presses needed from the start item; -1 when it can never be reached. */
    steps: number[];
}

/** Breadth-first walk of the remote's arrow keys, with the TV's own `pickNext`. */
export function focusGraph(items: Rect[], start: number, pickNext: PickNext): FocusGraph {
    const next = items.map((_, i) => ({
        left: pickNext(items, i, 'left'), right: pickNext(items, i, 'right'),
        up: pickNext(items, i, 'up'), down: pickNext(items, i, 'down'),
    }));
    const steps = items.map(() => -1);
    if (start >= 0 && start < items.length) {
        steps[start] = 0;
        const queue = [start];
        while (queue.length) {
            const i = queue.shift()!;
            for (const d of DIRS) {
                const n = next[i][d];
                if (n !== -1 && steps[n] === -1) { steps[n] = steps[i] + 1; queue.push(n); }
            }
        }
    }
    return { next, steps };
}

/* ------------------------------------------------------------------ */
/* Screen edges                                                        */
/* ------------------------------------------------------------------ */

/** Recommended (title-safe) area, drawn on the canvas: 5% in from every edge. */
export const SAFE = { x: 96, y: 54, w: 1728, h: 972 };
/**
 * What TVs with overscan actually crop: 2.5% of each side (48 px left and right,
 * 27 px top and bottom). Alerts fire here; the launcher's own widgets sit inside it.
 */
export const ACTION_SAFE = { x: 48, y: 27, w: 1824, h: 1026 };

/** How far (px) a rectangle sticks out of an area; 0 when it is inside. */
export function outsideSafeArea(r: Rect, area: Rect = ACTION_SAFE): number {
    return Math.max(0, area.x - r.x, area.y - r.y, r.x + r.w - (area.x + area.w), r.y + r.h - (area.y + area.h));
}

/** Is any part of the rectangle on the 1920×1080 screen? */
export const onScreen = (r: Rect) => r.w > 0 && r.h > 0 && r.x < 1920 && r.y < 1080 && r.x + r.w > 0 && r.y + r.h > 0;

/* ------------------------------------------------------------------ */
/* Alerts                                                              */
/* ------------------------------------------------------------------ */

export type A11yRule = 'unreachable' | 'contrast' | 'text-size' | 'safe-area' | 'resolution';

export interface A11yIssue {
    rule: A11yRule;
    /** Layout element the alert is about (selected when clicked), if any. */
    nodeId: string | null;
    message: string;
}

/** Below this, text is hard to read from a couch, whatever the TV (fraction of the screen height). */
export const MIN_TEXT_PX = 16;
/** Real pixels under which a glyph loses its shape. */
export const MIN_REAL_TEXT_PX = 12;
/** Real pixels under which a line fades or shimmers. */
export const MIN_REAL_LINE_PX = 1;
