// `fmtv check` (Phase 9): parsers for real adb outputs, and the whole check
// against the pretend Fire TVs (a 2 GB 4K Max and a 1 GB 3rd-generation stick).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../lib/check.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'fmtv.mjs');
const dir = mkdtempSync(join(tmpdir(), 'fmtv-check-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));

// The 1 GB stick joins the list in the second test: name the 4K Max everywhere else.
const run = (...args) => spawnSync(process.execPath, [cli, ...args, ...(args.includes('--device') ? [] : ['--device', 'G070VM2011FAKE'])], {
    encoding: 'utf8', env: { ...process.env, ADB: join(here, 'fake-adb.mjs'), FAKE_ADB_DIR: join(dir, 'tv') }, timeout: 120000,
});

test('parses what Fire OS prints', () => {
    assert.equal(parse.memTotalMb('MemTotal:        1968312 kB\nMemFree: 1 kB'), 1922);
    assert.equal(parse.launchMs('Status: ok\nLaunchState: COLD\nTotalTime: 1840\nWaitTime: 1862\nComplete'), 1840);
    // Android 9 meminfo (TOTAL row) and Android 11 (TOTAL PSS:)
    assert.equal(parse.pssMb('                   Pss  Private\n        TOTAL   151234   131234'), 148);
    assert.equal(parse.pssMb(' TOTAL PSS:   238,410            TOTAL RSS:   300000'), 233);
    assert.deepEqual(parse.gfx('Total frames rendered: 216\nJanky frames: 32 (14.81%)\n50th percentile: 9ms\n90th percentile: 21ms'), { frames: 216, janky: 32, jankPct: 14.81, p90: 21 });
    assert.equal(parse.gfx('nothing'), null);
});

test('a good device: everything ok, a report to paste, and the TV back as it was', () => {
    const report = join(dir, 'r.md');
    const r = run('check', '--report', report);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /tudo certo neste aparelho/);
    const md = readFileSync(report, 'utf8');
    for (const s of ['Tempo para abrir | 1,8 s', 'Memória usada | 148 MB', 'Botão Home abre o Free My TV', 'confirmado na TV', 'tela original de volta']) assert.ok(md.includes(s), s);
    const status = run('status');
    assert.match(status.stdout, /"active": false/, 'the test layout does not stay on screen');
});

test('a 1 GB stick: light mode, warnings with hints, Home button not set up', () => {
    const r = run('check', '--device', '192.168.0.50', '--json');
    const json = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'), r.stdout.lastIndexOf('}') + 1));
    const by = Object.fromEntries(json.items.map((i) => [i.id, i]));
    assert.equal(json.device.ramMb, 913);
    assert.equal(by.weak.status, 'ok');
    assert.equal(by.home.status, 'warn');
    assert.equal(by.launch.status, 'warn');
    assert.equal(by.smooth.status, 'warn');
    assert.match(by.smooth.hint, /modo leve/);
    assert.equal(by.memory.status, 'warn');
    assert.equal(by.publish.status, 'ok');
    assert.equal(r.status, 0, 'warnings are not failures');
});

test('keeps the previous layout: publish one, check, and it is still there', () => {
    const tv = { ADB: join(here, 'fake-adb.mjs'), FAKE_ADB_DIR: join(dir, 'tv') };
    const pub = spawnSync(process.execPath, [cli, 'publish', join(here, '..', '..', 'examples', 'layouts', 'streaming.json'), '--device', 'G070VM2011FAKE'], { encoding: 'utf8', env: { ...process.env, ...tv } });
    assert.equal(pub.status, 0, pub.stdout + pub.stderr);
    const r = run('check');
    assert.match(r.stdout, /layout "Streaming" de volta/);
    assert.match(run('status').stdout, /"id": "streaming"/);
});

test('installs an APK first, and explains a signature mismatch', () => {
    const good = join(dir, 'app-release.apk');
    const bad = join(dir, 'app-outra-assinatura.apk');
    writeFileSync(good, 'apk'); writeFileSync(bad, 'apk');
    assert.match(run('check', '--apk', good, '--no-publish').stdout, /Instalação do APK: instalado/);
    const r = run('check', '--apk', bad);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /INSTALL_FAILED_UPDATE_INCOMPATIBLE/);
    assert.match(run('check', '--apk', join(dir, 'nao-existe.apk')).stderr, /APK não encontrado/);
});
