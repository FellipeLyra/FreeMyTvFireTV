import { describe, expect, it } from 'vitest';
import { E } from '../src/engine';
import {
    backgroundCandidates, contrastRatio, focusGraph, gradientColors, minContrast, outsideSafeArea, parseColor,
    resScale, worstContrast, type Rgba,
} from '../src/model/a11y';

const c = (s: string) => parseColor(s)!;
const BLACK = c('#000');

describe('colours and contrast', () => {
    it('parses the colours getComputedStyle returns', () => {
        expect(c('rgb(10, 20, 30)')).toEqual({ r: 10, g: 20, b: 30, a: 1 });
        expect(c('rgba(255, 255, 255, 0.5)')).toEqual({ r: 255, g: 255, b: 255, a: 0.5 });
        expect(c('rgb(1 2 3 / 40%)')).toEqual({ r: 1, g: 2, b: 3, a: 0.4 });
        expect(c('#64d2ff')).toEqual({ r: 100, g: 210, b: 255, a: 1 });
        expect(c('transparent').a).toBe(0);
        expect(parseColor('var(--x)')).toBeNull();
    });

    it('matches the WCAG reference values', () => {
        expect(contrastRatio(c('#fff'), c('#000'))).toBeCloseTo(21, 5);
        expect(contrastRatio(c('#777'), c('#fff'))).toBeCloseTo(4.48, 2);
        expect(contrastRatio(c('#333'), c('#0a0e1a'))).toBeLessThan(2);
    });

    it('large text needs 3:1, normal text 4.5:1', () => {
        expect(minContrast(16, 400)).toBe(4.5);
        expect(minContrast(24, 400)).toBe(3);
        expect(minContrast(19, 700)).toBe(3);
    });

    it('reads every stop of a gradient', () => {
        expect(gradientColors('linear-gradient(rgb(0, 0, 0) 0%, rgba(255, 0, 0, 0.5) 100%)')).toHaveLength(2);
    });
});

describe('what lies behind the text', () => {
    it('stops at the first opaque layer and blends translucent ones over it', () => {
        const r = backgroundCandidates([
            { colors: [c('rgba(255,255,255,0.5)')], opacity: 1 },
            { colors: [c('#000')], opacity: 1 },
            { colors: [c('#f00')], opacity: 1 }, // hidden under the black layer
        ], BLACK);
        expect(r.image).toBe(false);
        expect(r.colors).toHaveLength(1);
        expect(Math.round(r.colors[0].r)).toBe(128);
        expect(Math.round(r.colors[0].g)).toBe(128);
    });

    it('an image counts as black and white: plain white text over a photo fails', () => {
        const r = backgroundCandidates([{ unknown: true }], BLACK);
        expect(r.image).toBe(true);
        expect(worstContrast(c('#fff'), r.colors).ratio).toBeCloseTo(1, 5);
    });

    it('a dark enough scrim over the photo makes white text pass whatever the photo shows', () => {
        const scrim = backgroundCandidates([{ colors: [c('rgba(0,0,0,0.7)')], opacity: 1 }, { unknown: true }], BLACK);
        expect(worstContrast(c('#fff'), scrim.colors).ratio).toBeGreaterThan(4.5);
        const light = backgroundCandidates([{ colors: [c('rgba(0,0,0,0.3)')], opacity: 1 }, { unknown: true }], BLACK);
        expect(worstContrast(c('#fff'), light.colors).ratio).toBeLessThan(4.5);
    });

    it('element opacity thins its background out', () => {
        const r = backgroundCandidates([{ colors: [c('#fff')], opacity: 0.5 }], BLACK);
        expect(Math.round(r.colors[0].r)).toBe(128);
    });

    it('a gradient is judged by its worst stop', () => {
        const r = backgroundCandidates([{ colors: gradientColors('linear-gradient(rgb(0, 0, 0), rgb(255, 255, 255))'), opacity: 1 }], BLACK);
        expect(worstContrast(c('#fff'), r.colors).ratio).toBeCloseTo(1, 5);
    });

    it('translucent text is blended before measuring', () => {
        const bg: Rgba[] = [c('#000')];
        expect(worstContrast(c('rgba(255,255,255,0.3)'), bg).ratio).toBeLessThan(worstContrast(c('#fff'), bg).ratio);
    });
});

describe('focus graph (the TV\'s own pickNext)', () => {
    const row = [0, 1, 2].map((i) => ({ x: 100 + i * 220, y: 500, w: 200, h: 120 }));

    it('counts arrow presses from the start', () => {
        const g = focusGraph(row, 0, E.pickNext);
        expect(g.steps).toEqual([0, 1, 2]);
        expect(g.next[1]).toEqual({ left: 0, right: 2, up: -1, down: -1 });
    });

    it('an item hidden exactly behind another is never reached', () => {
        const items = [...row, { ...row[1] }];
        expect(focusGraph(items, 0, E.pickNext).steps[3]).toBe(-1);
    });

    it('no start, nothing reached', () => {
        expect(focusGraph(row, -1, E.pickNext).steps).toEqual([-1, -1, -1]);
    });
});

describe('screen edges and resolution', () => {
    it('alerts only inside the band overscan crops (48 px sides, 27 px top and bottom)', () => {
        expect(outsideSafeArea({ x: 54, y: 34, w: 400, h: 100 })).toBe(0); // launcher's own margins
        expect(outsideSafeArea({ x: 20, y: 500, w: 100, h: 40 })).toBe(28);
        expect(outsideSafeArea({ x: 1800, y: 1060, w: 100, h: 40 })).toBe(47); // bottom: 1100 - 1053
    });

    it('real pixels per layout pixel', () => {
        expect(resScale('720p')).toBeCloseTo(2 / 3, 5);
        expect(resScale('1080p')).toBe(1);
        expect(resScale('4k')).toBe(2);
    });
});
