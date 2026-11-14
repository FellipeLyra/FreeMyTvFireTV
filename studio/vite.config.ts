/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    // The Studio reuses the launcher's own engine and example layouts from the repository.
    // src-tauri/target holds Rust build output (locked .exe files on Windows): never watch it.
    server: { fs: { allow: ['..'] }, port: 5610, strictPort: false, watch: { ignored: ['**/src-tauri/**'] } },
    build: { target: 'es2020', outDir: 'dist', chunkSizeWarningLimit: 1500 },
    test: { environment: 'node', include: ['test/**/*.test.ts'] },
});
