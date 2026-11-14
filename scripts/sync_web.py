#!/usr/bin/env python3
"""Copy the Free My TV web UI from the upstream webOS project and adapt it to Fire TV.

Usage:
    python scripts/sync_web.py <path-to-FreeMyTvWebOS-checkout>

The upstream UI (https://github.com/danielthejoker18/FreeMyTvWebOS, MIT) is a
single index.html that talks to webOS through `webOS.service.request`. Instead
of rewriting it, this script swaps in `firetv-bridge.js`, which implements the
same call shape on top of the Android bridge, and replaces the LG-specific app
catalog with Fire TV package names. Every patch must match exactly once, so an
upstream change that breaks a patch fails loudly instead of shipping silently.
"""
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB_OUT = ROOT / "app" / "src" / "main" / "assets" / "web"

CATALOG = r"""        var DEFAULT_CATALOG = [
            { id: 'com.amazon.firetv.youtube', title: 'YouTube', tag: 'Streaming', desc: 'Watch 4K videos, live streams, music, and coding radio.', color: '#ff0000', badge: 'YT', bg: 'linear-gradient(135deg, #ff0000, #b00000)' },
            { id: 'com.netflix.ninja', title: 'Netflix', tag: 'Movies & Series', desc: 'Unlimited movies, TV shows, and originals in 4K Dolby Vision.', color: '#e50914', badge: 'N', bg: 'linear-gradient(135deg, #1f1f1f, #080808)' },
            { id: 'com.amazon.avod', title: 'Prime Video', tag: 'Movies & Shows', desc: 'Watch Amazon Originals, popular movies, and live sports.', color: '#00a8e1', badge: 'prime', bg: 'linear-gradient(135deg, #00a8e1, #00628a)' },
            { id: 'com.disney.disneyplus', title: 'Disney+', tag: 'Streaming', desc: 'Disney, Pixar, Marvel, Star Wars, and National Geographic.', color: '#113ccf', badge: 'D+', bg: 'linear-gradient(135deg, #113ccf, #071961)' },
            { id: 'com.wbd.stream', title: 'Max', tag: 'Movies & Series', desc: 'HBO originals, Warner Bros. movies, series and live sports.', color: '#002be7', badge: 'max', bg: 'linear-gradient(135deg, #002be7, #00137a)' },
            { id: 'com.globo.globotv', title: 'Globoplay', tag: 'Brazil Streaming', desc: 'Original series, live channels, sports, and cinema.', color: '#fb003f', badge: 'globo', bg: 'linear-gradient(135deg, #fb003f, #aa002a)' },
            { id: 'com.crunchyroll.crunchyroid', title: 'Crunchyroll', tag: 'Anime', desc: 'Stream the world\'s largest anime library and simulcasts.', color: '#f47521', badge: 'CR', bg: 'linear-gradient(135deg, #f47521, #c4570d)' },
            { id: 'com.plexapp.android', title: 'Plex', tag: 'Personal Media', desc: 'Stream your personal home cinema, movies, and music library.', color: '#e5a00d', badge: '>', bg: 'linear-gradient(135deg, #e5a00d, #9e6d00)' },
            { id: 'com.spotify.tv.android', title: 'Spotify', tag: 'Music', desc: 'Listen to millions of songs, albums, and podcasts on your TV.', color: '#1db954', badge: 'SP', bg: 'linear-gradient(135deg, #1db954, #0f7833)' },
            { id: 'com.amazon.cloud9', title: 'Silk Browser', tag: 'Internet', desc: 'Full-screen web browsing on your Fire TV.', color: '#5856d6', badge: 'WEB', bg: 'linear-gradient(135deg, #5856d6, #3634a3)' },
            { id: 'org.xbmc.kodi', title: 'Kodi', tag: 'Local Media', desc: 'Play your own videos, music and photos from USB or the network.', color: '#17b2e7', badge: 'KODI', bg: 'linear-gradient(135deg, #17b2e7, #0b5f7d)' },
            { id: 'com.esaba.downloader', title: 'Downloader', tag: 'System', desc: 'Download and install apps (APK) from the internet.', color: '#f48c06', badge: 'DL', bg: 'linear-gradient(135deg, #f48c06, #a35c00)' },
            { id: 'fmtv.settings', title: 'Settings', tag: 'System', desc: 'Open the Fire TV settings.', color: '#8e8e93', badge: 'SET', bg: 'linear-gradient(135deg, #636366, #2c2c2e)' },
            { id: 'fmtv.amazonhome', title: 'Fire TV Home', tag: 'System', desc: 'Open the original Amazon home screen and app store.', color: '#ff9900', badge: 'HOME', bg: 'linear-gradient(135deg, #ff9900, #b36b00)' }
        ];
"""

