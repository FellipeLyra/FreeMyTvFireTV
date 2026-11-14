/*
 * Free My TV — layout runtime.
 *
 * Renders a published layout (see engine.js) on top of the existing launcher
 * page without replacing it:
 *
 *   - Launcher widgets (app shelf, weather, clock, trending, ...) are "slots": the
 *     existing elements are moved into the layout. The page's own code keeps
 *     updating them by id, so weather, app launching, trailers, focus effects and
 *     translations work exactly as without a layout.
 *   - New elements (stacks, frames, text, images, buttons, ...) are built from data.
 *   - Arrow keys use the engine's spatial navigation while a layout is shown.
 *
 * With no layout, or with a layout that fails validation or rendering, the page
 * stays exactly as it was and the failure is reported to the app, which falls
 * back to the previous working layout. Plain ES5, no dependencies.
 */
(function() {
    'use strict';
    var E = window.FMTVEngine;
    if (!E) return;

    var api = window.FMTVLayout = { active: null, lastError: null, render: render, clear: clear, reload: boot };
    var slotHomes = [];          // [{el, parent, next}] to put moved widgets back
    var rootEl = null;
    var clockTimers = [];
    var reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

    function bridge() { return window.FireTV || null; }
    function call(name) {
        var b = bridge();
        if (!b || typeof b[name] !== 'function') return undefined;
        try { return b[name].apply(b, Array.prototype.slice.call(arguments, 1)); } catch (e) { return undefined; }
    }
    function lang() {
        try { return typeof currentLang === 'function' ? currentLang() : 'en'; } catch (e) { return 'en'; }
    }
    function tr(en, pt) { return lang() === 'pt' ? pt : en; }

    /* ---------------- styles the runtime needs ---------------- */

    function ensureStylesheet() {
        if (document.getElementById('fmtvRuntimeCss')) return;
        var s = document.createElement('style');
        s.id = 'fmtvRuntimeCss';
        s.textContent = [
            '#fmtvLayoutRoot{position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:10;overflow:hidden}',
            '#fmtvParking{display:none}',
            '.fmtv-slot > *{max-width:100%}',
            '.fmtv-slot > .shelf-wrapper,.fmtv-slot > .picks-section,.fmtv-slot > .hero-shelf{width:100%;margin:0}',
            '.fmtv-button{border:0;cursor:pointer;font:inherit;padding:14px 28px;border-radius:999px;',
            'background:var(--fmtv-surface);color:var(--fmtv-text);outline:none;',
            'transition:transform .18s ease, box-shadow .18s ease, background .18s ease}',
            '.fmtv-button.focused{transform:translateY(calc(var(--fmtv-lift, 4px) * -1)) scale(var(--fmtv-scale, 1.06));',
            'box-shadow:0 0 0 3px var(--fmtv-focus), 0 12px 30px rgba(0,0,0,.45)}',
            '.fmtv-image{background-repeat:no-repeat}',
            '.fmtv-page-root{flex:1 1 auto;min-height:0;width:100%}',
            '#screensaverOverlay > .fmtv-page-root{height:100%}',
            '#weatherDrawer[data-fmtv-place="left"] .drawer-panel{transform:translateX(-100%);border-left:0;border-right:1px solid rgba(255,255,255,.14)}',
            '#weatherDrawer.active[data-fmtv-place="left"] .drawer-panel{transform:none}',
            '#weatherDrawer[data-fmtv-place="center"] .drawer-panel{transform:scale(.96);opacity:0;transition:transform .25s ease,opacity .25s ease}',
            '#weatherDrawer.active[data-fmtv-place="center"] .drawer-panel{transform:none;opacity:1}',
            '#weatherDrawer[data-fmtv-place="bottom"] .drawer-panel{transform:translateY(100%);border-left:0;border-top:1px solid rgba(255,255,255,.14)}',
            '#weatherDrawer.active[data-fmtv-place="bottom"] .drawer-panel{transform:none}'
        ].join('');
        document.head.appendChild(s);
    }

    /* ---------------- slots ---------------- */

    function parking() {
        var p = document.getElementById('fmtvParking');
        if (!p) {
            p = document.createElement('div');
            p.id = 'fmtvParking';
            p.setAttribute('aria-hidden', 'true');
            document.body.appendChild(p);
        }
        return p;
    }

    function takeSlot(selector, up) {
        var el = typeof selector === 'string' ? document.querySelector(selector) : selector;
        for (var u = 0; el && u < (up || 0); u++) el = el.parentElement;
        if (!el) return null;
        var known = false;
        for (var i = 0; i < slotHomes.length; i++) if (slotHomes[i].el === el) known = true;
        if (!known) slotHomes.push({ el: el, parent: el.parentNode, next: el.nextSibling });
        return el;
    }

    function restoreSlots() {
        // Put widgets back in reverse order so `next` siblings already exist.
        for (var i = slotHomes.length - 1; i >= 0; i--) {
            var h = slotHomes[i];
            if (h.next && h.next.parentNode === h.parent) h.parent.insertBefore(h.el, h.next);
            else h.parent.appendChild(h.el);
        }
        slotHomes = [];
    }

    /* ---------------- building ---------------- */

    function applyCss(el, css) {
        for (var k in css) {
            if (Object.prototype.hasOwnProperty.call(css, k)) el.style.setProperty(k, css[k]);
        }
    }

    function runAction(action) {
        if (!action) return;
        switch (action.type) {
            case 'open-settings':
                if (typeof openSettingsModal === 'function') openSettingsModal();
                break;
            case 'open-weather':
                if (typeof openDrawer === 'function') openDrawer();
                break;
            case 'launch-app':
                if (typeof launchApp === 'function') launchApp(action.appId);
                break;
            case 'fire-settings':
                if (typeof launchApp === 'function') launchApp('fmtv.settings');
                break;
            case 'amazon-home':
                if (typeof launchApp === 'function') launchApp('fmtv.amazonhome');
                break;
        }
    }

    function formatClock(format) {
        var d = new Date();
        var h = d.getHours(), m = d.getMinutes();
        var use12 = format === '12h' || (format === 'auto' && typeof state !== 'undefined' && state.clockFormat === '12h');
        var mm = (m < 10 ? '0' : '') + m;
        if (use12) return ((h % 12) || 12) + ':' + mm + (h < 12 ? ' AM' : ' PM');
        return (h < 10 ? '0' : '') + h + ':' + mm;
    }

    function build(node, parent, index, ctx) {
        var def = E.registry[node.type];
        var el;
        if (node.type === 'button') {
            el = document.createElement('button');
            el.className = 'fmtv-button' + (node.focus && node.focus.skip ? '' : ' nav-item');
            var label = (node.props && node.props.label) || '';
            el.textContent = label;
            el.dataset.tag = tr('Shortcut', 'Atalho');
            el.dataset.title = label;
            el.dataset.desc = '';
            var action = node.props && node.props.action;
            el.addEventListener('click', function() { runAction(action); });
        } else {
            el = document.createElement('div');
        }
        el.setAttribute('data-fmtv-id', node.id);
        var css = E.nodeCss(node, parent, ctx.tokens, { index: index, assetUrl: ctx.assetUrl });
        applyCss(el, css);

        if (node.animation && node.animation.focus) {
            if (E.resolveToken(node.animation.focus.scale, ctx.tokens, 'number')) el.style.setProperty('--fmtv-scale', String(node.animation.focus.scale));
            if (node.animation.focus.lift !== undefined) el.style.setProperty('--fmtv-lift', node.animation.focus.lift + 'px');
        }

        if (node.type === 'text') {
            el.textContent = (node.props && node.props.text) || '';
        } else if (node.type === 'image') {
            el.className = 'fmtv-image';
            var url = ctx.assetUrl(node.props.asset);
            if (url) {
                el.style.backgroundImage = 'url("' + url + '")';
                var fit = node.props.fit || 'cover';
                el.style.backgroundSize = fit === 'fill' ? '100% 100%' : fit;
                el.style.backgroundPosition = 'center';
            }
        } else if (node.type === 'clock-text') {
            var fmt = (node.props && node.props.format) || 'auto';
            var tick = function() { el.textContent = formatClock(fmt); };
            tick();
            clockTimers.push(setInterval(tick, 1000));
        } else if (window.FMTVBlocks && window.FMTVBlocks.builds(node.type)) {
            window.FMTVBlocks.build(node, el, ctx);
        } else if (def.slot) {
            el.className = 'fmtv-slot';
            var widget = takeSlot(def.slot, def.up);
            if (!widget) throw new Error('widget ' + node.type + ' (' + def.slot + ') não existe nesta versão da tela');
            el.appendChild(widget);
            if (SLOT_PROPS[node.type]) SLOT_PROPS[node.type](widget, node.props || {}, ctx);
        }

        if (def.container) {
            var kids = node.children || [];
            var flow = 0;
            for (var i = 0; i < kids.length; i++) {
                var child = kids[i];
                var isAbs = child.position === 'absolute' || node.type === 'frame';
                el.appendChild(build(child, node, isAbs ? 0 : flow, ctx));
                if (!isAbs && child.visible !== false) flow++;
            }
        }

        var anim = !reducedMotion && !ctx.noAnim && E.enterAnimation(node);
        if (anim && el.animate) {
            var from = {}, to = { opacity: el.style.opacity || '1' };
            for (var k in anim.from) from[k] = anim.from[k];
            if (from.transform) to.transform = 'none';
            try { el.animate([from, to], { duration: anim.duration, delay: anim.delay, easing: anim.easing, fill: 'backwards' }); } catch (e) {}
        }
        if (node.focus && node.focus.initial) ctx.initial = el;
        return el;
    }

    /* ---------------- other screens (overlays) ---------------- */

    var savedStyles = [];   // [{el, style, attrs}] restored by clear()
    var overlayRoots = [];

    function saveEl(el, attrs) {
        for (var i = 0; i < savedStyles.length; i++) if (savedStyles[i].el === el) return;
        var rec = { el: el, style: el.getAttribute('style'), attrs: {} };
        (attrs || []).forEach(function(a) { rec.attrs[a] = el.getAttribute(a); });
        savedStyles.push(rec);
    }
    function restoreSaved() {
        for (var i = savedStyles.length - 1; i >= 0; i--) {
            var r = savedStyles[i];
            if (r.style === null) r.el.removeAttribute('style'); else r.el.setAttribute('style', r.style);
            for (var a in r.attrs) {
                if (r.attrs[a] === null) r.el.removeAttribute(a); else r.el.setAttribute(a, r.attrs[a]);
            }
        }
        savedStyles = [];
    }

    // Per-widget settings for launcher widgets that have props.
    var SLOT_PROPS = {
        'screensaver.clock': function(wrap, p, ctx) {
            // The page is still being built (not in the document yet): search inside the widget.
            var clock = wrap.querySelector('#screensaverClock');
            var date = wrap.querySelector('#screensaverDate');
            var color = E.resolveToken(p.color || 'rgba(255,255,255,0.82)', ctx.tokens, 'color');
            if (clock) { saveEl(clock); if (p.clockSize) clock.style.fontSize = p.clockSize + 'px'; if (color) clock.style.color = color; }
            if (date) {
                saveEl(date);
                if (p.dateSize) date.style.fontSize = p.dateSize + 'px';
                if (color) date.style.color = color;
                if (p.showDate === false) date.style.display = 'none';
            }
        }
    };

    // The page root's own look (background, corners, border, shadow, blur) belongs to the panel.
    var PANEL_PROPS = ['background', 'border-radius', 'border', 'box-shadow', 'backdrop-filter', '-webkit-backdrop-filter', 'opacity'];

    function moveLook(fromCss, toEl, rootEl) {
        for (var i = 0; i < PANEL_PROPS.length; i++) {
            var k = PANEL_PROPS[i];
            if (fromCss[k] !== undefined) {
                toEl.style.setProperty(k, fromCss[k]);
                if (rootEl) rootEl.style.removeProperty(k);
            }
        }
    }

    function placePanel(pid, host, backdrop, panel) {
        panel = panel || {};
        var place = panel.placement;
        if (backdrop) { saveEl(backdrop, ['data-fmtv-place']); if (place) backdrop.setAttribute('data-fmtv-place', place); }
        if (pid === 'weather') {
            place = place || 'right';
            var w = panel.width || (place === 'bottom' ? 1920 : place === 'center' ? 720 : 460);
            host.style.width = w + 'px';
            host.style.maxWidth = '100vw';
            if (place === 'left') { backdrop.style.justifyContent = 'flex-start'; }
            if (place === 'center') {
                backdrop.style.justifyContent = 'center'; backdrop.style.alignItems = 'center';
                host.style.height = (panel.height || 640) + 'px'; host.style.borderRadius = host.style.borderRadius || '28px';
            }
            if (place === 'bottom') {
                backdrop.style.justifyContent = 'center'; backdrop.style.alignItems = 'flex-end';
                host.style.height = (panel.height || 420) + 'px';
            }
        } else if (pid === 'settings') {
            place = place || 'center';
            if (panel.width) host.style.width = panel.width + 'px';
            if (panel.height) { host.style.height = panel.height + 'px'; host.style.maxHeight = '100vh'; }
            if (place === 'left' || place === 'right') {
                backdrop.style.justifyContent = place === 'left' ? 'flex-start' : 'flex-end';
                backdrop.style.alignItems = 'stretch'; backdrop.style.padding = '0';
                host.style.maxHeight = '100vh'; host.style.borderRadius = host.style.borderRadius || '0';
            }
            if (place === 'fullscreen') {
                backdrop.style.padding = '0';
                host.style.width = '100vw'; host.style.height = '100vh'; host.style.maxHeight = '100vh'; host.style.borderRadius = '0';
            }
        } else if (pid === 'messages') {
            place = place || 'top-right';
            var pos = {
                'top-right': { top: '24px', right: '36px' },
                top: { top: '24px', left: '50%', transform: 'translateX(-50%)' },
                bottom: { bottom: '40px', left: '50%', transform: 'translateX(-50%)' },
                'bottom-right': { bottom: '40px', right: '36px' },
                center: { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }
            }[place];
            host.style.top = host.style.right = host.style.bottom = host.style.left = 'auto';
            host.style.transform = 'none';
            for (var k in pos) host.style[k] = pos[k];
        }
    }

    /** Render one of the other screens into its overlay. */
    function renderPage(pid, page, ctx) {
        var meta = E.PAGES[pid];
        var host = document.querySelector(meta.host);
        if (!host) throw new Error('a tela "' + meta.label + '" não existe nesta versão do launcher');
        var backdrop = meta.backdrop ? document.querySelector(meta.backdrop) : null;
        saveEl(host, ['data-fmtv-id', 'data-fmtv-page']);
        var css = E.nodeCss(page.root, null, ctx.tokens, { assetUrl: ctx.assetUrl });
        applyCss(host, E.rootVars(ctx.tokens));
        if (meta.styleOnly) {
            // Only the look changes: the launcher keeps writing the message text into it.
            moveLook(css, host, null);
            ['color', 'font-size', 'font-weight', 'font-family', 'letter-spacing', 'text-align', 'padding'].forEach(function(k) {
                if (css[k] !== undefined) host.style.setProperty(k, css[k]);
            });
            host.setAttribute('data-fmtv-id', page.root.id);
            host.setAttribute('data-fmtv-page', pid);
            placePanel(pid, host, backdrop, page.panel);
            return;
        }
        var root = build(page.root, null, 0, ctx);
        root.setAttribute('data-fmtv-page', pid);
        root.className = (root.className ? root.className + ' ' : '') + 'fmtv-page-root';
        moveLook(css, host, root);
        // Original parts the layout does not use leave the screen (and its navigation).
        Array.prototype.slice.call(host.children).forEach(function(child) { parking().appendChild(takeSlot(child)); });
        host.appendChild(root);
        placePanel(pid, host, backdrop, page.panel);
        overlayRoots.push(root);
    }

    /* ---------------- render / clear ---------------- */

    function clear() {
        if (window.FMTVBlocks) window.FMTVBlocks.reset();
        for (var i = 0; i < clockTimers.length; i++) clearInterval(clockTimers[i]);
        clockTimers = [];
        restoreSlots();
        overlayRoots.forEach(function(r) { if (r.parentNode) r.parentNode.removeChild(r); });
        overlayRoots = [];
        restoreSaved();
        if (rootEl && rootEl.parentNode) rootEl.parentNode.removeChild(rootEl);
        rootEl = null;
        var container = document.querySelector('.container');
        if (container) container.style.display = '';
        api.active = null;
        document.body.classList.remove('fmtv-layout');
        refreshNav(null);
    }

    function refreshNav(initialEl) {
        if (typeof refreshMainNavList !== 'function') return;
        refreshMainNavList();
        if (!initialEl || typeof setMainFocus !== 'function') return;
        // Inside a widget, an app tile beats its toolbar buttons (e.g. "Reorder").
        var target = initialEl.classList.contains('nav-item') ? initialEl
            : (initialEl.querySelector('.app-tile.nav-item') || initialEl.querySelector('.nav-item'));
        if (target && typeof mainNavItems !== 'undefined' && mainNavItems.indexOf(target) !== -1) setMainFocus(target);
    }

    /**
     * Render `input` (layout object or JSON text). Returns {ok, errors, warnings}.
     * `opts.assetUrl(asset)` resolves asset URLs (defaults to the app's imported layout folder).
     */
    function render(input, opts) {
        opts = opts || {};
        // opts.preview: Studio canvas. Unfinished layouts are drawn and enter
        // animations only play when opts.animate is set.
        var result = E.validate(input, opts.preview ? { studio: true } : undefined);
        if (!result.ok) {
            api.lastError = result.errors;
            return result;
        }
        var layout = result.layout;
        clear();
        ensureStylesheet();
        var assetsById = {};
        (layout.assets || []).forEach(function(a) { assetsById[a.id] = a; });
        var ctx = {
            tokens: E.mergeTokens(layout.tokens || {}),
            assetUrl: opts.assetUrl || function(id) {
                var a = assetsById[id];
                return a ? '/userlayout/assets/' + encodeURIComponent(a.file) : null;
            },
            initial: null,
            noAnim: !!opts.preview && !opts.animate
        };
        try {
            var root = build(layout.pages.home.root, null, 0, ctx);
            root.id = 'fmtvLayoutRoot';
            applyCss(root, E.rootVars(ctx.tokens));
            // Widgets the layout does not use stay alive, hidden, so the page's code still finds them.
            var unused = ['.brand-group', '#customizeBtn', '#weatherWidget', '#clockText', '#dateText', '.hero-shelf', '.shelf-wrapper', '.picks-section'];
            for (var i = 0; i < unused.length; i++) {
                var el = document.querySelector(unused[i]);
                if (el && !root.contains(el)) parking().appendChild(takeSlot(unused[i]));
            }
            var container = document.querySelector('.container');
            if (container) container.style.display = 'none';
            document.body.appendChild(root);
            rootEl = root;
            for (var pid in layout.pages) {
                if (pid !== 'home' && Object.prototype.hasOwnProperty.call(layout.pages, pid) && E.PAGES[pid] && E.PAGES[pid].runtime) {
                    renderPage(pid, layout.pages[pid], ctx);
                }
            }
            api.active = layout;
            document.body.classList.add('fmtv-layout');
            refreshNav(ctx.initial);
            if (!opts.preview && typeof mainNavItems !== 'undefined' && !mainNavItems.length) throw new Error('nenhum elemento navegável ficou visível na tela');
        } catch (e) {
            clear();
            api.lastError = [{ path: '', message: String(e && e.message || e) }];
            return { ok: false, errors: api.lastError, warnings: result.warnings };
        }
        api.lastError = null;
        return result;
    }

    /* ---------------- remote control ---------------- */

    var DIRS = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };

    function onKey(e) {
        if (!api.active) return;
        var dir = DIRS[e.key];
        if (!dir) return;
        if (typeof modalOpen !== 'undefined' && modalOpen) return;
        if (typeof drawerOpen !== 'undefined' && drawerOpen) return;
        if (typeof screensaverOn !== 'undefined' && screensaverOn) return;
        if (typeof shelfEdit !== 'undefined' && shelfEdit) return;
        if (typeof mainNavItems === 'undefined' || typeof setMainFocus !== 'function') return;
        if (typeof lastActivity !== 'undefined') lastActivity = Date.now();
        var rects = mainNavItems.map(function(el) {
            var r = el.getBoundingClientRect();
            return { x: r.left, y: r.top, w: r.width, h: r.height };
        });
        var next = E.pickNext(rects, curIndex, dir);
        if (next !== -1) setMainFocus(mainNavItems[next]);
        e.preventDefault();
        e.stopPropagation();
    }

    /* ---------------- safe way back ---------------- */

    function addRestoreButton() {
        var actions = document.querySelector('#settingsModal .modal-actions');
        if (!actions || document.getElementById('fmtvRestoreLayout')) return;
        var b = document.createElement('button');
        b.id = 'fmtvRestoreLayout';
        b.className = 'btn-secondary modal-nav';
        b.textContent = tr('Default layout', 'Layout padrão');
        b.title = tr('Remove the published layout and go back to the original screen', 'Remove o layout publicado e volta à tela original');
        b.addEventListener('click', function() {
            call('resetLayout');
            location.reload();
        });
        actions.insertBefore(b, actions.firstChild);
    }

    /* ---------------- boot ---------------- */

    function boot() {
        // Studio preview: the layout is handed over by the editor, never by the network.
        if (window.__fmtvPreviewMode) {
            if (window.__fmtvPreviewLayout) render(window.__fmtvPreviewLayout, { assetUrl: window.__fmtvPreviewAssetUrl, preview: true });
            return;
        }
        var json = call('getLayoutJson');
        if (!json) return;
        var res = render(json);
        var id = res.layout ? res.layout.id : '';
        if (!id) {
            // Invalid layouts still carry an id the app can match against its records.
            try { var raw = JSON.parse(json); if (raw && typeof raw.id === 'string') id = raw.id.slice(0, 64); } catch (e) {}
        }
        if (res.ok) {
            addRestoreButton();
            // Confirm only once the page has actually been painted with the layout.
            requestAnimationFrame(function() { requestAnimationFrame(function() { call('layoutRendered', id); }); });
        } else {
            var msg = res.errors.map(function(x) { return (x.path ? x.path + ': ' : '') + x.message; }).join('\n');
            if (window.console) console.error('[FMTV layout] ' + msg);
            call('layoutFailed', id, msg.slice(0, 2000));
        }
    }

    window.addEventListener('keydown', onKey, true);
    window.addEventListener('message', function(ev) {
        if (!window.__fmtvPreviewMode || !ev.data || ev.data.type !== 'fmtv:preview') return;
        var res = render(ev.data.layout, { assetUrl: window.__fmtvPreviewAssetUrl, preview: true, animate: !!ev.data.animate });
        if (ev.source && ev.source.postMessage) {
            ev.source.postMessage({ type: 'fmtv:rendered', ok: res.ok, errors: res.errors, warnings: res.warnings }, '*');
        }
    });
    boot();
})();
