// Phase 7: Fire TVs the Studio can publish to. Editor state only: nothing here is
// saved in the project. The chosen TV, the addresses used before and this PC's
// publish history are remembered in the browser (per-PC conveniences).
import { create } from 'zustand';
import * as D from '../lib/device';
import * as C from '../lib/cloud';
import { buildPackage } from '../lib/pack';
import { useEditor } from './editor';

export interface HistoryEntry {
    time: number;
    serial: string;
    device: string;
    layout: string;
    op: 'publish' | 'rollback' | 'reset';
    ok: boolean;
    message: string;
}

export interface Job {
    serial: string;
    op: 'publish' | 'rollback' | 'reset' | 'connect' | 'scan' | 'pair' | 'check';
    logs: string[];
    done: boolean;
    ok?: boolean;
    /** Not an error: something the person has to do (accept the prompt on the TV). */
    warn?: boolean;
    message?: string;
}

interface DevicesState {
    open: boolean;
    bridge: (D.Hello & { where: string }) | null | 'checking';
    devices: D.Device[];
    loading: boolean;
    error: string | null;
    selected: string | null;
    addresses: string[];
    history: HistoryEntry[];
    job: Job | null;
    found: string[] | null;
    /** Phase 9: last device test, shown under that device. */
    report: { serial: string; result: D.CheckReport } | null;
    /** Phase 8: TVs paired through a Free My TV Cloud server (selected as "cloud:<id>"). */
    cloud: C.CloudTarget[];
    cloudServer: string;
    cloudDevices: Record<string, C.CloudDevice | { error: string }>;

    setOpen(open: boolean): void;
    refresh(): Promise<void>;
    select(serial: string): void;
    connect(address: string): Promise<void>;
    disconnect(serial: string): Promise<void>;
    scan(): Promise<void>;
    publish(serial?: string): Promise<void>;
    command(serial: string, op: 'rollback' | 'reset'): Promise<void>;
    check(serial: string): Promise<void>;
    refreshCloud(): Promise<void>;
    pairCloud(server: string, code: string): Promise<void>;
    unpairCloud(deviceId: string): Promise<void>;
}

export const CLOUD = 'cloud:';
export const isCloud = (key: string | null | undefined) => !!key && key.startsWith(CLOUD);