APP_LOGOS = r"""        var APP_LOGOS = {
            'com.amazon.firetv.youtube': 'youtube',
            'com.netflix.ninja': 'netflix',
            'com.plexapp.android': 'plex',
            'com.crunchyroll.crunchyroid': 'crunchyroll',
            'com.globo.globotv': 'globoplay',
            'com.amazon.avod': 'amazonprime',
            'com.disney.disneyplus': 'disneyplus',
            'com.spotify.tv.android': 'spotify'
        };
"""

FAVORITES = r"""        var DEFAULT_FAVORITES = [
            'com.amazon.firetv.youtube',
            'com.netflix.ninja',
            'com.amazon.avod',
            'com.disney.disneyplus',
            'com.globo.globotv',
            'com.wbd.stream',
            'fmtv.settings',
            'fmtv.amazonhome'
        ];
"""

# Portuguese strings for text that only exists in the Fire TV catalog.
EXTRA_PT = r"""        (function(pt) {
            pt['HBO originals, Warner Bros. movies, series and live sports.'] = 'Originais HBO, filmes da Warner Bros., séries e esportes ao vivo.';
            pt['Full-screen web browsing on your Fire TV.'] = 'Navegação web em tela cheia no seu Fire TV.';
            pt['Play your own videos, music and photos from USB or the network.'] = 'Reproduza seus vídeos, músicas e fotos do USB ou da rede.';
            pt['Download and install apps (APK) from the internet.'] = 'Baixe e instale apps (APK) da internet.';
            pt['Open the Fire TV settings.'] = 'Abra as configurações do Fire TV.';
            pt['Open the original Amazon home screen and app store.'] = 'Abra a tela inicial original da Amazon e a loja de apps.';
            pt['Settings'] = 'Ajustes';
            pt['Fire TV Home'] = 'Tela Amazon';
            pt['Silk Browser'] = 'Navegador Silk';
        })(I18N.pt);

"""


def block(text, start, end):
    """Return the exact source block from `start` through the first `end` after it."""
    i = text.index(start)
    j = text.index(end, i) + len(end)
    return text[i:j]


