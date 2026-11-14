import { describe, expect, it } from 'vitest';
import * as T from '../src/model/tree';
import { E } from '../src/engine';
import type { LayoutNode } from '../src/model/types';

function sample(): LayoutNode {
    return {
        id: 'root', type: 'frame', children: [
            { id: 'apps', type: 'launcher.app-shelf', constraints: { h: { anchor: 'stretch', start: 54, end: 54 }, v: { anchor: 'end', offset: 200, size: 300 } } },
            {
                id: 'row', type: 'stack', layout: { direction: 'horizontal', gap: 10 },
                constraints: { h: { anchor: 'start', offset: 100, size: 800 }, v: { anchor: 'start', offset: 100, size: 100 } },
                children: [
                    { id: 'a', type: 'text', props: { text: 'A' } },
                    { id: 'b', type: 'text', props: { text: 'B' } },
                    { id: 'c', type: 'button', props: { label: 'C', action: { type: 'open-settings' } } },
                ],
            },
        ],
    };
}
const PARENT = { w: 1920, h: 1080 };

describe('constraints', () => {
    it('round-trips every anchor', () => {
        for (const anchor of ['start', 'end', 'center', 'stretch', 'scale'] as const) {
            const c = T.axisConstraint(anchor, 120, 300, 1920);
            const [pos, size] = T.axisRange(c, 1920);
            expect(pos).toBeCloseTo(120, 0);
            expect(size).toBeCloseTo(300, 0);
        }
    });
    it('changing the anchor keeps the element in place', () => {
        const n: LayoutNode = { id: 'x', type: 'text', constraints: { h: { anchor: 'start', offset: 100, size: 200 }, v: { anchor: 'start', offset: 50, size: 40 } } };
        T.setAnchor(n, 'h', 'end', { x: 100, y: 50, w: 200, h: 40 }, PARENT);
        expect(n.constraints!.h).toEqual({ anchor: 'end', offset: 1620, size: 200 });
        T.setAnchor(n, 'v', 'center', { x: 100, y: 50, w: 200, h: 40 }, PARENT);
        expect(n.constraints!.v).toEqual({ anchor: 'center', offset: -470, size: 40 });
    });
    it('placeAbsolute keeps existing anchors', () => {
        const n: LayoutNode = { id: 'x', type: 'text', constraints: { h: { anchor: 'stretch', start: 10, end: 10 }, v: { anchor: 'end', offset: 0, size: 10 } } };
        T.placeAbsolute(n, { x: 20, y: 1000, w: 1880, h: 60 }, PARENT);
        expect(n.constraints).toEqual({ h: { anchor: 'stretch', start: 20, end: 20 }, v: { anchor: 'end', offset: 20, size: 60 } });
    });
});

describe('moving', () => {
    it('reorders inside a stack', () => {
        const r = sample();
        T.move(r, 'a', { parentId: 'row', index: 3 }, null);
        expect(T.find(r, 'row')!.node.children!.map((c) => c.id)).toEqual(['b', 'c', 'a']);
        T.move(r, 'c', { parentId: 'row', index: 0 }, null);
        expect(T.find(r, 'row')!.node.children!.map((c) => c.id)).toEqual(['c', 'b', 'a']);
    });
    it('stack child dropped into a frame becomes absolute at the drop point', () => {
        const r = sample();
        const note = T.move(r, 'b', { parentId: 'root', index: 9, rect: { x: 300, y: 400, w: 120, h: 40 }, parentSize: PARENT }, { x: 0, y: 0, w: 120, h: 40 });
        const b = T.find(r, 'b')!;
        expect(b.parent!.id).toBe('root');
        expect(b.node.constraints).toEqual({ h: { anchor: 'start', offset: 300, size: 120 }, v: { anchor: 'start', offset: 400, size: 40 } });
        expect(note).toMatch(/absoluta/);
    });
    it('absolute element dropped into a stack joins the flow with its size fixed', () => {
        const r = sample();
        const note = T.move(r, 'apps', { parentId: 'row', index: 1 }, { x: 54, y: 580, w: 1812, h: 300 });
        const apps = T.find(r, 'apps')!;
        expect(apps.parent!.id).toBe('row');
        expect(apps.node.constraints).toBeUndefined();
        expect(apps.node.size).toEqual({ width: { mode: 'fixed', value: 1812 }, height: { mode: 'fixed', value: 300 } });
        expect(note).toMatch(/fluxo/);
    });
    it('refuses to move a node into itself or the root anywhere', () => {
        const r = sample();
        expect(() => T.move(r, 'row', { parentId: 'row', index: 0 }, null)).toThrow();
        expect(() => T.move(r, 'root', { parentId: 'row', index: 0 }, null)).toThrow();
    });
    it('flow <-> absolute inside a stack preserves the visual box', () => {
        const r = sample();
        const row = T.find(r, 'row')!.node;
        const b = T.find(r, 'b')!.node;
        T.makeAbsolute(b, row, { x: 60, y: 10, w: 50, h: 30 }, { w: 800, h: 100 });
        expect(b.position).toBe('absolute');
        expect(b.constraints!.h).toEqual({ anchor: 'start', offset: 60, size: 50 });
        T.makeFlow(b, { x: 60, y: 10, w: 50, h: 30 });
        expect(b.position).toBeUndefined();
        expect(b.size!.width).toEqual({ mode: 'fixed', value: 50 });
    });
});

