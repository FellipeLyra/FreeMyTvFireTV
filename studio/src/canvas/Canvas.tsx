import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { E } from '../engine';
import { useEditor, selectRoot } from '../store/editor';
import * as T from '../model/tree';
import type { LayoutNode, Rect } from '../model/types';
import { PreviewFrame, STAGE_H, STAGE_W } from './preview';
import { ContextMenu, type MenuItem } from '../ui/ContextMenu';
import { BUILTIN_BLOCKS, type Block } from '../model/blocks';
import { PAGE_HINTS } from '../model/pages';
import { runAudit, type FocusMap } from './audit';
import { DIRS, TV_RES, SAFE } from '../model/a11y';

export let preview: PreviewFrame | null = null;

type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const SNAP_PX = 6;
const GRID = 8;

interface DropTarget {
    parentId: string;
    index: number;
    /** frame drops: rectangle relative to the parent */
    rect?: Rect;
    parentSize?: { w: number; h: number };
    indicator: Rect;
    container: Rect;
}

type Drag =
    | { kind: 'pan'; sx: number; sy: number; pan0: { x: number; y: number } }
    | { kind: 'pending'; ids: string[]; sx: number; sy: number; reparent: boolean }
    | { kind: 'move-abs'; ids: string[]; sx: number; sy: number; dx: number; dy: number; guides: Rect[] }
    | { kind: 'move-flow'; id: string; sx: number; sy: number; x: number; y: number; target: DropTarget | null }
    | { kind: 'resize'; id: string; handle: Handle; sx: number; sy: number; origin: Rect; rect: Rect };

