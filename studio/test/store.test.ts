import { beforeEach, describe, expect, it } from 'vitest';
import { useEditor } from '../src/store/editor';
import { blankLayout, newProject, parseProject, serializeProject } from '../src/model/project';
import * as T from '../src/model/tree';
import { buildPackage } from '../src/lib/pack';
import { E } from '../src/engine';

const s = () => useEditor.getState();
const root = () => s().project.layout.pages.home.root;

beforeEach(() => {
    s().load(newProject(blankLayout('Teste')), 'Teste');
    // Rectangles as the canvas would measure them for the blank layout.
    s().setRects({ root: { x: 0, y: 0, w: 1920, h: 1080 }, apps: { x: 54, y: 520, w: 1812, h: 300 }, customize: { x: 1676, y: 40, w: 190, h: 50 } });
    useEditor.setState({ toasts: [] });
});

describe('history', () => {
    it('undo and redo restore exact documents', () => {
        const before = s().project;
        s().addNode('text');
        const after = s().project;
        expect(after).not.toBe(before);
        s().undo();
        expect(s().project).toBe(before);
        s().redo();
        expect(s().project).toBe(after);
    });
    it('coalesces fast edits of the same field into one step', () => {
        const id = s().addNode('text')!;
        const steps = s().past.length;
        s().updateNode(id, (n) => { n.props!.text = 'O'; }, 'text');
        s().updateNode(id, (n) => { n.props!.text = 'Oi'; }, 'text');
        s().updateNode(id, (n) => { n.props!.text = 'Oi!'; }, 'text');
        expect(s().past.length).toBe(steps + 1);
        s().undo();
        expect(T.find(root(), id)!.node.props!.text).toBe('Texto');
    });
    it('editor state is not part of history', () => {
        const steps = s().past.length;
        s().select(['apps']);
        s().setZoom(2);
        s().setMode('preview');
        expect(s().past.length).toBe(steps);
        expect(s().dirty).toBe(false);
    });
});

describe('editing', () => {
    it('adds components into frames with constraints, at the drop rect', () => {
        const id = s().addNode('button', { parentId: 'root', index: 0, rect: { x: 100, y: 200, w: 220, h: 64 } })!;
        const n = T.find(root(), id)!.node;
        expect(n.constraints).toEqual({ h: { anchor: 'start', offset: 100, size: 220 }, v: { anchor: 'start', offset: 200, size: 64 } });
        expect(s().selection).toEqual([id]);
    });
    it('refuses a second copy of a launcher widget', () => {
        expect(s().addNode('launcher.app-shelf')).toBeNull();
        expect(s().toasts.at(-1)!.text).toMatch(/já está na tela/);
    });
    it('moves absolute elements by a delta, keeping anchors', () => {
        s().moveAbsolute(['customize'], -100, 20);
        expect(T.find(root(), 'customize')!.node.constraints).toEqual({ h: { anchor: 'end', offset: 154, size: 190 }, v: { anchor: 'start', offset: 60, size: 50 } });
    });
    it('resizes from canvas rectangles', () => {
        s().setNodeRect('apps', { x: 100, y: 500, w: 1720, h: 320 });
        expect(T.find(root(), 'apps')!.node.constraints).toEqual({ h: { anchor: 'stretch', start: 100, end: 100 }, v: { anchor: 'end', offset: 260, size: 320 } });
    });
    it('deletes, duplicates, copies and pastes', () => {
        const id = s().addNode('text')!;
        s().select([id]);
        s().duplicateSelection();
        const dup = s().selection[0];
        expect(dup).not.toBe(id);
        expect(T.find(root(), dup)).toBeTruthy();
        s().copySelection();
        s().paste();
        expect(root().children!.length).toBe(5);
        s().select([id]);
        s().deleteSelection();
        expect(T.find(root(), id)).toBeNull();
    });
    it('locked elements are not deleted or moved', () => {
        s().toggleLocked('customize');
        s().select(['customize']);
        s().deleteSelection();
        expect(T.find(root(), 'customize')).toBeTruthy();
        const before = JSON.stringify(T.find(root(), 'customize')!.node.constraints);
        s().moveAbsolute(['customize'], 50, 50);
        expect(JSON.stringify(T.find(root(), 'customize')!.node.constraints)).toBe(before);
    });
    it('keeps the document valid through a typical session', () => {
        const stack = s().addNode('stack', { parentId: 'root', index: 0, rect: { x: 60, y: 40, w: 700, h: 120 } })!;
        s().addNode('text', { parentId: stack, index: 0 });
        s().addNode('clock-text', { parentId: stack, index: 1 });
        s().select(['customize']);
        s().moveNode('customize', { parentId: stack, index: 2 });
        const v = E.validate(s().project.layout);
        expect(v.errors).toEqual([]);
        expect(T.find(root(), 'customize')!.parent!.id).toBe(stack);
    });
});

