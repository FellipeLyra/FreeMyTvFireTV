// Publishing layouts to a Fire TV over ADB. Uses only standard adb commands:
// devices / connect / push / shell am start / shell cat. No root, no settings
// changed on the device.
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
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

export function findAdb() {
    const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
    const candidates = [
        process.env.ADB,
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

export class AdbError extends Error {}

export class Adb {
    constructor({ adb = findAdb(), serial = null, log = () => {} } = {}) {
        this.adb = adb;
        this.serial = serial;
        this.log = log;
    }

    run(args, { allowFail = false, timeout = 30000 } = {}) {
        const full = this.serial ? ['-s', this.serial, ...args] : args;
        const r = spawnSync(this.adb, full, { encoding: 'utf8', timeout });
        if (r.error) throw new AdbError(`adb falhou: ${r.error.message}`);
        const out = (r.stdout || '') + (r.stderr || '');
        if (r.status !== 0 && !allowFail) throw new AdbError(`adb ${args.join(' ')}: ${out.trim()}`);
        return out;
    }

    /** [{serial, state, model}] */
    devices() {
        const out = new Adb({ adb: this.adb }).run(['devices', '-l']);
        return out.split(/\r?\n/).slice(1).filter((l) => l.trim()).map((l) => {
            const [serial, state] = l.trim().split(/\s+/);
            const model = (/model:(\S+)/.exec(l) || [])[1] || '';
            return { serial, state, model };
        });
    }

    connect(address) {
        const target = address.includes(':') ? address : `${address}:5555`;
        const out = new Adb({ adb: this.adb }).run(['connect', target], { allowFail: true });
        if (!/connected to/.test(out)) throw new AdbError(`não foi possível conectar em ${target}: ${out.trim()}`);
        return target;
    }

    /** Choose the device: the given serial, or the only one connected. */
    select(serial) {
        const list = this.devices();
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

    appVersion() {
        const listed = this.run(['shell', 'pm', 'list', 'packages', PKG], { allowFail: true });
        if (!listed.split(/\r?\n/).some((l) => l.trim() === `package:${PKG}`)) {
            throw new AdbError('o Free My TV não está instalado neste aparelho.');
        }
        const dump = this.run(['shell', 'dumpsys', 'package', PKG], { allowFail: true });
        return {
            versionName: (/versionName=(\S+)/.exec(dump) || [])[1] || '?',
            versionCode: Number((/versionCode=(\d+)/.exec(dump) || [])[1] || 0),
        };
    }

    readResult() {
        const out = this.run(['shell', 'cat', RESULT], { allowFail: true });
        try { return JSON.parse(out); } catch { return null; }
    }

    startAction(action) {
        this.run(['shell', 'rm', '-f', RESULT], { allowFail: true });
        this.run(['shell', 'am', 'start', '-n', ACTIVITY, '-a', action]);
    }

    /**
     * Wait for outbox/result.json with one of `ops`. startAction() deletes the
     * file first, so whatever appears is the answer to this command (the TV's
     * clock is not compared with the PC's).
     */
    async waitResult(ops, timeoutMs) {
        const end = Date.now() + timeoutMs;
        while (Date.now() < end) {
            const r = this.readResult();
            if (r && ops.includes(r.op)) return r;
            await new Promise((res) => setTimeout(res, 700));
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
            this.run(['shell', 'mkdir', '-p', `${FILES}/inbox`], { allowFail: true });
            this.run(['push', local, INBOX], { timeout: 120000 });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
        this.log('pedindo ao Free My TV para importar…');
        this.startAction(ACTIONS.import);
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
        this.startAction(ACTIONS[kind]);
        return await this.waitResult([kind], 15000);
    }
}
