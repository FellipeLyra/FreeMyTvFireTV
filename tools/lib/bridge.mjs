// Local bridge between Free My TV Studio and adb. Browsers cannot run programs,
// so the Studio asks this small HTTP service to talk to the Fire TV for it.
//
// It runs inside the Studio's dev server (studio/vite.config.ts) and standalone
// with `node tools/fmtv.mjs serve` (for a built Studio). Only fixed operations
// exist (list, connect, publish, rollback, reset, history); never raw adb
// arguments. Requests must come from the machine itself (Host 127.0.0.1 or
// localhost: no DNS rebinding), from a Studio page (Origin allowlist) and carry
// the X-FMTV-Studio header, which a web page on another site cannot send
// without a CORS preflight this bridge refuses. So a site open in the browser
// cannot reach the TV through it.
import { createServer } from 'node:http';
import { connect as tcpConnect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { Adb, AdbError, findAdb } from './adb.mjs';
import { unzip, engine } from './package.mjs';

export const API = '/api/fmtv/';
const MAX_BODY = 40 * 1024 * 1024;
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i;
const STUDIO_ORIGIN = /^(https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?|tauri:\/\/localhost|https?:\/\/tauri\.localhost)$/i;
const ADDRESS = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}(:\d{1,5})?$/;
/** Friendly names for Fire TV model codes (the code is always shown next to it). */
const FIRE_TV = {
    AFTM: 'Fire TV Stick (1ª geração)', AFTT: 'Fire TV Stick (2ª geração)', AFTSSS: 'Fire TV Stick (3ª geração)', AFTSS: 'Fire TV Stick Lite',
    AFTMM: 'Fire TV Stick 4K', AFTKA: 'Fire TV Stick 4K Max', AFTN: 'Fire TV (3ª geração)', AFTA: 'Fire TV Cube (1ª geração)', AFTR: 'Fire TV Cube (2ª geração)',
};

class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

/** Is this request allowed? Returns an error message, or null. */
export function rejectReason(req) {
    if (!LOOPBACK_HOST.test(req.headers.host || '')) return 'host não permitido';
    const origin = req.headers.origin;
    if (origin && !STUDIO_ORIGIN.test(origin)) return 'origem não permitida';
    if (req.method !== 'OPTIONS' && req.headers['x-fmtv-studio'] !== '1') return 'cabeçalho X-FMTV-Studio ausente';
    return null;
}

