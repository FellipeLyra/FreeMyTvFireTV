#!/usr/bin/env node
// End-to-end test of the Studio in real Chrome, driven through the DevTools
// Protocol with real mouse and keyboard events (no test framework needed).
// Needs the dev server: `npm run dev` (port 5610), then `node scripts/e2e.mjs`.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
} catch (e) {
    check('execução', false, e.stack || String(e));
} finally {
    try { ws?.close(); } catch { /* ignore */ }
    proc.kill();
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
