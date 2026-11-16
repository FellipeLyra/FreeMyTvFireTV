#!/usr/bin/env node
// A pretend Fire TV that publishes over the internet, for testing the cloud flow
// without a device. It does what the app's CloudSync.kt does: register, show a
// pairing code, wait for news (long poll), download the package, import it with
// the LayoutStore.kt checks (names, sizes, SHA-256, schema), confirm the drawing
// (or roll back) and report back. Also runs rollback/reset commands.
//
//   node tools/test/fake-cloud-tv.mjs http://127.0.0.1:8787   (prints the pairing code)
//
// Like fake-adb.mjs, a layout whose name contains "falha-na-tv" fails to render.
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzip } from '../lib/package.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The checks LayoutStore.unpackToStaging() makes. Returns the layout or throws. */
export function checkPackage(bytes) {
    const files = new Map();
    for (const e of unzip(bytes)) {
        if (e.name === 'assets/') continue;
        if (e.name !== 'layout.json' && !/^assets\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.(png|jpg|jpeg|webp)$/.test(e.name)) throw new Error('arquivo não permitido no pacote: ' + e.name);
        files.set(e.name, e.data);
    }
    if (!files.has('layout.json')) throw new Error('layout.json ausente');
    let layout;
    try { layout = JSON.parse(files.get('layout.json').toString('utf8')); } catch { throw new Error('layout.json não é JSON válido'); }
    if (!(layout.schemaVersion >= 1)) throw new Error('schemaVersion ausente');
    if (layout.schemaVersion > 1) throw new Error(`layout usa o schema ${layout.schemaVersion}; este app entende até o 1. Atualize o Free My TV.`);
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(layout.id || '')) throw new Error('id do layout inválido');
    const declared = new Set();
    for (const a of layout.assets || []) {
        const data = files.get('assets/' + a.file);
        if (!data) throw new Error('asset declarado mas ausente: ' + a.file);
        if (data.length !== a.bytes) throw new Error('tamanho não confere: ' + a.file);
        if (createHash('sha256').update(data).digest('hex') !== String(a.sha256).toLowerCase()) throw new Error('SHA-256 não confere: ' + a.file);
        declared.add('assets/' + a.file);
    }
    for (const n of files.keys()) if (n !== 'layout.json' && !declared.has(n)) throw new Error('asset não declarado: ' + n.slice(7));
    return layout;
}

export class FakeCloudTv {
    constructor(server, { model = 'AFTKA', name = 'Fire TV Stick 4K Max', appVersion = '1.0.0-dev.42', renderDelay = 300 } = {}) {
        this.server = server.replace(/\/+$/, '');
        this.info = { model, name, appVersion };
        this.renderDelay = renderDelay;
        this.token = null;
        this.me = null;
        this.etag = '';
        this.cmd = 0;
        this.current = null; // { layout, status }
        this.previous = null;
        this.log = [];
        this.running = false;
    }

    async api(method, path, body) {
        const r = await fetch(this.server + path, {
            method,
            headers: { ...(this.token ? { authorization: 'Bearer ' + this.token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined,
        });
        if (!r.ok) { const e = new Error((await r.json().catch(() => ({}))).error || 'HTTP ' + r.status); e.status = r.status; throw e; }
        return /json/.test(r.headers.get('content-type') || '') ? r.json() : Buffer.from(await r.arrayBuffer());
    }

    async register() {
        const r = await this.api('POST', '/v1/tv/register', this.info);
        this.token = r.deviceToken;
        this.me = r;
        return r;
    }

    status() {
        return {
            active: !!this.current, id: this.current?.layout.id || '', name: this.current?.layout.name || '',
            status: this.current?.status || '', previous: this.previous ? { id: this.previous.layout.id, name: this.previous.layout.name } : null,
        };
    }

    async report(op, result) {
        this.log.push(`${op} ${result.ok ? 'ok' : 'falhou'} ${result.error || result.reason || ''}`.trim());
        await this.api('POST', '/v1/tv/report', { op, ...result, status: this.status(), appVersion: this.info.appVersion });
    }

    rollbackLocal() {
        const had = !!this.previous;
        this.current = this.previous ? { ...this.previous, status: 'verified' } : null;
        this.previous = null;
        return had ? 'previous' : 'default';
    }

    async applyLayout(msg) {
        const bytes = await this.api('GET', '/v1/tv/package?etag=' + encodeURIComponent(msg.etag));
        this.etag = msg.etag; // never fetch the same package twice, even when it fails
        let layout;
        try {
            layout = checkPackage(bytes);
        } catch (e) {
            await this.report('import', { ok: false, error: e.message, etag: msg.etag });
            return;
        }
        if (this.current?.status === 'verified') this.previous = this.current;
        this.current = { layout, status: 'pending' };
        await this.report('import', { ok: true, id: layout.id, name: layout.name, etag: msg.etag });
        await sleep(this.renderDelay); // the page reloads and draws
        if (/falha-na-tv/.test(layout.name || '')) {
            const restored = this.rollbackLocal();
            await this.report('rollback', { ok: true, reason: `o layout ${layout.id} falhou: simulação de falha na TV`, restored, etag: msg.etag });
        } else {
            this.current.status = 'verified';
            await this.report('render', { ok: true, id: layout.id, etag: msg.etag });
        }
    }

    async runCommand(msg) {
        this.cmd = msg.id;
        if (msg.op === 'rollback') {
            const restored = this.rollbackLocal();
            await this.report('rollback', { ok: true, reason: 'pedido pela internet', restored, cmd: msg.id });
        } else if (msg.op === 'reset') {
            if (this.current?.status === 'verified') this.previous = this.current;
            this.current = null;
            await this.report('reset', { ok: true, cmd: msg.id });
        }
    }

    /** One long poll; returns the message handled. */
    async step(wait = 25000) {
        const msg = await this.api('GET', `/v1/tv/next?etag=${encodeURIComponent(this.etag)}&cmd=${this.cmd}&wait=${wait}`);
        this.me = { ...this.me, ...msg };
        if (msg.type === 'command') await this.runCommand(msg);
        else if (msg.type === 'layout') await this.applyLayout(msg);
        return msg;
    }

    async run() {
        this.running = true;
        while (this.running) {
            try { await this.step(); } catch (e) {
                if (e.status === 401) { this.running = false; break; }
                await sleep(1000);
            }
        }
    }

    stop() { this.running = false; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const server = process.argv[2] || 'http://127.0.0.1:8787';
    const tv = new FakeCloudTv(server);
    const me = await tv.register();
    console.log(JSON.stringify({ pairCode: me.pairCode, deviceId: me.deviceId }));
    tv.run();
}
