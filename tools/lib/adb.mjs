// Publishing layouts to a Fire TV over ADB. Uses only standard adb commands:
// devices / connect / push / shell am start / shell cat. No root, no settings
// changed on the device. Shared by the CLI (tools/fmtv.mjs) and the Studio's
// local bridge (tools/lib/bridge.mjs); everything is asynchronous so the bridge
// keeps serving while a package is being pushed.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';

export const PKG = 'io.github.fellipelyra.freemytv';
export const ACTIVITY = `${PKG}/.MainActivity`;
export const ACTIONS = {
    import: `${PKG}.action.IMPORT_LAYOUT`,
    rollback: `${PKG}.action.ROLLBACK_LAYOUT`,
    reset: `${PKG}.action.RESET_LAYOUT`,
};
const FILES = `/sdcard/Android/data/${PKG}/files`;
const INBOX = `${FILES}/inbox/layout.fmtv`;
const RESULT = `${FILES}/outbox/result.json`;
const LOG = `${FILES}/outbox/log.txt`;

export class AdbError extends Error {}

export function findAdb() {
    const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
    const candidates = [
        process.env.ADB,
        // The desktop Studio's bundled fmtv.exe keeps adb in an "adb" folder next to it.
        join(dirname(process.execPath), 'adb', exe),
        process.env.ANDROID_HOME && join(process.env.ANDROID_HOME, 'platform-tools', exe),
        process.env.ANDROID_SDK_ROOT && join(process.env.ANDROID_SDK_ROOT, 'platform-tools', exe),
        join(homedir(), 'android-build-tools', 'sdk', 'platform-tools', exe),
        process.platform === 'win32' && process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', exe),
    ].filter(Boolean);
    for (const c of candidates) if (existsSync(c)) return c;
    const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['adb'], { encoding: 'utf8' });
    if (which.status === 0) return which.stdout.split(/\r?\n/)[0].trim();
    throw new AdbError('adb não encontrado. Instale o Android platform-tools ou defina a variável ADB.');
}

