// Phase 9: shrink images to what the TV can show (1920×1080), in the browser.
import { fitSize } from '../model/perf';

export interface Shrunk {
    bytes: Uint8Array;
    width: number;
    height: number;
    /** Original size, for the message. */
    from: { w: number; h: number };
}

const QUALITY = 0.9;

/**
 * Resize an image so it just covers 1920×1080, keeping its format (PNG stays
 * PNG for transparency). Null when it is already small enough or the result
 * would not be smaller.
 */
export async function shrinkForTv(bytes: Uint8Array, type: string): Promise<Shrunk | null> {
    const bmp = await createImageBitmap(new Blob([bytes], { type }));
    const from = { w: bmp.width, h: bmp.height };
    const fit = fitSize(bmp.width, bmp.height);
    if (!fit) { bmp.close(); return null; }
    const canvas = document.createElement('canvas');
    canvas.width = fit.w;
    canvas.height = fit.h;
    const ctx = canvas.getContext('2d');
    if (!ctx) { bmp.close(); return null; }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, fit.w, fit.h);
    bmp.close();
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, type, QUALITY));
    if (!blob || blob.type !== type) return null;
    // Even when the file does not get smaller on disk, the TV needs less memory to show it.
    const out = new Uint8Array(await blob.arrayBuffer());
    return { bytes: out, width: fit.w, height: fit.h, from };
}

export const mimeOf = (file: string) => (file.endsWith('.png') ? 'image/png' : file.endsWith('.webp') ? 'image/webp' : 'image/jpeg');
