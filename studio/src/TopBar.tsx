import { useState } from 'react';
import { E } from './engine';
import { useEditor } from './store/editor';
import { I } from './ui/icons';
import { ContextMenu, type MenuItem } from './ui/ContextMenu';
import { TEMPLATES } from './model/project';
import { openProject, saveProject, download, clearAutosave } from './lib/storage';
import { buildPackage, finalizeLayout } from './lib/pack';
import { TV_RES, type TvRes } from './model/a11y';
import { useDevices, isReady, CLOUD } from './store/devices';

export async function doSave(saveAs = false) {
    const s = useEditor.getState();
    try {
        const r = await saveProject(s.project, s.fileName || s.project.layout.name, s.fileHandle, saveAs);
        s.markSaved(r.name, r.handle);
        clearAutosave();
        s.toast(`salvo: ${r.name}`, 'success');
    } catch (e) {
        if ((e as Error).name !== 'AbortError') s.toast('não foi possível salvar: ' + (e as Error).message, 'error');
    }
}

export async function doOpen() {
    const s = useEditor.getState();
    if (s.dirty && !confirm('Há alterações não salvas. Abrir outro projeto mesmo assim?')) return;
    try {
        const f = await openProject();
        if (!f) return;
        s.load(f.project, f.name, f.handle);
        window.dispatchEvent(new Event('fmtv:fit'));
        s.toast(`aberto: ${f.name}`, 'success');
    } catch (e) {
        s.toast((e as Error).message, 'error');
    }
}

