#!/usr/bin/env node
// End-to-end test of the layout runtime in headless Chrome.
//
// Serves the launcher page exactly as the APK does (/assets/web/index.html and
// /userlayout/assets/...), replaces the Android bridge with a recording mock,
// and checks each scenario: no layout, valid layouts, an invalid layout, and
// remote-control navigation. This is a browser simulation, not a Fire TV.
//
//   node tools/browser-test.mjs [--chrome PATH] [--shots DIR]
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, extname, resolve, normalize } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { prepare } from './lib/package.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const WEB = join(ROOT, 'app', 'src', 'main', 'assets', 'web');
const EXAMPLES = join(ROOT, 'examples', 'layouts');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const chrome = opt('--chrome') || [
    process.env.CHROME,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => p && existsSync(p));
const shotsDir = opt('--shots');
if (!chrome) { console.error('Chrome/Chromium não encontrado (use --chrome)'); process.exit(2); }

function layoutJson(name) {
    const p = prepare(join(EXAMPLES, name + '.json'), join(EXAMPLES, name + '-assets'));
    if (!p.validation.ok) throw new Error(name + ' inválido: ' + JSON.stringify(p.validation.errors));
    return JSON.stringify(p.layout);
}

const invalid = JSON.parse(readFileSync(join(EXAMPLES, 'classic.json'), 'utf8'));
invalid.id = 'broken';
invalid.pages.home.root.style = { background: { type: 'solid', color: 'red;background:url(http://evil)' } };

const SCENARIOS = {
    none: { layout: '' },
    classic: { layout: layoutJson('classic'), assets: null },
    cinema: { layout: layoutJson('cinema'), assets: join(EXAMPLES, 'cinema-assets') },
    invalid: { layout: JSON.stringify(invalid) },
};

// Runs inside the page before firetv-bridge.js: a recording stand-in for AppBridge.
const MOCK = (layout) => `<script>
(function(){
  var log = window.__fmtvTestLog = { calls: [], errors: [], focus: [] };
  window.addEventListener('error', function(e){ log.errors.push(String(e.message)); });
  try { localStorage.clear(); localStorage.setItem('fmtv_lang','pt'); localStorage.setItem('fmtv_city','São Paulo'); } catch (e) {}
  var installed = ['com.amazon.firetv.youtube','com.netflix.ninja','com.amazon.avod','com.disney.disneyplus','com.wbd.stream','com.globo.globotv'];
  window.FireTV = {
    getLayoutJson: function(){ log.calls.push(['getLayoutJson']); return ${JSON.stringify(layout)}; },
    layoutRendered: function(id){ log.calls.push(['layoutRendered', id]); },
    layoutFailed: function(id, reason){ log.calls.push(['layoutFailed', id, reason]); },
    resetLayout: function(){ log.calls.push(['resetLayout']); },
    listLaunchPoints: function(id){ setTimeout(function(){ window.__fmtvResolve(id, { returnValue: true,
      launchPoints: installed.map(function(p){ return { id: p, title: p }; }) }); }, 20); },
    launch: function(id, app){ log.calls.push(['launch', app]); setTimeout(function(){ window.__fmtvResolve(id, { returnValue: true }); }, 20); }
  };
  function describe(el){
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { id: el.id || el.getAttribute('data-fmtv-id') || el.getAttribute('data-id') || el.getAttribute('data-title') || el.className,
             tile: el.classList.contains('app-tile'), inLayout: !!(document.getElementById('fmtvLayoutRoot') || {contains:function(){return false;}}).contains(el),
             visible: r.width > 0 && r.height > 0 };
  }
  function press(key){
    var e; try { e = new KeyboardEvent('keydown', { key: key, bubbles: true, cancelable: true }); } catch (x) {}
    document.body.dispatchEvent(e);
    log.focus.push([key, describe(document.querySelector('.nav-item.focused'))]);
  }
  window.addEventListener('load', function(){
    setTimeout(function(){
      log.focus.push(['initial', describe(document.querySelector('.nav-item.focused'))]);
      ['ArrowRight','ArrowRight','ArrowUp','ArrowUp','ArrowDown','ArrowDown','ArrowDown','ArrowLeft'].forEach(press);
      var root = document.getElementById('fmtvLayoutRoot');
      var container = document.querySelector('.container');
      log.dom = {
        root: !!root,
        containerHidden: container ? getComputedStyle(container).display === 'none' : null,
        appsGridInRoot: !!(root && root.querySelector('#appsGrid')),
        parked: Array.prototype.map.call(document.querySelectorAll('#fmtvParking > *'), function(e){ return e.id || e.className; }),
        restoreButton: !!document.getElementById('fmtvRestoreLayout'),
        rootBackground: root ? getComputedStyle(root).backgroundImage.slice(0, 120) : null,
        tiles: document.querySelectorAll('#appsGrid .app-tile').length
      };
      // Put focus back where the screenshot expects it.
      var pre = document.createElement('pre'); pre.id = 'fmtvTestResult'; pre.style.display = 'none';
      pre.textContent = JSON.stringify(log); document.body.appendChild(pre);
    }, 3000);
  });
})();
</script>`;

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.css': 'text/css' };