export function Canvas() {
    const project = useEditor((s) => s.project);
    const page = useEditor((s) => s.page);
    const rects = useEditor((s) => s.rects);
    const selection = useEditor((s) => s.selection);
    const hover = useEditor((s) => s.hover);
    const zoom = useEditor((s) => s.zoom);
    const pan = useEditor((s) => s.pan);
    const mode = useEditor((s) => s.mode);
    const showSafeArea = useEditor((s) => s.showSafeArea);
    const showFocusMap = useEditor((s) => s.showFocusMap);
    const focusMap = useEditor((s) => s.audit.focus);
    const tvRes = useEditor((s) => s.tvRes);
    const root = useEditor(selectRoot);
    const [focusHover, setFocusHover] = useState(-1);

    const viewportRef = useRef<HTMLDivElement>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const drag = useRef<Drag | null>(null);
    const [, redraw] = useReducer((n: number) => n + 1, 0);
    const [ready, setReady] = useState(false);
    const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
    const [external, setExternal] = useState<DropTarget | null>(null);
    const spaceDown = useRef(false);

    /* ---------------- rendering through the real runtime ---------------- */

    const measure = useCallback(() => {
        if (!preview?.ready) return;
        const st = useEditor.getState();
        const next = preview.measure(st.page);
        if (JSON.stringify(next) !== JSON.stringify(st.rects)) st.setRects(next);
        // Focus map and accessibility alerts come from the same runtime the TV runs.
        // While previewing, focus effects move things around: keep the edit-time result.
        if (st.mode !== 'edit') return;
        try {
            const audit = runAudit(preview, st.page, selectRoot(st), st.tvRes);
            if (JSON.stringify(audit) !== JSON.stringify(st.audit)) st.setAudit(audit);
        } catch (e) {
            if (import.meta.env.DEV) console.warn('[audit]', e);
        }
    }, []);

    useEffect(() => {
        const iframe = iframeRef.current!;
        preview = new PreviewFrame(iframe);
        const onLoad = () => {
            const wait = () => (preview?.ready ? setReady(true) : setTimeout(wait, 50));
            wait();
            // In the preview the page may hold keyboard focus (clicks inside it); Esc still leaves the preview.
            iframe.contentWindow?.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && useEditor.getState().mode === 'preview') {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    useEditor.getState().setMode('edit');
                }
            }, true);
        };
        if (import.meta.env.DEV) (window as unknown as { __fmtvPreview: () => PreviewFrame | null }).__fmtvPreview = () => preview;
        iframe.addEventListener('load', onLoad);
        const onMsg = (ev: MessageEvent) => {
            if (ev.data?.type === 'fmtv:launch') useEditor.getState().toast(`Na TV, abriria o app ${ev.data.appId}`);
        };
        window.addEventListener('message', onMsg);
        return () => {
            iframe.removeEventListener('load', onLoad);
            window.removeEventListener('message', onMsg);
            preview?.dispose();
            preview = null;
        };
    }, []);

    useEffect(() => {
        if (!ready || !preview) return;
        const res = preview.render(project.layout, project.assetData);
        useEditor.getState().setRenderErrors(res.ok ? [] : res.errors);
        preview.showPage(page);
        measure();
        // Widgets fill in asynchronously (weather, posters), so measure again shortly after.
        const t = setTimeout(measure, 300);
        return () => clearTimeout(t);
    }, [ready, project, page, measure]);

    // The launcher page starts its OLED screensaver after 3 idle minutes. Inside the editor
    // the page never sees a key press, so keep it "in use" and close the screensaver if it
    // opened (except when the screensaver itself is the screen being edited).
    useEffect(() => {
        if (!ready) return;
        const keepAwake = () => {
            const w = preview?.win;
            if (!w || useEditor.getState().page === 'screensaver') return;
            try {
                w.lastActivity = Date.now();
                if (w.screensaverOn && typeof w.exitScreensaver === 'function') w.exitScreensaver();
            } catch { /* page reloading */ }
        };
        keepAwake();
        const t = setInterval(keepAwake, 1000);
        return () => clearInterval(t);
    }, [ready]);

    // Content blocks only manage remote focus while the preview is being "played".
    useEffect(() => {
        const w = preview?.win;
        if (!ready || !w) return;
        w.__fmtvPreviewPlaying = mode === 'preview';
        if (mode === 'preview' && typeof w.refreshMainNavList === 'function') w.refreshMainNavList();
        if (mode === 'edit') preview?.releaseFocus();
    }, [mode, ready]);

    useEffect(() => { measure(); }, [tvRes, measure]);

    useEffect(() => {
        if (!ready) return;
        const t = setInterval(measure, 800);
        return () => clearInterval(t);
    }, [ready, measure]);

    /* ---------------- zoom & pan ---------------- */

    const fit = useCallback(() => {
        const vp = viewportRef.current;
        if (!vp) return;
        const z = Math.min((vp.clientWidth - 64) / STAGE_W, (vp.clientHeight - 64) / STAGE_H);
        useEditor.getState().setZoom(z, { x: (vp.clientWidth - STAGE_W * z) / 2, y: (vp.clientHeight - STAGE_H * z) / 2 });
    }, []);

    /** "Actual size": one real pixel of the chosen TV per pixel of this screen, centred. */
    const actualSize = useCallback(() => {
        const vp = viewportRef.current;
        if (!vp) return;
        const res = TV_RES[useEditor.getState().tvRes];
        const z = res.w / STAGE_W / (window.devicePixelRatio || 1);
        useEditor.getState().setZoom(z, { x: (vp.clientWidth - STAGE_W * z) / 2, y: (vp.clientHeight - STAGE_H * z) / 2 });
    }, []);

    useLayoutEffect(() => { fit(); }, [fit]);
    useEffect(() => {
        const onFit = () => fit();
        window.addEventListener('fmtv:fit', onFit);
        window.addEventListener('fmtv:actual-size', actualSize);
        window.addEventListener('resize', onFit);
        return () => {
            window.removeEventListener('fmtv:fit', onFit);
            window.removeEventListener('fmtv:actual-size', actualSize);
            window.removeEventListener('resize', onFit);
        };
    }, [fit, actualSize]);

    useEffect(() => {
        const vp = viewportRef.current!;
        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            const s = useEditor.getState();
            if (e.ctrlKey || e.metaKey) {
                const b = vp.getBoundingClientRect();
                const cx = e.clientX - b.left, cy = e.clientY - b.top;
                const z = Math.min(4, Math.max(0.1, s.zoom * Math.exp(-e.deltaY * 0.0015)));
                const k = z / s.zoom;
                s.setZoom(z, { x: cx - (cx - s.pan.x) * k, y: cy - (cy - s.pan.y) * k });
            } else {
                s.setPan({ x: s.pan.x - e.deltaX, y: s.pan.y - e.deltaY });
            }
        };
        vp.addEventListener('wheel', onWheel, { passive: false });
        const kd = (e: KeyboardEvent) => { if (e.code === 'Space' && !isTyping(e)) { spaceDown.current = true; } };
        const ku = (e: KeyboardEvent) => { if (e.code === 'Space') spaceDown.current = false; };
        window.addEventListener('keydown', kd);
        window.addEventListener('keyup', ku);
        return () => { vp.removeEventListener('wheel', onWheel); window.removeEventListener('keydown', kd); window.removeEventListener('keyup', ku); };
    }, []);

    /* ---------------- geometry helpers ---------------- */

    const toStage = (e: { clientX: number; clientY: number }) => {
        const b = stageRef.current!.getBoundingClientRect();
        const z = useEditor.getState().zoom;
        return { x: (e.clientX - b.left) / z, y: (e.clientY - b.top) / z };
    };

    const nodeAt = (x: number, y: number, exclude?: string): LayoutNode | null => {
        const ids = preview?.hit(x, y, useEditor.getState().page) || [];
        const r = selectRoot(useEditor.getState());
        for (const id of ids) {
            if (exclude && (id === exclude || T.isDescendant(r, exclude, id))) continue;
            const loc = T.find(r, id);
            if (loc) return loc.node;
        }
        return null;
    };

    /** Where a dragged element (or a new component) would land at (x, y). */
    const dropTargetAt = (x: number, y: number, draggedId: string | null, size: { w: number; h: number }): DropTarget | null => {
        const s = useEditor.getState();
        const r = selectRoot(s);
        const ids = preview?.hit(x, y, useEditor.getState().page) || [];
        let container: LayoutNode | null = null;
        for (const id of ids) {
            if (draggedId && (id === draggedId || T.isDescendant(r, draggedId, id))) continue;
            const loc = T.find(r, id);
            if (loc && E.registry[loc.node.type]?.container && !loc.node.locked) { container = loc.node; break; }
        }
        if (!container) container = r;
        const cr = s.rects[container.id];
        if (!cr) return null;
        if (container.type === 'frame') {
            const rect = { x: Math.round(x - cr.x - size.w / 2), y: Math.round(y - cr.y - size.h / 2), w: size.w, h: size.h };
            return {
                parentId: container.id, index: (container.children || []).length, rect, parentSize: { w: cr.w, h: cr.h },
                indicator: { x: rect.x + cr.x, y: rect.y + cr.y, w: size.w, h: size.h }, container: cr,
            };
        }
        const horizontal = container.layout?.direction !== 'vertical';
        const kids = (container.children || []).filter((c) => c.id !== draggedId && c.position !== 'absolute' && c.visible !== false && s.rects[c.id]);
        let index = 0;
        for (const c of kids) {
            const kr = s.rects[c.id];
            const center = horizontal ? kr.x + kr.w / 2 : kr.y + kr.h / 2;
            if ((horizontal ? x : y) > center) index++;
        }
        // Index among all children (absolute ones keep their place).
        const all = container.children || [];
        const realIndex = index < kids.length ? all.indexOf(kids[index]) : all.length;
        let indicator: Rect;
        const t = 4 / s.zoom;
        if (!kids.length) indicator = horizontal ? { x: cr.x + 8, y: cr.y + 8, w: t, h: cr.h - 16 } : { x: cr.x + 8, y: cr.y + 8, w: cr.w - 16, h: t };
        else if (index < kids.length) {
            const kr = s.rects[kids[index].id];
            indicator = horizontal ? { x: kr.x - t * 1.5, y: kr.y, w: t, h: kr.h } : { x: kr.x, y: kr.y - t * 1.5, w: kr.w, h: t };
        } else {
            const kr = s.rects[kids[kids.length - 1].id];
            indicator = horizontal ? { x: kr.x + kr.w + t / 2, y: kr.y, w: t, h: kr.h } : { x: kr.x, y: kr.y + kr.h + t / 2, w: kr.w, h: t };
        }
        return { parentId: container.id, index: realIndex === -1 ? all.length : realIndex, indicator, container: cr };
    };

    /* ---------------- pointer interaction ---------------- */

    const onPointerDown = (e: React.PointerEvent) => {
        if (mode !== 'edit') return;
        // Capture on the overlay itself: resize handles disappear while dragging, and a capture
        // held by a removed element swallows the next drag's events.
        (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
        setMenu(null);
        if (e.button === 1 || (e.button === 0 && spaceDown.current)) {
            drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, pan0: { ...useEditor.getState().pan } };
            return;
        }
        if (e.button !== 0) return;
        // No text selection from canvas drags: a selected label would turn the next drag
        // into a native text drag (dragstart + pointercancel) and the move would be lost.
        e.preventDefault();
        window.getSelection()?.removeAllRanges();
        const { x, y } = toStage(e);
        const handle = (e.target as HTMLElement).dataset?.handle as Handle | undefined;
        const s = useEditor.getState();
        if (handle && s.selection.length === 1) {
            const origin = s.rects[s.selection[0]];
            if (origin) drag.current = { kind: 'resize', id: s.selection[0], handle, sx: x, sy: y, origin, rect: origin };
            return;
        }
        const node = nodeAt(x, y);
        if (!node) { s.select([]); return; }
        let sel = s.selection;
        if (e.shiftKey) {
            sel = sel.includes(node.id) ? sel.filter((i) => i !== node.id) : [...sel, node.id];
            s.select(sel);
            return;
        }
        if (!sel.includes(node.id)) { sel = [node.id]; s.select(sel); }
        if (node.id === root.id) return;
        drag.current = { kind: 'pending', ids: sel, sx: x, sy: y, reparent: e.ctrlKey || e.metaKey };
    };

    const onPointerMove = (e: React.PointerEvent) => {
        if (mode !== 'edit') return;
        const d = drag.current;
        const s = useEditor.getState();
        if (!d) {
            const { x, y } = toStage(e);
            s.setHover(nodeAt(x, y)?.id || null);
            if (s.showFocusMap && s.audit.focus) setFocusHover(focusItemAt(s.audit.focus.items.map((i) => i.rect), x, y));
            return;
        }
        if (d.kind === 'pan') {
            s.setPan({ x: d.pan0.x + e.clientX - d.sx, y: d.pan0.y + e.clientY - d.sy });
            return;
        }
        const { x, y } = toStage(e);
        if (d.kind === 'pending') {
            if (Math.hypot(x - d.sx, y - d.sy) * s.zoom < 4) return;
            const r = selectRoot(s);
            const locs = d.ids.map((id) => T.find(r, id)).filter((l): l is T.Located => !!l && !!l.parent && !l.node.locked);
            if (!locs.length) { drag.current = null; return; }
            const allAbs = locs.every((l) => T.isAbsolute(l.node, l.parent));
            if (allAbs && !d.reparent) drag.current = { kind: 'move-abs', ids: locs.map((l) => l.node.id), sx: d.sx, sy: d.sy, dx: 0, dy: 0, guides: [] };
            else if (locs.length === 1) drag.current = { kind: 'move-flow', id: locs[0].node.id, sx: d.sx, sy: d.sy, x, y, target: null };
            else { drag.current = null; s.toast('para levar vários elementos a outro container, agrupe-os em uma stack primeiro', 'error'); return; }
        }
        const cur = drag.current!;
        if (cur.kind === 'move-abs') {
            const res = snapMove(cur.ids, x - cur.sx, y - cur.sy, s.snap && !e.altKey);
            cur.dx = res.dx; cur.dy = res.dy; cur.guides = res.guides;
        } else if (cur.kind === 'move-flow') {
            cur.x = x; cur.y = y;
            const r0 = s.rects[cur.id];
            cur.target = dropTargetAt(x, y, cur.id, { w: r0?.w || 200, h: r0?.h || 100 });
        } else if (cur.kind === 'resize') {
            cur.rect = resizeRect(cur.origin, cur.handle, x - cur.sx, y - cur.sy, s.snap && !e.altKey, e.shiftKey);
        }
        redraw();
    };

    const onPointerUp = () => {
        const d = drag.current;
        drag.current = null;
        if (!d) return;
        const s = useEditor.getState();
        if (d.kind === 'move-abs') s.moveAbsolute(d.ids, Math.round(d.dx), Math.round(d.dy));
        else if (d.kind === 'move-flow' && d.target) {
            s.moveNode(d.id, { parentId: d.target.parentId, index: d.target.index, rect: d.target.rect, parentSize: d.target.parentSize });
        } else if (d.kind === 'resize') s.setNodeRect(d.id, roundRect(d.rect));
        redraw();
    };

    /** Move with smart guides (parent and sibling edges/centres) or the grid. */
    const snapMove = (ids: string[], dx: number, dy: number, enabled: boolean) => {
        const s = useEditor.getState();
        const r = selectRoot(s);
        const boxes = ids.map((id) => s.rects[id]).filter(Boolean);
        if (!boxes.length || !enabled) return { dx, dy, guides: [] as Rect[] };
        const u = union(boxes);
        const moved = { ...u, x: u.x + dx, y: u.y + dy };
        const loc = T.find(r, ids[0]);
        const others: Rect[] = [];
        if (loc?.parent) {
            const pr = s.rects[loc.parent.id];
            if (pr) others.push(pr);
            for (const c of loc.parent.children || []) if (!ids.includes(c.id) && s.rects[c.id] && c.visible !== false) others.push(s.rects[c.id]);
        }
        const th = SNAP_PX / s.zoom;
        const xs = (b: Rect) => [b.x, b.x + b.w / 2, b.x + b.w];
        const ys = (b: Rect) => [b.y, b.y + b.h / 2, b.y + b.h];
        let bestX: { d: number; line: number } | null = null, bestY: { d: number; line: number } | null = null;
        for (const o of others) {
            for (const lx of xs(o)) for (const mx of xs(moved)) {
                const dd = lx - mx;
                if (Math.abs(dd) <= th && (!bestX || Math.abs(dd) < Math.abs(bestX.d))) bestX = { d: dd, line: lx };
            }
            for (const ly of ys(o)) for (const my of ys(moved)) {
                const dd = ly - my;
                if (Math.abs(dd) <= th && (!bestY || Math.abs(dd) < Math.abs(bestY.d))) bestY = { d: dd, line: ly };
            }
        }
        const guides: Rect[] = [];
        if (bestX) { dx += bestX.d; guides.push({ x: bestX.line, y: 0, w: 0, h: STAGE_H }); }
        else dx = Math.round((u.x + dx) / GRID) * GRID - u.x;
        if (bestY) { dy += bestY.d; guides.push({ x: 0, y: bestY.line, w: STAGE_W, h: 0 }); }
        else dy = Math.round((u.y + dy) / GRID) * GRID - u.y;
        return { dx, dy, guides };
    };

    /* ---------------- drops from the component library / assets ---------------- */

    const dragTypes = (e: React.DragEvent) => Array.from(e.dataTransfer.types);
    const onDragOver = (e: React.DragEvent) => {
        const types = dragTypes(e);
        if (!types.includes('application/x-fmtv-component') && !types.includes('application/x-fmtv-asset') && !types.includes('application/x-fmtv-block')) return;
        e.preventDefault();
        const { x, y } = toStage(e);
        setExternal(dropTargetAt(x, y, null, { w: 240, h: 120 }));
    };
    const onDrop = (e: React.DragEvent) => {
        e.preventDefault();
        const { x, y } = toStage(e);
        const type = e.dataTransfer.getData('application/x-fmtv-component');
        const asset = e.dataTransfer.getData('application/x-fmtv-asset');
        const blockId = e.dataTransfer.getData('application/x-fmtv-block');
        setExternal(null);
        const s = useEditor.getState();
        if (blockId) {
            const block: Block | undefined = BUILTIN_BLOCKS.find((b) => b.id === blockId) || (s.project.blocks || []).find((b) => b.id === blockId);
            if (!block) return;
            const r = T.defaultDropRect(block.node, 0, 0);
            const bt = dropTargetAt(x, y, null, { w: r.w, h: r.h });
            if (bt) s.insertBlock(block, { parentId: bt.parentId, index: bt.index, rect: bt.rect });
            return;
        }
        const probe = T.createNode(type || 'image', new Set());
        const size = T.defaultDropRect(probe, 0, 0);
        const t = dropTargetAt(x, y, null, { w: size.w, h: size.h });
        if (!t) return;
        if (type === 'stack') {
            const dir = e.dataTransfer.getData('application/x-fmtv-direction') === 'vertical' ? 'vertical' : 'horizontal';
            s.createStack(dir, { parentId: t.parentId, index: t.index, rect: t.rect });
            return;
        }
        const id = s.addNode(type || 'image', { parentId: t.parentId, index: t.index, rect: t.rect });
        if (id && asset) s.updateNode(id, (n) => { n.props = { ...(n.props || {}), asset }; });
    };

    /* ---------------- context menu ---------------- */

    const onContextMenu = (e: React.MouseEvent) => {
        if (mode !== 'edit') return;
        e.preventDefault();
        const { x, y } = toStage(e);
        const node = nodeAt(x, y);
        const s = useEditor.getState();
        if (node && !s.selection.includes(node.id)) s.select([node.id]);
        const vp = viewportRef.current!.getBoundingClientRect();
        setMenu({ x: e.clientX - vp.left, y: e.clientY - vp.top });
    };

    const menuItems = useMemo<MenuItem[]>(() => {
        const s = useEditor.getState();
        const one = selection.length === 1 ? T.find(root, selection[0]) : null;
        const isCont = !!one && !!E.registry[one.node.type]?.container;
        return [
            { label: 'Duplicar', shortcut: 'Ctrl+D', action: s.duplicateSelection, disabled: !selection.length },
            { label: 'Copiar', shortcut: 'Ctrl+C', action: s.copySelection, disabled: !selection.length },
            { label: 'Colar', shortcut: 'Ctrl+V', action: s.paste, disabled: !s.clipboard },
            { label: 'Excluir', shortcut: 'Del', action: s.deleteSelection, disabled: !selection.length, danger: true },
            { separator: true },
            { label: 'Criar stack horizontal', shortcut: 'Ctrl+G', action: () => s.wrapSelection('horizontal'), disabled: !selection.length },
            { label: 'Criar stack vertical', shortcut: 'Ctrl+Alt+G', action: () => s.wrapSelection('vertical'), disabled: !selection.length },
            { label: 'Desagrupar', shortcut: 'Ctrl+Shift+G', action: s.unwrapSelection, disabled: !isCont || !one?.parent },
            { label: 'Salvar como bloco', shortcut: 'Meus blocos', action: s.saveSelectionAsBlock, disabled: !one?.parent },
            { separator: true },
            { label: 'Trazer para frente', shortcut: 'Ctrl+]', action: () => s.reorderSelection('front'), disabled: !selection.length },
            { label: 'Enviar para trás', shortcut: 'Ctrl+[', action: () => s.reorderSelection('back'), disabled: !selection.length },
            { separator: true },
            { label: one?.node.visible === false ? 'Mostrar' : 'Ocultar', shortcut: 'Ctrl+Shift+H', action: () => one && s.toggleVisible(one.node.id), disabled: !one },
            { label: one?.node.locked ? 'Desbloquear' : 'Bloquear', shortcut: 'Ctrl+Shift+L', action: () => one && s.toggleLocked(one.node.id), disabled: !one },
        ];
    }, [selection, root]);

    /* ---------------- overlay drawing ---------------- */

    const d = drag.current;
    const z = zoom;
    const box = (r: Rect, cls: string, key?: string, extra?: React.CSSProperties) => (
        <div key={key} className={cls} style={{ left: r.x, top: r.y, width: r.w, height: r.h, borderWidth: 1.5 / z, ...extra }} />
    );

    const selRects = selection.map((id) => ({ id, r: rects[id] })).filter((x) => x.r);
    const emptyContainers: LayoutNode[] = [];
    E.walk(root, (n, p) => { if (p && E.registry[n.type]?.container && !(n.children || []).length && n.visible !== false) emptyContainers.push(n); });
    const single = selection.length === 1 ? T.find(root, selection[0]) : null;
    const showHandles = !!single && !!single.parent && !single.node.locked && !d;
    const sizeLabel = single && rects[single.node.id];
    const target = d?.kind === 'move-flow' ? d.target : external;

    return (
        <div ref={viewportRef} className={'canvas-viewport' + (mode === 'preview' ? ' is-preview' : '')}
            onDragOver={onDragOver} onDrop={onDrop} onDragLeave={() => setExternal(null)}>
            <div ref={stageRef} className="canvas-stage" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
                <iframe ref={iframeRef} title="Prévia do Free My TV" src="/runtime/preview.html" width={STAGE_W} height={STAGE_H}
                    className="canvas-frame" tabIndex={mode === 'preview' ? 0 : -1} />
                {mode === 'edit' && (
                    <div className="canvas-overlay" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
                        onPointerLeave={() => !drag.current && useEditor.getState().setHover(null)} onContextMenu={onContextMenu}
                        onDragStart={(e) => e.preventDefault()} onPointerCancel={() => { drag.current = null; redraw(); }}
                        onDoubleClick={() => window.dispatchEvent(new CustomEvent('fmtv:focus-props'))}>
                        {showSafeArea && <div className="safe-area" style={{ left: SAFE.x, top: SAFE.y, width: SAFE.w, height: SAFE.h, borderWidth: 1 / z }} title="Área segura da TV (90%)" />}
                        {showFocusMap && focusMap && <FocusOverlay map={focusMap} hover={focusHover} zoom={z} />}
                        {emptyContainers.map((c) => rects[c.id] && (
                            <div key={'empty-' + c.id} className="ov-empty" style={{ left: rects[c.id].x, top: rects[c.id].y, width: rects[c.id].w, height: rects[c.id].h, borderWidth: 1.5 / z }}>
                                <span style={{ transform: `scale(${1 / z})` }}>{c.type === 'stack' ? 'Stack vazia: arraste elementos para cá' : 'Container vazio'}</span>
                            </div>
                        ))}
                        {hover && !selection.includes(hover) && rects[hover] && !d && box(rects[hover], 'ov-hover')}
                        {d?.kind !== 'move-abs' && d?.kind !== 'resize' && selRects.map(({ id, r }) => box(r, 'ov-selected', id))}
                        {d?.kind === 'move-abs' && d.ids.map((id) => rects[id] && box({ ...rects[id], x: rects[id].x + d.dx, y: rects[id].y + d.dy }, 'ov-ghost', id))}
                        {d?.kind === 'move-abs' && d.guides.map((g, i) => <div key={i} className="ov-guide" style={{ left: g.x, top: g.y, width: g.w || 1 / z, height: g.h || 1 / z }} />)}
                        {d?.kind === 'move-flow' && rects[d.id] && box({ ...rects[d.id], x: d.x - rects[d.id].w / 2, y: d.y - rects[d.id].h / 2 }, 'ov-ghost')}
                        {target && box(target.container, 'ov-drop-container')}
                        {target && <div className={target.rect ? 'ov-drop-rect' : 'ov-insert'} style={{ left: target.indicator.x, top: target.indicator.y, width: target.indicator.w, height: target.indicator.h, borderWidth: 1.5 / z }} />}
                        {d?.kind === 'resize' && box(d.rect, 'ov-selected')}
                        {showHandles && rects[single!.node.id] && HANDLES.map((h) => {
                            const r = rects[single!.node.id];
                            const hs = 9 / z;
                            const px = h.includes('w') ? r.x : h.includes('e') ? r.x + r.w : r.x + r.w / 2;
                            const py = h.includes('n') ? r.y : h.includes('s') ? r.y + r.h : r.y + r.h / 2;
                            return <div key={h} data-handle={h} className={'ov-handle h-' + h} style={{ left: px - hs / 2, top: py - hs / 2, width: hs, height: hs, borderWidth: 1.5 / z }} />;
                        })}
                        {sizeLabel && !d && (
                            <div className="ov-size" style={{ left: sizeLabel.x + sizeLabel.w / 2, top: sizeLabel.y + sizeLabel.h + 8 / z, transform: `translateX(-50%) scale(${1 / z})`, transformOrigin: 'top center' }}>
                                {Math.round(sizeLabel.w)} × {Math.round(sizeLabel.h)}
                            </div>
                        )}
                        {d?.kind === 'resize' && (
                            <div className="ov-size" style={{ left: d.rect.x + d.rect.w / 2, top: d.rect.y + d.rect.h + 8 / z, transform: `translateX(-50%) scale(${1 / z})`, transformOrigin: 'top center' }}>
                                {Math.round(d.rect.w)} × {Math.round(d.rect.h)}
                            </div>
                        )}
                    </div>
                )}
            </div>
            {!ready && <div className="canvas-loading">Carregando o runtime da TV…</div>}
            {ready && mode === 'edit' && !project.layout.pages[page] && (
                <div className="page-original">
                    <div>
                        <strong>{E.PAGES[page]?.label}: visual original</strong>
                        <span>{PAGE_HINTS[page]} Esta tela ainda não faz parte do layout.</span>
                    </div>
                    <button className="btn primary" onClick={() => useEditor.getState().customizePage(page)}>Personalizar esta tela</button>
                </div>
            )}
            {ready && mode === 'edit' && showFocusMap && <FocusLegend page={page} />}
            {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
        </div>
    );
}

