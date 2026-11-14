/*
 * Free My TV — content blocks for layouts (carousel, grid, banner, full weather, icon).
 *
 * The data comes from the launcher's own services, never from the layout:
 *   - movies / shows: fetchTrendingPicks(tab, sink) (TMDB with the user's key,
 *     TVMaze, or the curated list), the same code as the trending row;
 *   - apps / favorites: the launcher catalog and the apps reported by Android;
 *   - weather: the launcher's Open-Meteo forecast (state + its widget).
 * Cards are real `.nav-item`s, so remote focus, the hero text and launching
 * behave like the launcher's own tiles. Plain ES5, no dependencies.
 */
(function() {
    'use strict';

    /* ---------------- data hub ---------------- */

    var listeners = [];
    var hub = {
        picks: { movies: null, shows: null },
        requested: {},
        installed: null,      // {appId: true} once Android reported the installed apps
        weatherVersion: 0
    };
    function emit(kind) {
        for (var i = 0; i < listeners.length; i++) {
            try { listeners[i](kind); } catch (e) { if (window.console) console.error('[FMTV block]', e); }
        }
    }

    window.FMTVData = {
        /** Called by the page's trending service for every result (see sync_web.py). */
        picks: function(tab, items, source) {
            if (tab !== 'movies' && tab !== 'shows' || !items || !items.length) return;
            hub.picks[tab] = items.slice();
            hub.picks[tab].source = source;
            emit('picks');
        },
        hub: hub
    };

    function requestPicks(tab) {
        if (hub.requested[tab] || typeof fetchTrendingPicks !== 'function') return;
        hub.requested[tab] = true;
        try { fetchTrendingPicks(tab, function() { /* FMTVData.picks already stored it */ }); } catch (e) {}
        // Same refresh rhythm as the trending row.
        setInterval(function() { try { fetchTrendingPicks(tab, function() {}); } catch (e) {} }, 60 * 60 * 1000);
    }

    // Installed apps and weather updates: listen to the page's own functions.
    function wrapGlobal(name, after) {
        var orig = window[name];
        if (typeof orig !== 'function' || orig.__fmtvWrapped) return;
        var wrapped = function() {
            var r = orig.apply(this, arguments);
            try { after.apply(this, arguments); } catch (e) {}
            return r;
        };
        wrapped.__fmtvWrapped = true;
        window[name] = wrapped;
    }
    wrapGlobal('addLaunchPoints', function(points) {
        hub.installed = hub.installed || {};
        (points || []).forEach(function(lp) { var id = lp.appId || lp.id; if (id) hub.installed[id] = true; });
        emit('apps');
    });
    wrapGlobal('renderDrawerForecast', function() { hub.weatherVersion++; emit('weather'); });
    wrapGlobal('renderAppsShelf', function() { emit('favorites'); });
    // Keep the focused card of a carousel or grid in view.
    wrapGlobal('setMainFocus', function(item) { if (item) scrollIntoTrack(item); });

    /* ---------------- helpers ---------------- */

    var SAFE_IMG = /^https:\/\/[^\s"'()\\]+$/;
    function tt(s) { try { return typeof t === 'function' ? t(s) : s; } catch (e) { return s; } }
    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined && text !== null) e.textContent = text;
        return e;
    }
    function editing() { return !!window.__fmtvPreviewMode && !window.__fmtvPreviewPlaying; }

    /** Re-scan the focusable items after a block changed, keeping the current focus. */
    function refreshNav() {
        if (editing() || typeof refreshMainNavList !== 'function') return;
        var focused = document.querySelector('.nav-item.focused');
        refreshMainNavList();
        if (focused && document.body.contains(focused) && typeof setMainFocus === 'function') setMainFocus(focused);
    }

    function scrollIntoTrack(item) {
        var track = item.parentNode;
        if (!track || !track.classList || !track.classList.contains('fmtv-track')) return;
        var box = track.parentNode;
        var vertical = track.classList.contains('fmtv-track-v');
        var start = vertical ? item.offsetTop : item.offsetLeft;
        var size = vertical ? item.offsetHeight : item.offsetWidth;
        var view = vertical ? box.clientHeight : box.clientWidth;
        var pad = 28;
        var cur = track.__fmtvOffset || 0;
        if (start + size - cur > view - pad) cur = start + size - view + pad;
        if (start - cur < pad) cur = Math.max(0, start - pad);
        track.__fmtvOffset = cur;
        track.style.transform = vertical ? 'translateY(' + (-cur) + 'px)' : 'translateX(' + (-cur) + 'px)';
    }

    function contentItems(source, max) {
        var out = [];
        if (source === 'movies' || source === 'shows') {
            var picks = hub.picks[source];
            if (!picks) {
                requestPicks(source);
                picks = (source === 'shows' ? window.FALLBACK_SHOWS : window.FALLBACK_MOVIES) || [];
            }
            for (var i = 0; i < picks.length && out.length < max; i++) {
                var p = picks[i];
                out.push({ kind: 'pick', title: p.title, badge: p.badge, desc: p.desc, poster: p.poster, color: p.color, app: p.app, target: p.contentTarget });
            }
            return out;
        }
        // An empty report means "unknown" (no Android bridge, e.g. the Studio preview): show the catalog.
        var known = !!hub.installed && Object.keys(hub.installed).length > 0;
        var catalog = (typeof state !== 'undefined' && state.catalog) || [];
        var byId = {};
        catalog.forEach(function(a) { byId[a.id] = a; });
        var apps = source === 'favorites'
            ? ((typeof state !== 'undefined' && state.favorites) || []).map(function(id) { return byId[id]; }).filter(Boolean)
            : catalog.filter(function(a) { return !/^fmtv\./.test(a.id) && !/^com\.webos\./.test(a.id) && (!known || hub.installed[a.id]); });
        var logos = window.APP_LOGOS || {};
        for (var j = 0; j < apps.length && out.length < max; j++) {
            var a = apps[j];
            out.push({
                kind: 'app', id: a.id, title: tt(a.title), badge: a.tag, desc: a.desc, color: a.color, bg: a.bg, letters: a.badge,
                logo: a.iconUrl || (logos[a.id] ? 'assets/brands/' + logos[a.id] + '.svg' : '')
            });
        }
        return out;
    }

    function openItem(item) {
        if (typeof launchApp !== 'function') return;
        if (item.kind === 'app') launchApp(item.id);
        else launchApp(item.app, item.target);
    }

    function card(item, style, showTitle) {
        var c = el('div', 'fmtv-card fmtv-card-' + style + ' nav-item');
        c.dataset.tag = item.badge || '';
        c.dataset.title = item.title || '';
        c.dataset.desc = item.desc || '';
        c.dataset.color = item.color || '#0a84ff';
        var art = el('div', 'fmtv-card-art');
        if (item.kind === 'pick') {
            if (item.poster && SAFE_IMG.test(item.poster)) art.style.backgroundImage = "url('" + item.poster + "')";
            else art.appendChild(el('span', 'fmtv-card-letters', item.title));
        } else {
            // Catalog colours/gradients come from the launcher's own catalog, not from the layout.
            if (item.bg) art.style.background = item.bg; else if (item.color) art.style.background = item.color;
            if (item.logo) {
                var img = el('img', 'fmtv-card-logo');
                img.alt = '';
                img.onerror = function() { img.parentNode && img.parentNode.removeChild(img); art.appendChild(el('span', 'fmtv-card-letters', item.title)); };
                img.src = item.logo;
                art.appendChild(img);
            } else {
                art.appendChild(el('span', 'fmtv-card-letters', item.title));
            }
        }
        c.appendChild(art);
        if (showTitle) c.appendChild(el('div', 'fmtv-card-title', item.title));
        c.addEventListener('click', function() { openItem(item); });
        c.addEventListener('mouseenter', function() { if (typeof setMainFocus === 'function' && !editing()) setMainFocus(c); });
        return c;
    }

    /* ---------------- blocks ---------------- */

    var builders = {};
    var cleanups = [];

    function live(container, signature, draw, kinds) {
        var last = null;
        function update(kind) {
            if (kind && kinds.indexOf(kind) === -1) return;
            var sig = signature();
            if (sig === last) return;
            last = sig;
            var hadFocus = !!container.querySelector('.nav-item.focused');
            var focusIndex = -1;
            if (hadFocus) {
                var items = container.querySelectorAll('.nav-item');
                for (var i = 0; i < items.length; i++) if (items[i].classList.contains('focused')) focusIndex = i;
            }
            draw();
            if (kind) {
                refreshNav();
                if (focusIndex >= 0 && typeof setMainFocus === 'function' && !editing()) {
                    var again = container.querySelectorAll('.nav-item');
                    if (again.length) setMainFocus(again[Math.min(focusIndex, again.length - 1)]);
                }
            }
        }
        listeners.push(update);
        update(null);
    }

    function itemsSignature(items) {
        return items.map(function(i) { return (i.id || i.title) + '|' + (i.poster || i.logo || '') + '|' + (i.target || ''); }).join(';');
    }

    builders['content-row'] = builders['content-grid'] = function(node, root) {
        var p = node.props || {};
        var grid = node.type === 'content-grid';
        var source = p.source || (grid ? 'apps' : 'movies');
        var style = p.cardStyle || (source === 'apps' || source === 'favorites' ? 'app' : 'poster');
        var max = p.maxItems || 10;
        var showTitles = p.showTitles !== false;
        root.className = grid ? 'fmtv-grid-box' : 'fmtv-row';
        var track = el('div', grid ? 'fmtv-track fmtv-track-v fmtv-grid' : 'fmtv-track');
        if (grid) track.style.gridTemplateColumns = 'repeat(' + (p.columns || 5) + ', minmax(0, 1fr))';
        root.appendChild(track);
        var items = [];
        live(root, function() { items = contentItems(source, max); return itemsSignature(items) + '#' + style; }, function() {
            track.innerHTML = '';
            track.__fmtvOffset = 0;
            track.style.transform = '';
            items.forEach(function(item) { track.appendChild(card(item, style, showTitles)); });
            if (!items.length) track.appendChild(el('div', 'fmtv-empty', tt('Nothing to show yet')));
        }, ['picks', 'apps', 'favorites']);
    };

    builders.banner = function(node, root) {
        var p = node.props || {};
        var source = p.source || 'movies';
        var rotate = p.rotateSeconds === undefined ? 8 : p.rotateSeconds;
        root.className = 'fmtv-banner';
        var bg = el('div', 'fmtv-banner-bg');
        var info = el('div', 'fmtv-banner-info');
        var poster = el('div', 'fmtv-banner-poster');
        var badge = el('div', 'fmtv-banner-badge');
        var title = el('div', 'fmtv-banner-title');
        var desc = el('div', 'fmtv-banner-desc');
        var button = el('button', 'fmtv-banner-button nav-item', (p.buttonLabel || 'Assistir'));
        info.appendChild(badge); info.appendChild(title); info.appendChild(desc); info.appendChild(button);
        root.appendChild(bg); root.appendChild(info); root.appendChild(poster);
        var items = [], index = 0;
        function show() {
            var item = items[index % (items.length || 1)];
            if (!item) { title.textContent = tt('Loading...'); return; }
            badge.textContent = item.badge || '';
            title.textContent = item.title || '';
            desc.textContent = item.desc || '';
            var img = item.poster && SAFE_IMG.test(item.poster) ? "url('" + item.poster + "')" : '';
            bg.style.backgroundImage = img;
            poster.style.backgroundImage = img;
            poster.style.display = img ? '' : 'none';
            button.dataset.tag = item.badge || '';
            button.dataset.title = item.title || '';
            button.dataset.desc = item.desc || '';
            button.dataset.color = item.color || '#0a84ff';
        }
        button.addEventListener('click', function() { if (items.length) openItem(items[index % items.length]); });
        button.addEventListener('mouseenter', function() { if (typeof setMainFocus === 'function' && !editing()) setMainFocus(button); });
        live(root, function() { items = contentItems(source, 8); return itemsSignature(items); }, function() { index = 0; show(); }, ['picks']);
        if (rotate > 0) {
            var timer = setInterval(function() {
                // Never change the title under the viewer's focus.
                if (!items.length || button.classList.contains('focused')) return;
                index = (index + 1) % items.length;
                show();
            }, rotate * 1000);
            cleanups.push(function() { clearInterval(timer); });
        }
    };

    builders['weather-full'] = function(node, root) {
        var p = node.props || {};
        var hours = p.hours === undefined ? 6 : p.hours;
        root.className = 'fmtv-weather' + (p.opensDrawer === false ? '' : ' nav-item');
        if (p.opensDrawer !== false) {
            root.dataset.tag = tt('Live Forecast');
            root.dataset.title = tt('Weather & Sun');
            root.dataset.desc = '';
            root.addEventListener('click', function() { if (typeof openDrawer === 'function') openDrawer(); });
        }
        var now = el('div', 'fmtv-weather-now');
        var icon = el('div', 'fmtv-weather-icon');
        var text = el('div', 'fmtv-weather-text');
        var temp = el('div', 'fmtv-weather-temp');
        var city = el('div', 'fmtv-weather-city');
        text.appendChild(temp); text.appendChild(city);
        now.appendChild(icon); now.appendChild(text);
        var hourly = el('div', 'fmtv-weather-hours');
        var sun = el('div', 'fmtv-weather-sun');
        root.appendChild(now); root.appendChild(hourly); root.appendChild(sun);
        function txt(id) { var e = document.getElementById(id); return e ? e.textContent : ''; }
        live(root, function() {
            return [txt('weatherIcon'), txt('weatherText'), txt('weatherSub'), hub.weatherVersion].join('|');
        }, function() {
            icon.textContent = txt('weatherIcon');
            temp.textContent = txt('weatherText');
            city.textContent = txt('weatherSub');
            hourly.innerHTML = '';
            var list = (typeof state !== 'undefined' && state.hourlyForecast) || [];
            var codes = window.WMO_CODES || {};
            list.slice(0, hours).forEach(function(h) {
                var chip = el('div', 'fmtv-weather-chip');
                chip.appendChild(el('div', 'fmtv-weather-chip-time', h.hour));
                chip.appendChild(el('div', 'fmtv-weather-chip-icon', (codes[h.code] || ['⛅'])[0]));
                chip.appendChild(el('div', 'fmtv-weather-chip-temp', h.temp + '°'));
                hourly.appendChild(chip);
            });
            hourly.style.display = hours && list.length ? '' : 'none';
            sun.innerHTML = '';
            if (p.showSun !== false && typeof state !== 'undefined' && (state.sunrise || state.sunset)) {
                sun.appendChild(el('span', '', '☀ ' + tt('Sunrise') + ' ' + (state.sunrise || '--:--')));
                sun.appendChild(el('span', '', '☾ ' + tt('Sunset') + ' ' + (state.sunset || '--:--')));
            }
        }, ['weather']);
        // The weather widget's text changes without an event when the city changes; check now and then.
        var timer = setInterval(function() { emit('weather'); }, 5000);
        cleanups.push(function() { clearInterval(timer); });
    };

    builders.icon = function(node, root) {
        var p = node.props || {};
        var path = (window.FMTVEngine.ICONS || {})[p.name || 'star'];
        root.className = 'fmtv-icon';
        var ns = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', String(p.strokeWidth || 2));
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        svg.setAttribute('aria-hidden', 'true');
        var pathEl = document.createElementNS(ns, 'path');
        pathEl.setAttribute('d', path || '');
        svg.appendChild(pathEl);
        root.appendChild(svg);
        var color = window.FMTVEngine.resolveToken(p.color || '$colors.text', window.FMTVEngine.mergeTokens((window.FMTVLayout && window.FMTVLayout.active || {}).tokens || {}), 'color');
        if (color) root.style.color = color;
    };

    /* ---------------- styles ---------------- */

    function ensureCss() {
        if (document.getElementById('fmtvBlocksCss')) return;
        var s = document.createElement('style');
        s.id = 'fmtvBlocksCss';
        s.textContent = [
            '.fmtv-row,.fmtv-grid-box{overflow:hidden;padding:14px 4px}',
            '.fmtv-track{position:relative;display:flex;transition:transform .35s cubic-bezier(.22,1,.36,1);will-change:transform}',
            '.fmtv-grid{display:grid;grid-gap:22px}',
            '.fmtv-track:not(.fmtv-grid) > * + *{margin-left:22px}',
            '.fmtv-card{position:relative;flex:none;border-radius:16px;cursor:pointer;outline:none;transition:transform .2s ease}',
            '.fmtv-card-art{position:relative;overflow:hidden;border-radius:16px;background:var(--fmtv-surface) center/cover no-repeat;display:flex;align-items:center;justify-content:center;box-shadow:0 8px 24px rgba(0,0,0,.35);transition:box-shadow .2s ease}',
            '.fmtv-card-poster{width:200px}.fmtv-card-poster .fmtv-card-art{height:300px}',
            '.fmtv-card-wide{width:360px}.fmtv-card-wide .fmtv-card-art{height:202px}',
            '.fmtv-card-app{width:240px}.fmtv-card-app .fmtv-card-art{height:150px}',
            '.fmtv-grid .fmtv-card{width:auto}',
            '.fmtv-card-logo{max-width:70%;max-height:58%;object-fit:contain}',
            '.fmtv-card-letters{padding:12px;text-align:center;font-weight:800;font-size:24px;color:#fff;overflow-wrap:anywhere}',
            '.fmtv-card-title{margin-top:10px;font-size:20px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.85}',
            '.fmtv-card.focused{transform:translateY(-6px) scale(1.06);z-index:2}',
            '.fmtv-card.focused .fmtv-card-art{box-shadow:0 0 0 4px var(--fmtv-focus,#fff),0 18px 40px rgba(0,0,0,.55)}',
            '.fmtv-card.focused .fmtv-card-title{opacity:1}',
            '.fmtv-empty{opacity:.6;font-size:20px;padding:20px}',
            '.fmtv-banner{position:relative;overflow:hidden;border-radius:24px;display:flex;align-items:center;padding:48px 56px;background:var(--fmtv-surface)}',
            '.fmtv-banner-bg{position:absolute;top:-40px;left:-40px;right:-40px;bottom:-40px;background:center/cover no-repeat;filter:blur(36px) saturate(1.3);opacity:.55;transform:scale(1.1)}',
            '.fmtv-banner::after{content:"";position:absolute;top:0;left:0;right:0;bottom:0;background:linear-gradient(90deg,rgba(0,0,0,.65),rgba(0,0,0,.15))}',
            '.fmtv-banner-info{position:relative;z-index:1;flex:1;min-width:0;display:flex;flex-direction:column;align-items:flex-start}',
            '.fmtv-banner-info > * + *{margin-top:14px}',
            '.fmtv-banner-badge{font-size:18px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--fmtv-accent)}',
            '.fmtv-banner-title{font-size:56px;font-weight:800;line-height:1.05}',
            '.fmtv-banner-desc{font-size:22px;line-height:1.4;opacity:.85;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;max-width:900px}',
            '.fmtv-banner-button{margin-top:10px;border:0;border-radius:999px;padding:14px 34px;font:inherit;font-size:22px;font-weight:700;background:#fff;color:#000;cursor:pointer;outline:none;transition:transform .18s ease,box-shadow .18s ease}',
            '.fmtv-banner-button.focused{transform:scale(1.06);box-shadow:0 0 0 4px var(--fmtv-focus,#fff)}',
            '.fmtv-banner-poster{position:relative;z-index:1;flex:none;margin-left:40px;width:220px;height:330px;border-radius:16px;background:center/cover no-repeat;box-shadow:0 18px 40px rgba(0,0,0,.5)}',
            '.fmtv-weather{display:flex;flex-direction:column;padding:28px 32px;border-radius:24px;background:var(--fmtv-surface);outline:none;transition:transform .2s ease,box-shadow .2s ease}',
            '.fmtv-weather.focused{transform:scale(1.03);box-shadow:0 0 0 4px var(--fmtv-focus,#fff)}',
            '.fmtv-weather > * + *{margin-top:18px}',
            '.fmtv-weather-now{display:flex;align-items:center}',
            '.fmtv-weather-icon{margin-right:20px}',
            '.fmtv-weather-icon{font-size:64px;line-height:1}',
            '.fmtv-weather-temp{font-size:34px;font-weight:700}',
            '.fmtv-weather-city{font-size:20px;opacity:.7}',
            '.fmtv-weather-hours{display:flex}',
            '.fmtv-weather-chip + .fmtv-weather-chip{margin-left:12px}',
            '.fmtv-weather-chip{flex:1;display:flex;flex-direction:column;align-items:center;padding:12px 8px;border-radius:14px;background:rgba(255,255,255,.06);font-size:18px}',
            '.fmtv-weather-chip-icon{font-size:26px}',
            '.fmtv-weather-chip-temp{font-weight:700}',
            '.fmtv-weather-sun{display:flex;font-size:19px;opacity:.8}',
            '.fmtv-weather-sun span + span{margin-left:28px}',
            '.fmtv-icon{display:flex;align-items:center;justify-content:center}',
            '.fmtv-icon svg{width:100%;height:100%}'
        ].join('');
        document.head.appendChild(s);
    }

    window.FMTVBlocks = {
        builds: function(type) { return !!builders[type]; },
        build: function(node, root, ctx) {
            ensureCss();
            builders[node.type](node, root, ctx);
        },
        /** Called by the runtime before a new render. */
        reset: function() {
            listeners = [];
            for (var i = 0; i < cleanups.length; i++) { try { cleanups[i](); } catch (e) {} }
            cleanups = [];
        },
        hub: hub
    };
})();