describe('files', () => {
    it('project files round-trip and reject other files', () => {
        s().addNode('text');
        const text = serializeProject(s().project);
        expect(parseProject(text).layout).toEqual(s().project.layout);
        expect(() => parseProject('{"hello": 1}')).toThrow(/não é um projeto/);
        expect(() => parseProject('not json')).toThrow();
        // A bare layout.json opens as a project too.
        expect(parseProject(JSON.stringify(blankLayout('X'))).layout.name).toBe('X');
        expect(text).not.toMatch(/token|password|secret/i);
    });
    it('exports a package only when the layout is strictly valid', async () => {
        const ok = await buildPackage(s().project);
        expect(ok.ok).toBe(true);
        expect(Array.from(ok.bytes!.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
        s().commit('quebrar', (p) => { (p.layout.pages.home.root.children as unknown[]).length = 0; });
        const bad = await buildPackage(s().project);
        expect(bad.ok).toBe(false);
        expect(bad.errors[0].message).toMatch(/navegável/);
    });
    it('packages carry only used assets with fresh hashes', async () => {
        s().addAsset({ id: 'pic', file: 'pic.png', sha256: '0'.repeat(64), bytes: 1 }, btoa('hello'));
        s().addAsset({ id: 'unused', file: 'unused.png', sha256: '0'.repeat(64), bytes: 1 }, btoa('x'));
        s().updateNode('root', (n) => { n.style = { background: { type: 'image', asset: 'pic' } }; });
        const res = await buildPackage(s().project);
        expect(res.ok).toBe(true);
        expect(res.layout!.assets!.map((a) => a.id)).toEqual(['pic']);
        expect(res.layout!.assets![0].bytes).toBe(5);
        expect(res.layout!.assets![0].sha256).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    });
});

describe('stacks and blocks', () => {
    it('createStack adds an empty stack, or wraps the selection', () => {
        s().select([]);
        s().createStack('vertical');
        const id = s().selection[0];
        expect(T.find(root(), id)!.node.layout!.direction).toBe('vertical');
        s().select(['customize']);
        s().createStack('horizontal');
        const wrapped = T.find(root(), 'customize')!;
        expect(wrapped.parent!.type).toBe('stack');
        expect(wrapped.parent!.layout!.direction).toBe('horizontal');
    });
    it('Shift+A on a free container adds auto layout', () => {
        s().setRects({ ...s().rects });
        s().select(['root']);
        s().toggleAutoLayout();
        expect(root().type).toBe('stack');
        s().undo();
        expect(root().type).toBe('frame');
    });
    it('inserts built-in blocks with fresh ids and valid content', async () => {
        const { BUILTIN_BLOCKS } = await import('../src/model/blocks');
        for (const b of BUILTIN_BLOCKS) {
            s().select([]);
            const id = s().insertBlock(b);
            expect(id, b.id).toBeTruthy();
        }
        const v = E.validate(s().project.layout);
        expect(v.errors).toEqual([]);
        // Backgrounds go behind everything and cover the screen.
        expect(root().children![0].constraints).toEqual({ h: { anchor: 'stretch', start: 0, end: 0 }, v: { anchor: 'stretch', start: 0, end: 0 } });
    });
    it('saves the selection as a reusable block stored in the project', () => {
        const id = s().addNode('button')!;
        s().select([id]);
        s().saveSelectionAsBlock();
        const blocks = s().project.blocks!;
        expect(blocks).toHaveLength(1);
        expect(blocks[0].node.constraints).toBeUndefined();
        expect(blocks[0].node.size!.width).toEqual({ mode: 'fixed', value: 220 });
        const copy = s().insertBlock(blocks[0])!;
        expect(copy).not.toBe(id);
        expect(parseProject(serializeProject(s().project)).blocks).toHaveLength(1);
        s().select(['apps']);
        s().saveSelectionAsBlock();
        expect(s().project.blocks).toHaveLength(1); // launcher widgets cannot become blocks
    });
});
