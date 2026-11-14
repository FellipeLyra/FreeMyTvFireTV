// Copies the launcher page (the same files the APK ships) into public/runtime so
// the Studio canvas renders layouts with the real runtime. preview.html is the
// page with a stand-in for the Android bridge: no layout from the device, no
// app launching, and preview mode on so the editor drives rendering.
import { cpSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, '..', '..', 'app', 'src', 'main', 'assets', 'web');
const out = join(here, '..', 'public', 'runtime');
if (!existsSync(join(web, 'index.html'))) throw new Error('launcher page not found at ' + web);
rmSync(out, { recursive: true, force: true });
cpSync(web, out, { recursive: true });

const mock = `<script>
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
const html = readFileSync(join(web, 'index.html'), 'utf8');
const marker = '<script src="firetv-bridge.js"></script>';
if (!html.includes(marker)) throw new Error('bridge script tag not found in index.html');
writeFileSync(join(out, 'preview.html'), html.replace(marker, mock + marker));
console.log('runtime copied to public/runtime');
