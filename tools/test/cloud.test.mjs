// Free My TV Cloud (server/fmtv-cloud.mjs) end to end with pretend TVs
// (fake-cloud-tv.mjs): pairing, isolation between TVs, delivery by long poll,
// a layout that fails on the TV, commands and unpairing from both sides.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCloud } from '../../server/fmtv-cloud.mjs';
import { FakeCloudTv } from './fake-cloud-tv.mjs';
import { prepare, buildPackage } from '../lib/package.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = mkdtempSync(join(tmpdir(), 'fmtv-cloud-test-'));
let clock = Date.now();
let cloud, server, base;

before(async () => {
    cloud = createCloud({ dataDir: dir, now: () => clock, limits: { pair: 12 } });
    server = createServer((q, s) => cloud.handle(q, s));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { cloud.close(); server.closeAllConnections(); server.close(); rmSync(dir, { recursive: true, force: true }); });

async function api(method, path, { token, json, body } = {}) {
    const r = await fetch(base + path, {
        method,
        headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(json ? { 'content-type': 'application/json' } : {}) },
        body: json ? JSON.stringify(json) : body,
    });
    return { status: r.status, json: await r.json().catch(() => null), headers: r.headers };
}
const pkg = (file, patch) => {
    const { layout, files } = prepare(join(root, 'examples', 'layouts', file), join(root, 'examples', 'layouts', file.replace(/\.json$/, '') + '-assets'));
    return buildPackage(Object.assign(layout, patch || {}), files);
};
const until = async (fn, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); }
    throw new Error('timeout');
};

let tv, pub, id;

