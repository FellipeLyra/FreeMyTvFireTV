// Phase 7: find Fire TVs, publish the layout, roll back, and see each TV's history.
import { useEffect, useState } from 'react';
import { useDevices, isReady, CLOUD } from '../store/devices';
import * as C from '../lib/cloud';
import { useEditor } from '../store/editor';
import * as D from '../lib/device';
import { I } from '../ui/icons';

export function DevicesDialog() {
    const s = useDevices();
    const layoutName = useEditor((e) => e.project.layout.name);
    const [address, setAddress] = useState('');
    const [logFor, setLogFor] = useState<string | null>(null);
    const [logLines, setLogLines] = useState<string[] | null>(null);
    const busy = !!s.job && !s.job.done;

    useEffect(() => {
        if (!s.open) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) s.setOpen(false); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [s.open, busy]);

    if (!s.open) return null;

    const showLog = async (serial: string) => {
        if (logFor === serial) { setLogFor(null); return; }
        setLogFor(serial);
        setLogLines(null);
        try { setLogLines((await D.deviceLog(serial)).slice(-40).reverse()); } catch (e) { setLogLines([`(não foi possível ler: ${(e as Error).message})`]); }
    };

    const bridge = s.bridge;
    return (
        <div className="dlg-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) s.setOpen(false); }}>
            <section className="dlg devices" role="dialog" aria-modal="true" aria-label="Dispositivos" data-testid="devices-dialog">
                <header className="dlg-head">
                    <I.Tv size={18} />
                    <h2>Dispositivos</h2>
                    {bridge && bridge !== 'checking' && bridge.simulated && <span className="badge sim" title={bridge.adb || ''}>Fire TV simulado</span>}
                    <span className="grow" />
                    <button className="btn btn-small" onClick={() => { s.refresh(); s.refreshCloud(); }} disabled={s.loading || busy}>{s.loading ? 'Atualizando…' : 'Atualizar'}</button>
                    <button className="tb-icon" aria-label="Fechar" onClick={() => s.setOpen(false)} disabled={busy}><I.Close /></button>
                </header>

                <div className="dlg-body">
                    {s.job && (
                        <div className={'dev-job' + (s.job.done ? (s.job.ok ? ' ok' : s.job.warn ? ' warn' : ' err') : '')} data-testid="device-job" aria-live="polite">
                            {s.job.logs.map((l, i) => <div key={i} className="job-line">· {l}</div>)}
                            {!s.job.done && <div className="job-line spin">trabalhando…</div>}
                            {s.job.done && <div className="job-final">{s.job.ok ? <I.Check size={14} /> : s.job.warn ? <I.Warning size={14} /> : <I.Error size={14} />} {s.job.message}</div>}
                        </div>
                    )}
                    <h3 className="dev-section">Na rede local (ADB)</h3>
                    {bridge === 'checking' && <p className="panel-note">Procurando a ponte com a TV…</p>}
                    {bridge === null && (
                        <div className="dev-card warn">
                            <strong>O Studio não encontrou a ponte com a TV.</strong>
                            <p>O navegador não consegue rodar o <code>adb</code> sozinho. Com <code>npm run dev</code> ou <code>npm run desktop</code> a ponte já vem junto. Com o Studio instalado, deixe esta janela aberta num terminal:</p>
                            <pre>node tools/fmtv.mjs serve</pre>
                            <button className="btn" onClick={() => s.refresh()}>Tentar de novo</button>
                        </div>
                    )}
                    {bridge && bridge !== 'checking' && !bridge.ok && (
                        <div className="dev-card warn">
                            <strong>adb não encontrado.</strong>
                            <p>Instale o <a href="https://developer.android.com/tools/releases/platform-tools" target="_blank" rel="noreferrer">Android platform-tools</a> e reinicie o Studio, ou indique o caminho na variável <code>ADB</code>. {bridge.error}</p>
                        </div>
                    )}

                    {bridge && bridge !== 'checking' && bridge.ok && (
                        <>
                            <form className="dev-add" onSubmit={(e) => { e.preventDefault(); s.connect(address); }}>
                                <input className="text-field" placeholder="IP do Fire TV (ex.: 192.168.0.50)" value={address} data-testid="device-address"
                                    onChange={(e) => setAddress(e.target.value)} aria-label="IP do Fire TV" />
                                <button className="btn primary" type="submit" disabled={busy || !address.trim()}>Conectar</button>
                                <button className="btn" type="button" onClick={() => s.scan()} disabled={busy} title="Procura aparelhos com a depuração ADB ligada (porta 5555) na rede deste PC">
                                    Procurar na rede
                                </button>
                            </form>
                            {(s.addresses.length > 0 || (s.found && s.found.length > 0)) && (
                                <div className="dev-chips">
                                    {(s.found || []).map((a) => <button key={'f' + a} className="chip new" onClick={() => s.connect(a)} disabled={busy}>{a.replace(/:5555$/, '')} · encontrado</button>)}
                                    {s.addresses.filter((a) => !s.devices.some((d) => d.serial.startsWith(a + ':'))).map((a) => (
                                        <button key={a} className="chip" onClick={() => s.connect(a)} disabled={busy} title="Usado antes">{a}</button>
                                    ))}
                                </div>
                            )}

                            {s.error && <div className="dev-msg err">{s.error}</div>}

                            {!s.devices.length && !s.loading && (
                                <div className="dev-card">
                                    <strong>Nenhum aparelho conectado.</strong>
                                    <ol>
                                        <li>No Fire TV: <b>Configurações → Meu Fire TV → Opções do desenvolvedor → Depuração ADB → Ativado</b>. Se a opção não aparecer, entre em <b>Sobre</b> e clique 7 vezes no nome do aparelho.</li>
                                        <li>Veja o IP em <b>Configurações → Meu Fire TV → Sobre → Rede</b>.</li>
                                        <li>Digite o IP acima e clique em <b>Conectar</b>. Na primeira vez, aceite o pedido que aparece na TV.</li>
                                    </ol>
                                </div>
                            )}

                            <div className="dev-list">
                                {s.devices.map((d) => {
                                    const ready = isReady(d);
                                    const on = s.selected === d.serial;
                                    const lay = d.layout;
                                    return (
                                        <article key={d.serial} className={'dev-item' + (on ? ' on' : '')} data-serial={d.serial}>
                                            <label className="dev-pick">
                                                <input type="radio" name="device" checked={on} disabled={!ready} onChange={() => s.select(d.serial)} />
                                                <div>
                                                    <div className="dev-name">{d.label}{d.manufacturer && !/amazon/i.test(d.manufacturer) ? ` · ${d.manufacturer}` : ''}</div>
                                                    <div className="dev-sub">{d.serial}{d.system ? ` · ${d.system}` : ''}{d.app?.versionName ? ` · Free My TV ${d.app.versionName}` : ''}</div>
                                                </div>
                                            </label>
                                            <StateBadge d={d} />
                                            {d.state === 'unauthorized' && <p className="dev-hint">Aceite o pedido <b>"Permitir depuração"</b> que apareceu na TV (marque "Sempre permitir deste computador") e clique em Atualizar.</p>}
                                            {d.state === 'device' && d.app?.error && <p className="dev-hint">O Free My TV não está instalado neste aparelho. Instale o APK (veja o README) e clique em Atualizar.</p>}
                                            {d.state === 'offline' && <p className="dev-hint">O aparelho não responde. Confira se ele está ligado e na mesma rede, e conecte de novo.</p>}
                                            {ready && (
                                                <div className="dev-layout">
                                                    <span>Na TV: {lay?.active ? <b>{lay.name || lay.id}</b> : <b>tela original</b>}
                                                        {lay?.active && <em className={lay.status === 'verified' ? 'ok' : 'warn'}>{lay.status === 'verified' ? ' confirmado' : ' aguardando confirmação'}</em>}
                                                    </span>
                                                    {lay?.previous && <span>Anterior: {lay.previous.name || lay.previous.id}</span>}
                                                </div>
                                            )}
                                            <div className="dev-actions">
                                                {ready && <button className="btn primary btn-small" disabled={busy} onClick={() => { s.select(d.serial); s.publish(d.serial); }} data-testid="publish-here">Publicar "{layoutName}"</button>}
                                                {ready && <button className="btn btn-small" disabled={busy || !lay?.active && !lay?.previous} onClick={() => s.command(d.serial, 'rollback')}
                                                    title="Volta ao último layout que funcionou (ou à tela original, se não houver)">Voltar ao anterior</button>}
                                                {ready && <button className="btn btn-small" disabled={busy || !lay?.active} onClick={() => s.command(d.serial, 'reset')}
                                                    title="Mostra a tela original do Free My TV; o layout fica guardado como anterior">Tela original</button>}
                                                {ready && <button className={'btn btn-small' + (logFor === d.serial ? ' on' : '')} onClick={() => showLog(d.serial)}>Histórico da TV</button>}
                                                {d.state === 'device' && <button className="btn btn-small" disabled={busy} onClick={() => s.check(d.serial)} data-testid="check-device"
                                                    title="Mede o tempo para abrir, a memória e a fluidez, e publica um layout de teste; no fim a TV volta como estava">Testar aparelho</button>}
                                                {d.network && <button className="btn btn-small" disabled={busy} onClick={() => s.disconnect(d.serial)}>Desconectar</button>}
                                            </div>
                                            {s.report?.serial === d.serial && <CheckReportView r={s.report.result} />}
                                            {logFor === d.serial && (
                                                <div className="dev-log" data-testid="device-log">
                                                    {!logLines ? 'lendo…' : logLines.length ? logLines.map((l, i) => <div key={i}>{l}</div>) : 'nenhum layout publicado ainda nesta TV'}
                                                </div>
                                            )}
                                        </article>
                                    );
                                })}
                            </div>

                        </>
                    )}

                    <CloudSection busy={busy} layoutName={layoutName} />

                    {s.history.length > 0 && (
                        <details className="dev-history">
                            <summary>Publicações feitas deste PC ({s.history.length})</summary>
                            {s.history.map((h, i) => (
                                <div key={i} className={'hist ' + (h.ok ? 'ok' : 'err')}>
                                    <span className="when">{new Date(h.time).toLocaleString('pt-BR')}</span>
                                    <span>{h.op === 'publish' ? `"${h.layout}" → ${h.device}` : `${h.op === 'rollback' ? 'Voltar' : 'Tela original'} em ${h.device}`}</span>
                                    <span className="what">{h.message}</span>
                                </div>
                            ))}
                        </details>
                    )}
                </div>
            </section>
        </div>
    );
}