/** Smallest focus item under the point, or -1. */
function focusItemAt(rs: Rect[], x: number, y: number): number {
    let best = -1, area = Infinity;
    rs.forEach((r, i) => {
        if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h && r.w * r.h < area) { best = i; area = r.w * r.h; }
    });
    return best;
}

const ARROW: Record<(typeof DIRS)[number], string> = { left: '◀', right: '▶', up: '▲', down: '▼' };

/**
 * Focus map: every item the remote can focus, numbered by how many arrow presses it
 * takes from the initial focus (red: never reached). Hovering an item shows where
 * each arrow goes from there.
 */
function FocusOverlay({ map, hover, zoom }: { map: FocusMap; hover: number; zoom: number }) {
    const k = 1 / zoom;
    const { items, graph, start } = map;
    const h = hover >= 0 && hover < items.length ? hover : -1;
    const center = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
    const stepsText = (s: number) => (s === -1 ? 'nunca recebe o foco pelas setas' : s === 0 ? 'foco inicial' : `${s} clique(s) a partir do início`);
    return (
        <>
            {items.map((it, i) => {
                const steps = graph.steps[i];
                const cls = 'fm-item' + (i === start ? ' start' : steps === -1 ? ' lost' : '') + (i === h ? ' hover' : '');
                return (
                    <div key={i} className={cls} data-focus-index={i} data-steps={steps}
                        style={{ left: it.rect.x, top: it.rect.y, width: it.rect.w, height: it.rect.h, borderWidth: 2 * k }}>
                        <span className="fm-badge" style={{ transform: `scale(${k})` }}>{i === start ? 'início' : steps === -1 ? '!' : steps}</span>
                    </div>
                );
            })}
            {h >= 0 && (
                <svg className="fm-arrows" width={STAGE_W} height={STAGE_H} viewBox={`0 0 ${STAGE_W} ${STAGE_H}`}>
                    <defs>
                        <marker id="fm-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                            <path d="M0 0 10 5 0 10z" fill="currentColor" />
                        </marker>
                    </defs>
                    {DIRS.map((d) => {
                        const n = graph.next[h][d];
                        if (n === -1) return null;
                        const a = center(items[h].rect), b = center(items[n].rect);
                        return (
                            <g key={d}>
                                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} strokeWidth={2.5 * k} markerEnd="url(#fm-head)" />
                                <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2} fontSize={16 * k} textAnchor="middle" dominantBaseline="middle">{ARROW[d]}</text>
                            </g>
                        );
                    })}
                </svg>
            )}
            {h >= 0 && (
                <div className="fm-tip" style={{ left: items[h].rect.x, top: items[h].rect.y + items[h].rect.h + 6 * k, transform: `scale(${k})`, transformOrigin: 'top left' }}>
                    <strong>{items[h].label || 'item'}</strong>
                    <span>{stepsText(graph.steps[h])}</span>
                    <span>{DIRS.map((d) => `${ARROW[d]} ${graph.next[h][d] === -1 ? '(nada)' : items[graph.next[h][d]].label || 'item'}`).join('    ')}</span>
                </div>
            )}
        </>
    );
}

