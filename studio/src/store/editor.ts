// Studio state. Two parts, kept apart on purpose:
//   - the document (`project`): what gets saved, exported and published; every
//     change goes through `commit`, which records undo history;
//   - the editor state (selection, zoom, measured rectangles, panels...): never
//     saved and never part of undo.
import { create } from 'zustand';
import { produce, type Draft } from 'immer';
import { E } from '../engine';
import type { Anchor, Asset, LayoutNode, Project, Rect, ValidationResult } from '../model/types';
import * as T from '../model/tree';
import { newProject } from '../model/project';

const HISTORY_LIMIT = 200;
const COALESCE_MS = 700;

export type Mode = 'edit' | 'preview';
export type LeftTab = 'pages' | 'layers' | 'components' | 'assets';

export interface Toast {
    id: number;
    text: string;
    kind: 'info' | 'error' | 'success';
}

export interface EditorState {
    project: Project;
    past: Project[];
    future: Project[];
    coalesce: { key: string; at: number } | null;
    dirty: boolean;
    fileName: string;
    fileHandle: unknown;

    page: string;
    selection: string[];
    hover: string | null;
    /** Measured on the canvas, in layout pixels; refreshed after every render. */
    rects: Record<string, Rect>;
    mode: Mode;
    zoom: number;
    pan: { x: number; y: number };
    leftTab: LeftTab;
    showSafeArea: boolean;
    snap: boolean;
    clipboard: LayoutNode[] | null;
    validation: ValidationResult;
    toasts: Toast[];
    renderErrors: string[];

    // document
    commit(label: string, recipe: (p: Draft<Project>) => void, coalesceKey?: string): void;
    undo(): void;
    redo(): void;
    load(project: Project, fileName: string, handle?: unknown): void;
    markSaved(fileName: string, handle: unknown): void;

    // editor
    select(ids: string[]): void;
    setHover(id: string | null): void;
    setRects(rects: Record<string, Rect>): void;
    setMode(mode: Mode): void;
    setZoom(zoom: number, pan?: { x: number; y: number }): void;
    setPan(pan: { x: number; y: number }): void;
    setLeftTab(tab: LeftTab): void;
    toggle(key: 'showSafeArea' | 'snap'): void;
    toast(text: string, kind?: Toast['kind']): void;
    dismissToast(id: number): void;
    setRenderErrors(errors: string[]): void;

    // node operations (all undoable)
    updateNode(id: string, recipe: (n: Draft<LayoutNode>) => void, coalesceKey?: string): void;
    addNode(type: string, target?: { parentId: string; index: number; rect?: Rect }): string | null;
    deleteSelection(): void;
    duplicateSelection(): void;
    copySelection(): void;
    cutSelection(): void;
    paste(): void;
    moveNode(id: string, target: T.MoveTarget): void;
    moveAbsolute(ids: string[], dx: number, dy: number): void;
    setNodeRect(id: string, rect: Rect): void;
    setAnchor(id: string, axis: 'h' | 'v', anchor: Anchor): void;
    setPositionMode(id: string, mode: 'flow' | 'absolute'): void;
    wrapSelection(direction: 'horizontal' | 'vertical'): void;
    unwrapSelection(): void;
    alignSelection(mode: T.AlignMode): void;
    distributeSelection(axis: 'h' | 'v'): void;
    reorderSelection(where: 'front' | 'back' | 'forward' | 'backward'): void;
    toggleVisible(id: string): void;
    toggleLocked(id: string): void;
    addAsset(asset: Asset, base64: string): void;
    removeAsset(id: string): void;
}

const root = (p: Project | Draft<Project>, page: string) => p.layout.pages[page].root as LayoutNode;

function validate(project: Project): ValidationResult {
    return E.validate(project.layout, { studio: true });
}

/** Rectangle of `id` relative to its parent's box (what constraints are measured against). */
export function relRect(rects: Record<string, Rect>, project: Project, page: string, id: string): { rect: Rect; parentSize: { w: number; h: number } } | null {
    const loc = T.find(root(project, page), id);
    if (!loc) return null;
    const r = rects[id];
    if (!r) return null;
    if (!loc.parent) return { rect: { ...r }, parentSize: { w: r.w, h: r.h } };
    const pr = rects[loc.parent.id];
    if (!pr) return null;
    return { rect: { x: r.x - pr.x, y: r.y - pr.y, w: r.w, h: r.h }, parentSize: { w: pr.w, h: pr.h } };
}

