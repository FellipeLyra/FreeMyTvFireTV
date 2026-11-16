#!/usr/bin/env node
// Free My TV Cloud: publish layouts to Fire TVs over the internet (roadmap phase 8).
// No dependencies (Node 18+). You host it; see docs/cloud.md.
//
//   node server/fmtv-cloud.mjs [--port 8787] [--host 0.0.0.0] [--data ./cloud-data]
//   HTTPS: FMTV_TLS_CERT=cert.pem FMTV_TLS_KEY=key.pem, or run it behind a proxy
//   that terminates HTTPS (Caddy, nginx) and set FMTV_TRUST_PROXY=1.
//
// How it works
//   1. The TV registers (POST /v1/tv/register) and gets its own secret token and a
//      short pairing code that it shows on screen (8 characters, 10 minutes, single use).
//   2. In the Studio, the person types the code (POST /v1/pair) and gets a publisher
//      token for that TV only.
//   3. The Studio uploads a .fmtv (PUT /v1/devices/:id/layout). It is validated with
//      the launcher's own engine.js, like on the TV.
//   4. The TV waits for news with a long poll (GET /v1/tv/next), downloads the
//      package, imports it with the same code as the ADB path (LayoutStore.kt) and
//      reports what happened (POST /v1/tv/report): drawn and confirmed, or rolled back.
//
// Only SHA-256 hashes of tokens are stored. Pairing attempts and registrations are
// rate limited per address. Layout packages are data: nothing in them is executed.
import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzip, engine } from '../tools/lib/package.mjs';

export const VERSION = 1;
const MAX_PACKAGE = 26 * 1024 * 1024;
const MAX_JSON = 64 * 1024;
const PAIR_TTL = 10 * 60 * 1000;
const POLL_MAX = 25 * 1000;
const ONLINE_MS = 45 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const HISTORY = 50;

const sha = (s) => createHash('sha256').update(s).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const newId = () => 'tv_' + randomBytes(9).toString('base64url');
const newCode = () => Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
export const formatCode = (c) => c.slice(0, 4) + '-' + c.slice(4);
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n);

class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

/** Fixed-window counter per key (address). */
class RateLimit {
    constructor(max, windowMs) { this.max = max; this.windowMs = windowMs; this.hits = new Map(); }
    take(key, now) {
        const h = this.hits.get(key);
        if (!h || now - h.start > this.windowMs) { this.hits.set(key, { start: now, n: 1 }); return true; }
        h.n++;
        if (this.hits.size > 10000) this.hits.clear();
        return h.n <= this.max;
    }
}

/**
 * The service, without the network part (tests drive it directly through `handle`).
 * `opts.now` lets tests move the clock.
 */
