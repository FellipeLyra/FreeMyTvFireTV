// Unit tests for the shared layout engine and the package format.
//   node --test tools/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { engine as E, prepare, buildPackage, unzip, zip, crc32 } from '../lib/package.mjs';

const EX = join(fileURLToPath(new URL('../../examples/layouts/', import.meta.url)));

function base(rootExtra = {}, extra = {}) {
    return {
        schemaVersion: 1, id: 'test', name: 'Teste',
        pages: { home: { root: { id: 'root', type: 'stack', children: [{ id: 'apps', type: 'launcher.app-shelf' }], ...rootExtra } } },
        ...extra,
    };
}
const messages = (v) => v.errors.map((e) => e.message).join(' | ');

test('example layouts are valid', () => {
    for (const name of ['classic', 'cinema']) {
        const { validation } = prepare(join(EX, name + '.json'), join(EX, name + '-assets'));
        assert.equal(validation.ok, true, name + ': ' + messages(validation));
    }
});

test('minimal layout is valid and accepts JSON text', () => {
    assert.equal(E.validate(base()).ok, true);
    assert.equal(E.validate(JSON.stringify(base())).ok, true);
    assert.equal(E.validate('{not json').ok, false);
});

test('rejects unknown components, fields and duplicate ids', () => {
    assert.match(messages(E.validate(base({ children: [{ id: 'x', type: 'iframe' }] }))), /componente desconhecido/);
    assert.match(messages(E.validate(base({ onclick: 'alert(1)' }))), /campo desconhecido/);
    assert.match(messages(E.validate(base({ children: [{ id: 'apps', type: 'launcher.app-shelf' }, { id: 'apps', type: 'text' }] }))), /id repetido/);
});

test('colors cannot smuggle CSS', () => {
    for (const bad of ['red;background:url(http://x)', 'url(x)', 'expression(alert(1))', '#12345', 'rgb(1,2)']) {
        const v = E.validate(base({ style: { background: { type: 'solid', color: bad } } }));
        assert.equal(v.ok, false, bad);
    }
    for (const good of ['#fff', '#0a84ffcc', 'rgba(1, 2, 3, 0.5)', 'transparent', '$colors.accent']) {
        assert.equal(E.validate(base({ style: { background: { type: 'solid', color: good } } })).ok, true, good);
    }
});

test('asset names cannot leave the assets folder and need a hash', () => {
    const asset = (file) => base({ style: { background: { type: 'image', asset: 'bg' } } },
        { assets: [{ id: 'bg', file, sha256: 'a'.repeat(64), bytes: 10 }] });
    for (const bad of ['../x.png', 'a/b.png', 'x.svg', 'x.html', '.hidden.png']) assert.equal(E.validate(asset(bad)).ok, false, bad);
    assert.equal(E.validate(asset('bg.jpg')).ok, true);
    const noHash = base({}, { assets: [{ id: 'bg', file: 'bg.jpg', bytes: 10 }] });
    assert.match(messages(E.validate(noHash)), /SHA-256/);
});

test('a home page with nothing focusable is rejected', () => {
    const v = E.validate(base({ children: [{ id: 't', type: 'text', props: { text: 'oi' } }] }));
    assert.match(messages(v), /nenhum elemento navegável/);
});

test('each launcher widget can be used once', () => {
    const v = E.validate(base({ children: [{ id: 'a', type: 'launcher.app-shelf' }, { id: 'b', type: 'launcher.app-shelf' }] }));
    assert.match(messages(v), /mais de uma vez/);
});

test('actions are whitelisted', () => {
    const btn = (action) => base({ children: [{ id: 'apps', type: 'launcher.app-shelf' }, { id: 'b', type: 'button', props: { label: 'x', action } }] });
    assert.equal(E.validate(btn({ type: 'launch-app', appId: 'com.netflix.ninja' })).ok, true);
    assert.equal(E.validate(btn({ type: 'launch-app', appId: 'rm -rf /' })).ok, false);
    assert.equal(E.validate(btn({ type: 'shell', cmd: 'reboot' })).ok, false);
});

test('absolute children need both constraints', () => {
    const frame = (c) => base({ type: 'frame', children: [{ id: 'apps', type: 'launcher.app-shelf', constraints: c }] });
    assert.equal(E.validate(frame({ h: { anchor: 'start', offset: 10, size: 100 } })).ok, false);
    assert.equal(E.validate(frame({ h: { anchor: 'start', offset: 10, size: 100 }, v: { anchor: 'stretch', start: 0, end: 0 } })).ok, true);
});

test('newer schema versions are refused with a clear message', () => {
    const v = E.validate({ ...base(), schemaVersion: 99 });
    assert.match(messages(v), /Atualize o app/);
});

