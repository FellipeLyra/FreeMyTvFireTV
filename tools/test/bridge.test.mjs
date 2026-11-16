// The Studio's local bridge, end to end against the pretend Fire TV (fake-adb.mjs):
// security checks, device list, connecting, publishing with progress, a layout
// that fails on the TV (automatic rollback), rollback/reset and the history.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepare, buildPackage } from '../lib/package.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const fakeDir = mkdtempSync(join(tmpdir(), 'fmtv-bridge-test-'));
process.env.FAKE_ADB_DIR = fakeDir;
process.env.ADB = join(here, 'fake-adb.mjs');
const { serve } = await import('../lib/bridge.mjs');

let server, port;
before(async () => { server = await serve(0); port = server.address().port; });
after(() => { server.close(); rmSync(fakeDir, { recursive: true, force: true }); });

const SERIAL = 'G070VM2011FAKE';
const STUDIO = { 'x-fmtv-studio': '1' };

function call(method, path, { body, headers = STUDIO, host } = {}) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
        const req = request({
            host: '127.0.0.1', port, method, path: '/api/fmtv/' + path,
            headers: {
                host: host || `127.0.0.1:${port}`, ...headers,
                ...(data ? { 'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json', 'content-length': data.length } : {}),
            },
        }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { text += c; });
            res.on('end', () => {
                const lines = /ndjson/.test(res.headers['content-type'] || '') ? text.trim().split('\n').map((l) => JSON.parse(l)) : null;
                let json = null;
                try { json = lines ? null : JSON.parse(text); } catch { /* not json */ }
                resolve({ status: res.statusCode, headers: res.headers, json, lines });
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

function pkg(file, rename) {
    const { layout, files } = prepare(join(root, 'examples', 'layouts', file), join(root, 'examples', 'layouts', file.replace(/\.json$/, '') + '-assets'));
    if (rename) Object.assign(layout, rename);
    return buildPackage(layout, files);
}

test('refuses requests that do not come from the Studio', async () => {
    assert.equal((await call('GET', 'hello', { headers: {} })).status, 403, 'without X-FMTV-Studio');
    assert.equal((await call('GET', 'hello', { headers: { ...STUDIO, origin: 'https://evil.example' } })).status, 403, 'foreign origin');
    assert.equal((await call('GET', 'hello', { host: 'evil.example:5611' })).status, 403, 'DNS rebinding host');
    const pre = await call('OPTIONS', 'devices', { headers: { origin: 'https://evil.example' } });
    assert.equal(pre.status, 403, 'preflight from another site');
    const ok = await call('OPTIONS', 'devices', { headers: { origin: 'tauri://localhost' } });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers['access-control-allow-origin'], 'tauri://localhost');
    assert.equal((await call('POST', 'shell', { body: { cmd: 'rm -rf /' } })).status, 404, 'no raw adb');
});

test('hello reports the adb in use', async () => {
    const r = await call('GET', 'hello');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.simulated, true);
});

test('lists devices with model, system, app version and layout state', async () => {
    const r = await call('GET', 'devices');
    const d = r.json.devices.find((x) => x.serial === SERIAL);
    assert.ok(d, JSON.stringify(r.json));
    assert.equal(d.state, 'device');
    assert.equal(d.model, 'AFTKA');
    assert.match(d.system, /^Fire OS 8/);
    assert.equal(d.app.versionName, '1.0.0-dev.42');
    assert.equal(d.layout, null);
});

