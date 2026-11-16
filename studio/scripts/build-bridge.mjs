#!/usr/bin/env node
// Phase 9: the desktop Studio carries its own bridge to the Fire TV, so nobody
// needs Node or the Android SDK installed. This script makes:
//
//   src-tauri/bin/fmtv.exe   the fmtv CLI (tools/fmtv.mjs) bundled with esbuild and
//                            turned into a single executable with Node's SEA
//                            (`node --build-sea`, Node 25.5+). The Studio runs
//                            `fmtv.exe serve --exit-with-stdin` when it opens.
//   src-tauri/bin/adb/       adb.exe and its two DLLs from Android platform-tools
//                            (Apache 2.0; NOTICE.txt goes along).
//
// Run by `npm run desktop:build` (tauri.conf.json → beforeBuildCommand).
// Where adb comes from: $ADB_DIR, $ANDROID_HOME/platform-tools, or the SDK in
// ~/android-build-tools/sdk/platform-tools.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const bin = join(here, '..', 'src-tauri', 'bin');
const work = join(bin, '.work');
const win = process.platform === 'win32';
const exe = join(bin, win ? 'fmtv.exe' : 'fmtv');

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 25 || (major === 25 && minor < 5)) {
    console.error(`✗ precisa do Node 25.5 ou mais novo (node --build-sea); este é o ${process.versions.node}`);
    process.exit(1);
}

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

// 1. One CommonJS file with the CLI, the bridge, the device check and engine.js.
const bundle = join(work, 'fmtv.cjs');
await build({
    entryPoints: [join(repo, 'tools', 'fmtv.mjs')],
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile: bundle,
    legalComments: 'none', logLevel: 'warning',
    banner: { js: '// Free My TV CLI and Studio bridge (bundled; source in tools/).' },
});

// 2. A single executable.
const config = join(work, 'sea-config.json');
writeFileSync(config, JSON.stringify({ main: bundle, output: exe, disableExperimentalSEAWarning: true, useCodeCache: false }));
const r = spawnSync(process.execPath, ['--build-sea', config], { encoding: 'utf8' });
if (r.status !== 0) { console.error(r.stdout + r.stderr); process.exit(1); }
const help = spawnSync(exe, ['--help'], { encoding: 'utf8' });
if (!/fmtv check/.test(help.stdout)) { console.error('✗ o executável não respondeu como esperado:\n' + help.stdout + help.stderr); process.exit(1); }
console.log(`✓ ${exe} (${Math.round(statSync(exe).size / 1048576)} MB)`);

// 3. adb.
const adbName = win ? 'adb.exe' : 'adb';
const sources = [
    process.env.ADB_DIR,
    process.env.ANDROID_HOME && join(process.env.ANDROID_HOME, 'platform-tools'),
    process.env.ANDROID_SDK_ROOT && join(process.env.ANDROID_SDK_ROOT, 'platform-tools'),
    join(homedir(), 'android-build-tools', 'sdk', 'platform-tools'),
    win && process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools'),
].filter(Boolean);
const from = sources.find((d) => existsSync(join(d, adbName)));
if (!from) {
    console.error('✗ adb não encontrado: baixe o Android platform-tools e defina ADB_DIR com a pasta dele');
    process.exit(1);
}
const adbDir = join(bin, 'adb');
rmSync(adbDir, { recursive: true, force: true });
mkdirSync(adbDir, { recursive: true });
for (const f of win ? ['adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll', 'NOTICE.txt'] : ['adb', 'NOTICE.txt']) {
    if (existsSync(join(from, f))) copyFileSync(join(from, f), join(adbDir, f));
    else if (f !== 'NOTICE.txt') { console.error(`✗ falta ${f} em ${from}`); process.exit(1); }
}
console.log(`✓ adb de ${from}`);
rmSync(work, { recursive: true, force: true });