function serveFile(res, base, rel) {
    const p = normalize(join(base, decodeURIComponent(rel)));
    if (!p.startsWith(base) || !existsSync(p)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' });
    res.end(readFileSync(p));
}

let current = null;
const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/assets/web/index.html' || url.pathname === '/assets/web/') {
        const html = readFileSync(join(WEB, 'index.html'), 'utf8')
            .replace('<script src="firetv-bridge.js"></script>', MOCK(SCENARIOS[current].layout) + '<script src="firetv-bridge.js"></script>');
        res.writeHead(200, { 'content-type': TYPES['.html'] });
        res.end(html);
    } else if (url.pathname.startsWith('/assets/web/')) {
        serveFile(res, WEB, url.pathname.slice('/assets/web/'.length));
    } else if (url.pathname.startsWith('/userlayout/assets/') && SCENARIOS[current].assets) {
        serveFile(res, SCENARIOS[current].assets, url.pathname.slice('/userlayout/assets/'.length));
    } else {
        res.writeHead(404); res.end();
    }
});

function runChrome(port, extra) {
    const profile = mkdtempSync(join(tmpdir(), 'fmtv-chrome-'));
    try {
        return spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
            `--user-data-dir=${profile}`, '--window-size=1920,1080', '--virtual-time-budget=20000', ...extra,
            `http://127.0.0.1:${port}/assets/web/index.html`], { encoding: 'utf8', timeout: 90000, maxBuffer: 64 * 1024 * 1024 });
    } finally {
        rmSync(profile, { recursive: true, force: true });
    }
}

const failures = [];
function check(name, cond, detail) {
    console.log(`  ${cond ? '✓' : '✗'} ${name}${cond || !detail ? '' : ' — ' + detail}`);
    if (!cond) failures.push(name);
}

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
for (const name of Object.keys(SCENARIOS)) {
    current = name;
    console.log(`\n[${name}]`);
    const r = runChrome(port, ['--dump-dom']);
    const m = /<pre id="fmtvTestResult"[^>]*>([\s\S]*?)<\/pre>/.exec(r.stdout || '');
    if (!m) { check('página carregou e o teste rodou', false, 'stdout=' + (r.stdout || '').length + ' status=' + r.status + ' ' + (r.stdout || '').slice(-400)); continue; }
    const log = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
    const calls = log.calls.map((c) => c[0]);
    const focus = log.focus;
    check('sem erros de JavaScript', log.errors.length === 0, log.errors.join(' | '));
    check('foco inicial existe', !!focus[0][1], JSON.stringify(focus[0]));
    check('todo foco cai em elemento visível', focus.every((f) => f[1] && f[1].visible), JSON.stringify(focus));

    if (name === 'none' || name === 'invalid') {
        check('tela original intacta', !log.dom.root && log.dom.containerHidden === false);
        check('prateleira com apps', log.dom.tiles > 0, String(log.dom.tiles));
    }
    if (name === 'none') check('nada reportado ao app', !calls.includes('layoutRendered') && !calls.includes('layoutFailed'));
    if (name === 'invalid') {
        const failed = log.calls.find((c) => c[0] === 'layoutFailed');
        check('falha reportada ao app (para rollback)', !!failed && failed[1] === 'broken');
        check('motivo cita a cor inválida', !!failed && /cor inválida/.test(failed[2]), failed && failed[2]);
    }
    if (name === 'classic' || name === 'cinema') {
        check('layout montado', log.dom.root && log.dom.containerHidden === true);
        check('widgets reais movidos para o layout', log.dom.appsGridInRoot && log.dom.tiles > 0);
        check('renderização confirmada ao app', log.calls.some((c) => c[0] === 'layoutRendered' && c[1] === name));
        check('botão "Layout padrão" no Personalizar', log.dom.restoreButton);
        check('foco inicial no primeiro app', focus[0][1] && focus[0][1].tile, JSON.stringify(focus[0][1]));
        const right = focus[1][1];
        check('→ vai para o próximo app', right && right.tile && right.id !== focus[0][1].id, JSON.stringify(right));
        const up = focus[3][1];
        check('↑ sai da prateleira', up && !up.tile, JSON.stringify(up));
        check('↓ volta para baixo da prateleira', focus.slice(5, 8).some((f) => f[1] && !f[1].tile && f[1].id !== up.id), JSON.stringify(focus.slice(5, 8)));
        check('foco nunca sai do layout', focus.every((f) => f[1] && f[1].inLayout), JSON.stringify(focus.filter((f) => !f[1] || !f[1].inLayout)));
        if (name === 'cinema') {
            check('fundo com o asset do layout', /userlayout\/assets\/aurora\.jpg/.test(log.dom.rootBackground), log.dom.rootBackground);
            check('destaque não usado ficou estacionado', log.dom.parked.some((p) => /hero-shelf/.test(p)), JSON.stringify(log.dom.parked));
        }
    }
    if (shotsDir) {
        mkdirSync(shotsDir, { recursive: true });
        runChrome(port, [`--screenshot=${join(resolve(shotsDir), name + '.png')}`]);
    }
}
server.close();
console.log(failures.length ? `\n✗ ${failures.length} verificação(ões) falharam` : '\n✓ todas as verificações passaram (simulação em navegador, não em Fire TV)');
process.exitCode = failures.length ? 1 : 0;
