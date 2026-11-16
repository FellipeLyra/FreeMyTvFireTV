import { describe, expect, it } from 'vitest';
import { fitSize, decodedMb, perfAudit, MAX_BLURS } from '../src/model/perf';
import type { Layout } from '../src/model/types';

const layout = (over: Partial<Layout> & { blurs?: number } = {}): Layout => {
    const children = Array.from({ length: over.blurs || 0 }, (_, i) => ({ id: 'b' + i, type: 'box', style: { blur: 12 } }));
    const { blurs, ...rest } = over;
    void blurs;
    return { schemaVersion: 1, id: 'x', name: 'X', pages: { home: { root: { id: 'root', type: 'box', children } } }, ...rest } as unknown as Layout;
};

describe('performance on weak devices', () => {
    it('fitSize: the smallest size that still covers 1920×1080', () => {
        expect(fitSize(4000, 3000)).toEqual({ w: 1920, h: 1440 });   // 4:3 photo: width decides
        expect(fitSize(3840, 2160)).toEqual({ w: 1920, h: 1080 });   // 4K wallpaper
        expect(fitSize(1000, 4000)).toBeNull();                      // narrow: would need upscaling, never done
        expect(fitSize(1920, 1080)).toBeNull();
        expect(fitSize(800, 600)).toBeNull();
        expect(fitSize(0, 0)).toBeNull();
    });

    it('decoded memory is 4 bytes per pixel', () => {
        expect(decodedMb(1920, 1080)).toBeCloseTo(7.91, 1);
        expect(decodedMb(4000, 3000)).toBeCloseTo(45.8, 1);
    });

    it('flags images bigger than the screen, and too much image memory', () => {
        const big = { id: 'foto', file: 'foto.jpg', sha256: '', bytes: 3e6, width: 4000, height: 3000 };
        const ok = { id: 'logo', file: 'logo.png', sha256: '', bytes: 2e4, width: 400, height: 200 };
        const issues = perfAudit(layout({ assets: [big, ok] }));
        expect(issues.map((i) => i.rule)).toEqual(['image-size']);
        expect(issues[0].message).toMatch(/4000×3000.*1920×1440/);
        const many = Array.from({ length: 9 }, (_, i) => ({ ...ok, id: 'w' + i, file: `w${i}.jpg`, width: 1920, height: 1080 }));
        expect(perfAudit(layout({ assets: many })).map((i) => i.rule)).toEqual(['image-memory']);
    });

    it('flags many blurred elements and heavy packages', () => {
        expect(perfAudit(layout({ blurs: MAX_BLURS }))).toEqual([]);
        const b = perfAudit(layout({ blurs: MAX_BLURS + 2 }));
        expect(b).toHaveLength(1);
        expect(b[0]).toMatchObject({ rule: 'blur', nodeId: 'b0', page: 'home' });
        const heavy = Array.from({ length: 3 }, (_, i) => ({ id: 'p' + i, file: `p${i}.jpg`, sha256: '', bytes: 5 * 1048576 }));
        expect(perfAudit(layout({ assets: heavy })).map((i) => i.rule)).toEqual(['package']);
    });
});
