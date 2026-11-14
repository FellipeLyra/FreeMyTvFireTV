/*
 * Free My TV — shared layout engine (schema v1).
 *
 * One file, plain ES5, no dependencies. The same code runs:
 *   - on the Fire TV, inside the launcher's WebView (window.FMTVEngine);
 *   - in Node, for the CLI and the automated tests (require/import);
 *   - in Free My TV Studio, for validation and the live preview.
 * Keeping validation, styling and focus rules in one place is what makes the
 * Studio preview and the TV render the same layout the same way.
 *
 * Nothing here touches the DOM. Layouts are data only: no functions, no HTML,
 * no CSS strings from the author. Every value that reaches CSS is validated and
 * rebuilt here from typed fields.
 */
(function(root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FMTVEngine = factory();
}(typeof self !== 'undefined' ? self : this, function() {
    'use strict';

    var SCHEMA_VERSION = 1;

    var LIMITS = {
        layoutBytes: 1024 * 1024,
        nodes: 600,
        depth: 24,
        children: 200,
        text: 500,
        name: 80,
        assets: 64,
        assetBytes: 8 * 1024 * 1024,
        totalAssetBytes: 24 * 1024 * 1024
    };

    // Pages the runtime knows. Only those marked `runtime: true` are rendered on
    // the TV by this version; the others are accepted (so a Studio project can
    // hold them) and reported as warnings.
    // Screens of the launcher. Besides `home`, each one replaces the contents of an
    // existing overlay (`host`), keeping its behaviour: the launcher still opens and
    // closes it, saves settings, updates the weather and shifts the screensaver clock.
    //   panel:    which placements the overlay accepts, and size limits;
    //   required: launcher widgets that must stay (never lose access to settings);
    //   styleOnly: only the look can change (no children).
    var PAGES = {
        home: { label: 'Tela inicial', runtime: true },
        weather: { label: 'Clima', runtime: true, host: '#weatherDrawer .drawer-panel', backdrop: '#weatherDrawer',
            panel: { placements: ['right', 'left', 'center', 'bottom'], width: [320, 1920], height: [200, 1080] } },
        settings: { label: 'Personalizar', runtime: true, host: '#settingsModal .modal-box', backdrop: '#settingsModal',
            panel: { placements: ['center', 'left', 'right', 'fullscreen'], width: [640, 1920], height: [400, 1080] },
            required: ['settings.preferences', 'settings.actions'] },
        screensaver: { label: 'Protetor de tela', runtime: true, host: '#screensaverOverlay',
            required: ['screensaver.clock'] },
        messages: { label: 'Mensagens', runtime: true, host: '#toastMsg', styleOnly: true,
            panel: { placements: ['top-right', 'top', 'bottom', 'bottom-right', 'center'] } }
    };

    var ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
    var FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.(png|jpg|jpeg|webp)$/;
    var APP_ID_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;
    var SHA256_RE = /^[0-9a-f]{64}$/;
    var HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
    var RGBA_RE = /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\)$/;
    var TOKEN_RE = /^\$(colors|spacing|radius|fontSizes)\.([A-Za-z][A-Za-z0-9_-]{0,31})$/;

    var FONT_FAMILIES = {
        system: '-apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        rounded: '"SF Pro Rounded", "Nunito", "Varela Round", -apple-system, Roboto, sans-serif',
        serif: 'Georgia, "Times New Roman", serif',
        mono: '"SF Mono", "Roboto Mono", Consolas, monospace'
    };
    var EASINGS = {
        ease: 'ease', linear: 'linear', 'ease-in': 'ease-in', 'ease-out': 'ease-out', 'ease-in-out': 'ease-in-out',
        spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)', smooth: 'cubic-bezier(0.22, 1, 0.36, 1)'
    };
    var ENTER_PRESETS = ['none', 'fade', 'slide-up', 'slide-down', 'slide-left', 'slide-right', 'scale'];

    // Default design tokens. A layout may override any of them; components refer
    // to them as "$colors.accent", "$spacing.md", ...
    var DEFAULT_TOKENS = {
        colors: {
            primary: '#f5f5f7', secondary: '#c7c7cc', accent: '#0a84ff', background: '#0a0e1a',
            surface: 'rgba(255,255,255,0.07)', text: '#f5f5f7', textMuted: 'rgba(245,245,247,0.65)',
            border: 'rgba(255,255,255,0.13)', focus: 'rgba(255,255,255,0.95)', shadow: 'rgba(0,0,0,0.45)'
        },
        spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 40, xxl: 64 },
        radius: { sm: 8, md: 14, lg: 22, pill: 999 },
        fontSizes: { caption: 16, body: 22, title: 34, display: 64, hero: 96 },
        fontFamily: 'system'
    };

    // Existing launcher CSS variables that follow the layout's tokens, so the
    // original widgets placed inside a layout pick up its colours.
    var LEGACY_VARS = {
        text: '--text-primary', textMuted: '--text-secondary', accent: '--accent',
        surface: '--glass-shelf', border: '--glass-border', focus: '--glass-focus-border'
    };

    /* ------------------------------------------------------------------ */
    /* Component registry                                                  */
    /* ------------------------------------------------------------------ */

    // `slot` components are the launcher's own live widgets. The runtime moves the
    // existing element (found by `selector`) into the layout, so its data, focus
    // handling and behaviour stay exactly as before. Each slot can appear once.
    var registry = {};

    function defineComponent(def) {
        if (!ID_RE.test(def.type.replace(/\./g, '-'))) throw new Error('bad component type ' + def.type);
        def.version = def.version || 1;
        def.props = def.props || {};
        registry[def.type] = def;
        return def;
    }

    var ACTIONS = {
        'open-settings': { label: 'Abrir Personalizar' },
        'open-weather': { label: 'Abrir clima' },
        'launch-app': { label: 'Abrir app', needsApp: true },
        'fire-settings': { label: 'Configurações do Fire TV' },
        'amazon-home': { label: 'Tela da Amazon' }
    };

    defineComponent({ type: 'stack', label: 'Stack', category: 'layout', container: true,
        props: {} });
    defineComponent({ type: 'frame', label: 'Container absoluto', category: 'layout', container: true,
        props: {} });
    defineComponent({ type: 'text', label: 'Texto', category: 'basic',
        props: { text: { type: 'string', max: LIMITS.text, def: 'Texto' } } });
    defineComponent({ type: 'image', label: 'Imagem', category: 'basic',
        props: {
            asset: { type: 'asset', def: '' },
            fit: { type: 'enum', values: ['cover', 'contain', 'fill'], def: 'cover' }
        } });
    defineComponent({ type: 'spacer', label: 'Espaçador', category: 'layout', props: {} });
    defineComponent({ type: 'divider', label: 'Divisor', category: 'basic',
        props: {
            thickness: { type: 'number', min: 1, max: 20, def: 1 },
            color: { type: 'color', def: '$colors.border' }
        } });
    defineComponent({ type: 'button', label: 'Botão', category: 'basic', focusable: true,
        props: {
            label: { type: 'string', max: 80, def: 'Botão' },
            action: { type: 'action', def: { type: 'open-settings' } }
        } });
    defineComponent({ type: 'clock-text', label: 'Relógio (texto)', category: 'data', live: 'clock',
        props: { format: { type: 'enum', values: ['auto', '24h', '12h'], def: 'auto' } } });

    // Icons are drawn from this fixed set (24px grid, stroked); layouts can only pick a name.
    var ICONS = {
        home: 'M3 11l9-8 9 8M5 9.5V21h5v-6h4v6h5V9.5',
        settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
        sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
        moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
        cloud: 'M18 10h-1.3A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z',
        star: 'M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z',
        heart: 'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z',
        play: 'M6 4l14 8-14 8z',
        tv: 'M3 5h18a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM8 21h8',
        film: 'M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM7 3v18M17 3v18M3 8h4M17 8h4M3 12h18M3 16h4M17 16h4',
        music: 'M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
        game: 'M6 11h4M8 9v4M15 12h.01M18 10h.01M17.3 5H6.7A4 4 0 0 0 2.7 8.6l-.7 6.9A3 3 0 0 0 7.2 18l1.6-1.6a2 2 0 0 1 1.4-.6h3.6a2 2 0 0 1 1.4.6l1.6 1.6a3 3 0 0 0 5.2-2.5l-.7-6.9A4 4 0 0 0 17.3 5z',
        search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
        clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
        wifi: 'M5 12.6a10 10 0 0 1 14 0M8.5 16.1a5 5 0 0 1 7 0M2 8.8a15 15 0 0 1 20 0M12 20h.01',
        user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
        bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
        bolt: 'M13 2L3 14h9l-1 8 10-12h-9z',
        apps: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
        arrow: 'M5 12h14M12 5l7 7-7 7',
        back: 'M19 12H5M12 19l-7-7 7-7',
        sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z'
    };
    var ICON_NAMES = Object.keys(ICONS);
    defineComponent({ type: 'icon', label: 'Ícone', category: 'basic',
        props: {
            name: { type: 'enum', values: ICON_NAMES, def: 'star' },
            color: { type: 'color', def: '$colors.text' },
            strokeWidth: { type: 'number', min: 1, max: 4, def: 2 }
        } });

    // Content blocks: filled at runtime by the launcher's own data services
    // (TMDB/TVMaze trending, Open-Meteo weather, installed apps). Layouts only
    // choose the source and the presentation.
    var CONTENT_SOURCES = ['movies', 'shows', 'apps', 'favorites'];
    var CARD_STYLES = ['poster', 'wide', 'app'];
    defineComponent({ type: 'content-row', label: 'Carrossel', category: 'data', focusable: true, live: 'content',
        props: {
            source: { type: 'enum', values: CONTENT_SOURCES, def: 'movies' },
            maxItems: { type: 'number', min: 1, max: 20, def: 10 },
            cardStyle: { type: 'enum', values: CARD_STYLES, def: 'poster' },
            showTitles: { type: 'boolean', def: true }
        } });
    defineComponent({ type: 'content-grid', label: 'Grade de conteúdo', category: 'data', focusable: true, live: 'content',
        props: {
            source: { type: 'enum', values: CONTENT_SOURCES, def: 'apps' },
            columns: { type: 'number', min: 1, max: 8, def: 5 },
            maxItems: { type: 'number', min: 1, max: 40, def: 10 },
            cardStyle: { type: 'enum', values: CARD_STYLES, def: 'app' },
            showTitles: { type: 'boolean', def: true }
        } });
    defineComponent({ type: 'banner', label: 'Banner de destaque', category: 'data', focusable: true, live: 'content',
        props: {
            source: { type: 'enum', values: ['movies', 'shows'], def: 'movies' },
            rotateSeconds: { type: 'number', min: 0, max: 60, def: 8 },
            buttonLabel: { type: 'string', max: 30, def: 'Assistir' }
        } });
    defineComponent({ type: 'weather-full', label: 'Clima completo', category: 'data', focusable: true, live: 'weather',
        props: {
            hours: { type: 'number', min: 0, max: 6, def: 6 },
            showSun: { type: 'boolean', def: true },
            opensDrawer: { type: 'boolean', def: true }
        } });

    function slot(type, label, selector, extra) {
        var def = { type: type, label: label, category: 'launcher', slot: selector, props: {}, page: 'home' };
        for (var k in extra) def[k] = extra[k];
        return defineComponent(def);
    }
    slot('launcher.brand', 'Logo Free My TV', '.brand-group');
    slot('launcher.settings-button', 'Botão Personalizar', '#customizeBtn', { focusable: true, opensSettings: true });
    slot('launcher.weather', 'Clima resumido', '#weatherWidget', { focusable: true });
    slot('launcher.clock', 'Relógio', '#clockText');
    slot('launcher.date', 'Data', '#dateText');
    slot('launcher.hero', 'Destaque do item focado', '.hero-shelf');
    slot('launcher.app-shelf', 'Apps favoritos', '.shelf-wrapper', { focusable: true });
    slot('launcher.trending', 'Filmes e séries em alta', '.picks-section', { focusable: true });

    // Widgets of the other screens. `up: 1` takes the parent of the matched element
    // (sections without their own class in the launcher page).
    slot('weather.header', 'Título do clima', '#weatherDrawer .modal-header', { page: 'weather' });
    slot('weather.current', 'Clima agora', '#weatherDrawer .drawer-current', { page: 'weather' });
    slot('weather.hourly', 'Próximas horas', '#drawerHourly', { page: 'weather', up: 1 });
    slot('weather.sun', 'Nascer e pôr do sol', '#weatherDrawer .drawer-sun-row', { page: 'weather' });
    slot('weather.close', 'Botão Fechar', '#weatherDrawer .modal-actions', { page: 'weather' });
    slot('settings.header', 'Título do Personalizar', '#settingsModal .modal-header', { page: 'settings' });
    slot('settings.apps', 'Escolha de apps', '#appSelectorGrid', { page: 'settings', up: 1 });
    slot('settings.preferences', 'Preferências', '#settingsModal .settings-row', { page: 'settings', up: 1 });
    slot('settings.actions', 'Botões Salvar / Cancelar', '#settingsModal .modal-actions', { page: 'settings' });
    slot('screensaver.clock', 'Relógio do protetor', '#screensaverClockWrap', { page: 'screensaver',
        props: {
            showDate: { type: 'boolean', def: true },
            clockSize: { type: 'number', min: 40, max: 400, def: 132 },
            dateSize: { type: 'number', min: 10, max: 120, def: 22 },
            color: { type: 'color', def: 'rgba(255,255,255,0.82)' }
        } });

    /* ------------------------------------------------------------------ */
    /* Small helpers                                                       */
    /* ------------------------------------------------------------------ */

    function isObj(v) { return v !== null && typeof v === 'object' && !(v instanceof Array); }
    function isNum(v) { return typeof v === 'number' && isFinite(v); }
    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
    function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

    function mergeTokens(custom) {
        var out = {};
        for (var group in DEFAULT_TOKENS) {
            var base = DEFAULT_TOKENS[group];
            if (isObj(base)) {
                out[group] = {};
                for (var k in base) out[group][k] = base[k];
                if (custom && isObj(custom[group])) for (var c in custom[group]) out[group][c] = custom[group][c];
            } else {
                out[group] = custom && own(custom, group) ? custom[group] : base;
            }
        }
        return out;
    }

    function isColorLiteral(v) {
        return typeof v === 'string' && (v === 'transparent' || HEX_RE.test(v) || RGBA_RE.test(v));
    }

    /** Resolve "$group.name" against the tokens; literals pass through. Returns undefined when invalid. */
    function resolveToken(value, tokens, kind) {
        if (typeof value === 'string') {
            var m = TOKEN_RE.exec(value);
            if (m) {
                var group = tokens[m[1]];
                if (!group || !own(group, m[2])) return undefined;
                return resolveToken(group[m[2]], tokens, kind);
            }
            if (kind === 'color') return isColorLiteral(value) ? value : undefined;
            return undefined;
        }
        if (kind === 'number' && isNum(value)) return value;
        return undefined;
    }

    /* ------------------------------------------------------------------ */
    /* Migration                                                           */
    /* ------------------------------------------------------------------ */

    // migrations[n] upgrades a layout from schema n to n + 1. Add one entry for
    // every schema change; never edit an old one.
    var migrations = {};

    function migrate(layout) {
        if (!isObj(layout) || !isNum(layout.schemaVersion)) {
            return { ok: false, error: 'schemaVersion ausente ou inválido' };
        }
        var v = layout.schemaVersion;
        if (v > SCHEMA_VERSION) {
            return { ok: false, error: 'layout usa o schema ' + v + ', mas este Free My TV entende até o ' + SCHEMA_VERSION + '. Atualize o app.' };
        }
        var out = JSON.parse(JSON.stringify(layout));
        while (out.schemaVersion < SCHEMA_VERSION) {
            var step = migrations[out.schemaVersion];
            if (!step) return { ok: false, error: 'sem migração a partir do schema ' + out.schemaVersion };
            out = step(out);
        }
        return { ok: true, layout: out };
    }

    /* ------------------------------------------------------------------ */
    /* Validation                                                          */
    /* ------------------------------------------------------------------ */

    function Report() { this.errors = []; this.warnings = []; }
    Report.prototype.error = function(path, msg) { this.errors.push({ path: path, message: msg }); };
    Report.prototype.warn = function(path, msg) { this.warnings.push({ path: path, message: msg }); };

    function checkColor(r, path, v, tokens) {
        if (v === undefined) return;
        if (resolveToken(v, tokens, 'color') === undefined) r.error(path, 'cor inválida: ' + JSON.stringify(v));
    }
    function checkLength(r, path, v, tokens, min, max) {
        if (v === undefined) return;
        var n = resolveToken(v, tokens, 'number');
        if (n === undefined) { r.error(path, 'número inválido: ' + JSON.stringify(v)); return; }
        if (n < min || n > max) r.error(path, 'fora do intervalo ' + min + '…' + max + ': ' + n);
    }
    function checkEnum(r, path, v, values) {
        if (v === undefined) return;
        if (values.indexOf(v) === -1) r.error(path, 'valor deve ser um de ' + values.join(', '));
    }
    function checkKeys(r, path, obj, allowed) {
        for (var k in obj) if (own(obj, k) && allowed.indexOf(k) === -1) r.error(path + '.' + k, 'campo desconhecido');
    }

    function checkPaint(r, path, p, tokens, assets) {
        if (p === undefined) return;
        if (!isObj(p)) { r.error(path, 'pintura deve ser um objeto'); return; }
        if (p.type === 'solid') {
            checkKeys(r, path, p, ['type', 'color']);
            checkColor(r, path + '.color', p.color, tokens);
            if (p.color === undefined) r.error(path + '.color', 'obrigatório');
        } else if (p.type === 'linear') {
            checkKeys(r, path, p, ['type', 'angle', 'stops']);
            if (p.angle !== undefined && !(isNum(p.angle) && p.angle >= -360 && p.angle <= 360)) r.error(path + '.angle', 'ângulo inválido');
            if (!(p.stops instanceof Array) || p.stops.length < 2 || p.stops.length > 8) {
                r.error(path + '.stops', 'gradiente precisa de 2 a 8 paradas');
            } else {
                for (var i = 0; i < p.stops.length; i++) {
                    var s = p.stops[i];
                    if (!isObj(s)) { r.error(path + '.stops[' + i + ']', 'parada inválida'); continue; }
                    checkColor(r, path + '.stops[' + i + '].color', s.color, tokens);
                    if (!(isNum(s.pos) && s.pos >= 0 && s.pos <= 100)) r.error(path + '.stops[' + i + '].pos', 'posição deve ser 0…100');
                }
            }
        } else if (p.type === 'image') {
            checkKeys(r, path, p, ['type', 'asset', 'fit', 'position']);
            if (!assets[p.asset]) r.error(path + '.asset', 'asset inexistente: ' + JSON.stringify(p.asset));
            checkEnum(r, path + '.fit', p.fit, ['cover', 'contain', 'fill']);
            checkEnum(r, path + '.position', p.position, ['center', 'top', 'bottom', 'left', 'right']);
        } else {
            r.error(path + '.type', 'tipo de pintura deve ser solid, linear ou image');
        }
    }

    function checkDim(r, path, d) {
        if (d === undefined) return;
        if (!isObj(d)) { r.error(path, 'dimensão deve ser um objeto'); return; }
        checkEnum(r, path + '.mode', d.mode, ['fixed', 'hug', 'fill', 'percent']);
        if (d.mode === 'fixed' && !(isNum(d.value) && d.value >= 0 && d.value <= 8000)) r.error(path + '.value', 'tamanho fixo inválido');
        if (d.mode === 'percent' && !(isNum(d.value) && d.value >= 0 && d.value <= 100)) r.error(path + '.value', 'percentual inválido');
    }

    function checkConstraint(r, path, c) {
        if (c === undefined) return;
        if (!isObj(c)) { r.error(path, 'constraint deve ser um objeto'); return; }
        var a = c.anchor;
        checkEnum(r, path + '.anchor', a, ['start', 'end', 'center', 'stretch', 'scale']);
        function n(field, lo, hi) {
            if (!(isNum(c[field]) && c[field] >= lo && c[field] <= hi)) r.error(path + '.' + field, 'obrigatório, ' + lo + '…' + hi);
        }
        if (a === 'start' || a === 'end' || a === 'center') { n('offset', -8000, 8000); n('size', 0, 8000); }
        if (a === 'stretch') { n('start', -8000, 8000); n('end', -8000, 8000); }
        if (a === 'scale') { n('start', -100, 200); n('size', 0, 200); }
    }

    function checkAction(r, path, a) {
        if (!isObj(a) || !own(ACTIONS, a.type)) { r.error(path, 'ação inválida; use ' + Object.keys(ACTIONS).join(', ')); return; }
        checkKeys(r, path, a, ['type', 'appId']);
        if (ACTIONS[a.type].needsApp && !(typeof a.appId === 'string' && APP_ID_RE.test(a.appId))) r.error(path + '.appId', 'pacote Android inválido');
    }

    var NODE_KEYS = ['id', 'type', 'name', 'visible', 'locked', 'position', 'size', 'constraints', 'layout',
        'style', 'text', 'animation', 'focus', 'props', 'children'];

    function validateNode(r, node, path, ctx, depth, parent) {
        if (!isObj(node)) { r.error(path, 'nó deve ser um objeto'); return; }
        ctx.count++;
        if (ctx.count > LIMITS.nodes) { if (ctx.count === LIMITS.nodes + 1) r.error(path, 'mais de ' + LIMITS.nodes + ' elementos'); return; }
        if (depth > LIMITS.depth) { r.error(path, 'aninhamento acima de ' + LIMITS.depth + ' níveis'); return; }
        checkKeys(r, path, node, NODE_KEYS);

        if (typeof node.id !== 'string' || !ID_RE.test(node.id)) r.error(path + '.id', 'id inválido (letras, números, - e _; começa com letra)');
        else if (ctx.ids[node.id]) r.error(path + '.id', 'id repetido: ' + node.id);
        else ctx.ids[node.id] = true;

        var def = registry[node.type];
        if (!def) { r.error(path + '.type', 'componente desconhecido: ' + JSON.stringify(node.type)); return; }
        path = path + '<' + (node.id || '?') + '>';

        if (node.name !== undefined && !(typeof node.name === 'string' && node.name.length <= LIMITS.name)) r.error(path + '.name', 'nome inválido');
        if (node.visible !== undefined && typeof node.visible !== 'boolean') r.error(path + '.visible', 'deve ser true/false');
        if (node.locked !== undefined && typeof node.locked !== 'boolean') r.error(path + '.locked', 'deve ser true/false');
        checkEnum(r, path + '.position', node.position, ['flow', 'absolute']);

        var absolute = node.position === 'absolute' || (parent && parent.type === 'frame');
        if (absolute) {
            if (!parent) r.error(path, 'a raiz não pode ser absoluta');
            if (!isObj(node.constraints)) r.error(path + '.constraints', 'elemento absoluto precisa de constraints h e v');
            else {
                checkKeys(r, path + '.constraints', node.constraints, ['h', 'v']);
                checkConstraint(r, path + '.constraints.h', node.constraints.h);
                checkConstraint(r, path + '.constraints.v', node.constraints.v);
                if (!node.constraints.h || !node.constraints.v) r.error(path + '.constraints', 'h e v são obrigatórios');
            }
        } else if (node.constraints !== undefined) {
            r.warn(path + '.constraints', 'ignorado: o elemento está no fluxo da stack');
        }

        if (node.size !== undefined) {
            if (!isObj(node.size)) r.error(path + '.size', 'deve ser um objeto');
            else {
                checkKeys(r, path + '.size', node.size, ['width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight']);
                checkDim(r, path + '.size.width', node.size.width);
                checkDim(r, path + '.size.height', node.size.height);
                var mm = ['minWidth', 'maxWidth', 'minHeight', 'maxHeight'];
                for (var i = 0; i < mm.length; i++) {
                    var v = node.size[mm[i]];
                    if (v !== undefined && !(isNum(v) && v >= 0 && v <= 8000)) r.error(path + '.size.' + mm[i], 'inválido');
                }
                if (node.size.width && node.size.width.mode === 'fill' && (!parent || parent.type !== 'stack') && !absolute && parent) {
                    r.warn(path + '.size.width', '"fill" só tem efeito dentro de uma stack');
                }
            }
        }

        if (def.container) {
            var L = node.layout || {};
            if (node.layout !== undefined && !isObj(node.layout)) r.error(path + '.layout', 'deve ser um objeto');
            checkKeys(r, path + '.layout', L, ['direction', 'gap', 'padding', 'align', 'justify', 'wrap', 'clip']);
            if (node.type === 'stack') {
                checkEnum(r, path + '.layout.direction', L.direction, ['horizontal', 'vertical']);
                checkLength(r, path + '.layout.gap', L.gap, ctx.tokens, 0, 2000);
                checkEnum(r, path + '.layout.align', L.align, ['start', 'center', 'end', 'stretch', 'baseline']);
                checkEnum(r, path + '.layout.justify', L.justify, ['start', 'center', 'end', 'space-between', 'space-around', 'space-evenly']);
                if (L.wrap !== undefined && typeof L.wrap !== 'boolean') r.error(path + '.layout.wrap', 'deve ser true/false');
            } else {
                var allowedFrame = ['padding', 'clip'];
                for (var lk in L) if (own(L, lk) && allowedFrame.indexOf(lk) === -1) r.warn(path + '.layout.' + lk, 'ignorado em container absoluto');
            }
            if (L.padding !== undefined) {
                if (L.padding instanceof Array) {
                    if (L.padding.length !== 4) r.error(path + '.layout.padding', 'use [cima, direita, baixo, esquerda]');
                    for (var p = 0; p < L.padding.length; p++) checkLength(r, path + '.layout.padding[' + p + ']', L.padding[p], ctx.tokens, 0, 2000);
                } else checkLength(r, path + '.layout.padding', L.padding, ctx.tokens, 0, 2000);
            }
            if (L.clip !== undefined && typeof L.clip !== 'boolean') r.error(path + '.layout.clip', 'deve ser true/false');
            if (node.children !== undefined && !(node.children instanceof Array)) r.error(path + '.children', 'deve ser uma lista');
            var kids = node.children || [];
            if (kids.length > LIMITS.children) r.error(path + '.children', 'mais de ' + LIMITS.children + ' filhos');
            for (var c = 0; c < kids.length && c < LIMITS.children; c++) validateNode(r, kids[c], path + '.children[' + c + ']', ctx, depth + 1, node);
        } else if (node.children !== undefined) {
            r.error(path + '.children', node.type + ' não aceita filhos');
        }

        if (node.style !== undefined) {
            var S = node.style;
            if (!isObj(S)) r.error(path + '.style', 'deve ser um objeto');
            else {
                checkKeys(r, path + '.style', S, ['background', 'opacity', 'radius', 'border', 'shadow', 'blur']);
                checkPaint(r, path + '.style.background', S.background, ctx.tokens, ctx.assets);
                if (S.opacity !== undefined && !(isNum(S.opacity) && S.opacity >= 0 && S.opacity <= 1)) r.error(path + '.style.opacity', '0…1');
                checkLength(r, path + '.style.radius', S.radius, ctx.tokens, 0, 2000);
                if (S.border !== undefined) {
                    if (!isObj(S.border)) r.error(path + '.style.border', 'deve ser um objeto');
                    else {
                        checkKeys(r, path + '.style.border', S.border, ['width', 'color']);
                        checkLength(r, path + '.style.border.width', S.border.width, ctx.tokens, 0, 40);
                        checkColor(r, path + '.style.border.color', S.border.color, ctx.tokens);
                    }
                }
                if (S.shadow !== undefined) {
                    if (!isObj(S.shadow)) r.error(path + '.style.shadow', 'deve ser um objeto');
                    else {
                        checkKeys(r, path + '.style.shadow', S.shadow, ['x', 'y', 'blur', 'spread', 'color']);
                        var sk = ['x', 'y', 'blur', 'spread'];
                        for (var s = 0; s < sk.length; s++) {
                            var sv = S.shadow[sk[s]];
                            if (sv !== undefined && !(isNum(sv) && sv >= -200 && sv <= 200)) r.error(path + '.style.shadow.' + sk[s], 'inválido');
                        }
                        checkColor(r, path + '.style.shadow.color', S.shadow.color, ctx.tokens);
                    }
                }
                if (S.blur !== undefined && !(isNum(S.blur) && S.blur >= 0 && S.blur <= 60)) r.error(path + '.style.blur', '0…60');
            }
        }

        if (node.text !== undefined) {
            var T = node.text;
            if (!isObj(T)) r.error(path + '.text', 'deve ser um objeto');
            else {
                checkKeys(r, path + '.text', T, ['size', 'weight', 'color', 'align', 'lineHeight', 'letterSpacing', 'family', 'transform', 'maxLines']);
                checkLength(r, path + '.text.size', T.size, ctx.tokens, 6, 400);
                if (T.weight !== undefined && [100, 200, 300, 400, 500, 600, 700, 800, 900].indexOf(T.weight) === -1) r.error(path + '.text.weight', '100…900 em passos de 100');
                checkColor(r, path + '.text.color', T.color, ctx.tokens);
                checkEnum(r, path + '.text.align', T.align, ['left', 'center', 'right']);
                if (T.lineHeight !== undefined && !(isNum(T.lineHeight) && T.lineHeight >= 0.5 && T.lineHeight <= 4)) r.error(path + '.text.lineHeight', '0.5…4');
                if (T.letterSpacing !== undefined && !(isNum(T.letterSpacing) && T.letterSpacing >= -10 && T.letterSpacing <= 40)) r.error(path + '.text.letterSpacing', '-10…40');
                checkEnum(r, path + '.text.family', T.family, Object.keys(FONT_FAMILIES));
                checkEnum(r, path + '.text.transform', T.transform, ['none', 'uppercase', 'lowercase']);
                if (T.maxLines !== undefined && !(isNum(T.maxLines) && T.maxLines >= 1 && T.maxLines <= 20)) r.error(path + '.text.maxLines', '1…20');
            }
        }

        if (node.animation !== undefined) {
            var A = node.animation;
            if (!isObj(A)) r.error(path + '.animation', 'deve ser um objeto');
            else {
                checkKeys(r, path + '.animation', A, ['enter', 'focus']);
                if (A.enter !== undefined) {
                    if (!isObj(A.enter)) r.error(path + '.animation.enter', 'deve ser um objeto');
                    else {
                        checkKeys(r, path + '.animation.enter', A.enter, ['preset', 'duration', 'delay', 'easing', 'distance']);
                        checkEnum(r, path + '.animation.enter.preset', A.enter.preset, ENTER_PRESETS);
                        if (A.enter.duration !== undefined && !(isNum(A.enter.duration) && A.enter.duration >= 0 && A.enter.duration <= 2000)) r.error(path + '.animation.enter.duration', '0…2000 ms');
                        if (A.enter.delay !== undefined && !(isNum(A.enter.delay) && A.enter.delay >= 0 && A.enter.delay <= 5000)) r.error(path + '.animation.enter.delay', '0…5000 ms');
                        if (A.enter.distance !== undefined && !(isNum(A.enter.distance) && A.enter.distance >= 0 && A.enter.distance <= 400)) r.error(path + '.animation.enter.distance', '0…400 px');
                        checkEnum(r, path + '.animation.enter.easing', A.enter.easing, Object.keys(EASINGS));
                    }
                }
                if (A.focus !== undefined) {
                    if (!isObj(A.focus)) r.error(path + '.animation.focus', 'deve ser um objeto');
                    else {
                        checkKeys(r, path + '.animation.focus', A.focus, ['scale', 'lift']);
                        if (A.focus.scale !== undefined && !(isNum(A.focus.scale) && A.focus.scale >= 1 && A.focus.scale <= 1.3)) r.error(path + '.animation.focus.scale', '1…1.3');
                        if (A.focus.lift !== undefined && !(isNum(A.focus.lift) && A.focus.lift >= 0 && A.focus.lift <= 30)) r.error(path + '.animation.focus.lift', '0…30 px');
                    }
                }
            }
        }

        if (node.focus !== undefined) {
            if (!isObj(node.focus)) r.error(path + '.focus', 'deve ser um objeto');
            else {
                checkKeys(r, path + '.focus', node.focus, ['initial', 'skip']);
                if (node.focus.initial === true) {
                    if (ctx.initialFocus) r.error(path + '.focus.initial', 'apenas um elemento pode ter o foco inicial');
                    ctx.initialFocus = node.id;
                }
            }
        }

        // Component props
        var props = node.props || {};
        if (node.props !== undefined && !isObj(node.props)) r.error(path + '.props', 'deve ser um objeto');
        for (var pk in props) {
            if (!own(props, pk)) continue;
            var spec = def.props[pk];
            if (!spec) { r.error(path + '.props.' + pk, 'propriedade desconhecida para ' + node.type); continue; }
            var pv = props[pk];
            var pp = path + '.props.' + pk;
            if (spec.type === 'string' && !(typeof pv === 'string' && pv.length <= spec.max)) r.error(pp, 'texto de até ' + spec.max + ' caracteres');
            if (spec.type === 'number' && !(isNum(pv) && pv >= spec.min && pv <= spec.max)) r.error(pp, spec.min + '…' + spec.max);
            if (spec.type === 'enum') checkEnum(r, pp, pv, spec.values);
            if (spec.type === 'color') checkColor(r, pp, pv, ctx.tokens);
            if (spec.type === 'asset' && !ctx.assets[pv]) r.error(pp, 'asset inexistente: ' + JSON.stringify(pv));
            if (spec.type === 'action') checkAction(r, pp, pv);
            if (spec.type === 'boolean' && typeof pv !== 'boolean') r.error(pp, 'deve ser true/false');
        }
        if (node.type === 'image' && !props.asset) r.error(path + '.props.asset', 'imagem sem asset');

        if (def.slot) {
            if (ctx.slots[node.type]) r.error(path, node.type + ' aparece mais de uma vez (cada widget do launcher só pode ser usado uma vez)');
            ctx.slots[node.type] = true;
            if (def.page !== ctx.page) r.error(path, def.label + ' pertence à tela "' + (PAGES[def.page] || {}).label + '"');
        }
        if (ctx.page === 'screensaver' && parent && !def.slot && !def.container && node.visible !== false) ctx.staticOnScreensaver = true;
        if ((node.type === 'content-row' || node.type === 'content-grid') && (props.source === 'apps' || props.source === 'favorites' || (!props.source && node.type === 'content-grid'))) ctx.appsBlock = true;
        var takesFocus = def.focusable && !(node.type === 'weather-full' && props.opensDrawer === false);
        if (takesFocus && node.visible !== false && !(node.focus && node.focus.skip)) ctx.focusable.push(node.id);
        if (def.opensSettings || (node.type === 'button' && props.action && props.action.type === 'open-settings')) ctx.settingsReachable = true;
    }

    function validateTokens(r, tokens) {
        if (tokens === undefined) return;
        if (!isObj(tokens)) { r.error('tokens', 'deve ser um objeto'); return; }
        checkKeys(r, 'tokens', tokens, ['colors', 'spacing', 'radius', 'fontSizes', 'fontFamily']);
        var merged = mergeTokens(tokens);
        var groups = { colors: 'color', spacing: 'number', radius: 'number', fontSizes: 'number' };
        for (var g in groups) {
            if (tokens[g] === undefined) continue;
            if (!isObj(tokens[g])) { r.error('tokens.' + g, 'deve ser um objeto'); continue; }
            for (var k in tokens[g]) {
                if (!own(tokens[g], k)) continue;
                if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(k)) r.error('tokens.' + g + '.' + k, 'nome de token inválido');
                if (resolveToken(tokens[g][k], merged, groups[g]) === undefined) r.error('tokens.' + g + '.' + k, 'valor inválido');
            }
        }
        checkEnum(r, 'tokens.fontFamily', tokens.fontFamily, Object.keys(FONT_FAMILIES));
    }

    /**
     * Validate a layout (already parsed JSON). Returns {ok, errors, warnings, layout}
     * where `layout` is the migrated copy to render. Never throws on bad input.
     */
    function validate(input, opts) {
        opts = opts || {};
        var r = new Report();
        var raw = input;
        if (typeof input === 'string') {
            if (input.length > LIMITS.layoutBytes) { r.error('', 'layout maior que ' + LIMITS.layoutBytes + ' bytes'); return finish(r, null); }
            try { raw = JSON.parse(input); } catch (e) { r.error('', 'JSON inválido: ' + e.message); return finish(r, null); }
        }
        var m = migrate(raw);
        if (!m.ok) { r.error('schemaVersion', m.error); return finish(r, null); }
        var L = m.layout;
        checkKeys(r, '', L, ['schemaVersion', 'id', 'name', 'createdAt', 'generator', 'tokens', 'assets', 'pages']);
        if (typeof L.id !== 'string' || !ID_RE.test(L.id)) r.error('id', 'id do layout inválido');
        if (typeof L.name !== 'string' || !L.name.length || L.name.length > LIMITS.name) r.error('name', 'nome obrigatório, até ' + LIMITS.name + ' caracteres');
        if (L.createdAt !== undefined && typeof L.createdAt !== 'string') r.error('createdAt', 'deve ser texto ISO 8601');
        if (L.generator !== undefined && !(typeof L.generator === 'string' && L.generator.length <= 80)) r.error('generator', 'inválido');

        validateTokens(r, L.tokens);
        var tokens = mergeTokens(isObj(L.tokens) ? L.tokens : {});

        var assets = {};
        var total = 0;
        if (L.assets !== undefined) {
            if (!(L.assets instanceof Array)) r.error('assets', 'deve ser uma lista');
            else {
                if (L.assets.length > LIMITS.assets) r.error('assets', 'mais de ' + LIMITS.assets + ' assets');
                for (var i = 0; i < L.assets.length; i++) {
                    var a = L.assets[i];
                    var ap = 'assets[' + i + ']';
                    if (!isObj(a)) { r.error(ap, 'deve ser um objeto'); continue; }
                    checkKeys(r, ap, a, ['id', 'file', 'sha256', 'bytes', 'width', 'height']);
                    if (typeof a.id !== 'string' || !ID_RE.test(a.id)) r.error(ap + '.id', 'id inválido');
                    else if (assets[a.id]) r.error(ap + '.id', 'id repetido');
                    if (typeof a.file !== 'string' || !FILE_RE.test(a.file)) r.error(ap + '.file', 'nome de arquivo inválido (somente png, jpg, webp; sem pastas)');
                    if (typeof a.sha256 !== 'string' || !SHA256_RE.test(a.sha256)) r.error(ap + '.sha256', 'hash SHA-256 obrigatório');
                    if (!(isNum(a.bytes) && a.bytes > 0 && a.bytes <= LIMITS.assetBytes)) r.error(ap + '.bytes', 'tamanho inválido (máx. ' + LIMITS.assetBytes + ')');
                    else total += a.bytes;
                    if (typeof a.id === 'string') assets[a.id] = a;
                }
                if (total > LIMITS.totalAssetBytes) r.error('assets', 'assets somam mais de ' + LIMITS.totalAssetBytes + ' bytes');
            }
        }

        if (!isObj(L.pages)) { r.error('pages', 'obrigatório'); return finish(r, null); }
        if (!L.pages.home) r.error('pages.home', 'a tela inicial é obrigatória');
        for (var pid in L.pages) {
            if (!own(L.pages, pid)) continue;
            if (!PAGES[pid]) { r.error('pages.' + pid, 'tela desconhecida'); continue; }
            var page = L.pages[pid];
            if (!isObj(page) || !isObj(page.root)) { r.error('pages.' + pid + '.root', 'obrigatório'); continue; }
            var meta = PAGES[pid];
            checkKeys(r, 'pages.' + pid, page, meta.panel ? ['root', 'panel'] : ['root']);
            if (!meta.runtime && !opts.studio) r.warn('pages.' + pid, meta.label + ' ainda não é aplicada pelo runtime desta versão');
            if (page.panel !== undefined && meta.panel) {
                var P = page.panel, pp = 'pages.' + pid + '.panel';
                if (!isObj(P)) r.error(pp, 'deve ser um objeto');
                else {
                    checkKeys(r, pp, P, meta.panel.width ? ['placement', 'width', 'height'] : ['placement']);
                    checkEnum(r, pp + '.placement', P.placement, meta.panel.placements);
                    if (P.width !== undefined && !(isNum(P.width) && P.width >= meta.panel.width[0] && P.width <= meta.panel.width[1])) r.error(pp + '.width', meta.panel.width.join('…') + ' px');
                    if (P.height !== undefined && !(isNum(P.height) && P.height >= meta.panel.height[0] && P.height <= meta.panel.height[1])) r.error(pp + '.height', meta.panel.height.join('…') + ' px');
                }
            }
            var ctx = { page: pid, count: 0, ids: {}, slots: {}, tokens: tokens, assets: assets, focusable: [], initialFocus: null, settingsReachable: false };
            if (!registry[page.root.type] || !registry[page.root.type].container) r.error('pages.' + pid + '.root', 'a raiz precisa ser stack ou frame');
            if (meta.styleOnly && page.root.children && page.root.children.length) r.error('pages.' + pid + '.root.children', meta.label + ': só o visual pode mudar (sem elementos dentro)');
            validateNode(r, page.root, 'pages.' + pid + '.root', ctx, 0, null);
            (meta.required || []).forEach(function(t) {
                if (!ctx.slots[t]) r.error('pages.' + pid, meta.label + ' precisa de "' + registry[t].label + '" (para nunca perder o acesso a essa função)');
            });
            if (pid === 'screensaver' && ctx.staticOnScreensaver) {
                r.warn('pages.screensaver', 'elementos parados no protetor de tela podem marcar telas OLED; o relógio do protetor muda de lugar sozinho');
            }
            if (pid === 'weather' && !ctx.slots['weather.close']) r.warn('pages.weather', 'sem o botão Fechar; o painel fecha com OK ou Voltar');
            if (pid === 'home') {
                // In the Studio an unfinished page is allowed; export and the TV are strict.
                if (!ctx.focusable.length) (opts.studio ? r.warn : r.error).call(r, 'pages.home', 'nenhum elemento navegável pelo controle; o layout seria inutilizável');
                if (!ctx.slots['launcher.app-shelf'] && !ctx.appsBlock) r.warn('pages.home', 'sem a prateleira de apps nem um carrossel/grade de apps');
                if (!ctx.settingsReachable) r.warn('pages.home', 'sem botão para Personalizar; ele continua acessível pela tecla ≡ do controle');
            }
        }
        return finish(r, L);
    }

    function finish(r, layout) {
        return { ok: r.errors.length === 0, errors: r.errors, warnings: r.warnings, layout: r.errors.length ? null : layout };
    }

    /* ------------------------------------------------------------------ */
    /* Styling: node -> CSS declarations                                   */
    /* ------------------------------------------------------------------ */

    function px(n) { return Math.round(n * 100) / 100 + 'px'; }

    function paintCss(p, tokens, assetUrl) {
        if (!p) return null;
        if (p.type === 'solid') return resolveToken(p.color, tokens, 'color');
        if (p.type === 'linear') {
            var stops = [];
            for (var i = 0; i < p.stops.length; i++) stops.push(resolveToken(p.stops[i].color, tokens, 'color') + ' ' + p.stops[i].pos + '%');
            return 'linear-gradient(' + (isNum(p.angle) ? p.angle : 180) + 'deg, ' + stops.join(', ') + ')';
        }
        if (p.type === 'image') {
            var url = assetUrl(p.asset);
            if (!url) return null;
            var fit = p.fit === 'fill' ? '100% 100%' : (p.fit || 'cover');
            return 'url("' + url + '") ' + (p.position || 'center') + ' / ' + fit + ' no-repeat';
        }
        return null;
    }

    function constraintCss(c, axis, out) {
        var startProp = axis === 'h' ? 'left' : 'top';
        var endProp = axis === 'h' ? 'right' : 'bottom';
        var sizeProp = axis === 'h' ? 'width' : 'height';
        if (c.anchor === 'start') { out[startProp] = px(c.offset); out[sizeProp] = px(c.size); }
        else if (c.anchor === 'end') { out[endProp] = px(c.offset); out[sizeProp] = px(c.size); }
        else if (c.anchor === 'center') { out[startProp] = 'calc(50% - ' + px(c.size / 2) + ' + ' + px(c.offset) + ')'; out[sizeProp] = px(c.size); }
        else if (c.anchor === 'stretch') { out[startProp] = px(c.start); out[endProp] = px(c.end); }
        else if (c.anchor === 'scale') { out[startProp] = c.start + '%'; out[sizeProp] = c.size + '%'; }
    }

    // Components whose text follows node.text (or the theme's text colour by default).
    var TEXT_TYPES = { text: 1, button: 1, 'clock-text': 1, 'content-row': 1, 'content-grid': 1, banner: 1, 'weather-full': 1, icon: 1 };

    var JUSTIFY = { start: 'flex-start', center: 'center', end: 'flex-end', 'space-between': 'space-between', 'space-around': 'space-around', 'space-evenly': 'space-evenly' };
    var ALIGN = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch', baseline: 'baseline' };

    /**
     * CSS declarations (property -> value) for one node, given its parent.
     * `opts.assetUrl(assetId)` maps an asset id to a URL; `opts.index` is the
     * node's position among its parent's flow children (for gap margins).
     */
    function nodeCss(node, parent, tokens, opts) {
        opts = opts || {};
        var assetUrl = opts.assetUrl || function() { return null; };
        var css = { 'box-sizing': 'border-box' };
        var def = registry[node.type] || {};
        var absolute = node.position === 'absolute' || (parent && parent.type === 'frame');
        var size = node.size || {};

        if (!parent) {
            css.position = 'relative';
            css.width = '100%';
            css.height = '100%';
        } else if (absolute) {
            css.position = 'absolute';
            constraintCss(node.constraints.h, 'h', css);
            constraintCss(node.constraints.v, 'v', css);
        } else {
            css.position = 'relative';
            var horizontal = parent.type === 'stack' && (parent.layout || {}).direction !== 'vertical';
            var mainProp = horizontal ? 'width' : 'height';
            var crossProp = horizontal ? 'height' : 'width';
            var main = horizontal ? size.width : size.height;
            var cross = horizontal ? size.height : size.width;
            css.flex = '0 0 auto';
            if (main && main.mode === 'fixed') css[mainProp] = px(main.value);
            if (main && main.mode === 'percent') css[mainProp] = main.value + '%';
            if (main && main.mode === 'fill') { css.flex = '1 1 0'; css['min-' + mainProp] = '0'; }
            if (cross && cross.mode === 'fixed') css[crossProp] = px(cross.value);
            if (cross && cross.mode === 'percent') css[crossProp] = cross.value + '%';
            if (cross && cross.mode === 'fill') css['align-self'] = 'stretch';
            if (node.type === 'spacer' && !main) { css.flex = '1 1 0'; }
            // Gap as margins: CSS `gap` for flexbox needs Chromium 84, older Fire OS WebViews lack it.
            var pl = parent.layout || {};
            var gap = resolveToken(pl.gap, tokens, 'number') || 0;
            if (gap && opts.index > 0 && !pl.wrap) css[horizontal ? 'margin-left' : 'margin-top'] = px(gap);
        }
        if (isNum(size.minWidth)) css['min-width'] = px(size.minWidth);
        if (isNum(size.maxWidth)) css['max-width'] = px(size.maxWidth);
        if (isNum(size.minHeight)) css['min-height'] = px(size.minHeight);
        if (isNum(size.maxHeight)) css['max-height'] = px(size.maxHeight);

        if (def.container) {
            var L = node.layout || {};
            var pad = L.padding;
            if (pad instanceof Array) {
                css.padding = [0, 1, 2, 3].map(function(i) { return px(resolveToken(pad[i], tokens, 'number') || 0); }).join(' ');
            } else if (pad !== undefined) css.padding = px(resolveToken(pad, tokens, 'number') || 0);
            if (node.type === 'stack') {
                css.display = 'flex';
                css['flex-direction'] = L.direction === 'vertical' ? 'column' : 'row';
                css['justify-content'] = JUSTIFY[L.justify || 'start'];
                css['align-items'] = ALIGN[L.align || 'start'];
                if (L.wrap) {
                    css['flex-wrap'] = 'wrap';
                    var g = resolveToken(L.gap, tokens, 'number');
                    if (g) css.gap = px(g);
                }
            } else {
                css.display = 'block';
            }
            if (L.clip) css.overflow = 'hidden';
        }

        var S = node.style || {};
        var bg = paintCss(S.background, tokens, assetUrl);
        if (bg) css.background = bg;
        if (isNum(S.opacity)) css.opacity = String(S.opacity);
        var radius = resolveToken(S.radius, tokens, 'number');
        if (radius !== undefined) css['border-radius'] = px(radius);
        if (S.border) {
            var bw = resolveToken(S.border.width, tokens, 'number') || 0;
            var bc = resolveToken(S.border.color, tokens, 'color') || 'transparent';
            if (bw) css.border = px(bw) + ' solid ' + bc;
        }
        if (S.shadow) {
            var sh = S.shadow;
            css['box-shadow'] = px(sh.x || 0) + ' ' + px(sh.y || 0) + ' ' + px(sh.blur || 0) + ' ' + px(sh.spread || 0) + ' ' +
                (resolveToken(sh.color, tokens, 'color') || 'rgba(0,0,0,0.4)');
        }
        if (S.blur) {
            css['backdrop-filter'] = 'blur(' + px(S.blur) + ')';
            css['-webkit-backdrop-filter'] = css['backdrop-filter'];
        }
        if (node.visible === false) css.display = 'none';

        var T = node.text;
        if (T || TEXT_TYPES[node.type]) {
            T = T || {};
            css.color = resolveToken(T.color, tokens, 'color') || resolveToken('$colors.text', tokens, 'color');
            css['font-family'] = FONT_FAMILIES[T.family || tokens.fontFamily] || FONT_FAMILIES.system;
            var fs = resolveToken(T.size, tokens, 'number');
            if (fs !== undefined) css['font-size'] = px(fs);
            if (T.weight) css['font-weight'] = String(T.weight);
            if (T.align) css['text-align'] = T.align;
            if (isNum(T.lineHeight)) css['line-height'] = String(T.lineHeight);
            if (isNum(T.letterSpacing)) css['letter-spacing'] = px(T.letterSpacing);
            if (T.transform && T.transform !== 'none') css['text-transform'] = T.transform;
            if (T.maxLines) {
                css.overflow = 'hidden';
                css.display = '-webkit-box';
                css['-webkit-box-orient'] = 'vertical';
                css['-webkit-line-clamp'] = String(T.maxLines);
            }
        }

        if (node.type === 'divider') {
            var thick = (node.props && node.props.thickness) || 1;
            var dc = resolveToken((node.props && node.props.color) || '$colors.border', tokens, 'color');
            css.background = dc;
            var vertical = parent && parent.type === 'stack' && (parent.layout || {}).direction !== 'vertical';
            css[vertical ? 'width' : 'height'] = px(thick);
            if (!css[vertical ? 'height' : 'width']) css['align-self'] = 'stretch';
        }
        return css;
    }

    /** CSS custom properties for the layout root (tokens and the launcher's own variables). */
    function rootVars(tokens) {
        var out = {};
        for (var c in tokens.colors) {
            var v = resolveToken(tokens.colors[c], tokens, 'color');
            if (v) out['--fmtv-' + c] = v;
            if (v && LEGACY_VARS[c]) out[LEGACY_VARS[c]] = v;
        }
        out['font-family'] = FONT_FAMILIES[tokens.fontFamily] || FONT_FAMILIES.system;
        return out;
    }

    /** Keyframes name + declarations for an enter animation, or null. */
    function enterAnimation(node) {
        var e = node.animation && node.animation.enter;
        if (!e || !e.preset || e.preset === 'none') return null;
        var d = isNum(e.distance) ? e.distance : 40;
        var from = { opacity: '0' };
        if (e.preset === 'slide-up') from.transform = 'translateY(' + d + 'px)';
        if (e.preset === 'slide-down') from.transform = 'translateY(' + (-d) + 'px)';
        if (e.preset === 'slide-left') from.transform = 'translateX(' + d + 'px)';
        if (e.preset === 'slide-right') from.transform = 'translateX(' + (-d) + 'px)';
        if (e.preset === 'scale') from.transform = 'scale(0.92)';
        return {
            from: from,
            duration: isNum(e.duration) ? e.duration : 400,
            delay: isNum(e.delay) ? e.delay : 0,
            easing: EASINGS[e.easing || 'smooth']
        };
    }

    /* ------------------------------------------------------------------ */
    /* Directional focus                                                   */
    /* ------------------------------------------------------------------ */

    /**
     * Pick the element to focus when moving `dir` ('left'|'right'|'up'|'down')
     * from items[from]. Items are rectangles {x, y, w, h} in screen pixels.
     * Returns an index, or -1 when nothing lies in that direction.
     *
     * Candidates must lie in the requested half-plane. Rows/columns that overlap
     * the current element on the cross axis win over diagonal ones; among those,
     * the nearest along the movement axis wins, then the best aligned.
     */
    function pickNext(items, from, dir) {
        var cur = items[from];
        if (!cur) return -1;
        var horizontal = dir === 'left' || dir === 'right';
        var sign = dir === 'right' || dir === 'down' ? 1 : -1;
        var best = -1, bestScore = Infinity;
        var cc = { x: cur.x + cur.w / 2, y: cur.y + cur.h / 2 };
        for (var i = 0; i < items.length; i++) {
            if (i === from) continue;
            var it = items[i];
            if (!it || it.w <= 0 || it.h <= 0) continue;
            var ic = { x: it.x + it.w / 2, y: it.y + it.h / 2 };
            // Distance along the movement axis, edge to edge (0 when touching/overlapping).
            var along, crossGap, crossCenter;
            // Elements sharing more than half of their extent along the movement axis are
            // in the same row (or column), even if one is shifted by a focus lift/scale
            // animation that is still running; they are never "above" or "beside" each other.
            var axisOverlap = horizontal
                ? Math.min(it.x + it.w, cur.x + cur.w) - Math.max(it.x, cur.x)
                : Math.min(it.y + it.h, cur.y + cur.h) - Math.max(it.y, cur.y);
            if (axisOverlap > 0.5 * Math.min(horizontal ? it.w : it.h, horizontal ? cur.w : cur.h)) continue;
            if (horizontal) {
                if ((ic.x - cc.x) * sign <= 1) continue;
                along = sign > 0 ? it.x - (cur.x + cur.w) : cur.x - (it.x + it.w);
                crossGap = Math.max(0, Math.max(it.y, cur.y) - Math.min(it.y + it.h, cur.y + cur.h));
                crossCenter = Math.abs(ic.y - cc.y);
            } else {
                if ((ic.y - cc.y) * sign <= 1) continue;
                along = sign > 0 ? it.y - (cur.y + cur.h) : cur.y - (it.y + it.h);
                crossGap = Math.max(0, Math.max(it.x, cur.x) - Math.min(it.x + it.w, cur.x + cur.w));
                crossCenter = Math.abs(ic.x - cc.x);
            }
            along = Math.max(0, along);
            var overlapping = crossGap === 0;
            var score = (overlapping ? 0 : 1e6) + along * 4 + crossGap * 2 + crossCenter * 0.5;
            if (score < bestScore) { bestScore = score; best = i; }
        }
        return best;
    }

    /** Indexes reachable from `start` with the four arrow keys. Used to flag unreachable controls. */
    function reachable(items, start) {
        var seen = {};
        var queue = [start];
        seen[start] = true;
        var dirs = ['left', 'right', 'up', 'down'];
        while (queue.length) {
            var i = queue.shift();
            for (var d = 0; d < dirs.length; d++) {
                var n = pickNext(items, i, dirs[d]);
                if (n !== -1 && !seen[n]) { seen[n] = true; queue.push(n); }
            }
        }
        var out = [];
        for (var k in seen) out.push(Number(k));
        return out.sort(function(a, b) { return a - b; });
    }

    /* ------------------------------------------------------------------ */
    /* Tree helpers (shared with the Studio)                               */
    /* ------------------------------------------------------------------ */

    function walk(node, fn, parent, depth) {
        if (fn(node, parent || null, depth || 0) === false) return;
        var kids = node.children || [];
        for (var i = 0; i < kids.length; i++) walk(kids[i], fn, node, (depth || 0) + 1);
    }

    function findNode(root, id) {
        var found = null;
        walk(root, function(n, p) { if (n.id === id) { found = { node: n, parent: p }; return false; } });
        return found;
    }

    return {
        SCHEMA_VERSION: SCHEMA_VERSION,
        LIMITS: LIMITS,
        PAGES: PAGES,
        ICONS: ICONS,
        CONTENT_SOURCES: CONTENT_SOURCES,
        ACTIONS: ACTIONS,
        FONT_FAMILIES: FONT_FAMILIES,
        EASINGS: EASINGS,
        ENTER_PRESETS: ENTER_PRESETS,
        DEFAULT_TOKENS: DEFAULT_TOKENS,
        registry: registry,
        defineComponent: defineComponent,
        mergeTokens: mergeTokens,
        resolveToken: resolveToken,
        migrate: migrate,
        migrations: migrations,
        validate: validate,
        nodeCss: nodeCss,
        rootVars: rootVars,
        enterAnimation: enterAnimation,
        pickNext: pickNext,
        reachable: reachable,
        walk: walk,
        findNode: findNode
    };
}));
