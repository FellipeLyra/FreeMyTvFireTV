// Byte helpers that work in browsers, Tauri and Node 18+ (tests).

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function bytesToBase64(bytes: Uint8Array): string {
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
    return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
}

const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

export function crc32(buf: Uint8Array): number {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

/** Zip with STORE entries and sizes in the local headers (what the app's ZipInputStream expects). */
export function zip(entries: { name: string; data: Uint8Array }[]): Uint8Array {
    const enc = new TextEncoder();
    const parts: Uint8Array[] = [];
    const central: Uint8Array[] = [];
    let offset = 0;
    for (const { name, data } of entries) {
        const nameBuf = enc.encode(name);
        const crc = crc32(data);
        const local = new DataView(new ArrayBuffer(30));
        local.setUint32(0, 0x04034b50, true);
        local.setUint16(4, 20, true);
        local.setUint16(6, 0x0800, true);
        local.setUint32(14, crc, true);
        local.setUint32(18, data.length, true);
        local.setUint32(22, data.length, true);
        local.setUint16(26, nameBuf.length, true);
        parts.push(new Uint8Array(local.buffer), nameBuf, data);
        const c = new DataView(new ArrayBuffer(46));
        c.setUint32(0, 0x02014b50, true);
        c.setUint16(4, 20, true);
        c.setUint16(6, 20, true);
        c.setUint16(8, 0x0800, true);
        c.setUint32(16, crc, true);
        c.setUint32(20, data.length, true);
        c.setUint32(24, data.length, true);
        c.setUint16(28, nameBuf.length, true);
        c.setUint32(42, offset, true);
        central.push(new Uint8Array(c.buffer), nameBuf);
        offset += 30 + nameBuf.length + data.length;
    }
    const centralSize = central.reduce((s, p) => s + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);
    const all = [...parts, ...central, new Uint8Array(end.buffer)];
    const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
    let p = 0;
    for (const a of all) { out.set(a, p); p += a.length; }
    return out;
}
