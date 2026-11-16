// Phase 7: Fire TVs the Studio can publish to. Editor state only: nothing here is
// saved in the project. The chosen TV, the addresses used before and this PC's
// publish history are remembered in the browser (per-PC conveniences).
import { create } from 'zustand';
import * as D from '../lib/device';
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
    op: 'publish' | 'rollback' | 'reset' | 'connect' | 'scan';
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

    setOpen(open: boolean): void;
    refresh(): Promise<void>;
    select(serial: string): void;
    connect(address: string): Promise<void>;
    disconnect(serial: string): Promise<void>;
    scan(): Promise<void>;
    publish(serial?: string): Promise<void>;
    command(serial: string, op: 'rollback' | 'reset'): Promise<void>;
}

const KEY = 'fmtv.studio.devices';
function loadPrefs(): { selected: string | null; addresses: string[]; history: HistoryEntry[] } {
    try {
        const p = JSON.parse(localStorage.getItem(KEY) || '{}');
        return { selected: p.selected || null, addresses: Array.isArray(p.addresses) ? p.addresses.slice(0, 8) : [], history: Array.isArray(p.history) ? p.history.slice(0, 30) : [] };
    } catch {
        return { selected: null, addresses: [], history: [] };
    }
}
function savePrefs(s: Pick<DevicesState, 'selected' | 'addresses' | 'history'>) {
    try { localStorage.setItem(KEY, JSON.stringify({ selected: s.selected, addresses: s.addresses, history: s.history })); } catch { /* private window: not remembered */ }
}

/** A device that can receive a layout right now. */
export const isReady = (d?: D.Device | null) => !!d && d.state === 'device' && !!d.app?.versionName && !d.app.error;

export const useDevices = create<DevicesState>((set, get) => {
    const prefs = loadPrefs();
    const remember = (patch: Partial<DevicesState>) => { set(patch); savePrefs({ ...get(), ...patch }); };
    const labelOf = (serial: string) => get().devices.find((d) => d.serial === serial)?.label || serial;
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
        found: null,

        setOpen(open) {
            set({ open });
            if (open) get().refresh();
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
                if (!sel || !devices.some((d) => d.serial === sel)) {
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
            const finish = (ok: boolean, message: string) => {
                set({ job: { ...get().job!, done: true, ok, message } });
                addHistory({ serial, layout: name, op: 'publish', ok, message });
                ed.toast(ok ? `"${name}" está na TV (${labelOf(serial)})` : `não publicado: ${message}`, ok ? 'success' : 'error');
            };
            try {
                const pack = await buildPackage(ed.project);
                if (!pack.ok) {
                    finish(false, `o layout tem ${pack.errors.length} erro(s); veja a barra de problemas. ${pack.errors[0]?.message || ''}`);
                    return;
                }
                log(`pacote pronto (${Math.round(pack.bytes!.length / 1024)} KB)`);
                const r = await D.publish(serial, pack.bytes!, log);
                finish(r.ok, D.describeResult(r));
            } catch (e) {
                finish(false, fail(e));
            }
            get().refresh();
        },

        async command(serial, op) {
            if (get().job && !get().job!.done) return;
            set({ job: { serial, op, logs: [op === 'rollback' ? 'pedindo à TV para voltar ao layout anterior…' : 'pedindo à TV para voltar à tela original…'], done: false } });
            try {
                const r = op === 'rollback' ? await D.rollback(serial) : await D.reset(serial);
                const message = D.describeResult(r);
                set({ job: { serial, op, logs: [], done: true, ok: r.ok, message } });
                addHistory({ serial, layout: r.status?.name || '', op, ok: r.ok, message });
            } catch (e) {
                set({ job: { serial, op, logs: [], done: true, ok: false, message: fail(e) } });
            }
            get().refresh();
        },
    };
});

if (import.meta.env.DEV) (window as unknown as { __fmtvDevices: typeof useDevices }).__fmtvDevices = useDevices;