/** Phase 8: TVs paired through a Free My TV Cloud server. */
function CloudSection({ busy, layoutName }: { busy: boolean; layoutName: string }) {
    const s = useDevices();
    const [server, setServer] = useState(s.cloudServer);
    const [code, setCode] = useState('');
    const [histFor, setHistFor] = useState<string | null>(null);
    return (
        <>
            <h3 className="dev-section">Pela internet</h3>
            <p className="panel-note">Publica de qualquer lugar, por um servidor Free My TV Cloud que você hospeda (veja <code>docs/cloud.md</code>). Na TV: <b>Personalizar → Publicar pela internet → Parear com o Studio</b>, e digite aqui o código que aparecer.</p>
            <form className="dev-add" onSubmit={(e) => { e.preventDefault(); s.pairCloud(server, code).then(() => setCode('')); }}>
                <input className="text-field" placeholder="https://tv.seudominio.com" value={server} onChange={(e) => setServer(e.target.value)}
                    aria-label="Endereço do servidor" data-testid="cloud-server" />
                <input className="text-field code-field" placeholder="Código da TV" value={code} maxLength={9} onChange={(e) => setCode(e.target.value.toUpperCase())}
                    aria-label="Código que aparece na TV" data-testid="cloud-code" />
                <button className="btn primary" type="submit" disabled={busy || !server.trim() || code.replace(/[^A-Z0-9]/gi, '').length !== 8}>Parear</button>
            </form>
            <div className="dev-list">
                {s.cloud.map((t) => {
                    const key = CLOUD + t.deviceId;
                    const d = s.cloudDevices[t.deviceId];
                    const info = d && !('error' in d) ? d : null;
                    const lay = info?.lastResult?.status;
                    const on = s.selected === key;
                    const waiting = info?.pending && info.pending.etag !== info.tvEtag;
                    return (
                        <article key={key} className={'dev-item' + (on ? ' on' : '')} data-serial={key}>
                            <label className="dev-pick">
                                <input type="radio" name="device" checked={on} disabled={!info} onChange={() => s.select(key)} />
                                <div>
                                    <div className="dev-name">{info ? C.labelOf(info) : t.label}</div>
                                    <div className="dev-sub">{new URL(t.server).host}{info?.appVersion ? ` · Free My TV ${info.appVersion}` : ''}{info ? ` · vista ${C.seen(info.lastSeen)}` : ''}</div>
                                </div>
                            </label>
                            {info ? <span className={'dev-state ' + (info.online ? 'ok' : 'warn')}>{info.online ? 'conectada' : 'fora do ar'}</span>
                                : d ? <span className="dev-state err">sem acesso</span> : <span className="dev-state">…</span>}
                            {d && 'error' in d && <p className="dev-hint">{d.error}</p>}
                            {info && !info.online && <p className="dev-hint">A TV busca os layouts enquanto a tela inicial do Free My TV está aberta. O que você publicar agora fica guardado no servidor até lá.</p>}
                            {info && (
                                <div className="dev-layout">
                                    <span>Na TV: {lay?.active ? <b>{lay.name || lay.id}</b> : lay ? <b>tela original</b> : <b>sem notícias ainda</b>}
                                        {lay?.active && <em className={lay.status === 'verified' ? 'ok' : 'warn'}>{lay.status === 'verified' ? ' confirmado' : ' aguardando confirmação'}</em>}
                                    </span>
                                    {lay?.previous && <span>Anterior: {lay.previous.name || lay.previous.id}</span>}
                                    {waiting && <span className="warn">No servidor, esperando a TV: <b>{info.pending!.name}</b></span>}
                                </div>
                            )}
                            <div className="dev-actions">
                                {info && <button className="btn primary btn-small" disabled={busy} data-testid="cloud-publish" onClick={() => { s.select(key); s.publish(key); }}>Publicar "{layoutName}"</button>}
                                {info && <button className="btn btn-small" disabled={busy} onClick={() => s.command(key, 'rollback')} title="Volta ao último layout que funcionou (ou à tela original)">Voltar ao anterior</button>}
                                {info && <button className="btn btn-small" disabled={busy || !lay?.active} onClick={() => s.command(key, 'reset')}>Tela original</button>}
                                {info && <button className={'btn btn-small' + (histFor === key ? ' on' : '')} onClick={() => setHistFor(histFor === key ? null : key)}>Histórico da TV</button>}
                                <button className="btn btn-small" disabled={busy} onClick={() => s.unpairCloud(t.deviceId)} title="Este Studio deixa de ter acesso a esta TV">Remover</button>
                            </div>
                            {histFor === key && info && (
                                <div className="dev-log" data-testid="cloud-log">
                                    {info.history.length ? info.history.map((h, i) => <div key={i}>{new Date(h.at).toLocaleString('pt-BR')} {C.describe(h)}</div>) : 'nada publicado ainda nesta TV'}
                                </div>
                            )}
                        </article>
                    );
                })}
            </div>
        </>
    );
}

