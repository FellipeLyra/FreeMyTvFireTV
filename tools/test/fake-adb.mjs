#!/usr/bin/env node
// A pretend `adb` with pretend Fire TVs, for testing the publishing flow without a
// device: `ADB=tools/test/fake-adb.mjs node tools/fmtv.mjs ...` or the Studio's
// `npm run dev:fake-tv`. It answers the adb commands tools/lib/adb.mjs uses and
// behaves like the app's LayoutStore.kt: the package is checked on import
// (names, sizes, SHA-256, schema), the TV confirms the drawing a moment later,
// only a verified layout is kept as "previous", and rollback/reset work the same.
//
// Simulation hooks (never part of real layouts):
//   - a layout whose name contains "falha-na-tv" fails to render (the TV rolls back);
//   - `adb connect 192.168.0.77` gives an unauthorized device; 10.0.0.99 refuses;
//   - any other private IPv4 connects as a Fire TV Stick on port 5555.
//   - `fmtv check`: launch time, memory and frame stats come from each device's
//     "perf" entry (the 1 GB stick is slower); an APK whose name contains
//     "outra-assinatura" fails to install.
// State lives in FAKE_ADB_DIR (default: <tmp>/fmtv-fake-adb).
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync, copyFileSync, appendFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { unzip } from '../lib/package.mjs';

const PKG = 'io.github.fellipelyra.freemytv';
const EXT = `/sdcard/Android/data/${PKG}/files`;
const ROOT = process.env.FAKE_ADB_DIR || join(tmpdir(), 'fmtv-fake-adb');
const STATE = join(ROOT, 'devices.json');
const RENDER_DELAY_MS = 1200;
/** Numbers `fmtv check` reads: a 2 GB 4K Max, and a 1 GB 3rd-generation stick. */
const STRONG = { memKb: 1968312, launchMs: 1840, pssKb: 151234, jankPct: 4.2 };
const WEAK = { memKb: 934612, launchMs: 3900, pssKb: 238410, jankPct: 14.6 };

mkdirSync(ROOT, { recursive: true });
const load = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {
    devices: {
        G070VM2011FAKE: { state: 'device', model: 'AFTKA', name: 'Fire TV Stick 4K Max', system: 'Fire OS 8.1.0.3 (PS8103/3074)', android: '11', usb: true, a11y: true },
    },
});
const db = load();
const initial = JSON.stringify(db);
// Every adb call is its own process and the bridge runs some in parallel: write only real changes.
const save = () => { if (JSON.stringify(db) !== initial) writeFileSync(STATE, JSON.stringify(db, null, 2)); };
const out = (s) => process.stdout.write(s.endsWith('\n') ? s : s + '\n');
const fail = (s, code = 1) => { process.stderr.write(s + '\n'); process.exit(code); };

let args = process.argv.slice(2);
let serial = null;
if (args[0] === '-s') { serial = args[1]; args = args.slice(2); }

/* ---------------- device file system ---------------- */

const safe = (s) => s.replace(/[^A-Za-z0-9_.-]/g, '_');
const devDir = (s) => join(ROOT, safe(s));
/** Remote path → local file. Only the app's external folder is reachable, as on a real device without root. */
function local(s, remote) {
    if (!remote.startsWith(EXT + '/') && remote !== EXT) return null;
    return join(devDir(s), 'ext', remote.slice(EXT.length));
}
const store = (s, ...p) => join(devDir(s), 'int', 'layouts', ...p);

/* ---------------- the app (mirrors LayoutStore.kt) ---------------- */

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
function log(s, line) {
    const f = store(s, 'log.txt');
    mkdirSync(dirname(f), { recursive: true });
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    appendFileSync(f, `${ts} ${line}\n`);
}
function status(s) {
    const st = readJson(store(s, 'state.json')) || {};
    const prev = readJson(store(s, 'previous', 'layout.json'));
    return {
        active: existsSync(store(s, 'current', 'layout.json')), id: st.id || '', name: st.name || '', status: st.status || '',
        previous: prev ? { id: prev.id, name: prev.name } : null,
    };
}
function report(s, op, result) {
    const r = { ...result, op, status: status(s), time: Date.now(), supportedSchema: 1 };
    const outbox = local(s, `${EXT}/outbox`);
    mkdirSync(outbox, { recursive: true });
    writeFileSync(join(outbox, 'result.json'), JSON.stringify(r, null, 2));
    if (existsSync(store(s, 'log.txt'))) copyFileSync(store(s, 'log.txt'), join(outbox, 'log.txt'));
    return r;
}
function writeState(s, st) {
    mkdirSync(store(s), { recursive: true });
    if (st) writeFileSync(store(s, 'state.json'), JSON.stringify(st)); else rmSync(store(s, 'state.json'), { force: true });
}
function move(a, b) { rmSync(b, { recursive: true, force: true }); if (existsSync(a)) renameSync(a, b); }

