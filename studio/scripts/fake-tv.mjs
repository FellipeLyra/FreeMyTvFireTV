#!/usr/bin/env node
// `npm run dev:fake-tv`: the Studio's dev server with a pretend Fire TV instead of
// the real adb (tools/test/fake-adb.mjs), to try publishing without a device.
// The pretend TVs start fresh every time.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const env = {
    ...process.env,
    ADB: join(here, '..', '..', 'tools', 'test', 'fake-adb.mjs'),
    FAKE_ADB_DIR: mkdtempSync(join(tmpdir(), 'fmtv-fake-tv-')),
};
console.log('Fire TV simulado (adb falso): ' + env.FAKE_ADB_DIR);
const vite = join(here, '..', 'node_modules', 'vite', 'bin', 'vite.js');
const p = spawn(process.execPath, [vite, ...process.argv.slice(2)], { stdio: 'inherit', env });
p.on('exit', (code) => process.exit(code ?? 0));
