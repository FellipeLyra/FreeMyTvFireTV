// The launcher's shared layout engine, loaded from the repository so the Studio
// validates, styles and navigates layouts with exactly the code the TV runs.
import engineSource from '../../app/src/main/assets/web/fmtv/engine.js?raw';
import type { Layout, LayoutNode, Rect, ValidationResult } from './model/types';

export interface PropSpec {
    type: 'string' | 'number' | 'enum' | 'color' | 'asset' | 'action' | 'boolean';
    def?: unknown;
    max?: number;
    min?: number;
    values?: string[];
}

export interface ComponentDef {
    type: string;
    label: string;
    category: 'layout' | 'basic' | 'data' | 'launcher';
    container?: boolean;
    focusable?: boolean;
    slot?: string;
    /** Screen a launcher widget belongs to. */
    page?: string;
    props: Record<string, PropSpec>;
}

export interface EngineApi {
    SCHEMA_VERSION: number;
    LIMITS: Record<string, number>;
    PAGES: Record<string, { label: string; runtime: boolean; styleOnly?: boolean; required?: string[];
        panel?: { placements: string[]; width?: [number, number]; height?: [number, number] } }>;
    ICONS: Record<string, string>;
    CONTENT_SOURCES: string[];
    ACTIONS: Record<string, { label: string; needsApp?: boolean }>;
    FONT_FAMILIES: Record<string, string>;
    EASINGS: Record<string, string>;
    ENTER_PRESETS: string[];
    DEFAULT_TOKENS: {
        colors: Record<string, string>;
        spacing: Record<string, number>;
        radius: Record<string, number>;
        fontSizes: Record<string, number>;
        fontFamily: string;
    };
    registry: Record<string, ComponentDef>;
    validate(layout: Layout | string, opts?: { studio?: boolean }): ValidationResult;
    migrate(layout: unknown): { ok: boolean; error?: string; layout?: Layout };
    resolveToken(value: unknown, tokens: unknown, kind: 'color' | 'number'): string | number | undefined;
    mergeTokens(tokens: unknown): EngineApi['DEFAULT_TOKENS'];
    pickNext(items: Rect[], from: number, dir: 'left' | 'right' | 'up' | 'down'): number;
    reachable(items: Rect[], start: number): number[];
    walk(node: LayoutNode, fn: (n: LayoutNode, parent: LayoutNode | null, depth: number) => boolean | void): void;
}

function load(): EngineApi {
    const mod: { exports: unknown } = { exports: {} };
    // engine.js is a UMD file: given a `module`, it exports through it.
    new Function('module', 'self', engineSource)(mod, undefined);
    return mod.exports as EngineApi;
}

export const E = load();

export function isContainer(type: string): boolean {
    return !!E.registry[type]?.container;
}