test('limits: nodes, text length', () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ id: 's' + i, type: 'stack', children: [1, 2, 3, 4].map((k) => ({ id: 't' + i + '_' + k, type: 'spacer' })) }));
    assert.match(messages(E.validate(base({ children: [{ id: 'apps', type: 'launcher.app-shelf' }, ...many] }))), /mais de 600 elementos/);
    const long = base({ children: [{ id: 'apps', type: 'launcher.app-shelf' }, { id: 't', type: 'text', props: { text: 'x'.repeat(501) } }] });
    assert.equal(E.validate(long).ok, false);
});

test('stack children: fixed, hug, fill and gap', () => {
    const tokens = E.mergeTokens({});
    const parent = { id: 'p', type: 'stack', layout: { direction: 'horizontal', gap: '$spacing.md' } };
    const fixed = E.nodeCss({ id: 'a', type: 'spacer', size: { width: { mode: 'fixed', value: 120 } } }, parent, tokens, { index: 0 });
    assert.equal(fixed.width, '120px');
    assert.equal(fixed['margin-left'], undefined);
    const fill = E.nodeCss({ id: 'b', type: 'text', size: { width: { mode: 'fill' }, height: { mode: 'fill' } } }, parent, tokens, { index: 1 });
    assert.equal(fill.flex, '1 1 0');
    assert.equal(fill['align-self'], 'stretch');
    assert.equal(fill['margin-left'], '16px');
    const vertical = E.nodeCss({ id: 'c', type: 'text' }, { id: 'q', type: 'stack', layout: { direction: 'vertical', gap: 10 } }, tokens, { index: 2 });
    assert.equal(vertical['margin-top'], '10px');
    const stack = E.nodeCss({ id: 's', type: 'stack', layout: { direction: 'vertical', justify: 'space-between', align: 'center', padding: [1, 2, 3, 4] } }, null, tokens);
    assert.equal(stack['flex-direction'], 'column');
    assert.equal(stack['justify-content'], 'space-between');
    assert.equal(stack.padding, '1px 2px 3px 4px');
});

test('absolute constraints map to CSS', () => {
    const t = E.mergeTokens({});
    const frame = { id: 'f', type: 'frame' };
    const css = (h, v) => E.nodeCss({ id: 'n', type: 'text', constraints: { h, v } }, frame, t, {});
    let c = css({ anchor: 'start', offset: 64, size: 300 }, { anchor: 'end', offset: 40, size: 100 });
    assert.deepEqual([c.position, c.left, c.width, c.bottom, c.height], ['absolute', '64px', '300px', '40px', '100px']);
    c = css({ anchor: 'center', offset: 10, size: 200 }, { anchor: 'stretch', start: 5, end: 6 });
    assert.equal(c.left, 'calc(50% - 100px + 10px)');
    assert.deepEqual([c.top, c.bottom], ['5px', '6px']);
    c = css({ anchor: 'scale', start: 10, size: 80 }, { anchor: 'start', offset: 0, size: 1 });
    assert.deepEqual([c.left, c.width], ['10%', '80%']);
});

test('tokens, gradients and images become CSS', () => {
    const t = E.mergeTokens({ colors: { accent: '#ff0000' } });
    assert.equal(E.resolveToken('$colors.accent', t, 'color'), '#ff0000');
    assert.equal(E.resolveToken('$colors.missing', t, 'color'), undefined);
    const g = E.nodeCss({ id: 'g', type: 'frame', style: { background: { type: 'linear', angle: 90, stops: [{ color: '$colors.accent', pos: 0 }, { color: '#000', pos: 100 }] } } }, null, t);
    assert.equal(g.background, 'linear-gradient(90deg, #ff0000 0%, #000 100%)');
    const img = E.nodeCss({ id: 'i', type: 'frame', style: { background: { type: 'image', asset: 'bg', fit: 'contain' } } }, null, t, { assetUrl: () => '/userlayout/assets/bg.jpg' });
    assert.equal(img.background, 'url("/userlayout/assets/bg.jpg") center / contain no-repeat');
    const vars = E.rootVars(t);
    assert.equal(vars['--accent'], '#ff0000');
    assert.equal(vars['--fmtv-accent'], '#ff0000');
});

test('focus: grid navigation', () => {
    // 3 x 2 grid of 100x100 tiles with 20px gaps
    const items = [];
    for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) items.push({ x: c * 120, y: r * 120, w: 100, h: 100 });
    assert.equal(E.pickNext(items, 0, 'right'), 1);
    assert.equal(E.pickNext(items, 1, 'down'), 4);
    assert.equal(E.pickNext(items, 5, 'left'), 4);
    assert.equal(E.pickNext(items, 4, 'up'), 1);
    assert.equal(E.pickNext(items, 2, 'right'), -1);
    assert.equal(E.pickNext(items, 0, 'up'), -1);
    assert.deepEqual(E.reachable(items, 0), [0, 1, 2, 3, 4, 5]);
});