let toastSeq = 0;

export const useEditor = create<EditorState>((set, get) => {
    const initial = newProject();

    /** Apply a recipe to the current page root, with history. Errors become toasts. */
    function edit(label: string, fn: (r: LayoutNode, p: Draft<Project>) => void, key?: string) {
        try {
            get().commit(label, (p) => fn(root(p, get().page) as LayoutNode, p), key);
        } catch (e) {
            get().toast((e as Error).message, 'error');
        }
    }

    function selectionLocs() {
        const r = root(get().project, get().page);
        return get().selection.map((id) => T.find(r, id)).filter((l): l is T.Located => !!l);
    }

    return {
        project: initial,
        past: [],
        future: [],
        coalesce: null,
        dirty: false,
        fileName: 'Novo layout',
        fileHandle: null,
        page: 'home',
        selection: [],
        hover: null,
        rects: {},
        mode: 'edit',
        zoom: 0.5,
        pan: { x: 40, y: 40 },
        leftTab: 'layers',
        showSafeArea: true,
        snap: true,
        clipboard: null,
        validation: validate(initial),
        toasts: [],
        renderErrors: [],

        commit(_label, recipe, coalesceKey) {
            const s = get();
            const next = produce(s.project, recipe);
            if (next === s.project) return;
            const now = Date.now();
            const merge = !!coalesceKey && !!s.coalesce && s.coalesce.key === coalesceKey && now - s.coalesce.at < COALESCE_MS;
            const past = merge ? s.past : [...s.past, s.project].slice(-HISTORY_LIMIT);
            // Drop selected ids that no longer exist.
            const r = root(next, s.page);
            const selection = s.selection.filter((id) => !!T.find(r, id));
            set({
                project: next, past, future: [], dirty: true, selection,
                coalesce: coalesceKey ? { key: coalesceKey, at: now } : null,
                validation: validate(next),
            });
        },
        undo() {
            const s = get();
            if (!s.past.length) return;
            const prev = s.past[s.past.length - 1];
            set({ project: prev, past: s.past.slice(0, -1), future: [s.project, ...s.future], dirty: true, coalesce: null, validation: validate(prev) });
        },
        redo() {
            const s = get();
            if (!s.future.length) return;
            const next = s.future[0];
            set({ project: next, past: [...s.past, s.project], future: s.future.slice(1), dirty: true, coalesce: null, validation: validate(next) });
        },
        load(project, fileName, handle = null) {
            set({
                project, past: [], future: [], dirty: false, fileName, fileHandle: handle, selection: [], hover: null,
                rects: {}, coalesce: null, validation: validate(project), page: 'home',
            });
        },
        markSaved(fileName, handle) {
            set({ dirty: false, fileName, fileHandle: handle });
        },

        select(ids) { set({ selection: Array.from(new Set(ids)) }); },
        setHover(id) { if (get().hover !== id) set({ hover: id }); },
        setRects(rects) { set({ rects }); },
        setMode(mode) { set({ mode, hover: null }); },
        setZoom(zoom, pan) { set({ zoom: Math.min(4, Math.max(0.1, zoom)), ...(pan ? { pan } : {}) }); },
        setPan(pan) { set({ pan }); },
        setLeftTab(leftTab) { set({ leftTab }); },
        toggle(key) { set({ [key]: !get()[key] } as Partial<EditorState>); },
        toast(text, kind = 'info') {
            const id = ++toastSeq;
            set({ toasts: [...get().toasts, { id, text, kind }].slice(-4) });
            setTimeout(() => get().dismissToast(id), kind === 'error' ? 6000 : 3500);
        },
        dismissToast(id) { set({ toasts: get().toasts.filter((t) => t.id !== id) }); },
        setRenderErrors(renderErrors) { set({ renderErrors }); },

        updateNode(id, recipe, coalesceKey) {
            edit('alterar', (r) => {
                const loc = T.find(r, id);
                if (loc) recipe(loc.node as Draft<LayoutNode>);
            }, coalesceKey ? `${id}:${coalesceKey}` : undefined);
        },

        addNode(type, target) {
            const s = get();
            const r = root(s.project, s.page);
            if (E.registry[type]?.slot) {
                let exists = false;
                E.walk(r, (n) => { if (n.type === type) exists = true; });
                if (exists) { s.toast(`${E.registry[type].label} já está na tela (cada widget do launcher aparece uma vez)`, 'error'); return null; }
            }
            // Default target: inside the selected container, else next to the selected node, else the root.
            let parentId = r.id, index = (r.children || []).length;
            if (target) { parentId = target.parentId; index = target.index; }
            else if (s.selection.length === 1) {
                const loc = T.find(r, s.selection[0]);
                if (loc && E.registry[loc.node.type]?.container) { parentId = loc.node.id; index = (loc.node.children || []).length; }
                else if (loc && loc.parent) { parentId = loc.parent.id; index = loc.index + 1; }
            }
            let created: string | null = null;
            edit('adicionar', (rt) => {
                const parent = T.find(rt, parentId)!.node;
                const node = T.createNode(type, T.allIds(rt), { horizontalParent: parent.type === 'stack' && parent.layout?.direction !== 'vertical' });
                if (parent.type === 'frame') {
                    const pr = get().rects[parent.id];
                    const rect = target?.rect || T.defaultDropRect(node, (pr?.w || 1920) / 2, (pr?.h || 1080) / 2);
                    T.dropFlowSize(node);
                    T.placeAbsolute(node, rect, { w: pr?.w || 1920, h: pr?.h || 1080 });
                }
                T.insert(parent, node, index);
                created = node.id;
            });
            if (created) set({ selection: [created] });
            return created;
        },

        deleteSelection() {
            const ids = get().selection;
            if (!ids.length) return;
            edit('excluir', (r) => {
                for (const id of ids) {
                    if (id === r.id) throw new Error('a raiz da tela não pode ser excluída');
                    const loc = T.find(r, id);
                    if (loc?.node.locked) throw new Error(`"${loc.node.name || loc.node.id}" está bloqueado`);
                    T.remove(r, id);
                }
            });
            set({ selection: [] });
        },

        duplicateSelection() {
            const locs = selectionLocs().filter((l) => l.parent);
            if (!locs.length) return;
            const newIds: string[] = [];
            let skipped = 0;
            edit('duplicar', (r) => {
                const taken = T.allIds(r);
                for (const l of locs) {
                    const loc = T.find(r, l.node.id)!;
                    const copy = T.cloneWithNewIds(loc.node as LayoutNode, taken);
                    if (!copy) { skipped++; continue; }
                    if (copy.constraints && T.isAbsolute(copy, loc.parent)) {
                        const c = copy.constraints;
                        if ('offset' in c.h) c.h.offset += c.h.anchor === 'end' ? -24 : 24;
                        if ('offset' in c.v) c.v.offset += c.v.anchor === 'end' ? -24 : 24;
                    }
                    T.insert(loc.parent!, copy, loc.index + 1);
                    newIds.push(copy.id);
                }
            });
            if (skipped) get().toast('widgets do launcher não podem ser duplicados', 'error');
            if (newIds.length) set({ selection: newIds });
        },

        copySelection() {
            const nodes = selectionLocs().filter((l) => l.parent).map((l) => JSON.parse(JSON.stringify(l.node)));
            if (nodes.length) { set({ clipboard: nodes }); get().toast(`${nodes.length} elemento(s) copiado(s)`); }
        },
        cutSelection() {
            get().copySelection();
            get().deleteSelection();
        },
        paste() {
            const clip = get().clipboard;
            if (!clip?.length) return;
            const s = get();
            const r = root(s.project, s.page);
            let parentId = r.id;
            if (s.selection.length === 1) {
                const loc = T.find(r, s.selection[0]);
                if (loc && E.registry[loc.node.type]?.container) parentId = loc.node.id;
                else if (loc?.parent) parentId = loc.parent.id;
            }
            const newIds: string[] = [];
            edit('colar', (rt) => {
                const parent = T.find(rt, parentId)!.node;
                const taken = T.allIds(rt);
                for (const n of clip) {
                    const copy = T.cloneWithNewIds(n, taken);
                    if (!copy) continue;
                    if (parent.type === 'frame' && !copy.constraints) {
                        T.dropFlowSize(copy);
                        T.placeAbsolute(copy, T.defaultDropRect(copy, 960, 540), { w: 1920, h: 1080 });
                    }
                    if (parent.type === 'stack' && copy.position !== 'absolute') delete copy.constraints;
                    T.insert(parent, copy, (parent.children || []).length);
                    newIds.push(copy.id);
                }
            });
            if (newIds.length) set({ selection: newIds });
        },

        moveNode(id, target) {
            const s = get();
            const rect = s.rects[id] || null;
            let note: string | null = null;
            edit('mover', (r) => { note = T.move(r, id, target, rect); });
            if (note) s.toast(note);
        },

        moveAbsolute(ids, dx, dy) {
            const s = get();
            if (!dx && !dy) return;
            edit('mover', (r) => {
                for (const id of ids) {
                    const loc = T.find(r, id);
                    if (!loc || !T.isAbsolute(loc.node, loc.parent) || loc.node.locked) continue;
                    const rr = relRect(s.rects, s.project, s.page, id);
                    if (!rr) continue;
                    T.placeAbsolute(loc.node, { ...rr.rect, x: rr.rect.x + dx, y: rr.rect.y + dy }, rr.parentSize);
                }
            }, 'nudge:' + ids.join(','));
        },

        setNodeRect(id, rect) {
            const s = get();
            edit('redimensionar', (r) => {
                const loc = T.find(r, id);
                if (!loc || !loc.parent) return;
                const pr = s.rects[loc.parent.id];
                if (!pr) return;
                const rel = { x: rect.x - pr.x, y: rect.y - pr.y, w: Math.max(1, rect.w), h: Math.max(1, rect.h) };
                if (T.isAbsolute(loc.node, loc.parent)) {
                    T.placeAbsolute(loc.node, rel, { w: pr.w, h: pr.h });
                } else {
                    const old = s.rects[id];
                    const size = { ...(loc.node.size || {}) };
                    if (!old || Math.round(old.w) !== Math.round(rect.w)) size.width = { mode: 'fixed', value: Math.round(rel.w) };
                    if (!old || Math.round(old.h) !== Math.round(rect.h)) size.height = { mode: 'fixed', value: Math.round(rel.h) };
                    loc.node.size = size;
                }
            });
        },

        setAnchor(id, axis, anchor) {
            const s = get();
            const rr = relRect(s.rects, s.project, s.page, id);
            if (!rr) return;
            s.updateNode(id, (n) => T.setAnchor(n as LayoutNode, axis, anchor, rr.rect, rr.parentSize));
        },

        setPositionMode(id, mode) {
            const s = get();
            const rr = relRect(s.rects, s.project, s.page, id);
            edit('posição', (r) => {
                const loc = T.find(r, id);
                if (!loc || !loc.parent || loc.parent.type !== 'stack') return;
                if (mode === 'absolute') {
                    if (!rr) throw new Error('aguarde o canvas medir o elemento');
                    T.makeAbsolute(loc.node, loc.parent, rr.rect, rr.parentSize);
                } else {
                    T.makeFlow(loc.node, rr ? rr.rect : null);
                }
            });
            s.toast(mode === 'absolute' ? 'posição absoluta: o elemento saiu do fluxo e ficou no mesmo lugar' : 'de volta ao fluxo da stack, com o tamanho atual fixado');
        },

        wrapSelection(direction) {
            const s = get();
            const locs = selectionLocs().filter((l) => l.parent);
            if (!locs.length) return;
            const parent = locs[0].parent!;
            const pr = s.rects[parent.id];
            const rel: Record<string, Rect> = {};
            for (const l of locs) {
                const r = s.rects[l.node.id];
                if (r && pr) rel[l.node.id] = { x: r.x - pr.x, y: r.y - pr.y, w: r.w, h: r.h };
            }
            let created = '';
            edit('criar stack', (r) => {
                created = T.wrapInStack(r, locs.map((l) => l.node.id), direction, rel, { w: pr?.w || 1920, h: pr?.h || 1080 }, T.allIds(r));
            });
            if (created) set({ selection: [created] });
        },

        unwrapSelection() {
            const s = get();
            const [id] = s.selection;
            if (!id) return;
            const loc = T.find(root(s.project, s.page), id);
            if (!loc || !loc.parent) return;
            const pr = s.rects[loc.parent.id];
            const rel: Record<string, Rect> = {};
            for (const k of loc.node.children || []) {
                const r = s.rects[k.id];
                if (r && pr) rel[k.id] = { x: r.x - pr.x, y: r.y - pr.y, w: r.w, h: r.h };
            }
            let kids: string[] = [];
            edit('desagrupar', (r) => { kids = T.unwrap(r, id, rel, { w: pr?.w || 1920, h: pr?.h || 1080 }); });
            set({ selection: kids });
        },

        alignSelection(mode) {
            const s = get();
            const locs = selectionLocs().filter((l) => l.parent && T.isAbsolute(l.node, l.parent));
            if (!locs.length) { s.toast('alinhar funciona com elementos de posição absoluta; numa stack use o alinhamento dela', 'error'); return; }
            const rects = locs.map((l) => s.rects[l.node.id]).filter(Boolean);
            if (rects.length !== locs.length) return;
            const bounds = locs.length === 1 ? s.rects[locs[0].parent!.id] : undefined;
            const out = T.alignRects(rects, mode, bounds);
            edit('alinhar', (r) => {
                locs.forEach((l, i) => {
                    const loc = T.find(r, l.node.id)!;
                    const pr = s.rects[loc.parent!.id];
                    T.placeAbsolute(loc.node, { x: out[i].x - pr.x, y: out[i].y - pr.y, w: out[i].w, h: out[i].h }, { w: pr.w, h: pr.h });
                });
            });
        },

        distributeSelection(axis) {
            const s = get();
            const locs = selectionLocs().filter((l) => l.parent && T.isAbsolute(l.node, l.parent));
            if (locs.length < 3) { s.toast('selecione 3 ou mais elementos absolutos para distribuir', 'error'); return; }
            const out = T.distributeRects(locs.map((l) => s.rects[l.node.id]), axis);
            edit('distribuir', (r) => {
                locs.forEach((l, i) => {
                    const loc = T.find(r, l.node.id)!;
                    const pr = s.rects[loc.parent!.id];
                    T.placeAbsolute(loc.node, { x: out[i].x - pr.x, y: out[i].y - pr.y, w: out[i].w, h: out[i].h }, { w: pr.w, h: pr.h });
                });
            });
        },

        reorderSelection(where) {
            const ids = get().selection;
            edit('ordem', (r) => {
                for (const id of ids) {
                    const loc = T.find(r, id);
                    if (!loc || !loc.parent) continue;
                    const kids = loc.parent.children!;
                    kids.splice(loc.index, 1);
                    const to = where === 'front' ? kids.length : where === 'back' ? 0
                        : where === 'forward' ? Math.min(kids.length, loc.index + 1) : Math.max(0, loc.index - 1);
                    kids.splice(to, 0, loc.node);
                }
            });
        },

        toggleVisible(id) {
            get().updateNode(id, (n) => { if (n.visible === false) delete n.visible; else n.visible = false; });
        },
        toggleLocked(id) {
            get().updateNode(id, (n) => { if (n.locked) delete n.locked; else n.locked = true; });
        },

        addAsset(asset, base64) {
            get().commit('imagem', (p) => {
                p.layout.assets = [...(p.layout.assets || []).filter((a) => a.id !== asset.id), asset];
                p.assetData[asset.id] = base64;
            });
        },
        removeAsset(id) {
            const s = get();
            let used = false;
            for (const page of Object.values(s.project.layout.pages)) {
                E.walk(page.root, (n) => {
                    if ((n.style?.background?.type === 'image' && n.style.background.asset === id) || n.props?.asset === id) used = true;
                });
            }
            if (used) { s.toast('a imagem está em uso; remova-a dos elementos primeiro', 'error'); return; }
            s.commit('remover imagem', (p) => {
                p.layout.assets = (p.layout.assets || []).filter((a) => a.id !== id);
                if (!p.layout.assets.length) delete p.layout.assets;
                delete p.assetData[id];
            });
        },
    };
});

/** Convenience selectors */
export const selectRoot = (s: EditorState) => root(s.project, s.page);
export function selectedNodes(s: EditorState): T.Located[] {
    const r = root(s.project, s.page);
    return s.selection.map((id) => T.find(r, id)).filter((l): l is T.Located => !!l);
}