function FocusLegend({ page }: { page: string }) {
    const map = useEditor((s) => s.audit.focus);
    if (page !== 'home') {
        return <div className="fm-legend">Mapa de foco: vale para a tela inicial. Nas outras telas, a navegação é a do próprio launcher.</div>;
    }
    if (!map) return null;
    const lost = map.graph.steps.filter((s) => s === -1).length;
    const far = Math.max(0, ...map.graph.steps);
    return (
        <div className="fm-legend" data-testid="focus-legend">
            <span><i className="dot start" /> foco inicial</span>
            <span><i className="dot" /> número = cliques nas setas até chegar</span>
            <span><i className="dot lost" /> inalcançável</span>
            <span className="fm-sum">{map.items.length} itens · o mais distante a {far} clique(s){lost ? ` · ${lost} inalcançável(is)` : ''}</span>
        </div>
    );
}

function isTyping(e: Event) {
    const t = e.target as HTMLElement;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

function union(rs: Rect[]): Rect {
    const x = Math.min(...rs.map((r) => r.x)), y = Math.min(...rs.map((r) => r.y));
    return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y };
}

function roundRect(r: Rect): Rect {
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
}

function resizeRect(o: Rect, h: Handle, dx: number, dy: number, snap: boolean, keepRatio: boolean): Rect {
    let { x, y, w, h: hh } = o;
    const g = (v: number) => (snap ? Math.round(v / GRID) * GRID : v);
    if (h.includes('e')) w = g(o.x + o.w + dx) - o.x;
    if (h.includes('s')) hh = g(o.y + o.h + dy) - o.y;
    if (h.includes('w')) { x = g(o.x + dx); w = o.x + o.w - x; }
    if (h.includes('n')) { y = g(o.y + dy); hh = o.y + o.h - y; }
    if (keepRatio && o.w > 0 && o.h > 0) {
        const ratio = o.w / o.h;
        if (h === 'n' || h === 's') w = hh * ratio; else hh = w / ratio;
        if (h.includes('w')) x = o.x + o.w - w;
        if (h.includes('n')) y = o.y + o.h - hh;
    }
    w = Math.max(8, w); hh = Math.max(8, hh);
    return { x, y, w, h: hh };
}

export { isTyping };
