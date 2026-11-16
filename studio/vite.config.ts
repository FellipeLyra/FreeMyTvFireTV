/// <reference types="vitest" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
// @ts-expect-error plain ESM helper without types
import { WEB_DIR, previewHtml } from './scripts/copy-runtime.mjs';
// @ts-expect-error plain ESM helper without types
import { createBridge } from '../tools/lib/bridge.mjs';

const TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.json': 'application/json', '.css': 'text/css', '.md': 'text/plain; charset=utf-8',
};

/** Development: serve the TV runtime live from the app folder, so canvas and TV never drift apart. */
function liveRuntime(): Plugin {
    return {
        name: 'fmtv-live-runtime',
        configureServer(server) {
            server.watcher.add(WEB_DIR);
            server.middlewares.use('/runtime', (req, res, next) => {
                const path = decodeURIComponent((req.url || '/').split('?')[0]);
                try {
                    if (path === '/preview.html') {
                        res.setHeader('content-type', TYPES['.html']);
                        res.setHeader('cache-control', 'no-store');
                        res.end(previewHtml());
                        return;
                    }
                    const file = normalize(join(WEB_DIR, path));
                    if (!file.startsWith(normalize(WEB_DIR)) || !existsSync(file) || !statSync(file).isFile()) return next();
                    res.setHeader('content-type', TYPES[extname(file)] || 'application/octet-stream');
                    res.setHeader('cache-control', 'no-store');
                    res.end(readFileSync(file));
                } catch (e) {
                    next(e);
                }
            });
        },
    };
}

/**
 * Phase 7: the local bridge to adb (tools/lib/bridge.mjs) lives inside the Studio's own
 * server, so `npm run dev` and `npm run desktop` can publish with nothing else running.
 */
function deviceBridge(): Plugin {
    return {
        name: 'fmtv-device-bridge',
        configureServer(server) { server.middlewares.use(createBridge()); },
        configurePreviewServer(server) { server.middlewares.use(createBridge()); },
    };
}

export default defineConfig({
    plugins: [react(), liveRuntime(), deviceBridge()],
    // The Studio reuses the launcher's own engine and example layouts from the repository.
    // src-tauri/target holds Rust build output (locked .exe files on Windows): never watch it.
    server: { fs: { allow: ['..'] }, host: '127.0.0.1', port: 5610, strictPort: false, watch: { ignored: ['**/src-tauri/**'] } },
    build: { target: 'es2020', outDir: 'dist', chunkSizeWarningLimit: 1500 },
    test: { environment: 'node', include: ['test/**/*.test.ts'] },
});