const KEY = 'fmtv.studio.devices';
type Prefs = Pick<DevicesState, 'selected' | 'addresses' | 'history' | 'cloud' | 'cloudServer'>;
// The cloud tokens are kept here too: they open one TV each and can be revoked from
// the TV or the Studio ("Remover"). They never go into the project file.
function loadPrefs(): Prefs {
    try {
        const p = JSON.parse(localStorage.getItem(KEY) || '{}');
        return {
            selected: p.selected || null,
            addresses: Array.isArray(p.addresses) ? p.addresses.slice(0, 8) : [],
            history: Array.isArray(p.history) ? p.history.slice(0, 30) : [],
            cloud: Array.isArray(p.cloud) ? p.cloud.filter((t: C.CloudTarget) => t && t.server && t.deviceId && t.token) : [],
            cloudServer: typeof p.cloudServer === 'string' ? p.cloudServer : '',
        };
    } catch {
        return { selected: null, addresses: [], history: [], cloud: [], cloudServer: '' };
    }
}
function savePrefs(s: Prefs) {
    try {
        localStorage.setItem(KEY, JSON.stringify({ selected: s.selected, addresses: s.addresses, history: s.history, cloud: s.cloud, cloudServer: s.cloudServer }));
    } catch { /* private window: not remembered */ }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A device that can receive a layout right now. */
export const isReady = (d?: D.Device | null) => !!d && d.state === 'device' && !!d.app?.versionName && !d.app.error;

export const useDevices = create<DevicesState>((set, get) => {
    const prefs = loadPrefs();
    const remember = (patch: Partial<DevicesState>) => { set(patch); savePrefs({ ...get(), ...patch }); };
    const target = (key: string) => get().cloud.find((t) => CLOUD + t.deviceId === key) || null;
    const labelOf = (serial: string) => target(serial)?.label || get().devices.find((d) => d.serial === serial)?.label || serial;
    const setCloud = (id: string, v: C.CloudDevice | { error: string }) => set({ cloudDevices: { ...get().cloudDevices, [id]: v } });
    const addHistory = (e: Omit<HistoryEntry, 'time' | 'device'>) =>
        remember({ history: [{ ...e, time: Date.now(), device: labelOf(e.serial) }, ...get().history].slice(0, 30) });
    const fail = (e: unknown) => (e instanceof Error ? e.message : String(e));

    return {
        open: false,
        bridge: 'checking',
        devices: [],
        loading: false,
        error: null,
        ...prefs,
        job: null,
        report: null,
        found: null,
        cloudDevices: {},

        setOpen(open) {
            set({ open });
            if (open) { get().refresh(); get().refreshCloud(); }
        },

        async refreshCloud() {
            await Promise.all(get().cloud.map(async (t) => {
                try { setCloud(t.deviceId, await C.getDevice(t)); } catch (e) {
                    setCloud(t.deviceId, { error: e instanceof C.CloudError && e.status === 401 ? 'esta TV foi despareada: pareie de novo com o código que aparece nela' : fail(e) });
                }
            }));
        },

        async pairCloud(server, code) {
            set({ job: { serial: '', op: 'pair', logs: ['falando com o servidor…'], done: false } });
            try {
                const r = await C.pair(server, code, 'Free My TV Studio');
                const others = get().cloud.filter((t) => t.deviceId !== r.target.deviceId);
                remember({ cloud: [...others, r.target], cloudServer: r.target.server, selected: CLOUD + r.target.deviceId });
                setCloud(r.target.deviceId, r.device);
                set({ job: { serial: CLOUD + r.target.deviceId, op: 'pair', logs: [], done: true, ok: true, message: `pareado com ${r.target.label}. A TV recebe os layouts enquanto a tela inicial do Free My TV estiver aberta.` } });
            } catch (e) {
                set({ job: { serial: '', op: 'pair', logs: [], done: true, ok: false, message: fail(e) } });
            }
        },

        async unpairCloud(deviceId) {
            const t = get().cloud.find((x) => x.deviceId === deviceId);
            if (t) { try { await C.unpair(t); } catch { /* already gone on the server */ } }
            const cloudDevices = { ...get().cloudDevices };
            delete cloudDevices[deviceId];
            set({ cloudDevices });
            remember({ cloud: get().cloud.filter((x) => x.deviceId !== deviceId), selected: get().selected === CLOUD + deviceId ? null : get().selected });
        },

        async refresh() {
            set({ loading: true, error: null });
            try {
                const bridge = await D.hello();
                set({ bridge });
                if (!bridge || !bridge.ok) { set({ devices: [] }); return; }
                const devices = await D.listDevices();
                set({ devices });
                // Keep the choice; pick the only ready TV when there is no choice yet.
                const sel = get().selected;
                if (!sel || (!isCloud(sel) && !devices.some((d) => d.serial === sel))) {
                    const ready = devices.filter(isReady);
                    if (ready.length === 1) remember({ selected: ready[0].serial });
                }
            } catch (e) {
                set({ error: fail(e) });
            } finally {
                set({ loading: false });
            }
        },

        select(serial) { remember({ selected: serial }); },

        async connect(address) {
            const a = address.trim();
            if (!a) return;
            set({ job: { serial: a, op: 'connect', logs: [`conectando em ${a}…`], done: false }, error: null });
            try {
                const r = await D.connect(a);
                const host = a.replace(/:5555$/, '');
                remember({ addresses: [host, ...get().addresses.filter((x) => x !== host)].slice(0, 8) });
                await get().refresh();
                const d = r.device;
                const msg = d?.state === 'unauthorized'
                    ? 'A TV pediu autorização: aceite "Permitir depuração" na tela da TV (marque "Sempre permitir") e clique em Atualizar.'
                    : `conectado em ${r.serial}`;
                if (d && isReady(d)) remember({ selected: d.serial });
                set({ job: { serial: r.serial, op: 'connect', logs: [], done: true, ok: d?.state !== 'unauthorized', warn: d?.state === 'unauthorized', message: msg } });
            } catch (e) {
                set({ job: { serial: a, op: 'connect', logs: [], done: true, ok: false, message: fail(e) } });
            }
        },

        async disconnect(serial) {
            try { await D.disconnect(serial); } catch (e) { set({ error: fail(e) }); }
            if (get().selected === serial) remember({ selected: null });
            await get().refresh();
        },

        async scan() {
            set({ job: { serial: '', op: 'scan', logs: ['procurando aparelhos com a depuração ADB ligada nesta rede…'], done: false }, found: null });
            try {
                const r = await D.scan();
                const known = new Set(get().devices.map((d) => d.serial));
                const found = r.found.filter((f) => !known.has(f));
                set({
                    found,
                    job: {
                        serial: '', op: 'scan', logs: [], done: true, ok: true,
                        message: r.networks.length
                            ? `${found.length ? `${found.length} aparelho(s) novo(s)` : 'nenhum aparelho novo'} em ${r.networks.join(', ')}`
                            : 'este PC não está numa rede local (Wi-Fi ou cabo)',
                    },
                });
            } catch (e) {
                set({ job: { serial: '', op: 'scan', logs: [], done: true, ok: false, message: fail(e) } });
            }
        },

        async publish(serial = get().selected || undefined) {
            const ed = useEditor.getState();
            if (!serial) { set({ open: true }); get().refresh(); return; }
            if (get().job && !get().job!.done) return;
            const name = ed.project.layout.name;
            set({ open: true, job: { serial, op: 'publish', logs: ['montando o pacote (.fmtv)…'], done: false } });
            const log = (m: string) => { const j = get().job; if (j) set({ job: { ...j, logs: [...j.logs, m] } }); };
            const finish = (ok: boolean, message: string, warn = false) => {
                set({ job: { ...get().job!, done: true, ok, warn, message } });
                addHistory({ serial, layout: name, op: 'publish', ok, message });
                ed.toast(ok ? `"${name}" está na TV (${labelOf(serial)})` : warn ? message : `não publicado: ${message}`, ok ? 'success' : warn ? 'info' : 'error');
            };
            try {
                const pack = await buildPackage(ed.project);
                if (!pack.ok) {
                    finish(false, `o layout tem ${pack.errors.length} erro(s); veja a barra de problemas. ${pack.errors[0]?.message || ''}`);
                    return;
                }
                log(`pacote pronto (${Math.round(pack.bytes!.length / 1024)} KB)`);
                const t = target(serial);
                if (t) {
                    const r = await publishCloud(t, pack.bytes!, log);
                    finish(r.ok, r.message, r.warn);
                } else {
                    const r = await D.publish(serial, pack.bytes!, log);
                    finish(r.ok, D.describeResult(r));
                }
            } catch (e) {
                finish(false, fail(e));
            }
            if (isCloud(serial)) get().refreshCloud(); else get().refresh();
        },

        async check(serial) {
            if (get().job && !get().job!.done) return;
            set({ report: null, job: { serial, op: 'check', logs: ['testando o aparelho (leva uns 30 segundos; a TV abre o Free My TV e o foco anda sozinho)…'], done: false } });
            const log = (m: string) => { const j = get().job; if (j) set({ job: { ...j, logs: [...j.logs, m] } }); };
            try {
                const result = await D.checkDevice(serial, log);
                const fails = result.items.filter((i) => i.status === 'fail').length;
                const warns = result.items.filter((i) => i.status === 'warn').length;
                set({
                    report: { serial, result },
                    job: { serial, op: 'check', logs: [], done: true, ok: !fails && !warns, warn: !fails && !!warns,
                        message: fails ? `${fails} problema(s) no teste` : warns ? `funcionou, com ${warns} aviso(s)` : 'tudo certo neste aparelho' },
                });
            } catch (e) {
                set({ job: { serial, op: 'check', logs: [], done: true, ok: false, message: fail(e) } });
            }
            get().refresh();
        },

        async command(serial, op) {
            if (get().job && !get().job!.done) return;
            set({ job: { serial, op, logs: [op === 'rollback' ? 'pedindo à TV para voltar ao layout anterior…' : 'pedindo à TV para voltar à tela original…'], done: false } });
            try {
                const t = target(serial);
                if (t) {
                    const r = await commandCloud(t, op);
                    set({ job: { serial, op, logs: [], done: true, ok: r.ok, warn: r.warn, message: r.message } });
                    addHistory({ serial, layout: r.layout, op, ok: r.ok, message: r.message });
                } else {
                    const r = op === 'rollback' ? await D.rollback(serial) : await D.reset(serial);
                    const message = D.describeResult(r);
                    set({ job: { serial, op, logs: [], done: true, ok: r.ok, message } });
                    addHistory({ serial, layout: r.status?.name || '', op, ok: r.ok, message });
                }
            } catch (e) {
                set({ job: { serial, op, logs: [], done: true, ok: false, message: fail(e) } });
            }
            if (isCloud(serial)) get().refreshCloud(); else get().refresh();
        },
    };
});

/**
 * Upload to the server, then follow what the TV reports. A TV that is not showing the
 * home screen fetches it later: that is not an error.
 */
async function publishCloud(t: C.CloudTarget, bytes: Uint8Array, log: (m: string) => void): Promise<{ ok: boolean; warn?: boolean; message: string }> {
    log('enviando ao servidor…');
    const up = await C.upload(t, bytes);
    log('o servidor conferiu e guardou o layout');
    if (!up.device.online) {
        return { ok: false, warn: true, message: `a TV não está conectada agora (vista ${C.seen(up.device.lastSeen)}). O servidor guardou o layout: ela aplica assim que a tela inicial do Free My TV abrir.` };
    }
    log('esperando a TV buscar, aplicar e confirmar…');
    let said = false;
    for (let i = 0; i < 45; i++) {
        await sleep(800);
        const d = await C.getDevice(t);
        const r = d.lastResult;
        if (r && r.etag === up.etag) {
            if (r.op === 'import' && r.ok) { if (!said) { log('a TV importou; esperando ela desenhar…'); said = true; } continue; }
            return { ok: r.ok && r.op === 'render', message: C.describe(r) };
        }
    }
    return { ok: false, warn: true, message: 'a TV ainda não confirmou. O layout está no servidor e a TV aplica quando a tela inicial estiver aberta; acompanhe pelo histórico.' };
}

async function commandCloud(t: C.CloudTarget, op: 'rollback' | 'reset'): Promise<{ ok: boolean; warn?: boolean; message: string; layout: string }> {
    const c = await C.command(t, op);
    if (!c.device.online) return { ok: false, warn: true, layout: '', message: 'a TV não está conectada agora: o pedido fica no servidor e ela executa quando a tela inicial abrir.' };
    for (let i = 0; i < 25; i++) {
        await sleep(800);
        const r = (await C.getDevice(t)).lastResult;
        if (r && r.cmd === c.command.id) return { ok: r.ok, message: C.describe(r), layout: r.status?.name || '' };
    }
    return { ok: false, warn: true, layout: '', message: 'a TV ainda não respondeu; ela executa o pedido quando a tela inicial estiver aberta.' };
}

if (import.meta.env.DEV) (window as unknown as { __fmtvDevices: typeof useDevices }).__fmtvDevices = useDevices;
