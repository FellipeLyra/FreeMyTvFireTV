// Layout packages (.fmtv): a zip with layout.json and assets/<file>.
// Written with the STORE method (no compression; the images are already
// compressed) and sizes in the local headers, which is what the app's
// ZipInputStream reads most reliably. No dependencies.
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const engine = require('../../app/src/main/assets/web/fmtv/engine.js');

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

export function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

export function sha256(buf) {
    return createHash('sha256').update(buf).digest('hex');
}

/** Build a zip (STORE) from [{name, data: Buffer}]. */
export function zip(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const { name, data } of entries) {
        const nameBuf = Buffer.from(name, 'utf8');
        const crc = crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);        // version needed
        local.writeUInt16LE(0x0800, 6);    // UTF-8 names
        local.writeUInt16LE(0, 8);         // STORE
        local.writeUInt32LE(0, 10);        // time/date
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);
        locals.push(local, nameBuf, data);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(0, 10);
        central.writeUInt32LE(0, 12);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, nameBuf);
        offset += 30 + nameBuf.length + data.length;
    }
    const centralBuf = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralBuf.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, centralBuf, end]);
}

/** Read a STORE zip back into [{name, data}] (for inspection and tests). */
export function unzip(buf) {
    const out = [];
    let p = 0;
    while (p + 4 <= buf.length && buf.readUInt32LE(p) === 0x04034b50) {
        const method = buf.readUInt16LE(p + 8);
        const crc = buf.readUInt32LE(p + 14);
        const size = buf.readUInt32LE(p + 18);
        const nameLen = buf.readUInt16LE(p + 26);
        const extraLen = buf.readUInt16LE(p + 28);
        if (method !== 0) throw new Error('only STORE entries are supported');
        const name = buf.toString('utf8', p + 30, p + 30 + nameLen);
        const start = p + 30 + nameLen + extraLen;
        const data = buf.subarray(start, start + size);
        if (crc32(data) !== crc) throw new Error('CRC mismatch in ' + name);
        out.push({ name, data });
        p = start + size;
    }
    return out;
}

/**
 * Fill each asset's `bytes` and `sha256` from the files in `assetsDir`, then
 * validate. Returns {layout, files, validation}.
 */
export function prepare(layoutPath, assetsDir) {
    const layout = JSON.parse(readFileSync(layoutPath, 'utf8'));
    const files = [];
    for (const a of layout.assets || []) {
        if (typeof a.file !== 'string' || basename(a.file) !== a.file) {
            throw new Error(`asset ${a.id}: nome de arquivo inválido ${JSON.stringify(a.file)}`);
        }
        const path = join(assetsDir, a.file);
        if (!existsSync(path)) throw new Error(`asset ${a.id}: arquivo não encontrado em ${path}`);
        const data = readFileSync(path);
        a.bytes = data.length;
        a.sha256 = sha256(data);
        files.push({ name: 'assets/' + a.file, data });
    }
    const validation = engine.validate(layout);
    return { layout, files, validation };
}

/** Build the .fmtv bytes for a prepared, valid layout. */
export function buildPackage(layout, files) {
    const json = Buffer.from(JSON.stringify(layout, null, 2), 'utf8');
    return zip([{ name: 'layout.json', data: json }, ...files]);
}