test('connects by IP, reports unauthorised TVs and refusals', async () => {
    assert.equal((await call('POST', 'connect', { body: { address: '-s; rm' } })).status, 400);
    const ok = await call('POST', 'connect', { body: { address: '192.168.0.50' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.serial, '192.168.0.50:5555');
    assert.equal(ok.json.device.network, true);
    const un = await call('POST', 'connect', { body: { address: '192.168.0.77' } });
    assert.equal(un.json.device.state, 'unauthorized');
    const no = await call('POST', 'connect', { body: { address: '10.0.0.99' } });
    assert.equal(no.status, 400);
    assert.match(no.json.error, /não foi possível conectar/);
    assert.equal((await call('POST', 'disconnect', { body: { serial: '192.168.0.77:5555' } })).status, 200);
    assert.ok(!(await call('GET', 'devices')).json.devices.some((d) => d.serial === '192.168.0.77:5555'));
});

test('publishes with progress and waits for the TV to confirm', async () => {
    const r = await call('POST', `publish?serial=${SERIAL}`, { body: pkg('cinema.json') });
    assert.equal(r.status, 200);
    const logs = r.lines.filter((l) => l.type === 'log').map((l) => l.message);
    assert.ok(logs.some((m) => /enviando/.test(m)) && logs.some((m) => /confirmar/.test(m)), logs.join(' | '));
    const result = r.lines.at(-1);
    assert.equal(result.type, 'result', JSON.stringify(r.lines));
    assert.equal(result.result.ok, true);
    assert.equal(result.result.status.id, 'cinema');
    assert.equal(result.result.status.status, 'verified');
});

test('a second publish keeps the first as "previous"', async () => {
    const r = await call('POST', `publish?serial=${SERIAL}`, { body: pkg('classic.json') });
    assert.equal(r.lines.at(-1).result.ok, true);
    const d = (await call('GET', 'devices')).json.devices.find((x) => x.serial === SERIAL);
    assert.equal(d.layout.id, 'classic');
    assert.deepEqual(d.layout.previous, { id: 'cinema', name: 'Cinema' });
});

test('a layout that fails on the TV is rolled back, and the reason comes back', async () => {
    const r = await call('POST', `publish?serial=${SERIAL}`, { body: pkg('cinema.json', { id: 'quebrado', name: 'Teste falha-na-tv' }) });
    const res = r.lines.at(-1).result;
    assert.equal(res.ok, false);
    assert.equal(res.op, 'rollback');
    assert.equal(res.restored, 'previous');
    assert.match(res.reason, /falhou/);
    assert.equal(res.status.id, 'classic');
});

test('invalid packages never reach the TV', async () => {
    const bad = await call('POST', `publish?serial=${SERIAL}`, { body: Buffer.from('not a zip') });
    assert.equal(bad.status, 400);
    const invalid = await call('POST', `publish?serial=${SERIAL}`, { body: pkg('classic.json', { schemaVersion: 99 }) });
    assert.equal(invalid.status, 400);
    assert.match(invalid.json.error, /inválido/);
    const unknown = await call('POST', 'publish?serial=NAOEXISTE', { body: pkg('classic.json') });
    assert.equal(unknown.lines.at(-1).type, 'error');
    assert.match(unknown.lines.at(-1).message, /não está na lista/);
});

test('one operation at a time per TV', async () => {
    const [a, b] = await Promise.all([
        call('POST', `publish?serial=${SERIAL}`, { body: pkg('cinema.json') }),
        (async () => { await new Promise((r) => setTimeout(r, 150)); return call('POST', 'reset', { body: { serial: SERIAL } }); })(),
    ]);
    assert.equal(a.lines.at(-1).result.ok, true);
    assert.equal(b.status, 409);
});

test('rollback, reset and the TV\'s own history', async () => {
    const rb = await call('POST', 'rollback', { body: { serial: SERIAL } });
    assert.equal(rb.json.result.restored, 'previous');
    assert.equal(rb.json.result.status.id, 'classic');
    const rs = await call('POST', 'reset', { body: { serial: SERIAL } });
    assert.equal(rs.json.result.ok, true);
    assert.equal(rs.json.result.status.active, false);
    const log = await call('GET', `log?serial=${SERIAL}`);
    const text = log.json.lines.join('\n');
    assert.match(text, /importado cinema/);
    assert.match(text, /falhou: simulação/);
    assert.match(text, /layout desativado/);
});
