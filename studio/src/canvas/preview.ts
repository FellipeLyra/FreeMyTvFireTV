// The canvas draws layouts with the launcher's real runtime, loaded in a
// same-origin iframe (public/runtime/preview.html). This module talks to it:
// render a layout, measure every element, find what is under the pointer and
// send remote-control keys.
import type { Layout, Rect } from '../model/types';
import { base64ToBytes } from '../lib/bytes';

/* eslint-disable @typescript-eslint/no-explicit-any */

export const STAGE_W = 1920;
export const STAGE_H = 1080;

export class PreviewFrame {
    private urls = new Map<string, { b64: string; url: string }>();

    constructor(private iframe: HTMLIFrameElement) {}

    get win(): any {
        return this.iframe.contentWindow;
    }
    get doc(): Document | null {
        return this.iframe.contentDocument;
    }
    get ready(): boolean {
        return !!this.win?.FMTVLayout && this.doc?.readyState === 'complete';
    }

    /** Object URL for an asset's bytes, reused while the bytes stay the same. */
    assetUrl(layout: Layout, assetData: Record<string, string>, id: string): string | null {
        const b64 = assetData[id];
        const asset = (layout.assets || []).find((a) => a.id === id);
        if (!b64 || !asset) return null;
        const cached = this.urls.get(id);
        if (cached && cached.b64 === b64) return cached.url;
        if (cached) URL.revokeObjectURL(cached.url);
        const type = /\.png$/i.test(asset.file) ? 'image/png' : /\.webp$/i.test(asset.file) ? 'image/webp' : 'image/jpeg';
        const url = URL.createObjectURL(new Blob([base64ToBytes(b64)], { type }));
        this.urls.set(id, { b64, url });
        return url;
    }

    render(layout: Layout, assetData: Record<string, string>, opts: { animate?: boolean } = {}): { ok: boolean; errors: string[] } {
        if (!this.ready) return { ok: false, errors: ['canvas ainda carregando'] };
        const res = this.win.FMTVLayout.render(layout, {
            preview: true,
            animate: !!opts.animate,
            assetUrl: (id: string) => this.assetUrl(layout, assetData, id),
        });
        // The launcher focuses its first tile after every render; give keyboard focus back
        // to the editor so shortcuts (undo, delete...) keep working.
        this.releaseFocus();
        return { ok: !!res.ok, errors: (res.errors || []).map((e: any) => (e.path ? e.path + ': ' : '') + e.message) };
    }

    releaseFocus() {
        try { (this.doc?.activeElement as HTMLElement | null)?.blur?.(); } catch { /* ignore */ }
        if (document.activeElement === this.iframe) this.iframe.blur();
    }

    /** Rectangles of every layout element, in layout pixels. */
    measure(): Record<string, Rect> {
        const out: Record<string, Rect> = {};
        const d = this.doc;
        if (!d) return out;
        d.querySelectorAll('[data-fmtv-id]').forEach((el) => {
            const r = el.getBoundingClientRect();
            out[el.getAttribute('data-fmtv-id')!] = { x: r.left, y: r.top, w: r.width, h: r.height };
        });
        return out;
    }

    /** Ids under a point, deepest first. */
    hit(x: number, y: number): string[] {
        const d = this.doc;
        if (!d) return [];
        const ids: string[] = [];
        for (const el of d.elementsFromPoint(x, y)) {
            let e: Element | null = el;
            while (e) {
                const id = e.getAttribute && e.getAttribute('data-fmtv-id');
                if (id && !ids.includes(id)) ids.push(id);
                e = e.parentElement;
            }
        }
        // elementsFromPoint lists topmost first; ancestors were appended after each hit.
        return ids;
    }

    /** Send a remote-control key to the page (preview mode). */
    key(key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Enter' | 'Escape') {
        const w = this.win;
        if (!w) return;
        const ev = new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        (this.doc!.activeElement || this.doc!.body).dispatchEvent(ev);
    }

    /** Ids of elements that currently take remote focus, with their rectangles, in navigation order. */
    focusables(): { el: Element; rect: Rect; label: string }[] {
        const w = this.win;
        if (!w || !Array.isArray(w.mainNavItems)) return [];
        return w.mainNavItems.map((el: Element) => {
            const r = el.getBoundingClientRect();
            return { el, rect: { x: r.left, y: r.top, w: r.width, h: r.height }, label: (el as HTMLElement).dataset.title || el.textContent?.trim().slice(0, 30) || '' };
        });
    }

    focusedRect(): Rect | null {
        const el = this.doc?.querySelector('.nav-item.focused');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
    }

    dispose() {
        for (const { url } of this.urls.values()) URL.revokeObjectURL(url);
        this.urls.clear();
    }
}