/** Run adb (or, for tests, an adb simulator written in JavaScript). */
function exec(adb, args, timeout) {
    const [cmd, pre] = /\.m?js$/i.test(adb) ? [process.execPath, [adb]] : [adb, []];
    return new Promise((resolve, reject) => {
        const p = spawn(cmd, [...pre, ...args], { windowsHide: true });
        let out = '';
        const timer = setTimeout(() => { p.kill(); reject(new AdbError(`adb ${args[0]} não respondeu em ${Math.round(timeout / 1000)} s`)); }, timeout);
        p.stdout.on('data', (d) => { out += d; });
        p.stderr.on('data', (d) => { out += d; });
        p.on('error', (e) => { clearTimeout(timer); reject(new AdbError(`adb falhou: ${e.message}`)); });
        p.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Adb {
    constructor({ adb = findAdb(), serial = null, log = () => {} } = {}) {
        this.adb = adb;
        this.serial = serial;
        this.log = log;
    }

    async run(args, { allowFail = false, timeout = 30000 } = {}) {
        const full = this.serial ? ['-s', this.serial, ...args] : args;
        const { code, out } = await exec(this.adb, full, timeout);
        if (code !== 0 && !allowFail) throw new AdbError(`adb ${args.join(' ')}: ${out.trim()}`);
        return out;
    }

    /** [{serial, state, model}] */
    async devices() {
        const out = await new Adb({ adb: this.adb }).run(['devices', '-l']);
        // Only "serial  state ..." lines: adb may print "* daemon started" or warnings first.
        const STATES = /^\S+\s+(device|unauthorized|offline|authorizing|connecting|no permissions|recovery|sideload|bootloader|host|unknown)\b/;
        return out.split(/\r?\n/).filter((l) => STATES.test(l.trim())).map((l) => {
            const [serial, state] = l.trim().split(/\s+/);
            const model = (/model:(\S+)/.exec(l) || [])[1] || '';
            return { serial, state, model: model.replace(/_/g, ' ') };
        });
    }

    async connect(address) {
        const target = address.includes(':') ? address : `${address}:5555`;
        const hint = 'Confira se o Fire TV está ligado, na mesma rede deste PC e com a Depuração ADB ativada.';
        let out;
        try {
            out = await new Adb({ adb: this.adb }).run(['connect', target], { allowFail: true, timeout: 15000 });
        } catch (e) {
            throw new AdbError(`${target} não respondeu. ${hint}`);
        }
        if (!/connected to/.test(out)) throw new AdbError(`não foi possível conectar em ${target}: ${out.trim()}. ${hint}`);
        return target;
    }

    async disconnect(address) {
        await new Adb({ adb: this.adb }).run(['disconnect', address], { allowFail: true, timeout: 10000 });
    }

    /** Choose the device: the given serial, or the only one connected. */
    async select(serial) {
        const list = await this.devices();
        const pick = serial ? list.find((d) => d.serial === serial) : null;
        if (serial && !pick) throw new AdbError(`dispositivo ${serial} não está na lista do adb`);
        const ready = pick ? [pick] : list;
        if (!ready.length) throw new AdbError('nenhum dispositivo. Ative a Depuração ADB no Fire TV e use --device IP.');
        if (ready.length > 1) throw new AdbError(`há ${ready.length} dispositivos; escolha um com --device (${ready.map((d) => d.serial).join(', ')})`);
        const d = ready[0];
        if (d.state === 'unauthorized') throw new AdbError(`${d.serial} não autorizou este PC. Aceite o pedido de depuração que apareceu na TV e tente de novo.`);
        if (d.state !== 'device') throw new AdbError(`${d.serial} está "${d.state}"`);
        this.serial = d.serial;
        return d;
    }

    /** Version of Free My TV on the device; throws when it is not installed. */
    async appVersion() {
        const listed = await this.run(['shell', 'pm', 'list', 'packages', PKG], { allowFail: true });
        if (!listed.split(/\r?\n/).some((l) => l.trim() === `package:${PKG}`)) {
            throw new AdbError('o Free My TV não está instalado neste aparelho.');
        }
        const dump = await this.run(['shell', 'dumpsys', 'package', PKG], { allowFail: true });
        return {
            versionName: (/versionName=(\S+)/.exec(dump) || [])[1] || '?',
            versionCode: Number((/versionCode=(\d+)/.exec(dump) || [])[1] || 0),
        };
    }

    /** Model and system version (Fire OS names itself in ro.build.version.name). */
    async systemInfo() {
        const out = await this.run(['shell', 'getprop'], { allowFail: true, timeout: 10000 });
        const prop = (k) => (new RegExp(`\\[${k.replace(/\./g, '\\.')}\\]: \\[([^\\]]*)\\]`).exec(out) || [])[1] || '';
        return {
            model: prop('ro.product.model'),
            manufacturer: prop('ro.product.manufacturer'),
            system: prop('ro.build.version.name') || (prop('ro.build.version.release') ? `Android ${prop('ro.build.version.release')}` : ''),
            android: prop('ro.build.version.release'),
        };
    }

    async readResult() {
        const out = await this.run(['shell', 'cat', RESULT], { allowFail: true });
        try { return JSON.parse(out); } catch { return null; }
    }

    /** The device's own history of imports, confirmations and rollbacks (newest last). */
    async readLog() {
        const out = await this.run(['shell', 'cat', LOG], { allowFail: true });
        if (/No such file|does not exist/i.test(out)) return [];
        return out.split(/\r?\n/).filter((l) => /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d /.test(l));
    }

    async startAction(action) {
        await this.run(['shell', 'rm', '-f', RESULT], { allowFail: true });
        await this.run(['shell', 'am', 'start', '-n', ACTIVITY, '-a', action]);
    }

    /**
     * Wait for outbox/result.json with one of `ops`. startAction() deletes the
     * file first, so whatever appears is the answer to this command (the TV's
     * clock is not compared with the PC's).
     */
    async waitResult(ops, timeoutMs) {
        const end = Date.now() + timeoutMs;
        while (Date.now() < end) {
            const r = await this.readResult();
            if (r && ops.includes(r.op)) return r;
            await sleep(700);
        }
        return null;
    }

    /** Push a package, import it, and wait until the TV confirms or rolls it back. */
    async publish(pkgBytes, { renderTimeout = 25000 } = {}) {
        const dir = mkdtempSync(join(tmpdir(), 'fmtv-'));
        const local = join(dir, 'layout.fmtv');
        try {
            writeFileSync(local, pkgBytes);
            this.log('enviando o pacote…');
            await this.run(['shell', 'mkdir', '-p', `${FILES}/inbox`], { allowFail: true });
            await this.run(['push', local, INBOX], { timeout: 120000 });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
        this.log('pedindo ao Free My TV para importar…');
        await this.startAction(ACTIONS.import);
        // The render report can overwrite the import report quickly, so accept any of them.
        const first = await this.waitResult(['import', 'render', 'rollback'], 15000);
        if (!first) throw new AdbError('o aparelho não respondeu à importação (o app abriu?).');
        if (first.op === 'import' && !first.ok) return { stage: 'import', ...first };
        if (first.op !== 'import') return { stage: 'render', ...first, ok: first.op === 'render' };
        const imported = first;
        this.log('importado; esperando a TV confirmar que desenhou o layout…');
        const rendered = await this.waitResult(['render', 'rollback'], renderTimeout);
        if (!rendered) return { stage: 'render', ok: false, error: 'sem confirmação da TV dentro do prazo; o app volta ao layout anterior se ele não renderizar', imported };
        return { stage: 'render', ...rendered, ok: rendered.op === 'render' };
    }

    async command(kind) {
        await this.startAction(ACTIONS[kind]);
        return await this.waitResult([kind], 15000);
    }
}