describe('grouping', () => {
    it('wraps absolute siblings in a stack placed at their bounds, ordered by position', () => {
        const r: LayoutNode = {
            id: 'root', type: 'frame', children: [
                { id: 'x', type: 'text', constraints: { h: { anchor: 'start', offset: 500, size: 100 }, v: { anchor: 'start', offset: 50, size: 40 } } },
                { id: 'y', type: 'text', constraints: { h: { anchor: 'start', offset: 100, size: 100 }, v: { anchor: 'start', offset: 60, size: 40 } } },
            ],
        };
        const rects = { x: { x: 500, y: 50, w: 100, h: 40 }, y: { x: 100, y: 60, w: 100, h: 40 } };
        const id = T.wrapInStack(r, ['x', 'y'], 'horizontal', rects, PARENT, T.allIds(r));
        const stack = T.find(r, id)!.node;
        expect(stack.children!.map((c) => c.id)).toEqual(['y', 'x']);
        expect(stack.children!.every((c) => !c.constraints)).toBe(true);
        expect(stack.constraints!.h).toEqual({ anchor: 'start', offset: 100, size: 500 });
        expect(stack.constraints!.v).toEqual({ anchor: 'start', offset: 50, size: 50 });
        expect(E.validate({ schemaVersion: 1, id: 't', name: 't', pages: { home: { root: r } } }, { studio: true }).errors).toEqual([]);
    });
    it('unwrap puts children back with their positions', () => {
        const r = sample();
        const ids = T.unwrap(r, 'row', { a: { x: 100, y: 100, w: 30, h: 40 }, b: { x: 140, y: 100, w: 30, h: 40 }, c: { x: 180, y: 100, w: 60, h: 40 } }, PARENT);
        expect(ids).toEqual(['a', 'b', 'c']);
        expect(T.find(r, 'c')!.node.constraints!.h).toEqual({ anchor: 'start', offset: 180, size: 60 });
    });
});

describe('alignment', () => {
    it('aligns and distributes', () => {
        const rs = [{ x: 0, y: 0, w: 10, h: 10 }, { x: 50, y: 20, w: 20, h: 10 }, { x: 200, y: 5, w: 10, h: 30 }];
        expect(T.alignRects(rs, 'left').map((r) => r.x)).toEqual([0, 0, 0]);
        expect(T.alignRects(rs, 'bottom').map((r) => r.y + r.h)).toEqual([35, 35, 35]);
        const d = T.distributeRects(rs, 'h');
        expect(d[1].x - (d[0].x + d[0].w)).toBeCloseTo(d[2].x - (d[1].x + d[1].w));
    });
});

describe('creating and cloning', () => {
    it('new nodes are valid and ids are unique and readable', () => {
        const taken = new Set<string>(['text-1']);
        for (const type of Object.keys(E.registry)) {
            const n = T.createNode(type, taken);
            expect(n.id).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/);
        }
        expect(taken.has('text-2')).toBe(true);
    });
    it('clones drop launcher widgets and initial focus', () => {
        const r = sample();
        const copy = T.cloneWithNewIds({ ...T.find(r, 'row')!.node, focus: { initial: true }, children: [...T.find(r, 'row')!.node.children!, { id: 'w', type: 'launcher.weather' }] }, T.allIds(r))!;
        expect(copy.children!.map((c) => c.type)).toEqual(['text', 'text', 'button']);
        expect(copy.focus?.initial).toBeUndefined();
        expect(T.cloneWithNewIds({ id: 'z', type: 'launcher.clock' }, new Set())).toBeNull();
    });
});