export function createCloud({ dataDir, now = () => Date.now(), maxDevices = 5000, limits = {} } = {}) {
    if (!dataDir) throw new Error('dataDir é obrigatório');
    mkdirSync(join(dataDir, 'packages'), { recursive: true });
    const dbFile = join(dataDir, 'db.json');
    const db = existsSync(dbFile) ? JSON.parse(readFileSync(dbFile, 'utf8')) : { devices: {} };
    const byTvToken = new Map();
    const byPubToken = new Map();
    const reindex = () => {
        byTvToken.clear(); byPubToken.clear();
        for (const d of Object.values(db.devices)) {
            byTvToken.set(d.tokenHash, d.id);
            for (const p of d.publishers) byPubToken.set(p.tokenHash, d.id);
        }
    };
    reindex();
    let saveTimer = null;
    const saveNow = () => {
        clearTimeout(saveTimer); saveTimer = null;
        const tmp = dbFile + '.tmp';
        writeFileSync(tmp, JSON.stringify(db));
        renameSync(tmp, dbFile);
    };
    const save = () => { if (!saveTimer) saveTimer = setTimeout(saveNow, 200); };
    const pkgFile = (id) => join(dataDir, 'packages', id + '.fmtv');

    const registerLimit = new RateLimit(limits.register ?? 20, 60 * 60 * 1000);
    const pairLimit = new RateLimit(limits.pair ?? 30, 10 * 60 * 1000);
    const waiters = new Map(); // deviceId -> Set<fn>
    const wake = (id) => { for (const fn of waiters.get(id) || []) fn(); };

    function tvAuth(req) {
        const m = /^Bearer (\S+)$/.exec(req.headers.authorization || '');
        const id = m && byTvToken.get(sha(m[1]));
        if (!id || !db.devices[id]) throw new HttpError(401, 'TV não registrada (ou foi despareada)');
        const d = db.devices[id];
        d.lastSeen = now();
        return d;
    }
    function pubAuth(req, id) {
        const m = /^Bearer (\S+)$/.exec(req.headers.authorization || '');
        const owner = m && byPubToken.get(sha(m[1]));
        if (!owner || owner !== id || !db.devices[id]) throw new HttpError(401, 'sem acesso a esta TV: pareie de novo com o código que aparece nela');
        return { device: db.devices[id], hash: sha(m[1]) };
    }
    const freshCode = (d) => {
        let code;
        do { code = newCode(); } while (Object.values(db.devices).some((x) => x.pair?.code === code));
        d.pair = { code, expires: now() + PAIR_TTL };
        return d.pair;
    };
    const tvView = (d) => ({
        deviceId: d.id,
        paired: d.publishers.length > 0,
        publishers: d.publishers.map((p) => p.name),
        pairCode: d.pair && d.pair.expires > now() ? formatCode(d.pair.code) : null,
        pairExpires: d.pair && d.pair.expires > now() ? d.pair.expires : null,
    });
    const studioView = (d) => ({
        id: d.id, model: d.model, name: d.name, appVersion: d.appVersion, lastSeen: d.lastSeen,
        online: !!d.lastSeen && now() - d.lastSeen < ONLINE_MS,
        pending: d.pending ? { etag: d.pending.etag, name: d.pending.name, at: d.pending.at, bytes: d.pending.bytes } : null,
        tvEtag: d.tvEtag || null,
        command: d.command || null,
        lastResult: d.lastResult || null,
        history: d.history.slice(0, 20),
        publishers: d.publishers.length,
    });

    const routes = [
        // ---------------- the TV ----------------
        ['POST', /^\/v1\/tv\/register$/, async ({ ip, json }) => {
            if (!registerLimit.take(ip, now())) throw new HttpError(429, 'registros demais deste endereço; tente mais tarde');
            if (Object.keys(db.devices).length >= maxDevices) throw new HttpError(503, 'servidor cheio');
            const t = token();
            const d = {
                id: newId(), tokenHash: sha(t), createdAt: now(), lastSeen: now(),
                model: clean(json.model, 60), name: clean(json.name, 60), appVersion: clean(json.appVersion, 30),
                publishers: [], pending: null, command: null, lastResult: null, history: [], tvEtag: null, pair: null,
            };
            freshCode(d);
            db.devices[d.id] = d;
            byTvToken.set(d.tokenHash, d.id);
            save();
            return { deviceToken: t, ...tvView(d) };
        }],
        ['GET', /^\/v1\/tv\/me$/, async ({ req }) => { const d = tvAuth(req); save(); return tvView(d); }],
        ['POST', /^\/v1\/tv\/pair-code$/, async ({ req }) => { const d = tvAuth(req); freshCode(d); save(); return tvView(d); }],
        ['DELETE', /^\/v1\/tv$/, async ({ req }) => {
            const d = tvAuth(req);
            delete db.devices[d.id];
            rmSync(pkgFile(d.id), { force: true });
            reindex();
            saveNow();
            wake(d.id);
            return { ok: true };
        }],
        // Long poll: answers at once when there is a command or a layout the TV does not have yet.
        ['GET', /^\/v1\/tv\/next$/, async ({ req, res, query }) => {
            const d = tvAuth(req);
            const have = query.get('etag') || '';
            const lastCmd = Number(query.get('cmd') || 0);
            d.tvEtag = have || null;
            const wait = Math.min(POLL_MAX, Math.max(0, Number(query.get('wait') ?? POLL_MAX)));
            const check = () => {
                const cur = db.devices[d.id];
                if (!cur) return { type: 'unpaired' };
                if (cur.command && cur.command.id > lastCmd) return { type: 'command', id: cur.command.id, op: cur.command.op };
                if (cur.pending && cur.pending.etag !== have) return { type: 'layout', etag: cur.pending.etag, name: cur.pending.name, bytes: cur.pending.bytes };
                return null;
            };
            const ready = check();
            if (ready || !wait) { save(); return { ...(ready || { type: 'none' }), ...tvView(d) }; }
            const out = await new Promise((done) => {
                const set = waiters.get(d.id) || new Set();
                waiters.set(d.id, set);
                const finish = () => { clearTimeout(timer); set.delete(fn); done(check()); };
                const fn = () => finish();
                const timer = setTimeout(finish, wait);
                set.add(fn);
                res.on('close', finish); // the TV went away (on the request, 'close' fires as soon as it is read)
            });
            const cur = db.devices[d.id];
            if (cur) cur.lastSeen = now();
            save();
            return { ...(out || { type: 'none' }), ...(cur ? tvView(cur) : {}) };
        }],
        ['GET', /^\/v1\/tv\/package$/, async ({ req, query, res }) => {
            const d = tvAuth(req);
            if (!d.pending || d.pending.etag !== query.get('etag') || !existsSync(pkgFile(d.id))) throw new HttpError(404, 'pacote não disponível');
            const bytes = readFileSync(pkgFile(d.id));
            res.writeHead(200, { 'content-type': 'application/zip', 'content-length': bytes.length, etag: `"${d.pending.etag}"`, 'cache-control': 'no-store' });
            res.end(bytes);
            return undefined;
        }],
        ['POST', /^\/v1\/tv\/report$/, async ({ req, json }) => {
            const d = tvAuth(req);
            const r = {
                op: clean(json.op, 20), ok: json.ok === true, error: clean(json.error, 500) || undefined, reason: clean(json.reason, 500) || undefined,
                restored: ['previous', 'default'].includes(json.restored) ? json.restored : undefined,
                etag: clean(json.etag, 80) || undefined, cmd: Number.isInteger(json.cmd) ? json.cmd : undefined,
                status: json.status && typeof json.status === 'object' ? {
                    active: !!json.status.active, id: clean(json.status.id, 64), name: clean(json.status.name, 80), status: clean(json.status.status, 20),
                    previous: json.status.previous && typeof json.status.previous === 'object' ? { id: clean(json.status.previous.id, 64), name: clean(json.status.previous.name, 80) } : null,
                } : undefined,
                at: now(),
            };
            if (typeof json.appVersion === 'string') d.appVersion = clean(json.appVersion, 30);
            d.lastResult = r;
            d.history.unshift(r);
            d.history.length = Math.min(d.history.length, HISTORY);
            save();
            return { ok: true };
        }],

        // ---------------- the Studio ----------------
        ['POST', /^\/v1\/pair$/, async ({ ip, json }) => {
            if (!pairLimit.take(ip, now())) throw new HttpError(429, 'tentativas demais; espere alguns minutos');
            const code = normCode(json.code);
            const d = code.length === 8 && Object.values(db.devices).find((x) => x.pair && x.pair.code === code && x.pair.expires > now());
            if (!d) throw new HttpError(404, 'código inválido ou expirado: gere um novo na TV');
            d.pair = null; // single use
            const t = token();
            d.publishers.push({ tokenHash: sha(t), name: clean(json.name, 40) || 'Free My TV Studio', createdAt: now() });
            byPubToken.set(sha(t), d.id);
            save();
            wake(d.id); // the TV screen switches from the code to "paired"
            return { deviceId: d.id, publisherToken: t, device: studioView(d) };
        }],
        ['GET', /^\/v1\/devices\/([\w-]+)$/, async ({ req, params }) => studioView(pubAuth(req, params[0]).device)],
        ['PUT', /^\/v1\/devices\/([\w-]+)\/layout$/, async ({ req, params, body }) => {
            const { device: d } = pubAuth(req, params[0]);
            let layoutEntry;
            try { layoutEntry = unzip(body).find((e) => e.name === 'layout.json'); } catch { throw new HttpError(400, 'o pacote não é um .fmtv válido'); }
            if (!layoutEntry) throw new HttpError(400, 'o pacote não tem layout.json');
            const v = engine.validate(layoutEntry.data.toString('utf8'));
            if (!v.ok) throw new HttpError(400, 'layout inválido: ' + v.errors.slice(0, 3).map((e) => (e.path ? e.path + ': ' : '') + e.message).join('; '));
            const etag = sha(body).slice(0, 32);
            writeFileSync(pkgFile(d.id) + '.tmp', body);
            renameSync(pkgFile(d.id) + '.tmp', pkgFile(d.id));
            d.pending = { etag, name: clean(v.layout.name, 80), id: v.layout.id, at: now(), bytes: body.length };
            save();
            wake(d.id);
            return { etag, device: studioView(d) };
        }],
        ['POST', /^\/v1\/devices\/([\w-]+)\/command$/, async ({ req, params, json }) => {
            const { device: d } = pubAuth(req, params[0]);
            if (!['rollback', 'reset'].includes(json.op)) throw new HttpError(400, 'comando desconhecido');
            d.command = { id: (d.command?.id || 0) + 1, op: json.op, at: now() };
            // The layout waiting to be fetched is dropped: the person changed their mind.
            if (d.pending && d.pending.etag !== d.tvEtag) { d.pending = null; rmSync(pkgFile(d.id), { force: true }); }
            save();
            wake(d.id);
            return { command: d.command, device: studioView(d) };
        }],
        ['DELETE', /^\/v1\/devices\/([\w-]+)\/pairing$/, async ({ req, params }) => {
            const { device: d, hash } = pubAuth(req, params[0]);
            d.publishers = d.publishers.filter((p) => p.tokenHash !== hash);
            byPubToken.delete(hash);
            save();
            wake(d.id);
            return { ok: true };
        }],
        ['GET', /^\/v1\/health$/, async () => ({ ok: true, service: 'fmtv-cloud', version: VERSION })],
    ];

    function readBody(req, limit) {
        return new Promise((resolveBody, reject) => {
            const chunks = [];
            let size = 0;
            req.on('data', (c) => {
                size += c.length;
                if (size > limit) { reject(new HttpError(413, 'conteúdo grande demais')); req.destroy(); return; }
                chunks.push(c);
            });
            req.on('end', () => resolveBody(Buffer.concat(chunks)));
            req.on('error', reject);
        });
    }

    async function handle(req, res, { trustProxy = false } = {}) {
        const url = new URL(req.url || '/', 'http://x');
        // The Studio calls from a page (any origin: auth is a bearer token, never a cookie).
        res.setHeader('access-control-allow-origin', '*');
        res.setHeader('x-content-type-options', 'nosniff');
        if (req.method === 'OPTIONS') {
            res.writeHead(204, { 'access-control-allow-methods': 'GET, POST, PUT, DELETE', 'access-control-allow-headers': 'authorization, content-type', 'access-control-max-age': '600' });
            res.end();
            return;
        }
        const ip = (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';
        try {
            const r = routes.find(([m, re]) => m === req.method && re.test(url.pathname));
            if (!r) throw new HttpError(404, 'não encontrado');
            const params = r[1].exec(url.pathname).slice(1);
            const isPkg = req.method === 'PUT';
            const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req, isPkg ? MAX_PACKAGE : MAX_JSON) : Buffer.alloc(0);
            let json = {};
            if (!isPkg && body.length) { try { json = JSON.parse(body.toString('utf8')); } catch { throw new HttpError(400, 'JSON inválido'); } }
            if (!json || typeof json !== 'object') json = {};
            const out = await r[2]({ req, res, query: url.searchParams, params, body, json, ip });
            if (out === undefined) return;
            // (req.destroyed is true once a body was read; whether the client left shows on res.)
            if (res.writableEnded || res.destroyed) return;
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(JSON.stringify(out));
        } catch (e) {
            const status = e instanceof HttpError ? e.status : 500;
            if (status === 500) console.error(e);
            if (res.headersSent || res.writableEnded) { res.end(); return; }
            res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(JSON.stringify({ error: status === 500 ? 'erro interno' : e.message }));
        }
    }

    return {
        handle,
        flush: saveNow,
        close() { if (saveTimer) saveNow(); for (const id of waiters.keys()) wake(id); },
        _db: db,
    };
}