export function TopBar() {
    const name = useEditor((s) => s.project.layout.name);
    const dirty = useEditor((s) => s.dirty);
    const canUndo = useEditor((s) => s.past.length > 0);
    const canRedo = useEditor((s) => s.future.length > 0);
    const zoom = useEditor((s) => s.zoom);
    const mode = useEditor((s) => s.mode);
    const page = useEditor((s) => s.page);
    const customPages = useEditor((s) => Object.keys(s.project.layout.pages));
    const showSafeArea = useEditor((s) => s.showSafeArea);
    const snap = useEditor((s) => s.snap);
    const showFocusMap = useEditor((s) => s.showFocusMap);
    const tvRes = useEditor((s) => s.tvRes);
    const s = useEditor.getState();
    const adbDevice = useDevices((d) => d.devices.find((x) => x.serial === d.selected) || null);
    const cloudTarget = useDevices((d) => d.cloud.find((t) => CLOUD + t.deviceId === d.selected) || null);
    // The chosen TV, over ADB or over the internet, in one shape for the buttons.
    const device = cloudTarget ? { label: cloudTarget.label + ' · internet', serial: new URL(cloudTarget.server).host, ready: true }
        : adbDevice ? { label: adbDevice.label, serial: adbDevice.serial, ready: isReady(adbDevice) } : null;
    const publishing = useDevices((d) => !!d.job && d.job.op === 'publish' && !d.job.done);
    const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

    const newFrom = (id: string) => async () => {
        if (useEditor.getState().dirty && !confirm('Há alterações não salvas. Começar um projeto novo mesmo assim?')) return;
        const t = TEMPLATES.find((x) => x.id === id)!;
        const p = await t.create();
        useEditor.getState().load(p, p.layout.name);
        window.dispatchEvent(new Event('fmtv:fit'));
    };

    const exportPackage = async () => {
        const st = useEditor.getState();
        const res = await buildPackage(st.project);
        if (!res.ok) {
            st.toast('o layout tem erros; veja a barra de problemas', 'error');
            return;
        }
        download(new Blob([res.bytes!.slice().buffer], { type: 'application/zip' }), `${slug(st.project.layout.name)}.fmtv`);
        st.toast('pacote .fmtv exportado: publique com "node tools/fmtv.mjs publish arquivo.fmtv --device IP"', 'success');
    };
    const exportJson = async () => {
        const st = useEditor.getState();
        const { layout } = await finalizeLayout(st.project);
        download(new Blob([JSON.stringify(layout, null, 2)], { type: 'application/json' }), `${slug(st.project.layout.name)}.json`);
    };

    const open = (e: React.MouseEvent, items: MenuItem[]) => {
        const b = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setMenu({ x: b.left, y: b.bottom + 4, items });
    };

    return (
        <header className="topbar">
            <div className="tb-group">
                <div className="brand" title="Free My TV Studio"><I.Tv size={18} /><span>Studio</span></div>
                <button className="tb-btn" onClick={(e) => open(e, [
                    ...TEMPLATES.map((t) => ({ label: `Novo: ${t.name}`, shortcut: t.description, action: newFrom(t.id) } as MenuItem)),
                    { separator: true },
                    { label: 'Abrir…', shortcut: 'Ctrl+O', action: doOpen },
                    { label: 'Salvar', shortcut: 'Ctrl+S', action: () => doSave(false) },
                    { label: 'Salvar como…', shortcut: 'Ctrl+Shift+S', action: () => doSave(true) },
                ])}>Arquivo <I.ChevronDown size={12} /></button>
                <input className="project-name" value={name} maxLength={80} aria-label="Nome do projeto"
                    onChange={(e) => s.commit('nome', (p) => { p.layout.name = e.target.value || 'Sem nome'; }, 'project-name')} />
                <span className={'dirty-dot' + (dirty ? ' on' : '')} title={dirty ? 'Alterações não salvas' : 'Tudo salvo'} />
                <select className="select-field page-select" value={page} aria-label="Tela" onChange={(e) => s.setPage(e.target.value)}>
                    {Object.entries(E.PAGES).map(([id, p]) => <option key={id} value={id} disabled={!p.runtime}>{p.label}{customPages.includes(id) || id === 'home' ? '' : ' (original)'}</option>)}
                </select>
            </div>

            <div className="tb-group">
                <button className="tb-icon" title="Desfazer (Ctrl+Z)" disabled={!canUndo} onClick={s.undo}><I.Undo /></button>
                <button className="tb-icon" title="Refazer (Ctrl+Shift+Z)" disabled={!canRedo} onClick={s.redo}><I.Redo /></button>
                <button className="tb-icon" title="Salvar (Ctrl+S)" onClick={() => doSave(false)}><I.Save /></button>
                <span className="tb-sep" />
                <button className="tb-icon" title="Diminuir zoom (Ctrl+-)" onClick={() => s.setZoom(zoom / 1.25)}><I.Minus /></button>
                <button className="tb-zoom" title="Ajustar à tela (Shift+1)" onClick={() => window.dispatchEvent(new Event('fmtv:fit'))}>{Math.round(zoom * 100)}%</button>
                <button className="tb-icon" title="Aumentar zoom (Ctrl+=)" onClick={() => s.setZoom(zoom * 1.25)}><I.Plus /></button>
                <button className={'tb-icon' + (showSafeArea ? ' on' : '')} title="Área segura da TV" onClick={() => s.toggle('showSafeArea')}><I.Safe /></button>
                <button className={'tb-icon' + (snap ? ' on' : '')} title="Grade e guias inteligentes (segure Alt para soltar livre)" onClick={() => s.toggle('snap')}><I.Grid /></button>
                <button className={'tb-icon' + (showFocusMap ? ' on' : '')} data-testid="focus-map-btn"
                    title="Mapa de foco (F): por onde o controle remoto passa, quantos cliques até cada item e o que as setas não alcançam"
                    onClick={() => s.toggle('showFocusMap')}><I.Focus /></button>
                <select className="select-field res-select" value={tvRes} aria-label="Resolução da TV" data-testid="res-select"
                    title="Resolução da TV. O layout tem sempre 1920×1080 e a TV só muda a escala: em 720p tudo fica com 2/3 dos pixels (texto pequeno e linhas finas perdem nitidez); em 4K, o dobro."
                    onChange={(e) => s.setTvRes(e.target.value as TvRes)}>
                    {Object.entries(TV_RES).map(([id, r]) => <option key={id} value={id} title={r.label}>TV {r.label.split(' ')[0]}</option>)}
                </select>
                <button className="tb-btn tb-small" data-testid="actual-size"
                    title="Tamanho real: 1 pixel da TV nesta resolução = 1 pixel da sua tela (Shift+0)"
                    onClick={() => window.dispatchEvent(new Event('fmtv:actual-size'))}>1:1</button>
                <span className="tb-sep" />
                <button className="tb-icon" title="Stack horizontal: agrupa os elementos selecionados (Ctrl+G) ou cria uma vazia" onClick={() => s.createStack('horizontal')}><I.StackH /></button>
                <button className="tb-icon" title="Stack vertical: agrupa os elementos selecionados (Ctrl+Alt+G) ou cria uma vazia" onClick={() => s.createStack('vertical')}><I.StackV /></button>
            </div>

            <div className="tb-group">
                <button className={'tb-btn' + (mode === 'preview' ? ' primary-outline' : '')} onClick={() => s.setMode(mode === 'edit' ? 'preview' : 'edit')}
                    title="Prévia com navegação pelo controle (P)">
                    {mode === 'edit' ? <><I.Play size={14} /> Prévia</> : <><I.Edit size={14} /> Editar</>}
                </button>
                <button className="tb-btn" data-testid="devices-btn" onClick={() => useDevices.getState().setOpen(true)}
                    title={device ? `${device.label} (${device.serial}): trocar de aparelho, voltar ao layout anterior, histórico` : 'Conectar um Fire TV pelo ADB'}>
                    <I.Tv size={14} /> <span className="tb-device">{device ? device.label : 'Dispositivo'}</span>
                    {device && <span className={'dot-state ' + (device.ready ? 'ok' : 'warn')} />}
                </button>
                <button className="tb-btn" onClick={(e) => open(e, [
                    { label: 'Pacote para a TV (.fmtv)', action: exportPackage },
                    { label: 'Layout (layout.json)', action: exportJson },
                ])}><I.Export size={14} /> Exportar</button>
                <button className="tb-btn primary" data-testid="publish-btn" disabled={publishing} onClick={() => useDevices.getState().publish()}
                    title={device && device.ready ? `Publicar na TV ${device.label}: envia, aplica e espera a TV confirmar que desenhou` : 'Escolha um Fire TV para publicar'}>
                    <I.Send size={14} /> {publishing ? 'Publicando…' : 'Publicar'}
                </button>
            </div>
            {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
        </header>
    );
}

function slug(name: string) {
    return name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'layout';
}