def patch(text, old, new, count=1):
    found = text.count(old)
    if found != count:
        sys.exit(f"patch failed: expected {count} match(es), found {found}: {old[:70]!r}")
    return text.replace(old, new)


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    upstream = Path(sys.argv[1]) / "app"
    html = (upstream / "index.html").read_text(encoding="utf-8")

    html = patch(html, '<script src="webOSTV.js"></script>', '<script src="firetv-bridge.js"></script>')
    # The page is drawn for a 1920px wide screen; the WebView scales it to the TV.
    html = patch(html, '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
                 '<meta name="viewport" content="width=1920">')
    html = patch(html, block(html, "        var DEFAULT_CATALOG = [", "        ];\n"), CATALOG)
    html = patch(html, block(html, "        var APP_LOGOS = {", "        };\n"), APP_LOGOS)
    html = patch(html, block(html, "        var DEFAULT_FAVORITES = [", "        ];\n"), FAVORITES)
    html = patch(html, "        var LANG_LOCALES =", EXTRA_PT + "        var LANG_LOCALES =")

    # Trending picks point at streaming apps by id.
    html = patch(html, "app: 'netflix'", "app: 'com.netflix.ninja'", count=html.count("app: 'netflix'"))
    html = patch(html, "app: 'amazon'", "app: 'com.amazon.avod'")
    html = patch(html, "app: 'com.crunchyroll.webapp'", "app: 'com.crunchyroll.crunchyroid'")
    html = patch(html, "items[i].app = 'youtube.leanback.v4';", "items[i].app = 'com.amazon.firetv.youtube';")
    html = patch(html, "' natively on your LG TV.'", "' on your Fire TV.'")

    # The Fire TV-only tiles (Settings, Fire TV Home) have translated names, so app
    # titles go through t() where they are shown. Unknown titles come back unchanged.
    for old, new in (
        ("var title = device.title || app.title;", "var title = device.title || t(app.title);"),
        ("fallback.textContent = app.title;", "fallback.textContent = t(app.title);"),
        ("titleSpan.textContent = app.title;", "titleSpan.textContent = t(app.title);"),
        ("(devicePreset(app, state.hdmiDevices).title || app.title)", "(devicePreset(app, state.hdmiDevices).title || t(app.title))"),
    ):
        html = patch(html, old, new)

    # A Fire TV stick is itself plugged into an HDMI port, so input switching does not apply.
    html = patch(html, '            <div>\n                <div class="modal-section-title">2. HDMI Devices</div>',
                 '            <div style="display:none">\n                <div class="modal-section-title">2. HDMI Devices</div>')
    # ...and the section after it moves up from 3 to 2, in the markup and every language.
    html = "\n".join(
        line.replace("3. Pr", "2. Pr").replace("'3. ", "'2. ").replace(">3. ", ">2. ")
        if "3. Preferences & Display" in line else line
        for line in html.split("\n")
    )

    # Layout content blocks (carousels, grids, banners) reuse the trending service for
    # both movies and shows. fetchTrendingPicks(tab, sink) fetches one tab and hands
    # the items to `sink` instead of the trending row; every result is also offered
    # to window.FMTVData so the runtime always has the latest picks.
    html = patch(html, "        function fetchTrendingPicks() {\n            var badge = document.getElementById('picksSourceBadge');\n            var tab = state.picksTab;\n            var tmdbMediaPath = tab === 'shows' ? 'tv' : 'movie';\n",
                 "        function fetchTrendingPicks(forTab, sink) {\n            var badge = document.getElementById('picksSourceBadge');\n            var tab = forTab || state.picksTab;\n            var tmdbMediaPath = tab === 'shows' ? 'tv' : 'movie';\n"
                 "            function isCurrent() { return !!sink || tab === state.picksTab; }\n"
                 "            function deliver(items, source) {\n"
                 "                if (window.FMTVData) window.FMTVData.picks(tab, items, source);\n"
                 "                if (sink) { sink(items, source); return; }\n"
                 "                badge.textContent = source;\n"
                 "                renderPicks(items);\n"
                 "            }\n")
    html = patch(html, "if (tab !== state.picksTab) return;", "if (!isCurrent()) return;", count=2)
    html = patch(html, "tab === state.picksTab)", "isCurrent())", count=2)
    html = patch(html, "                badge.textContent = t('Curated Picks');\n                renderPicks(tab === 'shows' ? FALLBACK_SHOWS : FALLBACK_MOVIES);",
                 "                deliver(tab === 'shows' ? FALLBACK_SHOWS : FALLBACK_MOVIES, t('Curated Picks'));")
    html = patch(html, "                            badge.textContent = t('TMDB Live');\n                            renderPicks(items);",
                 "                            deliver(items, t('TMDB Live'));")
    html = patch(html, "if (linked) renderPicks(items);", "if (linked) deliver(items, t('TMDB Live'));")
    html = patch(html, "                                        badge.textContent = t('Live Popular Feed');\n                                        renderPicks(topShows);",
                 "                                        deliver(topShows, t('Live Popular Feed'));")

    # Layout runtime (this repo's own code in web/fmtv/): loaded after the page's
    # script, so it can reuse the page's widgets and functions.
    html = patch(html, "</body>",
                 '    <script src="fmtv/engine.js"></script>\n    <script src="fmtv/blocks.js"></script>\n    <script src="fmtv/runtime.js"></script>\n</body>')

    # Only the files that come from upstream are replaced. firetv-bridge.js and
    # fmtv/ (the layout engine and runtime) belong to this repository and are kept.
    for own in ("firetv-bridge.js", "fmtv/engine.js", "fmtv/blocks.js", "fmtv/runtime.js"):
        if not (WEB_OUT / own).is_file():
            sys.exit(f"missing app/src/main/assets/web/{own}")
    (WEB_OUT / "index.html").write_text(html, encoding="utf-8", newline="\n")
    brands = WEB_OUT / "assets" / "brands"
    if brands.exists():
        shutil.rmtree(brands)
    shutil.copytree(upstream / "assets" / "brands", brands)
    print(f"web UI written to {WEB_OUT}")


if __name__ == "__main__":
    main()