describe('auto layout on/off', () => {
    it('adding auto layout keeps the look: order, gap and padding come from positions', () => {
        const f: LayoutNode = {
            id: 'f', type: 'frame', children: [
                { id: 'b', type: 'text', constraints: { h: { anchor: 'start', offset: 240, size: 100 }, v: { anchor: 'start', offset: 20, size: 40 } } },
                { id: 'a', type: 'text', constraints: { h: { anchor: 'start', offset: 20, size: 200 }, v: { anchor: 'start', offset: 20, size: 40 } } },
            ],
        };
        T.addAutoLayout(f, { a: { x: 20, y: 20, w: 200, h: 40 }, b: { x: 240, y: 20, w: 100, h: 40 } }, { w: 360, h: 80 });
        expect(f.type).toBe('stack');
        expect(f.layout).toMatchObject({ direction: 'horizontal', gap: 20, padding: 20 });
        expect(f.children!.map((c) => c.id)).toEqual(['a', 'b']);
        expect(f.children!.every((c) => !c.constraints)).toBe(true);
        expect(f.children![0].size).toEqual({ width: { mode: 'fixed', value: 200 }, height: { mode: 'fixed', value: 40 } });
    });
    it('vertical arrangements become vertical stacks with per-side padding when uneven', () => {
        const f: LayoutNode = {
            id: 'f', type: 'frame', children: [
                { id: 'a', type: 'text', constraints: { h: { anchor: 'start', offset: 10, size: 100 }, v: { anchor: 'start', offset: 30, size: 40 } } },
                { id: 'b', type: 'text', constraints: { h: { anchor: 'start', offset: 10, size: 100 }, v: { anchor: 'start', offset: 90, size: 40 } } },
            ],
        };
        T.addAutoLayout(f, { a: { x: 10, y: 30, w: 100, h: 40 }, b: { x: 10, y: 90, w: 100, h: 40 } }, { w: 200, h: 200 });
        expect(f.layout).toMatchObject({ direction: 'vertical', gap: 20, padding: [30, 90, 70, 10] });
    });
    it('removing auto layout leaves every child at its place', () => {
        const r = sample();
        const row = T.find(r, 'row')!.node;
        T.removeAutoLayout(row, { a: { x: 0, y: 0, w: 30, h: 40 }, b: { x: 40, y: 0, w: 30, h: 40 }, c: { x: 80, y: 0, w: 60, h: 40 } }, { w: 800, h: 100 });
        expect(row.type).toBe('frame');
        expect(T.find(r, 'c')!.node.constraints).toEqual({ h: { anchor: 'start', offset: 80, size: 60 }, v: { anchor: 'start', offset: 0, size: 40 } });
        expect(E.validate({ schemaVersion: 1, id: 't', name: 't', pages: { home: { root: r } } }, { studio: true }).errors).toEqual([]);
    });
    it('guesses the direction from the spread', () => {
        expect(T.guessDirection([{ x: 0, y: 0, w: 10, h: 10 }, { x: 100, y: 5, w: 10, h: 10 }])).toBe('horizontal');
        expect(T.guessDirection([{ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 100, w: 10, h: 10 }])).toBe('vertical');
    });
});

describe('new components', () => {
    it('content blocks and icons are created valid', () => {
        for (const type of ['icon', 'content-row', 'content-grid', 'banner', 'weather-full']) {
            const n = T.createNode(type, new Set());
            const v = E.validate({ schemaVersion: 1, id: 't', name: 't', pages: { home: { root: { id: 'root', type: 'stack', children: [{ id: 'apps', type: 'launcher.app-shelf' }, n] } } } });
            expect(v.errors, type).toEqual([]);
        }
    });
});

describe('auto layout on the TV screen (reported case)', () => {
    it('shelf at the bottom + button at the top -> vertical stack, stretched shelf becomes Fill', () => {
        const screen: LayoutNode = {
            id: 'root', type: 'frame', children: [
                { id: 'apps', type: 'launcher.app-shelf', constraints: { h: { anchor: 'stretch', start: 54, end: 54 }, v: { anchor: 'end', offset: 260, size: 300 } } },
                { id: 'customize', type: 'launcher.settings-button', constraints: { h: { anchor: 'end', offset: 54, size: 190 }, v: { anchor: 'start', offset: 40, size: 50 } } },
            ],
        };
        T.addAutoLayout(screen, { apps: { x: 54, y: 520, w: 1812, h: 300 }, customize: { x: 1676, y: 40, w: 190, h: 50 } }, { w: 1920, h: 1080 });
        expect(screen.layout!.direction).toBe('vertical');
        expect(screen.children!.map((c) => c.id)).toEqual(['customize', 'apps']);
        expect(T.find(screen, 'apps')!.node.size!.width).toEqual({ mode: 'fill' });
        expect(T.find(screen, 'customize')!.node.size!.width).toEqual({ mode: 'fixed', value: 190 });
    });
});
