// Phase 8: the Studio side of Free My TV Cloud (server/fmtv-cloud.mjs). The Studio
// talks to the server directly; each paired TV gives this Studio its own token.
import type { LayoutStatus } from './device';

export interface CloudTarget {
    server: string;
    deviceId: string;
    token: string;
    label: string;
}

export interface CloudResult {
    op: string;
    ok: boolean;
    error?: string;
    reason?: string;
    restored?: 'previous' | 'default';
    etag?: string;
    cmd?: number;
    status?: LayoutStatus;
    at: number;
}

export interface CloudDevice {
    id: string;
    model: string;
    name: string;
    appVersion: string;
    lastSeen: number | null;
    online: boolean;
    pending: { etag: string; name: string; at: number; bytes: number } | null;
    tvEtag: string | null;
    command: { id: number; op: string; at: number } | null;
    lastResult: CloudResult | null;
    history: CloudResult[];
}

export class CloudError extends Error {
    constructor(message: string, readonly status = 0) { super(message); }
}

/** https:// only, except this computer (for trying the server locally). */
export function normalizeServer(input: string): string {
    let s = input.trim().replace(/\/+$/, '');
    if (!/^[a-z]+:\/\//i.test(s)) s = 'https://' + s;
    let u: URL;
    try { u = new URL(s); } catch { throw new CloudError('endereço do servidor inválido'); }
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new CloudError('use um endereço https:// (o token da TV não pode viajar sem criptografia)');
    return u.origin + u.pathname.replace(/\/+$/, '');
}

async function call<T>(server: string, path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
    let r: Response;
    try {
        r = await fetch(server + path, {
            ...init,
            headers: { ...(init.token ? { authorization: 'Bearer ' + init.token } : {}), ...(init.headers || {}) },
        });
    } catch {
        throw new CloudError(`não foi possível falar com ${server} (sem internet, endereço errado ou servidor fora do ar)`);
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new CloudError(data.error || `o servidor respondeu ${r.status}`, r.status);
    return data as T;
}

export async function health(server: string) {
    return call<{ ok: boolean; service: string; version: number }>(server, '/v1/health');
}

export async function pair(serverInput: string, code: string, name: string): Promise<{ target: CloudTarget; device: CloudDevice }> {
    const server = normalizeServer(serverInput);
    const h = await health(server).catch((e) => { throw e; });
    if (h.service !== 'fmtv-cloud') throw new CloudError('esse endereço não é um servidor do Free My TV');
    const r = await call<{ deviceId: string; publisherToken: string; device: CloudDevice }>(server, '/v1/pair', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name }),
    });
    return { target: { server, deviceId: r.deviceId, token: r.publisherToken, label: labelOf(r.device) }, device: r.device };
}

export const getDevice = (t: CloudTarget) => call<CloudDevice>(t.server, `/v1/devices/${t.deviceId}`, { token: t.token });

export const upload = (t: CloudTarget, bytes: Uint8Array) => call<{ etag: string; device: CloudDevice }>(t.server, `/v1/devices/${t.deviceId}/layout`, {
    method: 'PUT', token: t.token, headers: { 'content-type': 'application/octet-stream' }, body: bytes.slice().buffer,
});

export const command = (t: CloudTarget, op: 'rollback' | 'reset') => call<{ command: { id: number }; device: CloudDevice }>(t.server, `/v1/devices/${t.deviceId}/command`, {
    method: 'POST', token: t.token, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op }),
});

export const unpair = (t: CloudTarget) => call<{ ok: boolean }>(t.server, `/v1/devices/${t.deviceId}/pairing`, { method: 'DELETE', token: t.token });

const FIRE_TV: Record<string, string> = {
    AFTM: 'Fire TV Stick (1ª geração)', AFTT: 'Fire TV Stick (2ª geração)', AFTSSS: 'Fire TV Stick (3ª geração)', AFTSS: 'Fire TV Stick Lite',
    AFTMM: 'Fire TV Stick 4K', AFTKA: 'Fire TV Stick 4K Max', AFTN: 'Fire TV (3ª geração)', AFTA: 'Fire TV Cube (1ª geração)', AFTR: 'Fire TV Cube (2ª geração)',
};
export function labelOf(d: Pick<CloudDevice, 'model' | 'name'>): string {
    if (FIRE_TV[d.model]) return `${FIRE_TV[d.model]} (${d.model})`;
    return d.name || d.model || 'TV';
}

/** "agora", "há 5 min"... */
export function seen(ts: number | null, now = Date.now()): string {
    if (!ts) return 'nunca';
    const s = Math.round((now - ts) / 1000);
    if (s < 60) return 'agora';
    if (s < 3600) return `há ${Math.round(s / 60)} min`;
    if (s < 86400) return `há ${Math.round(s / 3600)} h`;
    return new Date(ts).toLocaleDateString('pt-BR');
}

/** One line for what the TV reported, in the person's words. */
export function describe(r: CloudResult): string {
    if (r.op === 'render' && r.ok) return 'aplicado e confirmado na TV';
    if (r.op === 'import' && !r.ok) return `a TV recusou o pacote: ${r.error || 'motivo desconhecido'}`;
    if (r.op === 'import') return 'a TV importou; esperando ela desenhar';
    if (r.op === 'rollback') {
        const to = r.restored === 'previous' ? 'o layout anterior' : 'a tela original';
        return r.reason && /falhou/.test(r.reason) ? `o layout falhou na TV e ela voltou para ${to}: ${r.reason}` : `a TV voltou para ${to}`;
    }
    if (r.op === 'reset') return 'a TV voltou à tela original (o layout fica guardado como anterior)';
    return r.error || r.op;
}