function readBody(req, limit = MAX_BODY) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > limit) { reject(new HttpError(413, 'pacote grande demais')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Private IPv4 /24 networks this computer is on, as "192.168.0." prefixes, with our own address. */
function localNetworks() {
    const out = [];
    for (const list of Object.values(networkInterfaces())) {
        for (const i of list || []) {
            if (i.family !== 'IPv4' && i.family !== 4) continue;
            if (i.internal || !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address)) continue;
            const prefix = i.address.split('.').slice(0, 3).join('.') + '.';
            if (!out.some((n) => n.prefix === prefix)) out.push({ prefix, self: i.address });
        }
    }
    return out.slice(0, 4);
}

function portOpen(host, port, timeout) {
    return new Promise((resolve) => {
        const s = tcpConnect({ host, port });
        const done = (ok) => { s.destroy(); resolve(ok); };
        s.setTimeout(timeout, () => done(false));
        s.once('connect', () => done(true));
        s.once('error', () => done(false));
    });
}

export function createBridge({ adbPath = process.env.ADB || null } = {}) {
    const busy = new Set();
    let adbExe = adbPath;
    const adbFor = (serial = null, log) => {
        if (!adbExe) adbExe = findAdb();
        return new Adb({ adb: adbExe, serial, log });
    };

    /** One operation at a time per device. */
    async function exclusive(serial, fn) {
        if (busy.has(serial)) throw new HttpError(409, 'este aparelho já está ocupado com outra operação');
        busy.add(serial);
        try { return await fn(); } finally { busy.delete(serial); }
    }

    /** A device from the adb list, ready and with the app installed. */
    async function ready(serial, log) {
        if (typeof serial !== 'string' || !serial) throw new HttpError(400, 'escolha um aparelho');
        const adb = adbFor(null, log);
        await adb.select(serial);
        await adb.appVersion();
        return adb;
    }

    async function describe(d) {
        const info = { ...d, label: FIRE_TV[d.model] ? `${FIRE_TV[d.model]} (${d.model})` : d.model || d.serial, network: /:\d+$/.test(d.serial) };
        if (d.state !== 'device') return info;
        const adb = adbFor(d.serial);
        const [sys, app, result] = await Promise.all([
            adb.systemInfo().catch(() => ({})),
            adb.appVersion().catch((e) => ({ error: e.message })),
            adb.readResult().catch(() => null),
        ]);
        const model = sys.model || d.model;
        return { ...info, ...sys, model, label: FIRE_TV[model] ? `${FIRE_TV[model]} (${model})` : model || info.label, app, layout: result?.status || null, lastOp: result ? { op: result.op, ok: result.ok, time: result.time } : null };
    }

    const routes = {
        'GET hello': async () => {
            try {
                const exe = adbExe || findAdb();
                adbExe = exe;
                return { ok: true, adb: exe, simulated: /\.m?js$/i.test(exe), version: 1 };
            } catch (e) {
                return { ok: false, adb: null, error: e.message, version: 1 };
            }
        },
        'GET devices': async () => {
            const list = await adbFor().devices();
            return { devices: await Promise.all(list.map(describe)) };
        },
        'POST connect': async ({ json }) => {
            const address = String(json.address || '').trim();
            if (!ADDRESS.test(address)) throw new HttpError(400, 'endereço inválido; use o IP do Fire TV, por exemplo 192.168.0.50');
            const serial = await adbFor().connect(address);
            // A first connection makes the TV ask for authorisation; give the list a moment.
            await sleep(300);
            const d = (await adbFor().devices()).find((x) => x.serial === serial);
            return { serial, device: d ? await describe(d) : null };
        },
        'POST disconnect': async ({ json }) => {
            const serial = String(json.serial || '');
            if (!/:\d+$/.test(serial)) throw new HttpError(400, 'só aparelhos conectados pela rede podem ser desconectados');
            await adbFor().disconnect(serial);
            return { ok: true };
        },
        'POST scan': async () => {
            const nets = localNetworks();
            const hosts = [];
            for (const n of nets) for (let i = 1; i < 255; i++) if (n.prefix + i !== n.self) hosts.push(n.prefix + i);
            const found = [];
            for (let i = 0; i < hosts.length; i += 64) {
                const batch = hosts.slice(i, i + 64);
                const open = await Promise.all(batch.map((h) => portOpen(h, 5555, 450)));
                batch.forEach((h, j) => { if (open[j]) found.push(h + ':5555'); });
            }
            return { networks: nets.map((n) => n.prefix + '0/24'), found };
        },
        'POST publish': async ({ req, res, query, body }) => {
            const serial = query.get('serial');
            // The Studio validated already; check again before anything reaches the TV.
            let layoutEntry;
            try { layoutEntry = unzip(body).find((e) => e.name === 'layout.json'); } catch { throw new HttpError(400, 'o pacote não é um .fmtv válido'); }
            if (!layoutEntry) throw new HttpError(400, 'o pacote não tem layout.json');
            const v = engine.validate(layoutEntry.data.toString('utf8'));
            if (!v.ok) throw new HttpError(400, 'layout inválido: ' + v.errors.slice(0, 3).map((e) => (e.path ? e.path + ': ' : '') + e.message).join('; '));
            // Progress goes out line by line (NDJSON) while the TV works.
            res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
            const send = (o) => res.write(JSON.stringify(o) + '\n');
            try {
                await exclusive(serial, async () => {
                    send({ type: 'log', message: 'conferindo o aparelho…' });
                    const adb = await ready(serial, (m) => send({ type: 'log', message: m }));
                    adb.serial = serial;
                    const result = await adb.publish(body);
                    send({ type: 'result', result });
                });
            } catch (e) {
                send({ type: 'error', message: e.message });
            }
            res.end();
            return undefined;
        },
        'POST rollback': async ({ json }) => exclusive(json.serial, async () => {
            const adb = await ready(json.serial);
            const r = await adb.command('rollback');
            if (!r) throw new HttpError(504, 'a TV não respondeu');
            return { result: r };
        }),
        'POST reset': async ({ json }) => exclusive(json.serial, async () => {
            const adb = await ready(json.serial);
            const r = await adb.command('reset');
            if (!r) throw new HttpError(504, 'a TV não respondeu');
            return { result: r };
        }),
        'GET log': async ({ query }) => {
            const adb = await ready(query.get('serial'));
            return { lines: await adb.readLog() };
        },
    };

    /** Connect/Express-style handler: handles /api/fmtv/*, calls next() for anything else. */
    return async function handle(req, res, next) {
        const url = new URL(req.url || '/', 'http://localhost');
        if (!url.pathname.startsWith(API)) { if (next) next(); else { res.statusCode = 404; res.end(); } return; }
        const origin = req.headers.origin;
        const reason = rejectReason(req);
        if (reason) {
            res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'pedido recusado: ' + reason }));
            return;
        }
        if (origin) {
            res.setHeader('access-control-allow-origin', origin);
            res.setHeader('vary', 'Origin');
        }
        if (req.method === 'OPTIONS') {
            res.writeHead(204, { 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type, x-fmtv-studio', 'access-control-max-age': '600' });
            res.end();
            return;
        }
        const route = routes[`${req.method} ${url.pathname.slice(API.length)}`];
        if (!route) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'operação desconhecida' })); return; }
        try {
            const body = req.method === 'POST' ? await readBody(req) : Buffer.alloc(0);
            let json = {};
            if (body.length && /json/.test(req.headers['content-type'] || '')) {
                try { json = JSON.parse(body.toString('utf8')); } catch { throw new HttpError(400, 'JSON inválido'); }
            }
            const out = await route({ req, res, query: url.searchParams, body, json });
            if (out === undefined) return; // streamed
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(JSON.stringify(out));
        } catch (e) {
            const status = e instanceof HttpError ? e.status : e instanceof AdbError ? 400 : 500;
            if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: e.message || String(e) }));
        }
    };
}

/** Standalone bridge: `node tools/fmtv.mjs serve`. Listens on 127.0.0.1 only. */
export function serve(port = 5611, host = '127.0.0.1') {
    const handle = createBridge();
    const server = createServer((req, res) => handle(req, res));
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server));
    });
}
