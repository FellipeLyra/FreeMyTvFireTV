#!/usr/bin/env node
// End-to-end test of the Studio in real Chrome, driven through the DevTools
// Protocol with real mouse and keyboard events (no test framework needed).
// Needs the dev server: `npm run dev` (port 5610), then `node scripts/e2e.mjs`.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.STUDIO_URL || 'http://127.0.0.1:5610';
const SHOT = process.argv.includes('--shot') ? process.argv[process.argv.indexOf('--shot') + 1] : null;
const chrome = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => p && existsSync(p));
if (!chrome) { console.error('Chrome não encontrado'); process.exit(2); }

const PORT = 9300 + Math.floor(Math.random() * 400);
const profile = mkdtempSync(join(tmpdir(), 'fmtv-e2e-'));
const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--window-size=1600,960', 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, seq = 0;
const pending = new Map();
function send(method, params = {}) {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function evaluate(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
}
async function waitFor(expr, ms = 15000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        try { if (await evaluate(expr)) return; } catch { /* page not ready */ }
        await sleep(100);
    }
    throw new Error('timeout esperando: ' + expr);
}
const mouse = (type, x, y, buttons = 1, modifiers = 0) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1, modifiers });
async function drag(from, to, steps = 12, modifiers = 0) {
    await mouse('mouseMoved', from.x, from.y, 0, modifiers);
    await mouse('mousePressed', from.x, from.y, 1, modifiers);
    for (let i = 1; i <= steps; i++) {
        await mouse('mouseMoved', from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, 1, modifiers);
        await sleep(16);
    }
    await mouse('mouseReleased', to.x, to.y, 0, modifiers);
    await sleep(250);
}
async function key(k, code, modifiers = 0, keyCode = 0) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, modifiers, windowsVirtualKeyCode: keyCode });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, modifiers, windowsVirtualKeyCode: keyCode });
    await sleep(150);
}
const S = '__fmtvStudio.getState()';
/** Screen point of a layout-space point (x, y) on the canvas. */
async function screen(x, y) {
    return evaluate(`(() => { const b = document.querySelector('.canvas-stage').getBoundingClientRect(); const z = ${S}.zoom; return { x: b.left + ${x} * z, y: b.top + ${y} * z }; })()`);
}
const rect = (id) => evaluate(`${S}.rects[${JSON.stringify(id)}]`);
const node = (id) => evaluate(`(() => { const r = ${S}.project.layout.pages.home.root; let f = null; (function w(n, p){ if (n.id === ${JSON.stringify(id)}) f = { node: n, parent: p && p.id }; (n.children||[]).forEach(c => w(c, n)); })(r, null); return f; })()`);