function importFromInbox(s) {
    const pkg = local(s, `${EXT}/inbox/layout.fmtv`);
    try {
        if (!existsSync(pkg)) throw new Error('pacote não encontrado');
        const entries = unzip(readFileSync(pkg));
        const files = new Map();
        for (const e of entries) {
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
        // Promote: only a verified layout is worth keeping for rollback.
        const st = readJson(store(s, 'state.json')) || {};
        if (existsSync(store(s, 'current', 'layout.json')) && st.status === 'verified') move(store(s, 'current'), store(s, 'previous'));
        else rmSync(store(s, 'current'), { recursive: true, force: true });
        mkdirSync(store(s, 'current', 'assets'), { recursive: true });
        for (const [n, d] of files) writeFileSync(store(s, 'current', ...n.split('/')), d);
        writeState(s, { id: layout.id, name: layout.name, status: 'pending', attempts: 0 });
        log(s, `importado ${layout.id} (${layout.name})`);
        db.devices[s].pendingRender = { id: layout.id, at: Date.now() + RENDER_DELAY_MS, fail: /falha-na-tv/.test(layout.name || '') };
        report(s, 'import', { ok: true, id: layout.id, name: layout.name });
    } catch (e) {
        log(s, 'importação recusada: ' + e.message);
        report(s, 'import', { ok: false, error: e.message });
    } finally {
        rmSync(pkg, { force: true });
    }
}

function rollback(s, reason) {
    const had = existsSync(store(s, 'previous', 'layout.json'));
    rmSync(store(s, 'current'), { recursive: true, force: true });
    if (had) {
        move(store(s, 'previous'), store(s, 'current'));
        const l = readJson(store(s, 'current', 'layout.json'));
        writeState(s, { id: l.id, name: l.name, status: 'verified', attempts: 0 });
    } else writeState(s, null);
    log(s, `rollback (${reason}) → ${had ? 'layout anterior' : 'tela original'}`);
    report(s, 'rollback', { ok: true, reason, restored: had ? 'previous' : 'default' });
}

function reset(s) {
    if (existsSync(store(s, 'current', 'layout.json'))) {
        const st = readJson(store(s, 'state.json')) || {};
        if (st.status === 'verified') move(store(s, 'current'), store(s, 'previous'));
        else rmSync(store(s, 'current'), { recursive: true, force: true });
        writeState(s, null);
        log(s, 'layout desativado; tela original');
    }
    report(s, 'reset', { ok: true });
}

/** The page reports back a moment after the import (the WebView reloads and draws). */
function tick(s) {
    const p = db.devices[s]?.pendingRender;
    if (!p || Date.now() < p.at) return;
    delete db.devices[s].pendingRender;
    const st = readJson(store(s, 'state.json')) || {};
    if (st.id !== p.id || st.status !== 'pending') return;
    if (p.fail) { rollback(s, `o layout ${p.id} falhou: simulação de falha na TV`); return; }
    writeState(s, { ...st, status: 'verified', attempts: 0 });
    log(s, `layout ${p.id} confirmado na tela`);
    report(s, 'render', { ok: true, id: p.id });
}

/* ---------------- adb commands ---------------- */

function pickDevice() {
    const online = Object.entries(db.devices).filter(([, d]) => d.state !== 'gone');
    if (serial) {
        const d = db.devices[serial];
        if (!d || d.state === 'gone') fail(`adb: device '${serial}' not found`);
        return serial;
    }
    if (online.length !== 1) fail(online.length ? 'adb: more than one device/emulator' : 'adb: no devices/emulators found');
    return online[0][0];
}

const cmd = args[0];
if (cmd === 'devices') {
    out('List of devices attached');
    for (const [s, d] of Object.entries(db.devices)) {
        if (d.state === 'gone') continue;
        out(d.state === 'device' ? `${s}\tdevice product:${d.model.toLowerCase()} model:${d.model} device:${d.model.toLowerCase()} transport_id:1` : `${s}\t${d.state} transport_id:1`);
    }
    out('');
} else if (cmd === 'connect') {
    const target = args[1] || '';
    const host = target.split(':')[0];
    if (host === '10.0.0.99') { out(`failed to connect to '${target}': Connection refused`); }
    else if (!/^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(host)) { out(`failed to connect to '${target}': No route to host`); }
    else {
        const was = db.devices[target];
        db.devices[target] = host === '192.168.0.77'
            ? { state: 'unauthorized', model: 'AFTSSS', name: 'Fire TV Stick', system: '', android: '' }
            : { state: 'device', model: 'AFTSSS', name: 'Fire TV Stick (3ª geração)', system: 'Fire OS 7.6.6.9 (RS8146/4566)', android: '9', perf: WEAK, ...(was && was.state !== 'gone' ? was : {}) };
        out(was && was.state !== 'gone' ? `already connected to ${target}` : `connected to ${target}`);
        save();
    }
} else if (cmd === 'disconnect') {
    const d = db.devices[args[1]];
    if (d && !d.usb) { d.state = 'gone'; save(); out(`disconnected ${args[1]}`); } else out(`error: no such device '${args[1]}'`);
} else if (cmd === 'install') {
    const s = pickDevice();
    const apk = args[args.length - 1];
    if (!existsSync(apk)) fail(`adb: failed to stat ${apk}: No such file or directory`);
    if (/outra-assinatura/.test(apk)) { out('Performing Streamed Install'); out(`adb: failed to install ${apk}: Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package ${PKG} signatures do not match newer version; ignoring!]`); process.exit(1); }
    db.devices[s].app = true;
    out('Performing Streamed Install'); out('Success');
    save();
} else if (cmd === 'push') {
    const s = pickDevice();
    const dest = local(s, args[2]);
    if (!dest) fail(`adb: error: failed to copy '${args[1]}' to '${args[2]}': remote Permission denied`);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(args[1], dest);
    out(`${args[1]}: 1 file pushed, 0 skipped. ${(statSync(dest).size / 1024).toFixed(1)} KB/s`);
} else if (cmd === 'shell') {
    const s = pickDevice();
    const d = db.devices[s];
    if (d.state !== 'device') fail(`adb: device ${d.state}`);
    tick(s);
    const [sub, ...rest] = args.slice(1);
    const app = d.app !== false;
    if (sub === 'pm' && rest[0] === 'list') { if (app) out(`package:${PKG}`); }
    else if (sub === 'cat' && rest[0] === '/proc/meminfo') out(`MemTotal:        ${(d.perf || STRONG).memKb} kB
MemFree:          212340 kB`);
    else if (sub === 'settings' && rest.join(' ') === 'get secure enabled_accessibility_services') out(d.a11y && app ? `${PKG}/${PKG}.HomeButtonService` : 'null');
    else if (sub === 'am' && rest[0] === 'force-stop') { /* nothing to stop */ }
    else if (sub === 'input' && rest[0] === 'keyevent') { d.keys = (d.keys || 0) + rest.length - 1; }
    else if (sub === 'dumpsys' && rest[0] === 'gfxinfo') {
        if (rest[2] === 'reset') d.keys = 0;
        else {
            const p = d.perf || STRONG;
            const frames = (d.keys || 0) * 18;
            const janky = Math.round(frames * p.jankPct / 100);
            out(`Applications Graphics Acceleration Info:
Stats since: 1234ns
Total frames rendered: ${frames}
Janky frames: ${janky} (${frames ? (janky / frames * 100).toFixed(2) : '0.00'}%)
50th percentile: 9ms
90th percentile: ${p.jankPct > 10 ? 21 : 13}ms
95th percentile: ${p.jankPct > 10 ? 34 : 17}ms`);
        }
    } else if (sub === 'dumpsys' && rest[0] === 'meminfo') {
        const p = d.perf || STRONG;
        out(`Applications Memory Usage (in Kilobytes):
** MEMINFO in pid 4242 [${PKG}] **
                   Pss  Private
        TOTAL   ${p.pssKb}   ${p.pssKb - 20000}
 TOTAL PSS:   ${p.pssKb}            TOTAL RSS:   ${p.pssKb + 60000}`);
    }
    else if (sub === 'dumpsys') { if (app) out(`Packages:\n  Package [${PKG}]\n    versionCode=42 minSdk=22 targetSdk=34\n    versionName=1.0.0-dev.42`); }
    else if (sub === 'getprop') out([`[ro.product.model]: [${d.model}]`, '[ro.product.manufacturer]: [Amazon]', `[ro.build.version.name]: [${d.system}]`, `[ro.build.version.release]: [${d.android}]`].join('\n'));
    else if (sub === 'cat') {
        const f = local(s, rest[0]);
        if (!f || !existsSync(f)) out(`cat: ${rest[0]}: No such file or directory`); else process.stdout.write(readFileSync(f));
    } else if (sub === 'rm') { const f = local(s, rest[rest.length - 1]); if (f) rmSync(f, { force: true }); }
    else if (sub === 'mkdir') { const f = local(s, rest[rest.length - 1]); if (f) mkdirSync(f, { recursive: true }); }
    else if (sub === 'am' && rest[0] === 'start') {
        if (!app) fail('Error: Activity not started, unable to resolve Intent');
        const ai = rest.indexOf('-a');
        const action = ai >= 0 ? rest[ai + 1] : 'android.intent.action.MAIN';
        out('Starting: Intent { act=' + action + ' }');
        if (rest.includes('-W')) { const t = (d.perf || STRONG).launchMs; out(`Status: ok
LaunchState: COLD
Activity: ${PKG}/.MainActivity
TotalTime: ${t}
WaitTime: ${t + 22}
Complete`); }
        if (action.endsWith('IMPORT_LAYOUT')) importFromInbox(s);
        else if (action.endsWith('ROLLBACK_LAYOUT')) rollback(s, 'pedido pelo Studio');
        else if (action.endsWith('RESET_LAYOUT')) reset(s);
    } else fail(`fake-adb: comando não simulado: shell ${sub}`);
    save();
} else {
    fail(`fake-adb: comando não simulado: ${args.join(' ')}`);
}
