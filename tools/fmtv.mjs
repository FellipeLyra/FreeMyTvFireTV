#!/usr/bin/env node
// Free My TV layout CLI: validate, package and publish layouts.
//
//   node tools/fmtv.mjs validate <layout.json> [--assets DIR]
//   node tools/fmtv.mjs pack     <layout.json> [--assets DIR] [-o out.fmtv]
//   node tools/fmtv.mjs inspect  <package.fmtv>
//   node tools/fmtv.mjs devices
//   node tools/fmtv.mjs publish  <layout.json|package.fmtv> [--assets DIR] [--device IP|SERIAL]
//   node tools/fmtv.mjs rollback [--device IP|SERIAL]
//   node tools/fmtv.mjs reset    [--device IP|SERIAL]
//   node tools/fmtv.mjs status   [--device IP|SERIAL]
//   node tools/fmtv.mjs log      [--device IP|SERIAL]
//   node tools/fmtv.mjs serve    [--port 5611]   (ponte para o Studio publicar)
//
// `--assets` defaults to "<layout name>-assets" next to the layout file.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, basename, resolve } from 'node:path';
import { prepare, buildPackage, unzip, engine } from './lib/package.mjs';
import { Adb, AdbError } from './lib/adb.mjs';
import { serve } from './lib/bridge.mjs';

function parseArgs(argv) {
    const args = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--assets') args.assets = argv[++i];
        else if (a === '-o' || a === '--out') args.out = argv[++i];
        else if (a === '--device') args.device = argv[++i];
        else if (a === '--json') args.json = true;
        else if (a === '--port') args.port = Number(argv[++i]);
        else args._.push(a);
    }
    return args;
}

function defaultAssets(layoutPath) {
    return join(dirname(layoutPath), basename(layoutPath).replace(/\.json$/i, '') + '-assets');
}

function printIssues(v) {
    for (const e of v.errors) console.log(`  ✗ ${e.path || '(layout)'}: ${e.message}`);
    for (const w of v.warnings) console.log(`  ! ${w.path || '(layout)'}: ${w.message}`);
}

function load(layoutPath, assets) {
    const { layout, files, validation } = prepare(layoutPath, assets || defaultAssets(layoutPath));
    return { layout, files, validation };
}

async function connectDevice(args, log) {
    const adb = new Adb({ log });
    let serial = args.device || null;
    if (serial && /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(serial)) {
        log(`conectando em ${serial}…`);
        serial = await adb.connect(serial);
    }
    const d = await adb.select(serial);
    log(`dispositivo: ${d.serial}${d.model ? ' (' + d.model + ')' : ''}`);
    const v = await adb.appVersion();
    log(`Free My TV ${v.versionName} instalado`);
    return adb;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const cmd = args._[0];
    const log = (m) => console.log('· ' + m);

    switch (cmd) {
        case 'validate': {
            const file = args._[1];
            if (!file) throw new Error('uso: validate <layout.json>');
            const { validation } = load(file, args.assets);
            if (args.json) { console.log(JSON.stringify(validation, null, 2)); break; }
            console.log(validation.ok ? `✓ ${file} é válido (schema ${engine.SCHEMA_VERSION})` : `✗ ${file} tem erros`);
            printIssues(validation);
            process.exitCode = validation.ok ? 0 : 1;
            break;
        }
        case 'pack': {
            const file = args._[1];
            if (!file) throw new Error('uso: pack <layout.json> [-o out.fmtv]');
            const { layout, files, validation } = load(file, args.assets);
            printIssues(validation);
            if (!validation.ok) { console.log('✗ layout inválido; nada foi gerado'); process.exitCode = 1; break; }
            const out = args.out || file.replace(/\.json$/i, '') + '.fmtv';
            const bytes = buildPackage(layout, files);
            writeFileSync(out, bytes);
            console.log(`✓ ${out} (${bytes.length} bytes, ${files.length} asset(s))`);
            break;
        }
        case 'inspect': {
            const file = args._[1];
            const entries = unzip(readFileSync(file));
            for (const e of entries) console.log(`  ${e.name}  ${e.data.length} bytes`);
            const layout = entries.find((e) => e.name === 'layout.json');
            if (!layout) { console.log('✗ sem layout.json'); process.exitCode = 1; break; }
            const v = engine.validate(layout.data.toString('utf8'));
            console.log(v.ok ? '✓ layout válido' : '✗ layout inválido');
            printIssues(v);
            break;
        }
        case 'devices': {
            const list = await new Adb().devices();
            if (!list.length) console.log('nenhum dispositivo');
            for (const d of list) console.log(`  ${d.serial}  ${d.state}  ${d.model}`);
            break;
        }
        case 'publish': {
            const file = args._[1];
            if (!file) throw new Error('uso: publish <layout.json|package.fmtv> [--device IP]');
            let bytes;
            if (/\.fmtv$/i.test(file)) {
                bytes = readFileSync(file);
                const layout = unzip(bytes).find((e) => e.name === 'layout.json');
                const v = engine.validate(layout ? layout.data.toString('utf8') : '');
                printIssues(v);
                if (!v.ok) { console.log('✗ pacote inválido; nada foi enviado'); process.exitCode = 1; break; }
            } else {
                const { layout, files, validation } = load(file, args.assets);
                printIssues(validation);
                if (!validation.ok) { console.log('✗ layout inválido; nada foi enviado'); process.exitCode = 1; break; }
                bytes = buildPackage(layout, files);
            }
            const adb = await connectDevice(args, log);
            const r = await adb.publish(bytes);
            if (r.ok) console.log(`✓ layout aplicado e confirmado na TV (${r.id || r.status?.id})`);
            else {
                console.log(`✗ não aplicado (${r.stage}): ${r.error || r.reason || 'erro desconhecido'}`);
                if (r.restored) console.log(`  a TV voltou para: ${r.restored === 'previous' ? 'o layout anterior' : 'a tela original'}`);
                process.exitCode = 1;
            }
            break;
        }
        case 'rollback':
        case 'reset': {
            const adb = await connectDevice(args, log);
            const r = await adb.command(cmd);
            if (!r) { console.log('✗ sem resposta da TV'); process.exitCode = 1; break; }
            console.log(cmd === 'reset' ? '✓ tela original restaurada (o layout fica guardado como anterior)'
                : `✓ voltou para ${r.restored === 'previous' ? 'o layout anterior' : 'a tela original'}`);
            break;
        }
        case 'status': {
            const adb = await connectDevice(args, log);
            const r = await adb.readResult();
            console.log(r ? JSON.stringify(r.status, null, 2) : 'sem informações (nenhum layout publicado ainda)');
            break;
        }
        case 'log': {
            const adb = await connectDevice(args, log);
            const lines = await adb.readLog();
            console.log(lines.length ? lines.join('\n') : 'histórico vazio (nenhum layout publicado ainda)');
            break;
        }
        case 'serve': {
            const port = args.port || 5611;
            await serve(port);
            console.log(`✓ ponte do Studio em http://127.0.0.1:${port} (Ctrl+C encerra). Só aceita pedidos do próprio Studio.`);
            return;
        }
        default:
            console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 15).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
            process.exitCode = cmd ? 1 : 0;
    }
}

main().catch((e) => {
    console.error('✗ ' + (e instanceof AdbError ? e.message : e.stack || e.message));
    process.exitCode = 1;
});