test('health and CORS for the Studio', async () => {
    assert.deepEqual((await api('GET', '/v1/health')).json, { ok: true, service: 'fmtv-cloud', version: 1 });
    const pre = await fetch(base + '/v1/pair', { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:5610', 'access-control-request-method': 'POST' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
    assert.match(pre.headers.get('access-control-allow-headers'), /authorization/);
});

test('the TV registers and shows a pairing code', async () => {
    tv = new FakeCloudTv(base);
    const me = await tv.register();
    assert.match(me.pairCode, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    assert.equal(me.paired, false);
    id = me.deviceId;
});

test('pairing: wrong code refused, right code (any spacing/case) works once', async () => {
    assert.equal((await api('POST', '/v1/pair', { json: { code: 'AAAA-AAAA' } })).status, 404);
    const code = tv.me.pairCode.toLowerCase().replace('-', ' ');
    const ok = await api('POST', '/v1/pair', { json: { code, name: 'Studio do PC da sala' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.deviceId, id);
    assert.equal(ok.json.device.model, 'AFTKA');
    pub = ok.json.publisherToken;
    assert.equal((await api('POST', '/v1/pair', { json: { code } })).status, 404, 'single use');
    const me = (await api('GET', '/v1/tv/me', { token: tv.token })).json;
    assert.equal(me.paired, true);
    assert.deepEqual(me.publishers, ['Studio do PC da sala']);
    assert.equal(me.pairCode, null);
});

test('codes expire after 10 minutes', async () => {
    const other = new FakeCloudTv(base);
    const me = await other.register();
    clock += 11 * 60 * 1000;
    assert.equal((await api('POST', '/v1/pair', { json: { code: me.pairCode } })).status, 404);
    const fresh = (await api('POST', '/v1/tv/pair-code', { token: other.token })).json;
    assert.notEqual(fresh.pairCode, me.pairCode);
    assert.equal((await api('POST', '/v1/pair', { json: { code: fresh.pairCode } })).status, 200);
});

test('a token only opens its own TV, and only hashes are stored', async () => {
    const other = new FakeCloudTv(base);
    const me = await other.register();
    const otherPub = (await api('POST', '/v1/pair', { json: { code: me.pairCode } })).json.publisherToken;
    assert.equal((await api('GET', `/v1/devices/${id}`, { token: otherPub })).status, 401);
    assert.equal((await api('GET', `/v1/devices/${id}`, { token: other.token })).status, 401, 'a TV token is not a publisher token');
    assert.equal((await api('GET', `/v1/devices/${id}`)).status, 401);
    assert.equal((await api('GET', '/v1/tv/me', { token: pub })).status, 401, 'a publisher token is not a TV token');
    cloud.flush();
    const raw = readFileSync(join(dir, 'db.json'), 'utf8');
    for (const t of [pub, tv.token, otherPub, other.token]) assert.ok(!raw.includes(t), 'raw token on disk');
});

test('invalid packages are refused before reaching the TV', async () => {
    assert.equal((await api('PUT', `/v1/devices/${id}/layout`, { token: pub, body: Buffer.from('not a zip') })).status, 400);
    const r = await api('PUT', `/v1/devices/${id}/layout`, { token: pub, body: pkg('classic.json', { schemaVersion: 99 }) });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /inválido/);
});

test('publishing: the waiting TV gets it at once, applies it and the Studio sees the confirmation', async () => {
    const poll = tv.step(20000); // the TV is already waiting
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    const put = await api('PUT', `/v1/devices/${id}/layout`, { token: pub, body: pkg('cinema.json') });
    assert.equal(put.status, 200);
    const msg = await poll;
    assert.equal(msg.type, 'layout');
    assert.ok(Date.now() - t0 < 2000, 'delivered by the long poll, not by a later check');
    const dev = await until(async () => { const d = (await api('GET', `/v1/devices/${id}`, { token: pub })).json; return d.lastResult?.op === 'render' && d; });
    assert.equal(dev.lastResult.ok, true);
    assert.equal(dev.lastResult.etag, put.json.etag);
    assert.equal(dev.lastResult.status.id, 'cinema');
    assert.equal(dev.lastResult.status.status, 'verified');
    assert.equal(dev.online, true);
    // Nothing new: the TV is not sent the same package again.
    assert.equal((await tv.step(0)).type, 'none');
});

test('a layout that fails on the TV is rolled back, with the reason', async () => {
    await api('PUT', `/v1/devices/${id}/layout`, { token: pub, body: pkg('classic.json', { id: 'quebrado', name: 'Teste falha-na-tv' }) });
    assert.equal((await tv.step(0)).type, 'layout');
    const d = (await api('GET', `/v1/devices/${id}`, { token: pub })).json;
    assert.equal(d.lastResult.op, 'rollback');
    assert.equal(d.lastResult.restored, 'previous');
    assert.match(d.lastResult.reason, /falhou/);
    assert.equal(d.lastResult.status.id, 'cinema');
    assert.equal((await tv.step(0)).type, 'none', 'the broken layout is not retried');
});

test('commands: reset, then rollback brings the layout back', async () => {
    let c = await api('POST', `/v1/devices/${id}/command`, { token: pub, json: { op: 'reset' } });
    assert.equal(c.status, 200);
    assert.equal((await tv.step(0)).op, 'reset');
    let d = (await api('GET', `/v1/devices/${id}`, { token: pub })).json;
    assert.equal(d.lastResult.op, 'reset');
    assert.equal(d.lastResult.status.active, false);
    assert.equal(d.lastResult.status.previous.id, 'cinema');
    c = await api('POST', `/v1/devices/${id}/command`, { token: pub, json: { op: 'rollback' } });
    assert.equal((await tv.step(0)).op, 'rollback');
    d = (await api('GET', `/v1/devices/${id}`, { token: pub })).json;
    assert.equal(d.lastResult.status.id, 'cinema');
    assert.equal((await tv.step(0)).type, 'none', 'commands run once');
    assert.equal((await api('POST', `/v1/devices/${id}/command`, { token: pub, json: { op: 'shell' } })).status, 400);
    assert.ok(d.history.length >= 6);
});

test('too many pairing attempts from one address are slowed down', async () => {
    let last;
    for (let i = 0; i < 14; i++) last = await api('POST', '/v1/pair', { json: { code: 'ZZZZ-ZZZZ' } });
    assert.equal(last.status, 429);
});

test('unpairing: the Studio can drop its access; the TV can drop everything', async () => {
    clock += 11 * 60 * 1000; // new rate-limit window (before registering: codes last 10 minutes)
    const other = new FakeCloudTv(base);
    const me = await other.register();
    const p1 = (await api('POST', '/v1/pair', { json: { code: me.pairCode, name: 'A' } })).json.publisherToken;
    const code2 = (await api('POST', '/v1/tv/pair-code', { token: other.token })).json.pairCode;
    const p2 = (await api('POST', '/v1/pair', { json: { code: code2, name: 'B' } })).json.publisherToken;
    assert.equal((await api('DELETE', `/v1/devices/${me.deviceId}/pairing`, { token: p1 })).status, 200);
    assert.equal((await api('GET', `/v1/devices/${me.deviceId}`, { token: p1 })).status, 401);
    assert.deepEqual((await api('GET', '/v1/tv/me', { token: other.token })).json.publishers, ['B']);
    assert.equal((await api('DELETE', '/v1/tv', { token: other.token })).status, 200);
    assert.equal((await api('GET', `/v1/devices/${me.deviceId}`, { token: p2 })).status, 401);
    assert.equal((await api('GET', '/v1/tv/me', { token: other.token })).status, 401);
});
