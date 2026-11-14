// The Studio canvas renders layouts with the launcher's real page (the same files
// the APK ships). In development the Vite server serves them live from
// app/src/main/assets/web (see vite.config.ts); for builds this script copies them
// into public/runtime. preview.html is the page with a stand-in for the Android
// bridge: no layout from the device, no app launching, and preview mode on so the
// editor drives rendering.
import { cpSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const WEB_DIR = join(here, '..', '..', 'app', 'src', 'main', 'assets', 'web');

const MOCK = `<script>
  // Free My TV Studio preview: the editor renders layouts through window.FMTVLayout.
  window.__fmtvPreviewMode = true;
  try { if (!localStorage.getItem('fmtv_city')) localStorage.setItem('fmtv_city', 'São Paulo'); } catch (e) {}
  window.FireTV = {
    getLayoutJson: function () { return ''; },
    getLayoutStatus: function () { return '{}'; },
    layoutRendered: function () {}, layoutFailed: function () {}, resetLayout: function () {},
    listLaunchPoints: function (id) { setTimeout(function () { window.__fmtvResolve(id, { returnValue: true, launchPoints: [] }); }, 0); },
    launch: function (id, app) {
      try { window.parent.postMessage({ type: 'fmtv:launch', appId: app }, '*'); } catch (e) {}
      setTimeout(function () { window.__fmtvResolve(id, { returnValue: true }); }, 0);
    }
  };
</script>`;

/** preview.html: the launcher page with the Studio's bridge stand-in. */
export function previewHtml() {
    const html = readFileSync(join(WEB_DIR, 'index.html'), 'utf8');
    const marker = '<script src="firetv-bridge.js"></script>';
    if (!html.includes(marker)) throw new Error('bridge script tag not found in index.html');
    return html.replace(marker, MOCK + marker);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const out = join(here, '..', 'public', 'runtime');
    if (!existsSync(join(WEB_DIR, 'index.html'))) throw new Error('launcher page not found at ' + WEB_DIR);
    rmSync(out, { recursive: true, force: true });
    cpSync(WEB_DIR, out, { recursive: true });
    writeFileSync(join(out, 'preview.html'), previewHtml());
    console.log('runtime copied to public/runtime');
}
