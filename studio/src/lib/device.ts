// Phase 7: talking to Fire TVs through the local bridge (tools/lib/bridge.mjs).
// The bridge lives inside the Studio's own server in development (`npm run dev`,
// `npm run desktop`); a built Studio uses the standalone one started with
// `node tools/fmtv.mjs serve` on port 5611.

export interface LayoutStatus {
    active: boolean;
    id: string;
    name: string;
    status: 'pending' | 'verified' | '';
    previous: { id: string; name: string } | null;
}

export interface Device {
    serial: string;
    state: string;
    model: string;
    label: string;
    network: boolean;
    system?: string;
    manufacturer?: string;
    app?: { versionName?: string; versionCode?: number; error?: string };
    layout?: LayoutStatus | null;
    lastOp?: { op: string; ok: boolean; time: number } | null;
}

export interface Hello {
    ok: boolean;
    adb: string | null;
    simulated?: boolean;
    error?: string;
}

/** What the TV answered: import refused, drawn and confirmed, or rolled back. */
export interface PublishResult {
    ok: boolean;
    stage?: 'import' | 'render';
    op?: string;
    error?: string;
    reason?: string;
    restored?: 'previous' | 'default';
    status?: LayoutStatus;
}

export class BridgeError extends Error {
    constructor(message: string, readonly status = 0) { super(message); }
}

const STANDALONE = 'http://127.0.0.1:5611';
let base: string | null = null;

async function req(path: string, init: RequestInit = {}): Promise<Response> {
    if (base === null) throw new BridgeError('ponte não encontrada');
    let res: Response;
    try {
        res = await fetch(base + '/api/fmtv/' + path, { ...init, headers: { 'x-fmtv-studio': '1', ...(init.headers || {}) } });
    } catch {
        base = null;
        throw new BridgeError('a ponte com a TV parou de responder');
    }
    if (!res.ok && !/ndjson/.test(res.headers.get('content-type') || '')) {
        let msg = `erro ${res.status}`;
        try { msg = (await res.json()).error || msg; } catch { /* not json */ }
        throw new BridgeError(msg, res.status);
    }
    return res;
}

const json = async <T>(path: string, init?: RequestInit): Promise<T> => (await req(path, init)).json();
const post = <T>(path: string, body: unknown) => json<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** Find the bridge: the Studio's own server first, then the standalone one. Null when there is none. */
export async function hello(): Promise<(Hello & { where: string }) | null> {
    for (const b of ['', STANDALONE]) {
        try {
            const r = await fetch(b + '/api/fmtv/hello', { headers: { 'x-fmtv-studio': '1' } });
            if (!r.ok || !/json/.test(r.headers.get('content-type') || '')) continue;
            const h = (await r.json()) as Hello;
            base = b;
            return { ...h, where: b || location.origin };
        } catch { /* try the next one */ }
    }
    base = null;
    return null;
}

export const listDevices = () => json<{ devices: Device[] }>('devices').then((r) => r.devices);
export const connect = (address: string) => post<{ serial: string; device: Device | null }>('connect', { address });
export const disconnect = (serial: string) => post<{ ok: boolean }>('disconnect', { serial });
export const scan = () => post<{ networks: string[]; found: string[] }>('scan', {});
export const rollback = (serial: string) => post<{ result: PublishResult }>('rollback', { serial }).then((r) => r.result);
export const reset = (serial: string) => post<{ result: PublishResult }>('reset', { serial }).then((r) => r.result);
export const deviceLog = (serial: string) => json<{ lines: string[] }>('log?serial=' + encodeURIComponent(serial)).then((r) => r.lines);

/** Send a .fmtv package and follow the TV's progress until it confirms (or rolls back). */
export async function publish(serial: string, bytes: Uint8Array, onLog: (m: string) => void): Promise<PublishResult> {
    const res = await req('publish?serial=' + encodeURIComponent(serial), {
        method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes.slice().buffer,
    });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (value) buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            const m = JSON.parse(line);
            if (m.type === 'log') onLog(m.message);
            else if (m.type === 'result') return m.result as PublishResult;
            else if (m.type === 'error') throw new BridgeError(m.message);
        }
        if (done) break;
    }
    throw new BridgeError('a ponte encerrou sem resposta da TV');
}

/** One line for a publish/rollback result, in the user's words. */
export function describeResult(r: PublishResult): string {
    if (r.ok && r.op === 'render') return 'aplicado e confirmado na TV';
    if (r.ok && r.op === 'rollback') return `a TV voltou para ${r.restored === 'previous' ? 'o layout anterior' : 'a tela original'}`;
    if (r.ok && r.op === 'reset') return 'a TV voltou à tela original (o layout fica guardado como anterior)';
    if (r.stage === 'import') return `a TV recusou o pacote: ${r.error || 'motivo desconhecido'}`;
    if (r.op === 'rollback') return `o layout falhou na TV e ela voltou para ${r.restored === 'previous' ? 'o layout anterior' : 'a tela original'}: ${r.reason || ''}`;
    return r.error || 'a TV não confirmou';
}