let cloudProc = null, tvProc = null;
const results = [];
const pageErrors = [];
function check(name, ok, detail = '') {
    results.push({ name, ok });
    console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ' — ' + detail}`);
}

try {
    let target;
    for (let i = 0; i < 50 && !target; i++) {
        try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page'); } catch { await sleep(100); }
    }
    ws = new WebSocket(target.webSocketDebuggerUrl);
    ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
        if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') pageErrors.push(m.params.args.map((a) => a.value || a.description).join(' '));
        if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    };
    await new Promise((r) => (ws.onopen = r));
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 960, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: `${BASE}/?template=cinema` });
    await waitFor(`window.__fmtvStudio && ${S}.project.layout.name === 'Cinema' && !!${S}.rects['big-clock'] && !!${S}.rects['btn-settings']`);
    await sleep(400);
    await evaluate(`window.__ptr = []; ['pointerdown','pointermove','pointerup','gotpointercapture','lostpointercapture','dragstart','pointercancel'].forEach(t => document.addEventListener(t, e => { window.__ptr.push(t + ':' + (e.target.className || e.target.tagName)); if (window.__ptr.length > 40) window.__ptr.shift(); }, true));`);
    console.log('\n[Studio e2e: modelo Cinema]');

    // 0. The launcher's idle screensaver must never cover the canvas while editing
    await evaluate(`document.querySelector('iframe').contentWindow.enterScreensaver()`);
    await sleep(1600);
    check('protetor de tela do launcher não fica sobre o canvas', (await evaluate(`document.querySelector('iframe').contentWindow.screensaverOn`)) === false);

    // 1. Click selects
    const clock0 = await rect('big-clock');
    const c0 = await screen(clock0.x + 60, clock0.y + clock0.h / 2);
    await mouse('mouseMoved', c0.x, c0.y, 0); await mouse('mousePressed', c0.x, c0.y); await mouse('mouseReleased', c0.x, c0.y, 0); await sleep(150);
    check('clique seleciona o relógio', JSON.stringify(await evaluate(`${S}.selection`)) === '["big-clock"]', JSON.stringify(await evaluate(`${S}.selection`)));

    // 2. Drag an absolute element (with grid/smart-guide snapping)
    await drag(c0, await screen(clock0.x + 60 + 200, clock0.y + clock0.h / 2 + 100));
    const moved = (await node('big-clock')).node.constraints;
    check('arrastar move o elemento absoluto (~+200, ~+100)', Math.abs(moved.h.offset - (64 + 200)) <= 10 && Math.abs(moved.v.offset - (150 + 100)) <= 10, JSON.stringify(moved));

    // 3. Undo with the keyboard
    await key('z', 'KeyZ', 2, 90);
    const undone = (await node('big-clock')).node.constraints;
    check('Ctrl+Z desfaz o movimento', undone.h.offset === 64 && undone.v.offset === 150, JSON.stringify(undone));
    await key('Z', 'KeyZ', 2 | 8, 90);
    check('Ctrl+Shift+Z refaz', (await node('big-clock')).node.constraints.h.offset !== 64);
    await key('z', 'KeyZ', 2, 90);


    // 4. Resize with the bottom-right handle
    await sleep(400);
    const r1 = await rect('big-clock');
    await drag(await screen(r1.x + r1.w, r1.y + r1.h), await screen(r1.x + r1.w - 300, r1.y + r1.h + 40));
    const resized = (await node('big-clock')).node.constraints;
    check('alça redimensiona (largura −300, altura +40)', Math.abs(resized.h.size - (r1.w - 300)) <= 10 && Math.abs(resized.v.size - (r1.h + 40)) <= 10, JSON.stringify(resized));

    // 5. Reorder inside a stack by dragging
    await sleep(400);
    const bw = await rect('btn-weather'), bs = await rect('btn-settings');
    const hitInfo = await evaluate(`__fmtvPreview().hit(${bw.x + bw.w / 2}, ${bw.y + bw.h / 2})`);
    await drag(await screen(bw.x + bw.w / 2, bw.y + bw.h / 2), await screen(bs.x + bs.w - 6, bs.y + bs.h / 2));
    const order = (await node('shortcuts')).node.children.map((c) => c.id);
    check('arrastar reordena dentro da stack', JSON.stringify(order) === '["btn-settings","btn-weather"]', JSON.stringify(order) + ' hit=' + JSON.stringify(hitInfo) + ' ptr=' + JSON.stringify(await evaluate('window.__ptr')) + ' bw=' + JSON.stringify(bw));

    // 6. Drag a stack child out into the free (absolute) area of the screen
    await sleep(400);
    const bw2 = await rect('btn-weather');
    await drag(await screen(bw2.x + bw2.w / 2, bw2.y + bw2.h / 2), await screen(960, 420));
    const out = await node('btn-weather');
    // The middle of this layout is covered by the full-screen "shade" frame, so that is the container it lands in.
    check('tirar da stack para a tela vira posição absoluta', out.parent !== 'shortcuts' && !!out.node.constraints, JSON.stringify(out));

    // 7. Add a component from the library
    await evaluate(`${S}.setLeftTab('components')`);
    await sleep(200);
    const before = await evaluate(`${S}.project.layout.pages.home.root.children.length`);
    await evaluate(`${S}.select([])`);
    const btn = await evaluate(`(() => { const b = Array.from(document.querySelectorAll('.comp')).find(e => e.textContent.trim() === 'Texto').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    await mouse('mouseMoved', btn.x, btn.y, 0); await mouse('mousePressed', btn.x, btn.y); await mouse('mouseReleased', btn.x, btn.y, 0); await sleep(300);
    check('clicar em "Texto" na biblioteca adiciona um texto', (await evaluate(`${S}.project.layout.pages.home.root.children.length`)) === before + 1);

    // 8. Edit a property in the panel
    const sel = (await evaluate(`${S}.selection`))[0];
    await evaluate(`(() => { const t = document.querySelector('.props textarea'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); })()`);
    await send('Input.insertText', { text: ' de teste' });
    await sleep(200);
    check('editar o texto no painel atualiza o documento', (await node(sel)).node.props.text === 'Texto de teste', JSON.stringify((await node(sel)).node.props));
    await sleep(400);
    const shown = await evaluate(`document.querySelector('iframe').contentDocument.querySelector('[data-fmtv-id="${sel}"]').textContent`);
    check('o canvas (runtime da TV) mostra o texto novo', shown === 'Texto de teste', shown);

    // 9. Delete
    await evaluate(`document.activeElement.blur()`);
    await key('Delete', 'Delete', 0, 46);
    check('Delete remove o elemento', !(await node(sel)));

    // 9b. Toolbar "stack" button creates a visible empty stack
    const clickEl = async (selector, text) => {
        const p = await evaluate(`(() => { const all = Array.from(document.querySelectorAll(${JSON.stringify(selector)})); const b = ${text ? `all.find(e => e.textContent.trim() === ${JSON.stringify(text)})` : 'all[0]'}; if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
        if (!p) throw new Error('não achei ' + selector + ' ' + (text || ''));
        await mouse('mouseMoved', p.x, p.y, 0); await mouse('mousePressed', p.x, p.y); await mouse('mouseReleased', p.x, p.y, 0);
        await sleep(400);
    };
    await evaluate(`${S}.select([])`);
    await clickEl('button[title^="Stack vertical"]');
    const newStack = (await evaluate(`${S}.selection`))[0];
    const ns = await node(newStack);
    check('botão de stack da barra cria uma stack vertical', ns && ns.node.type === 'stack' && ns.node.layout.direction === 'vertical', JSON.stringify(ns));
    await sleep(300);
    check('stack vazia aparece com contorno no canvas', (await evaluate(`document.querySelectorAll('.ov-empty').length`)) >= 1);

    // 9c. Auto layout grid: bottom-right cell = end/end for a vertical stack
    await clickEl('.align-grid .ag-cell:last-child');
    const lay = (await node(newStack)).node.layout;
    check('grade 3×3 define alinhamento nos dois eixos', lay.justify === 'end' && lay.align === 'end', JSON.stringify(lay));
    await clickEl('.al-auto-btn');
    check('"Auto" distribui com espaço entre', (await node(newStack)).node.layout.justify === 'space-between');

    // 9d. Remove / add auto layout keeps children in place
    await evaluate(`${S}.select(['shortcuts'])`);
    await sleep(300);
    const posBefore = await evaluate(`[${S}.rects['btn-settings']].map(r => Math.round(r.x) + ',' + Math.round(r.y))[0]`);
    await clickEl('.prop-section button[title="Remover auto layout"]');
    await sleep(500);
    const asFrame = await node('shortcuts');
    const posAfter = await evaluate(`[${S}.rects['btn-settings']].map(r => Math.round(r.x) + ',' + Math.round(r.y))[0]`);
    check('remover auto layout mantém os elementos no lugar', asFrame.node.type === 'frame' && posBefore === posAfter, posBefore + ' -> ' + posAfter);
    await key('A', 'KeyA', 8, 65); // Shift+A
    await sleep(500);
    check('Shift+A devolve o auto layout', (await node('shortcuts')).node.type === 'stack', JSON.stringify((await node('shortcuts')).node.type));

    // 9e. Insert a ready-made block and see real content in the TV runtime
    await evaluate(`${S}.select([]); ${S}.setLeftTab('components')`);
    await sleep(300);
    await clickEl('.block-item .block-name', 'Séries em alta');
    const blockId = (await evaluate(`${S}.selection`))[0];
    let cards = 0;
    for (let i = 0; i < 30 && !cards; i++) {
        cards = await evaluate(`(() => { const d = document.querySelector('iframe').contentDocument; const el = d.querySelector('[data-fmtv-id="${blockId}"]'); return el ? el.querySelectorAll('.fmtv-card').length : 0; })()`);
        if (!cards) await sleep(200);
    }
    check('bloco "Séries em alta" mostra cartões no canvas', cards > 0, String(cards));

    // 9f. Save as block
    await evaluate(`${S}.select(['btn-settings'])`);
    await evaluate(`${S}.saveSelectionAsBlock()`);
    await sleep(300);
    check('"Salvar como bloco" aparece em Meus blocos', (await evaluate(`Array.from(document.querySelectorAll('.block-item .block-name')).some(e => e.textContent === 'Botão')`)) || (await evaluate(`(${S}.project.blocks || []).length`)) === 1);

    // 10. Validation stays clean
    check('o documento continua válido', (await evaluate(`${S}.validation.errors.length`)) === 0, JSON.stringify(await evaluate(`${S}.validation.errors`)));

    // 11. Preview + remote control
    await key('p', 'KeyP', 0, 80);
    await sleep(400);
    const f0 = await evaluate(`(() => { const e = document.querySelector('iframe').contentDocument.querySelector('.nav-item.focused'); return e && (e.dataset.id || e.dataset.fmtvId || e.id); })()`);
    await key('ArrowRight', 'ArrowRight', 0, 39);
    const f1 = await evaluate(`(() => { const e = document.querySelector('iframe').contentDocument.querySelector('.nav-item.focused'); return e && (e.dataset.id || e.dataset.fmtvId || e.id); })()`);
    check('Prévia: → move o foco como na TV', !!f0 && !!f1 && f0 !== f1, `${f0} -> ${f1}`);
    await key('ArrowUp', 'ArrowUp', 0, 38);
    await key('ArrowUp', 'ArrowUp', 0, 38);
    const f2 = await evaluate(`(() => { const e = document.querySelector('iframe').contentDocument.querySelector('.nav-item.focused'); return e && (e.dataset.id || e.getAttribute('data-fmtv-id') || e.id); })()`);
    check('Prévia: ↑ alcança os botões do layout', !!f2 && f2 !== f1, `${f1} -> ${f2}`);
    if (SHOT) {
        const shot = await send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(SHOT.replace(/\.png$/, '-preview.png'), Buffer.from(shot.data, 'base64'));
    }
    await key('Escape', 'Escape', 0, 27);
    check('Esc volta para a edição', (await evaluate(`${S}.mode`)) === 'edit');

    if (SHOT) {
        await evaluate(`${S}.setLeftTab('components'); ${S}.select(['shortcuts'])`);
        await sleep(600);
        const shot0 = await send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(SHOT.replace(/\.png$/, '-autolayout.png'), Buffer.from(shot0.data, 'base64'));
        await evaluate(`${S}.setLeftTab('layers'); ${S}.select(['shortcuts'])`);
        await sleep(500);
        const shot = await send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
    }

    // Reported case: blank template, select the screen, Shift+A, then "bottom centre" in the grid.
    console.log('\n[Studio e2e: modelo Em branco + auto layout na Tela]');
    await evaluate(`${S}.load(${S}.project, 'x'); __fmtvStudio.setState({ dirty: false })`);
    await send('Page.navigate', { url: `${BASE}/?template=blank&select=root` });
    await waitFor(`window.__fmtvStudio && ${S}.project.layout.name === 'Novo layout' && !!${S}.rects['apps'] && !!${S}.rects['customize']`);
    await sleep(500);
    await evaluate(`${S}.select(['root']); document.activeElement && document.activeElement.blur()`);
    await key('A', 'KeyA', 8, 65); // Shift+A
    await sleep(600);
    const scr = (await node('root')).node;
    check('Shift+A na Tela cria stack vertical (botão em cima, prateleira embaixo)', scr.type === 'stack' && scr.layout.direction === 'vertical'
        && JSON.stringify(scr.children.map((c) => c.id)) === '["customize","apps"]', JSON.stringify(scr.layout) + ' ' + JSON.stringify(scr.children.map((c) => c.id)));
    check('a prateleira esticada vira Fill', JSON.stringify(scr.children[1].size.width) === '{"mode":"fill"}', JSON.stringify(scr.children[1].size));
    const cell = await evaluate(`(() => { const c = document.querySelectorAll('.align-grid .ag-cell')[7]; c.scrollIntoView({ block: 'center' }); const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await mouse('mouseMoved', cell.x, cell.y, 0); await mouse('mousePressed', cell.x, cell.y); await mouse('mouseReleased', cell.x, cell.y, 0);
    await sleep(900);
    const al = (await node('root')).node.layout;
    check('"inferior centro" = conteúdo no fim do eixo vertical, centralizado na horizontal', al.justify === 'end' && al.align === 'center', JSON.stringify(al));
    const ra = await rect('apps'), rc = await rect('customize');
    check('prateleira inteira dentro da tela', ra.x >= 0 && ra.x + ra.w <= 1920 && ra.y + ra.h <= 1080, JSON.stringify(ra));
    check('botão centralizado na horizontal', Math.abs(rc.x + rc.w / 2 - 960) <= 2, JSON.stringify(rc));
    check('conteúdo encostado embaixo (respeitando o padding)', Math.abs(1080 - (ra.y + ra.h) - 260) <= 2, JSON.stringify(ra));
    if (SHOT) {
        const shot = await send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(SHOT.replace(/\.png$/, '-tela-autolayout.png'), Buffer.from(shot.data, 'base64'));
    }

    // Phase 5: other screens
    console.log('\n[Studio e2e: outras telas]');
    const clickAt = async (expr) => {
        const p = await evaluate(`(() => { const b = ${expr}; if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
        if (!p) throw new Error('elemento não encontrado: ' + expr);
        await mouse('mouseMoved', p.x, p.y, 0); await mouse('mousePressed', p.x, p.y); await mouse('mouseReleased', p.x, p.y, 0);
        await sleep(600);
    };
    const frameEval = (code) => evaluate(`(() => { const w = document.querySelector('iframe').contentWindow, d = w.document; ${code} })()`);
    await evaluate(`${S}.setLeftTab('pages')`);
    await sleep(300);
    await clickAt(`Array.from(document.querySelectorAll('.page-item')).find(e => e.querySelector('.page-name').textContent === 'Clima')`);
    check('aba Páginas abre a tela de clima', (await evaluate(`${S}.page`)) === 'weather');
    check('canvas mostra o painel de clima original aberto', await frameEval(`return w.drawerOpen === true && !d.querySelector('[data-fmtv-page="weather"]');`));
    await clickAt(`document.querySelector('.page-original .btn')`);
    check('"Personalizar esta tela" cria a tela a partir do original', (await evaluate(`!!${S}.project.layout.pages.weather`)) && await frameEval(`return !!d.querySelector('#weatherDrawer [data-fmtv-page="weather"] .drawer-current');`));
    await evaluate(`${S}.updatePanel(p => { p.placement = 'center'; p.width = 720; p.height = 620; })`);
    await sleep(700);
    check('posição "Centro" e largura 720 chegam ao painel da TV', await frameEval(`const wd = d.getElementById('weatherDrawer'); return wd.getAttribute('data-fmtv-place') === 'center' && Math.round(wd.querySelector('.drawer-panel').getBoundingClientRect().width) === 720;`));
    const wsel = await evaluate(`Object.keys(${S}.rects).sort().join(',')`);
    check('seleção/medidas só da tela atual', /weather-current/.test(wsel) && !/(^|,)apps(,|$)/.test(wsel), wsel);
    if (SHOT) {
        await evaluate(`${S}.select(['weather-root'])`);
        await sleep(600);
        const shotW = await send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(SHOT.replace(/\.png$/, '-weather.png'), Buffer.from(shotW.data, 'base64'));
    }

    await evaluate(`${S}.setPage('settings')`);
    await sleep(700);
    check('tela Personalizar aberta no canvas', await frameEval(`return w.modalOpen === true;`));
    await evaluate(`${S}.customizePage('settings'); __fmtvStudio.setState({ toasts: [] })`);
    await sleep(500);
    await evaluate(`${S}.select(['settings-actions']); document.activeElement && document.activeElement.blur()`);
    await key('Delete', 'Delete', 0, 46);
    await sleep(400);
    check('remover Salvar/Cancelar é avisado na hora', (await evaluate(`${S}.toasts.some(t => /Mudança inválida/.test(t.text))`)) && (await evaluate(`${S}.validation.errors.some(e => /Botões Salvar/.test(e.message))`)));
    check('o canvas continua com os botões (última versão válida)', await frameEval(`return !!d.querySelector('#settingsModal #saveModalBtn');`));
    await key('z', 'KeyZ', 2, 90);
    await sleep(400);
    check('Ctrl+Z devolve os botões e o layout volta a ser válido', (await evaluate(`${S}.validation.errors.length`)) === 0);

    await evaluate(`${S}.setPage('screensaver')`);
    await sleep(700);
    check('protetor aberto no canvas e parado para edição', await frameEval(`return w.screensaverOn === true && d.getElementById('screensaverClockWrap').style.transform === 'none';`));
    await sleep(1500);
    check('protetor não é fechado enquanto é a tela editada', await frameEval(`return w.screensaverOn === true;`));
    await evaluate(`${S}.customizePage('screensaver')`);
    await evaluate(`${S}.updateNode('screensaver-clock', n => { n.props = { ...n.props, clockSize: 200, showDate: false }; })`);
    await sleep(600);
    check('tamanho do relógio e data oculta aplicados', await frameEval(`return getComputedStyle(d.getElementById('screensaverClock')).fontSize === '200px' && getComputedStyle(d.getElementById('screensaverDate')).display === 'none';`));

    await evaluate(`${S}.setPage('messages')`);
    await sleep(600);
    await evaluate(`${S}.customizePage('messages')`);
    await evaluate(`${S}.updatePanel(p => { p.placement = 'bottom'; })`);
    await sleep(600);
    check('mensagem de exemplo visível, embaixo', await frameEval(`const t = d.getElementById('toastMsg'); const r = t.getBoundingClientRect(); return t.style.display === 'block' && Math.round(w.innerHeight - r.bottom) === 40;`));
    check('mensagem selecionável no canvas', (await evaluate(`!!${S}.rects['message']`)));

    await evaluate(`${S}.setPage('home')`);
    await sleep(700);
    check('voltar à tela inicial fecha as outras telas', await frameEval(`return !w.drawerOpen && !w.modalOpen && !w.screensaverOn && d.getElementById('toastMsg').style.display !== 'block';`));
    check('documento com todas as telas continua válido', (await evaluate(`${S}.validation.errors.length`)) === 0, JSON.stringify(await evaluate(`${S}.validation.errors`)));

    // Phase 6: focus map, accessibility alerts, TV resolution
    console.log('\n[Studio e2e: mapa de foco, acessibilidade e resolução]');
    await evaluate(`${S}.load(${S}.project, 'x'); __fmtvStudio.setState({ dirty: false })`);
    await send('Page.navigate', { url: `${BASE}/?template=blank` });
    await waitFor(`window.__fmtvStudio && ${S}.project.layout.name === 'Novo layout' && !!${S}.rects['apps'] && !!${S}.rects['customize']`);
    await waitFor(`${S}.audit.focus && ${S}.audit.focus.items.length > 3`);
    check('modelo Em branco sem alertas de acessibilidade', (await evaluate(`${S}.audit.issues.length`)) === 0, JSON.stringify(await evaluate(`${S}.audit.issues`)));
    await evaluate(`document.activeElement && document.activeElement.blur()`);
    await key('f', 'KeyF', 0, 70);
    await sleep(400);
    const fm = await evaluate(`({ on: ${S}.showFocusMap, boxes: document.querySelectorAll('.fm-item').length, items: ${S}.audit.focus.items.length,
        start: (document.querySelector('.fm-item.start .fm-badge') || {}).textContent, legend: !!document.querySelector('[data-testid=focus-legend]') })`);
    check('tecla F mostra o mapa de foco com um quadro por item navegável', fm.on && fm.boxes === fm.items && fm.boxes > 3 && fm.legend, JSON.stringify(fm));
    const startTile = await evaluate(`(() => { const f = ${S}.audit.focus; const d = document.querySelector('iframe').contentDocument; const el = Array.from(d.querySelectorAll('.nav-item')).filter(e => e.offsetParent !== null)[f.start]; return el && el.classList.contains('app-tile'); })()`);
    check('o foco inicial é o primeiro app da prateleira, como na TV', fm.start === 'início' && startTile === true);
    // Hover an app tile: the arrows from it are drawn.
    const tileR = await evaluate(`(() => { const f = ${S}.audit.focus; return f.items[f.start + 1].rect; })()`);
    const tileP = await screen(tileR.x + tileR.w / 2, tileR.y + tileR.h / 2);
    await mouse('mouseMoved', tileP.x, tileP.y, 0);
    await sleep(300);
    const arrows = await evaluate(`({ lines: document.querySelectorAll('.fm-arrows line').length, tip: (document.querySelector('.fm-tip') || {}).textContent || '' })`);
    check('passar o mouse num item mostra para onde cada seta leva', arrows.lines >= 2 && /clique/.test(arrows.tip), JSON.stringify(arrows));

    const hiddenId = await evaluate(`(() => { const r = ${S}.rects['customize']; return ${S}.addNode('button', { parentId: 'root', index: 99, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) } }); })()`);
    // Two buttons on the same spot: the TV's pickNext always lands on the same one, the other never gets focus.
    const pair = JSON.stringify([hiddenId, 'customize']);
    await waitFor(`${S}.audit.issues.some(i => i.rule === 'unreachable' && ${pair}.includes(i.nodeId))`, 6000).catch(() => {});
    check('botão em cima de outro: um deles fica "inalcançável", com quadro vermelho',
        (await evaluate(`${S}.audit.issues.filter(i => i.rule === 'unreachable' && ${pair}.includes(i.nodeId)).length`)) === 1 && (await evaluate(`document.querySelectorAll('.fm-item.lost').length`)) === 1,
        JSON.stringify(await evaluate(`${S}.audit.issues`)));
    await key('z', 'KeyZ', 2, 90);
    await waitFor(`!${S}.audit.issues.some(i => i.rule === 'unreachable')`, 6000).catch(() => {});
    check('desfazer remove o alerta', !(await evaluate(`${S}.audit.issues.some(i => i.rule === 'unreachable')`)));

    // Dark grey, small text glued to the left edge.
    const textId = await evaluate(`${S}.addNode('text', { parentId: 'root', index: 99, rect: { x: 20, y: 460, w: 420, h: 40 } })`);
    await evaluate(`${S}.updateNode(${JSON.stringify(textId)}, n => { n.props = { text: 'Texto difícil de ler' }; n.text = { size: 12, color: '#333333' }; })`);
    await waitFor(`${S}.audit.issues.filter(i => i.nodeId === ${JSON.stringify(textId)}).length >= 3`, 6000).catch(() => {});
    const rules = await evaluate(`${S}.audit.issues.filter(i => i.nodeId === ${JSON.stringify(textId)}).map(i => i.rule).sort().join(',')`);
    check('texto cinza-escuro, 12 px, na borda: contraste, tamanho e área segura', rules === 'contrast,safe-area,text-size', rules);
    const cmsg = await evaluate(`(${S}.audit.issues.find(i => i.rule === 'contrast') || {}).message || ''`);
    check('alerta de contraste diz a razão e as cores', /Contraste de 1,\d:1/.test(cmsg) && /#333333/.test(cmsg) && /4,5:1/.test(cmsg), cmsg);

    // 17 px, light, inside the safe area: fine in 1080p, blurry in 720p.
    await evaluate(`${S}.updateNode(${JSON.stringify(textId)}, n => { n.text = { size: 17, color: '#f5f5f7' }; n.constraints.h.offset = 200; })`);
    await waitFor(`${S}.audit.issues.length === 0`, 6000).catch(() => {});
    check('texto claro de 17 px dentro da área segura: sem alertas em 1080p', (await evaluate(`${S}.audit.issues.length`)) === 0, JSON.stringify(await evaluate(`${S}.audit.issues`)));
    await evaluate(`${S}.setTvRes('720p')`);
    await waitFor(`${S}.audit.issues.some(i => i.rule === 'resolution')`, 6000).catch(() => {});
    const r720 = await evaluate(`${S}.audit.issues.filter(i => i.rule === 'resolution').map(i => i.message)`);
    check('em 720p o mesmo texto vira 11,3 px reais e é avisado', r720.some((m) => /720p/.test(m) && /11,3 px reais/.test(m)), JSON.stringify(r720));
    const status = await evaluate(`document.querySelector('[data-testid=a11y-status]').textContent`);
    check('barra de baixo conta os alertas de acessibilidade', /alerta\(s\) de acessibilidade/.test(status), status);

    const one = await evaluate(`(() => { const r = document.querySelector('[data-testid=actual-size]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await mouse('mouseMoved', one.x, one.y, 0); await mouse('mousePressed', one.x, one.y); await mouse('mouseReleased', one.x, one.y, 0);
    await sleep(300);
    const zr = await evaluate(`${S}.zoom`);
    check('"1:1" em 720p: 1 pixel da TV = 1 pixel da tela', Math.abs(zr - 1280 / 1920) < 0.01, String(zr));

    // Clicking an alert selects its element.
    await evaluate(`${S}.select([])`);
    const st = await evaluate(`(() => { const r = document.querySelector('[data-testid=a11y-status]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await mouse('mouseMoved', st.x, st.y, 0); await mouse('mousePressed', st.x, st.y); await mouse('mouseReleased', st.x, st.y, 0);
    await sleep(300);
    const pr = await evaluate(`(() => { const b = Array.from(document.querySelectorAll('.problem.a11y')).find(e => /720p/.test(e.textContent)); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2 }; })()`);
    if (pr) { await mouse('mouseMoved', pr.x, pr.y, 0); await mouse('mousePressed', pr.x, pr.y); await mouse('mouseReleased', pr.x, pr.y, 0); await sleep(300); }
    check('clicar no alerta seleciona o elemento', JSON.stringify(await evaluate(`${S}.selection`)) === JSON.stringify([textId]), JSON.stringify(await evaluate(`${S}.selection`)));
    if (SHOT) {
        const shotF = await send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(SHOT.replace(/\.png$/, '-focus.png'), Buffer.from(shotF.data, 'base64'));
    }

    // Phase 7: publishing over ADB, against the pretend Fire TV of `npm run dev:fake-tv`.
    const hi = await evaluate(`fetch('/api/fmtv/hello', { headers: { 'x-fmtv-studio': '1' } }).then(r => r.json()).catch(() => null)`);
    if (!hi || !hi.simulated) {
        console.log('\n[Studio e2e: publicação] pulado: rode o Studio com "npm run dev:fake-tv" para testar com o Fire TV simulado');
    } else {
        console.log('\n[Studio e2e: publicação no Fire TV simulado]');
        const click = async (sel) => {
            const p = await evaluate(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
            if (!p) throw new Error('não encontrado: ' + sel);
            await mouse('mouseMoved', p.x, p.y, 0); await mouse('mousePressed', p.x, p.y); await mouse('mouseReleased', p.x, p.y, 0);
            await sleep(300);
        };
        const D = '__fmtvDevices.getState()';
        const jobDone = (ms = 20000) => waitFor(`${D}.job && ${D}.job.done`, ms);
        const card = (serial) => `document.querySelector('.dev-item[data-serial="${serial}"]')`;
        const FAKE = 'G070VM2011FAKE';
        await evaluate(`${S}.load(${S}.project, 'x'); __fmtvStudio.setState({ dirty: false }); localStorage.removeItem('fmtv.studio.devices')`);
        // Start from one pretend TV: drop network TVs left connected by an earlier run.
        await evaluate(`(async () => { const h = { 'x-fmtv-studio': '1', 'content-type': 'application/json' };
            const { devices } = await (await fetch('/api/fmtv/devices', { headers: h })).json();
            for (const d of devices) if (d.network) await fetch('/api/fmtv/disconnect', { method: 'POST', headers: h, body: JSON.stringify({ serial: d.serial }) }); })()`);
        await send('Page.navigate', { url: `${BASE}/?template=cinema` });
        await waitFor(`window.__fmtvStudio && ${S}.project.layout.name === 'Cinema' && !!${S}.rects['big-clock']`);
        await waitFor(`window.__fmtvDevices && ${D}.devices.length > 0`);
        check('o aparelho único e pronto já vem escolhido; o nome aparece na barra', (await evaluate(`${D}.selected`)) === FAKE
            && /Fire TV Stick 4K Max \(AFTKA\)/.test(await evaluate(`document.querySelector('[data-testid=devices-btn]').textContent`)));

        await click('[data-testid=publish-btn]');
        await waitFor(`!!document.querySelector('[data-testid=devices-dialog]')`);
        await jobDone();
        const job1 = await evaluate(`${D}.job`);
        check('Publicar envia o Cinema, com o progresso, e a TV confirma', job1.ok && /confirmado na TV/.test(job1.message)
            && job1.logs.some((l) => /pacote pronto/.test(l)) && job1.logs.some((l) => /enviando/.test(l)), JSON.stringify(job1));
        await waitFor(`/Na TV: Cinema confirmado/.test(${card(FAKE)}.textContent)`, 8000).catch(() => {});
        check('o cartão do aparelho mostra o layout confirmado', /Na TV: Cinema confirmado/.test(await evaluate(`${card(FAKE)}.textContent`)));

        // The pretend TV fails to draw a layout whose name says so: the TV rolls back by itself.
        await evaluate(`${S}.commit('nome', p => { p.layout.name = 'Teste falha-na-tv'; })`);
        await click('[data-testid=publish-here]');
        await jobDone();
        const job2 = await evaluate(`${D}.job`);
        check('layout que falha na TV: o Studio mostra o motivo e que a TV voltou ao anterior', !job2.ok && /falhou na TV/.test(job2.message) && /layout anterior/.test(job2.message), JSON.stringify(job2));
        await sleep(800);
        check('a TV continua com o Cinema', /Na TV: Cinema confirmado/.test(await evaluate(`${card(FAKE)}.textContent`)));

        await click(`.dev-item[data-serial="${FAKE}"] .dev-actions .btn:nth-of-type(3)`); // Tela original
        await jobDone();
        await sleep(800);
        const afterReset = await evaluate(`${card(FAKE)}.textContent`);
        check('"Tela original" desliga o layout e guarda o Cinema como anterior', /Na TV: tela original/.test(afterReset) && /Anterior: Cinema/.test(afterReset), afterReset);
        await click(`.dev-item[data-serial="${FAKE}"] .dev-actions .btn:nth-of-type(2)`); // Voltar ao anterior
        await jobDone();
        await sleep(800);
        check('"Voltar ao anterior" traz o Cinema de volta', /Na TV: Cinema confirmado/.test(await evaluate(`${card(FAKE)}.textContent`)));

        await click(`.dev-item[data-serial="${FAKE}"] .dev-actions .btn:nth-of-type(4)`); // Histórico da TV
        await waitFor(`!!document.querySelector('[data-testid=device-log]') && /importado/.test(document.querySelector('[data-testid=device-log]').textContent)`, 8000).catch(() => {});
        const tvLog = await evaluate(`(document.querySelector('[data-testid=device-log]') || {}).textContent || ''`);
        check('histórico da própria TV: importações, falha e rollbacks', /importado cinema/.test(tvLog) && /falhou/.test(tvLog) && /desativado/.test(tvLog), tvLog.slice(0, 300));

        // Connect a second TV by IP, typing like a person.
        await click('[data-testid=device-address]');
        await send('Input.insertText', { text: '192.168.0.50' });
        await click('.dev-add .btn.primary');
        await jobDone();
        await waitFor(`!!${card('192.168.0.50:5555')}`, 8000).catch(() => {});
        check('conectar por IP adiciona o aparelho e passa a usá-lo', (await evaluate(`!!${card('192.168.0.50:5555')}`)) && (await evaluate(`${D}.selected`)) === '192.168.0.50:5555');
        await click('[data-testid=device-address]');
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65, commands: ['selectAll'] });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
        await send('Input.insertText', { text: '192.168.0.77' });
        await click('.dev-add .btn.primary');
        await jobDone();
        await sleep(500);
        check('TV que ainda não autorizou: o Studio explica o que fazer', /autoriza/.test(await evaluate(`${card('192.168.0.77:5555')}.textContent`))
            && /Permitir depuração/.test(await evaluate(`${D}.job.message`)));
        check('IPs usados ficam lembrados', JSON.stringify(await evaluate(`${D}.addresses`)) === '["192.168.0.77","192.168.0.50"]', JSON.stringify(await evaluate(`${D}.addresses`)));
        const hist = await evaluate(`${D}.history.map(h => h.op + ':' + h.ok)`);
        check('histórico deste PC registra publicações e comandos', hist.length === 4 && hist.includes('publish:true') && hist.includes('publish:false'), JSON.stringify(hist));
        if (SHOT) {
            await evaluate(`document.querySelector('.dlg-body').scrollTop = 0`);
            await sleep(300);
            const shotD = await send('Page.captureScreenshot', { format: 'png' });
            writeFileSync(SHOT.replace(/\.png$/, '-devices.png'), Buffer.from(shotD.data, 'base64'));
        }
        await key('Escape', 'Escape', 0, 27);
        check('Esc fecha a janela de dispositivos', !(await evaluate(`!!document.querySelector('[data-testid=devices-dialog]')`)));
    }

    // Phase 8: publishing over the internet, with a real Free My TV Cloud server and a pretend TV.
    console.log('\n[Studio e2e: publicação pela internet]');
    {
        const here = dirname(fileURLToPath(import.meta.url));
        const repo = join(here, '..', '..');
        const cloudPort = 5620 + Math.floor(Math.random() * 300);
        const CLOUD_URL = `http://127.0.0.1:${cloudPort}`;
        const cloudData = mkdtempSync(join(tmpdir(), 'fmtv-e2e-cloud-'));
        cloudProc = spawn(process.execPath, [join(repo, 'server', 'fmtv-cloud.mjs'), '--port', String(cloudPort), '--host', '127.0.0.1', '--data', cloudData], { stdio: 'ignore' });
        for (let i = 0; i < 50; i++) { try { if ((await fetch(CLOUD_URL + '/v1/health')).ok) break; } catch { await sleep(100); } }
        tvProc = spawn(process.execPath, [join(repo, 'tools', 'test', 'fake-cloud-tv.mjs'), CLOUD_URL], { stdio: ['ignore', 'pipe', 'inherit'] });
        const first = await new Promise((r) => { let b = ''; tvProc.stdout.on('data', (d) => { b += d; if (b.includes('\n')) r(JSON.parse(b.split('\n')[0])); }); });
        const D = '__fmtvDevices.getState()';
        const clickSel = async (sel) => {
            const p = await evaluate(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
            if (!p) throw new Error('não encontrado: ' + sel);
            await mouse('mouseMoved', p.x, p.y, 0); await mouse('mousePressed', p.x, p.y); await mouse('mouseReleased', p.x, p.y, 0);
            await sleep(300);
        };
        const typeInto = async (sel, text) => {
            await clickSel(sel);
            await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65, commands: ['selectAll'] });
            await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
            await send('Input.insertText', { text });
        };
        const jobDone = (ms = 30000) => waitFor(`${D}.job && ${D}.job.done`, ms);
        const card = () => `document.querySelector('.dev-item[data-serial="cloud:${first.deviceId}"]')`;

        await evaluate(`${S}.load(${S}.project, 'x'); __fmtvStudio.setState({ dirty: false }); localStorage.removeItem('fmtv.studio.devices')`);
        await send('Page.navigate', { url: `${BASE}/?template=cinema` });
        await waitFor(`window.__fmtvStudio && ${S}.project.layout.name === 'Cinema' && !!${S}.rects['big-clock']`);
        await clickSel('[data-testid=devices-btn]');
        await waitFor(`!!document.querySelector('[data-testid=cloud-server]')`);

        await typeInto('[data-testid=cloud-server]', 'http://evil.example');
        await typeInto('[data-testid=cloud-code]', first.pairCode);
        await clickSel('[data-testid=cloud-code] ~ .btn.primary');
        await jobDone();
        check('servidor sem https é recusado antes de enviar o código', /https/.test(await evaluate(`${D}.job.message`)) && !(await evaluate(`${D}.job.ok`)), await evaluate(`${D}.job.message`));

        await typeInto('[data-testid=cloud-server]', CLOUD_URL);
        await typeInto('[data-testid=cloud-code]', 'AAAA-AAAA');
        await clickSel('[data-testid=cloud-code] ~ .btn.primary');
        await jobDone();
        check('código errado: o servidor recusa e o Studio explica', /inválido ou expirado/.test(await evaluate(`${D}.job.message`)), await evaluate(`${D}.job.message`));

        await typeInto('[data-testid=cloud-code]', first.pairCode.toLowerCase());
        await clickSel('[data-testid=cloud-code] ~ .btn.primary');
        await jobDone();
        await waitFor(`!!${card()} && /conectada/.test(${card()}.textContent)`, 8000).catch(() => {});
        check('código da TV: pareado, TV conectada e escolhida para publicar', (await evaluate(`${D}.job.ok`)) && /conectada/.test(await evaluate(`(${card()} || {}).textContent || ''`))
            && (await evaluate(`${D}.selected`)) === 'cloud:' + first.deviceId, await evaluate(`${D}.job.message`));
        check('a barra mostra a TV pela internet', /internet/.test(await evaluate(`document.querySelector('[data-testid=devices-btn]').textContent`)));

        await key('Escape', 'Escape', 0, 27); // the dialog covers the top bar
        await clickSel('[data-testid=publish-btn]');
        await waitFor(`${D}.job && ${D}.job.op === 'publish' && ${D}.job.done`, 30000);
        const j1 = await evaluate(`${D}.job`);
        check('Publicar pela internet: o servidor confere, a TV aplica e confirma', j1.ok && /confirmado na TV/.test(j1.message) && j1.logs.some((l) => /conferiu/.test(l)), JSON.stringify(j1));
        await waitFor(`/Na TV: Cinema confirmado/.test(${card()}.textContent)`, 8000).catch(() => {});
        check('o cartão mostra o layout confirmado na TV', /Na TV: Cinema confirmado/.test(await evaluate(`${card()}.textContent`)));

        await evaluate(`${S}.commit('nome', p => { p.layout.name = 'Teste falha-na-tv'; })`);
        await clickSel(`.dev-item[data-serial="cloud:${first.deviceId}"] [data-testid=cloud-publish]`);
        await jobDone();
        const j2 = await evaluate(`${D}.job`);
        check('layout que falha na TV: volta sozinha ao anterior e o Studio mostra o motivo', !j2.ok && /falhou na TV/.test(j2.message) && /layout anterior/.test(j2.message), JSON.stringify(j2));

        await clickSel(`.dev-item[data-serial="cloud:${first.deviceId}"] .dev-actions .btn:nth-of-type(3)`); // Tela original
        await jobDone();
        await sleep(600);
        const afterReset = await evaluate(`${card()}.textContent`);
        check('"Tela original" pela internet', /Na TV: tela original/.test(afterReset) && /Anterior: Cinema/.test(afterReset), afterReset);
        await clickSel(`.dev-item[data-serial="cloud:${first.deviceId}"] .dev-actions .btn:nth-of-type(2)`); // Voltar ao anterior
        await jobDone();
        await sleep(600);
        check('"Voltar ao anterior" pela internet', /Na TV: Cinema confirmado/.test(await evaluate(`${card()}.textContent`)), await evaluate(`${card()}.textContent`));

        await clickSel(`.dev-item[data-serial="cloud:${first.deviceId}"] .dev-actions .btn:nth-of-type(4)`); // Histórico
        const hist = await evaluate(`(document.querySelector('[data-testid=cloud-log]') || {}).textContent || ''`);
        check('histórico da TV guardado no servidor', /confirmado na TV/.test(hist) && /falhou na TV/.test(hist) && /tela original/.test(hist), hist.slice(0, 300));
        if (SHOT) {
            const shotC = await send('Page.captureScreenshot', { format: 'png' });
            writeFileSync(SHOT.replace(/\.png$/, '-cloud.png'), Buffer.from(shotC.data, 'base64'));
        }

        const token = await evaluate(`JSON.parse(localStorage.getItem('fmtv.studio.devices')).cloud[0].token`);
        await clickSel(`.dev-item[data-serial="cloud:${first.deviceId}"] .dev-actions .btn:nth-of-type(5)`); // Remover
        await sleep(500);
        const gone = (await fetch(`${CLOUD_URL}/v1/devices/${first.deviceId}`, { headers: { authorization: 'Bearer ' + token } })).status;
        check('"Remover" revoga o acesso no servidor e some da lista', gone === 401 && !(await evaluate(`!!${card()}`)) && !(await evaluate(`localStorage.getItem('fmtv.studio.devices')`)).includes(token), String(gone));
        await key('Escape', 'Escape', 0, 27);
    }
} catch (e) {
    check('execução', false, e.stack || String(e));
} finally {
    try { ws?.close(); } catch { /* ignore */ }
    proc.kill();
    cloudProc?.kill();
    tvProc?.kill();
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* chrome may still hold files */ }
}
if (pageErrors.length) {
    console.log('\n  erros na página:');
    pageErrors.slice(0, 5).forEach((e) => console.log('   ' + String(e).split('\n').slice(0, 4).join('\n   ')));
}
check('sem erros de JavaScript na página', pageErrors.length === 0);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n✗ ${failed} de ${results.length} falharam` : `\n✓ ${results.length} verificações passaram (Chrome real, eventos de mouse e teclado)`);
process.exit(failed ? 1 : 0);
