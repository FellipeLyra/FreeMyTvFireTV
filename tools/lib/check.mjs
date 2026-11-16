// Phase 9: an automatic check of a real Fire TV, over ADB. It measures what can
// be measured from the PC without root and without changing settings:
//
//   device and RAM · app installed (optionally installs an APK) · Home button
//   (accessibility service) · launch time · memory · smoothness while moving the
//   focus with the remote's arrows · publish a test layout and put the TV back
//   the way it was.
//
// Every item comes back as ok / warn / fail / skip with a value and a hint, and
// formatReport() turns that into Markdown to paste into an issue.
import { PKG, ACTIVITY } from './adb.mjs';
import { buildPackage } from './package.mjs';
import classic from '../../examples/layouts/classic.json' with { type: 'json' };

/** Budgets: tuned for the Fire TV Stick 3rd gen / Lite (1 GB of RAM). */
export const BUDGET = {
    launchMs: { ok: 2500, warn: 5000 },
    memoryMb: { ok: 200, warn: 320 },
    jankPct: { ok: 10, warn: 25 },
    publishMs: { ok: 8000, warn: 20000 },
};

const KEYS = { right: 22, left: 21, up: 19, down: 20 };
const MOVES = ['right', 'right', 'right', 'right', 'left', 'left', 'left', 'left', 'down', 'up', 'right', 'left'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pt = (v, d = 1) => String(+Number(v).toFixed(d)).replace('.', ',');
const grade = (v, b) => (v <= b.ok ? 'ok' : v <= b.warn ? 'warn' : 'fail');

/** Parsers for the adb outputs, exported for the tests. */
export const parse = {
    memTotalMb: (s) => { const m = /MemTotal:\s+(\d+)\s*kB/i.exec(s); return m ? Math.round(Number(m[1]) / 1024) : null; },
    launchMs: (s) => { const m = /TotalTime:\s*(\d+)/.exec(s) || /WaitTime:\s*(\d+)/.exec(s); return m ? Number(m[1]) : null; },
    pssMb: (s) => {
        const m = /TOTAL PSS:\s*([\d,]+)/i.exec(s) || /^\s*TOTAL\s+([\d,]+)/m.exec(s);
        return m ? Math.round(Number(m[1].replace(/,/g, '')) / 1024) : null;
    },
    gfx: (s) => {
        const total = /Total frames rendered:\s*(\d+)/.exec(s);
        const janky = /Janky frames:\s*(\d+)\s*\(([\d.]+)%\)/.exec(s);
        const p90 = /90th percentile:\s*(\d+)ms/.exec(s);
        return total ? { frames: Number(total[1]), janky: janky ? Number(janky[1]) : 0, jankPct: janky ? Number(janky[2]) : 0, p90: p90 ? Number(p90[1]) : null } : null;
    },
};

/**
 * Run the check. `adb` is an Adb already pointed at the device (adb.select()).
 * Options: apk (path to install first), publish (default true), log(message).
 */
export async function runCheck(adb, { apk = null, publish = true, log = () => {} } = {}) {
    const items = [];
    const add = (id, label, status, value, hint = '') => { items.push({ id, label, status, value, hint }); log(`${status === 'ok' ? '✓' : status === 'warn' ? '!' : status === 'fail' ? '✗' : '–'} ${label}: ${value}`); };
    const shell = (args, opts) => adb.run(['shell', ...args], { allowFail: true, ...opts });

    log('lendo o aparelho…');
    const sys = await adb.systemInfo().catch(() => ({}));
    const ram = parse.memTotalMb(await shell(['cat', '/proc/meminfo']));
    const device = { serial: adb.serial, model: sys.model || '', system: sys.system || '', android: sys.android || '', ramMb: ram };
    add('device', 'Aparelho', 'ok', `${sys.model || '?'} · ${sys.system || 'sistema ?'}${ram ? ` · ${ram} MB de RAM` : ''}`);
    if (ram && ram < 1300) add('weak', 'Modo leve', 'ok', 'aparelho de 1 GB: o Free My TV liga o modo leve sozinho (sem desfoque e sem brilho)');

    if (apk) {
        log('instalando o APK…');
        const out = await adb.run(['install', '-r', apk], { allowFail: true, timeout: 180000 });
        if (/Success/.test(out)) add('install', 'Instalação do APK', 'ok', 'instalado');
        else { add('install', 'Instalação do APK', 'fail', out.trim().split(/\r?\n/).pop() || 'falhou', 'Um APK com outra assinatura precisa desinstalar o antigo antes (adb uninstall ' + PKG + ').'); return { device, items }; }
    }

    let version;
    try { version = await adb.appVersion(); } catch (e) {
        add('app', 'Free My TV instalado', 'fail', e.message, 'Instale o APK: node tools/fmtv.mjs check --apk app-release.apk');
        return { device, items };
    }
    add('app', 'Free My TV instalado', 'ok', `versão ${version.versionName} (${version.versionCode})`);

    const a11y = await shell(['settings', 'get', 'secure', 'enabled_accessibility_services']);
    if (a11y.includes(PKG)) add('home', 'Botão Home abre o Free My TV', 'ok', 'serviço de acessibilidade ativo');
    else add('home', 'Botão Home abre o Free My TV', 'warn', 'serviço de acessibilidade desligado', 'Configurações → Acessibilidade → Free My TV (veja o README, "Fazer o botão Home abrir o Free My TV").');

    log('abrindo o Free My TV do zero…');
    await shell(['am', 'force-stop', PKG]);
    const launch = parse.launchMs(await shell(['am', 'start', '-W', '-n', ACTIVITY], { timeout: 30000 }));
    if (launch == null) add('launch', 'Tempo para abrir', 'warn', 'não medido', 'O am start -W não informou o tempo.');
    else add('launch', 'Tempo para abrir', grade(launch, BUDGET.launchMs), `${pt(launch / 1000)} s`, launch > BUDGET.launchMs.ok ? 'O tempo inclui o WebView; o primeiro início depois de ligar a TV é o mais lento.' : '');
    await sleep(3500); // let the page draw, load the apps and the weather

    log('movendo o foco com as setas do controle…');
    await shell(['dumpsys', 'gfxinfo', PKG, 'reset']);
    for (const m of MOVES) { await shell(['input', 'keyevent', String(KEYS[m])], { timeout: 10000 }); await sleep(250); }
    await sleep(500);
    const gfx = parse.gfx(await shell(['dumpsys', 'gfxinfo', PKG]));
    if (!gfx || gfx.frames < 5) add('smooth', 'Fluidez da navegação', 'warn', 'não medida', 'O Fire OS não informou os quadros (dumpsys gfxinfo).');
    else add('smooth', 'Fluidez da navegação', grade(gfx.jankPct, BUDGET.jankPct), `${pt(gfx.jankPct)}% de quadros atrasados em ${gfx.frames}${gfx.p90 ? ` · 90% abaixo de ${gfx.p90} ms` : ''}`,
        gfx.jankPct > BUDGET.jankPct.ok ? 'Teste o modo leve em Personalizar → Modo de desempenho, ou use menos desfoque e imagens menores no layout.' : '');

    const pss = parse.pssMb(await shell(['dumpsys', 'meminfo', PKG], { timeout: 20000 }));
    if (pss == null) add('memory', 'Memória usada', 'warn', 'não medida');
    else add('memory', 'Memória usada', grade(pss, BUDGET.memoryMb), `${pss} MB`, pss > BUDGET.memoryMb.ok ? 'Imagens grandes no layout pesam mais; o Studio avisa e reduz (Otimizar imagens).' : '');

    if (publish) {
        const before = (await adb.readResult())?.status || null;
        const layout = { ...structuredClone(classic), id: 'fmtv-check', name: 'Teste do aparelho (fmtv check)', generator: 'fmtv check' };
        log('publicando um layout de teste…');
        const t0 = Date.now();
        let r;
        try { r = await adb.publish(buildPackage(layout, [])); } catch (e) { r = { ok: false, error: e.message }; }
        const ms = Date.now() - t0;
        if (r.ok) add('publish', 'Publicar e confirmar um layout', grade(ms, BUDGET.publishMs), `confirmado na TV em ${pt(ms / 1000)} s`);
        else add('publish', 'Publicar e confirmar um layout', 'fail', r.error || r.reason || 'a TV não confirmou', 'Rode node tools/fmtv.mjs log para ver o histórico da TV.');
        // Put the TV back the way it was.
        log('devolvendo a TV como estava…');
        const back = before?.active && before.status === 'verified' ? await adb.command('rollback') : await adb.command('reset');
        const restored = back ? (before?.active && before.status === 'verified' ? `layout "${before.name || before.id}" de volta` : 'tela original de volta') : 'sem resposta';
        add('restore', 'TV como estava antes', back ? 'ok' : 'warn', restored);
    } else add('publish', 'Publicar e confirmar um layout', 'skip', 'pulado (--no-publish)');

    return { device, items, at: new Date().toISOString() };
}

const ICON = { ok: '✅', warn: '⚠️', fail: '❌', skip: '➖' };

/** Markdown, ready to paste into a GitHub issue. */
export function formatReport(r) {
    const d = r.device || {};
    const lines = [
        `## Teste do Free My TV no aparelho`,
        '',
        `- **Aparelho:** ${d.model || '?'} (${d.serial || '?'})`,
        `- **Sistema:** ${d.system || '?'}${d.android ? ` (Android ${d.android})` : ''}${d.ramMb ? ` · ${d.ramMb} MB de RAM` : ''}`,
        `- **Quando:** ${r.at || new Date().toISOString()}`,
        '',
        '| | Item | Resultado | Dica |',
        '|---|---|---|---|',
        ...r.items.filter((i) => i.id !== 'device').map((i) => `| ${ICON[i.status]} | ${i.label} | ${i.value} | ${i.hint || ''} |`),
        '',
        `Limites usados: abrir em até ${pt(BUDGET.launchMs.ok / 1000)} s, memória até ${BUDGET.memoryMb.ok} MB, até ${BUDGET.jankPct.ok}% de quadros atrasados.`,
    ];
    return lines.join('\n') + '\n';
}

export const summary = (r) => {
    const n = (s) => r.items.filter((i) => i.status === s).length;
    return { ok: n('ok'), warn: n('warn'), fail: n('fail') };
};