/** Start the service on the network. */
export function startCloud({ port = 8787, host = '0.0.0.0', dataDir, tls = null, trustProxy = false } = {}) {
    const cloud = createCloud({ dataDir });
    const handler = (req, res) => cloud.handle(req, res, { trustProxy });
    const server = tls ? createHttps({ cert: tls.cert, key: tls.key }, handler) : createHttp(handler);
    server.requestTimeout = 120000;
    server.headersTimeout = 30000;
    return new Promise((ok, fail) => {
        server.once('error', fail);
        server.listen(port, host, () => {
            const close = server.close.bind(server);
            server.close = (cb) => { cloud.close(); server.closeAllConnections?.(); return close(cb); };
            ok({ server, cloud });
        });
    });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const arg = (name, def) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : def; };
    const port = Number(arg('--port', process.env.PORT || 8787));
    const host = arg('--host', '0.0.0.0');
    const dataDir = resolve(arg('--data', process.env.FMTV_DATA || './cloud-data'));
    const cert = process.env.FMTV_TLS_CERT, key = process.env.FMTV_TLS_KEY;
    const tls = cert && key ? { cert: readFileSync(cert), key: readFileSync(key) } : null;
    const trustProxy = process.env.FMTV_TRUST_PROXY === '1';
    const { server } = await startCloud({ port, host, dataDir, tls, trustProxy });
    console.log(`Free My TV Cloud em ${tls ? 'https' : 'http'}://${host}:${port}  (dados: ${dataDir})`);
    if (!tls && !trustProxy) console.log('! sem HTTPS: o app da TV só aceita endereços https://. Use FMTV_TLS_CERT/FMTV_TLS_KEY ou um proxy HTTPS (FMTV_TRUST_PROXY=1). Veja docs/cloud.md.');
    const stop = () => server.close(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
}
