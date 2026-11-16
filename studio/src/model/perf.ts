// Phase 9: what makes a layout heavy on a weak Fire TV (1 GB of RAM).
// Pure functions: the Studio shows these as "desempenho" alerts, which never
// block exporting.
import { E } from '../engine';
import type { Layout, LayoutNode } from './types';

/** The launcher always draws at 1920×1080 (4K TVs scale it up). */
export const TV_W = 1920;
export const TV_H = 1080;
/** Decoded images above this (all of them together) start to hurt a 1 GB device. */
export const IMAGE_MEMORY_MB = 64;
/** Elements with background blur: each one is re-blurred every frame something behind it moves. */
export const MAX_BLURS = 3;
/** A package above this is slow to send over Wi-Fi or the internet. */
export const PACKAGE_MB = 12;

/**
 * Size an image should have on the TV: the smallest one that still covers the
 * whole 1920×1080 screen (a full-screen background with "cover"). Null when the
 * image is already that small.
 */
export function fitSize(w: number, h: number): { w: number; h: number } | null {
    if (!(w > 0 && h > 0)) return null;
    const s = Math.max(TV_W / w, TV_H / h);
    if (s >= 1) return null;
    return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

/** Memory the TV needs to show an image (RGBA, 4 bytes per pixel), in MB. */
export const decodedMb = (w: number, h: number) => (w * h * 4) / 1048576;

export interface PerfIssue {
    rule: 'image-size' | 'image-memory' | 'blur' | 'package';
    nodeId: string | null;
    page?: string;
    asset?: string;
    message: string;
}

const mb = (n: number) => String(+n.toFixed(1)).replace('.', ',') + ' MB';

export function perfAudit(layout: Layout): PerfIssue[] {
    const out: PerfIssue[] = [];
    const assets = layout.assets || [];

    let decoded = 0;
    for (const a of assets) {
        if (!a.width || !a.height) continue;
        decoded += decodedMb(a.width, a.height);
        const fit = fitSize(a.width, a.height);
        if (fit && decodedMb(a.width, a.height) - decodedMb(fit.w, fit.h) >= 2) {
            out.push({
                rule: 'image-size', nodeId: null, asset: a.id,
                message: `${a.file} tem ${a.width}×${a.height}: a TV gasta ${mb(decodedMb(a.width, a.height))} de memória para mostrá-la. Com ${fit.w}×${fit.h} a imagem fica igual na tela e gasta ${mb(decodedMb(fit.w, fit.h))} (use "Otimizar imagens").`,
            });
        }
    }
    if (decoded > IMAGE_MEMORY_MB) {
        out.push({ rule: 'image-memory', nodeId: null, message: `As imagens ocupam ${mb(decoded)} de memória na TV. Acima de ${IMAGE_MEMORY_MB} MB, um Fire TV de 1 GB fica lento ou fecha o launcher.` });
    }

    const blurred: { id: string; page: string }[] = [];
    for (const [page, p] of Object.entries(layout.pages || {})) {
        if (!p?.root) continue;
        E.walk(p.root, (n: LayoutNode) => { if (n.style && typeof n.style.blur === 'number' && n.style.blur > 0) blurred.push({ id: n.id, page }); });
    }
    if (blurred.length > MAX_BLURS) {
        out.push({
            rule: 'blur', nodeId: blurred[0].id, page: blurred[0].page,
            message: `${blurred.length} elementos com desfoque de fundo. Cada um é redesenhado quando algo atrás dele se move, o que pesa em aparelhos fracos (lá o modo leve tira o desfoque). Use até ${MAX_BLURS}.`,
        });
    }

    const bytes = assets.reduce((t, a) => t + (a.bytes || 0), 0);
    if (bytes > PACKAGE_MB * 1048576) {
        out.push({ rule: 'package', nodeId: null, message: `As imagens somam ${mb(bytes / 1048576)}: publicar demora, principalmente pela internet. Tente ficar abaixo de ${PACKAGE_MB} MB.` });
    }
    return out;
}