/** Phase 9: what the device test measured, with a Markdown copy for an issue. */
function CheckReportView({ r }: { r: D.CheckReport }) {
    const [copied, setCopied] = useState(false);
    const icon = { ok: '✓', warn: '!', fail: '✗', skip: '–' };
    return (
        <div className="dev-check" data-testid="check-report">
            <table>
                <tbody>
                    {r.items.map((i) => (
                        <tr key={i.id} className={i.status}>
                            <td className="st">{icon[i.status]}</td>
                            <td>{i.label}</td>
                            <td><b>{i.value}</b>{i.hint && <div className="hint">{i.hint}</div>}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
            <button className="btn btn-small" onClick={() => { navigator.clipboard?.writeText(r.markdown).then(() => setCopied(true), () => {}); }}>
                {copied ? 'Copiado' : 'Copiar relatório (Markdown)'}
            </button>
        </div>
    );
}

function StateBadge({ d }: { d: D.Device }) {
    if (isReady(d)) return <span className="dev-state ok">pronto</span>;
    if (d.state === 'unauthorized') return <span className="dev-state warn">aguardando autorização na TV</span>;
    if (d.state === 'device' && d.app?.error) return <span className="dev-state warn">sem o Free My TV</span>;
    return <span className="dev-state err">{d.state === 'offline' ? 'sem resposta' : d.state}</span>;
}