test('focus: a tile still lifted by its animation stays in its row', () => {
    // Middle tile shifted 8px up and scaled, as while its focus animation runs.
    const items = [{ x: 0, y: 100, w: 200, h: 200 }, { x: 210, y: 88, w: 220, h: 220 }, { x: 440, y: 100, w: 200, h: 200 }, { x: 600, y: 0, w: 120, h: 40 }];
    assert.equal(E.pickNext(items, 2, 'up'), 3);
    assert.equal(E.pickNext(items, 0, 'up'), 3);
    assert.equal(E.pickNext(items, 0, 'right'), 1);
});

test('focus: prefers the aligned row over a closer diagonal element', () => {
    const items = [
        { x: 0, y: 0, w: 100, h: 50 },      // current
        { x: 400, y: 70, w: 100, h: 50 },   // close vertically but far to the side
        { x: 0, y: 300, w: 100, h: 50 },    // directly below, further away
    ];
    assert.equal(E.pickNext(items, 0, 'down'), 2);
});

test('packages round-trip and carry integrity data', () => {
    const { layout, files, validation } = prepare(join(EX, 'cinema.json'), join(EX, 'cinema-assets'));
    assert.equal(validation.ok, true);
    const entries = unzip(buildPackage(layout, files));
    assert.deepEqual(entries.map((e) => e.name), ['layout.json', 'assets/aurora.jpg']);
    const packed = JSON.parse(entries[0].data.toString('utf8'));
    assert.match(packed.assets[0].sha256, /^[0-9a-f]{64}$/);
    assert.equal(packed.assets[0].bytes, entries[1].data.length);
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
    assert.throws(() => unzip(Buffer.concat([zip([{ name: 'a', data: Buffer.from('x') }]).subarray(0, 31), Buffer.from('y')])));
});

test('migration framework refuses unknown old versions', () => {
    assert.equal(E.migrate({ schemaVersion: 0 }).ok, false);
    assert.equal(E.migrate({ schemaVersion: 1, x: 1 }).ok, true);
});

test('content blocks: valid props pass, bad ones fail', () => {
    const page = (child) => ({ schemaVersion: 1, id: 't', name: 'T', pages: { home: { root: { id: 'root', type: 'stack', children: [child] } } } });
    assert.equal(E.validate(page({ id: 'r', type: 'content-row', props: { source: 'shows', cardStyle: 'wide', maxItems: 6, showTitles: false } })).ok, true);
    assert.equal(E.validate(page({ id: 'g', type: 'content-grid', props: { source: 'apps', columns: 6 } })).ok, true);
    assert.equal(E.validate(page({ id: 'b', type: 'banner', props: { source: 'movies', rotateSeconds: 0, buttonLabel: 'Ver' } })).ok, true);
    assert.equal(E.validate(page({ id: 'r', type: 'content-row', props: { source: 'youtube' } })).ok, false);
    assert.equal(E.validate(page({ id: 'r', type: 'content-row', props: { showTitles: 'yes' } })).ok, false);
    assert.equal(E.validate(page({ id: 'g', type: 'content-grid', props: { columns: 12 } })).ok, false);
    assert.equal(E.validate(page({ id: 'b', type: 'banner', props: { source: 'apps' } })).ok, false);
    // A full-weather block that does not open the drawer cannot be the only focusable thing.
    assert.match(messages(E.validate(page({ id: 'w', type: 'weather-full', props: { opensDrawer: false } }))), /navegável/);
    assert.equal(E.validate(page({ id: 'w', type: 'weather-full' })).ok, true);
});

test('icons come from the fixed set only', () => {
    const page = (props) => ({ schemaVersion: 1, id: 't', name: 'T', pages: { home: { root: { id: 'root', type: 'stack', children: [{ id: 'apps', type: 'launcher.app-shelf' }, { id: 'i', type: 'icon', props }] } } } });
    assert.equal(E.validate(page({ name: 'heart', color: '#ff0000' })).ok, true);
    assert.equal(E.validate(page({ name: '<svg onload=alert(1)>' })).ok, false);
    assert.ok(Object.keys(E.ICONS).length >= 20);
    for (const d of Object.values(E.ICONS)) assert.match(d, /^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]+$/);
});

test('example layouts with content blocks are valid and need no app shelf warning', () => {
    const { validation } = prepare(join(EX, 'streaming.json'), join(EX, 'streaming-assets'));
    assert.equal(validation.ok, true, messages(validation));
    assert.equal(validation.warnings.length, 0, JSON.stringify(validation.warnings));
});
