// Types for the Free My TV layout schema v1 (see docs/layouts.md). The shared
// engine (engine.js) is the authority on what is valid; these types only help
// the editor code.

export type Dim =
    | { mode: 'fixed'; value: number }
    | { mode: 'hug' }
    | { mode: 'fill' }
    | { mode: 'percent'; value: number };

export type Anchor = 'start' | 'end' | 'center' | 'stretch' | 'scale';
export type Constraint =
    | { anchor: 'start' | 'end' | 'center'; offset: number; size: number }
    | { anchor: 'stretch'; start: number; end: number }
    | { anchor: 'scale'; start: number; size: number };

export type Paint =
    | { type: 'solid'; color: string }
    | { type: 'linear'; angle?: number; stops: { color: string; pos: number }[] }
    | { type: 'image'; asset: string; fit?: 'cover' | 'contain' | 'fill'; position?: string };

export type TokenValue = number | string;

export interface NodeSize {
    width?: Dim;
    height?: Dim;
    minWidth?: number;
    maxWidth?: number;
    minHeight?: number;
    maxHeight?: number;
}

export interface NodeLayout {
    direction?: 'horizontal' | 'vertical';
    gap?: TokenValue;
    padding?: TokenValue | TokenValue[];
    align?: 'start' | 'center' | 'end' | 'stretch' | 'baseline';
    justify?: 'start' | 'center' | 'end' | 'space-between' | 'space-around' | 'space-evenly';
    wrap?: boolean;
    clip?: boolean;
}

export interface NodeStyle {
    background?: Paint;
    opacity?: number;
    radius?: TokenValue;
    border?: { width: TokenValue; color: string };
    shadow?: { x?: number; y?: number; blur?: number; spread?: number; color?: string };
    blur?: number;
}

export interface NodeText {
    size?: TokenValue;
    weight?: number;
    color?: string;
    align?: 'left' | 'center' | 'right';
    lineHeight?: number;
    letterSpacing?: number;
    family?: string;
    transform?: 'none' | 'uppercase' | 'lowercase';
    maxLines?: number;
}

export interface NodeAnimation {
    enter?: { preset?: string; duration?: number; delay?: number; easing?: string; distance?: number };
    focus?: { scale?: number; lift?: number };
}

export interface LayoutNode {
    id: string;
    type: string;
    name?: string;
    visible?: boolean;
    locked?: boolean;
    position?: 'flow' | 'absolute';
    size?: NodeSize;
    constraints?: { h: Constraint; v: Constraint };
    layout?: NodeLayout;
    style?: NodeStyle;
    text?: NodeText;
    animation?: NodeAnimation;
    focus?: { initial?: boolean; skip?: boolean };
    // Component props are typed by the engine registry, so they stay loose here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    props?: Record<string, any>;
    children?: LayoutNode[];
}

export interface Asset {
    id: string;
    file: string;
    sha256: string;
    bytes: number;
    width?: number;
    height?: number;
}

export interface Tokens {
    colors?: Record<string, string>;
    spacing?: Record<string, number>;
    radius?: Record<string, number>;
    fontSizes?: Record<string, number>;
    fontFamily?: string;
}

export interface Layout {
    schemaVersion: number;
    id: string;
    name: string;
    createdAt?: string;
    generator?: string;
    tokens?: Tokens;
    assets?: Asset[];
    pages: Record<string, { root: LayoutNode }>;
}

export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface Issue {
    path: string;
    message: string;
}

export interface ValidationResult {
    ok: boolean;
    errors: Issue[];
    warnings: Issue[];
    layout: Layout | null;
}

/** A Studio project: the layout plus the image bytes it uses. Never contains credentials. */
export interface Project {
    format: 'fmtv-studio-project';
    formatVersion: 1;
    layout: Layout;
    /** asset id -> base64 file contents */
    assetData: Record<string, string>;
    /** Reusable blocks saved by the user (inserted as copies). */
    blocks?: UserBlock[];
}

export interface UserBlock {
    id: string;
    name: string;
    node: LayoutNode;
}
