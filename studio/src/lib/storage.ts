// Where projects live. One interface, so the desktop shell (Tauri) can provide
// native dialogs while the browser build uses the File System Access API (with a
// download fallback). Autosave goes to IndexedDB for crash recovery.
import type { Project } from '../model/types';
import { parseProject, serializeProject, PROJECT_EXTENSION } from '../model/project';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Handle = any;

export interface OpenedFile {
    project: Project;
    name: string;
    handle: Handle | null;
}

const hasPicker = () => typeof (window as any).showSaveFilePicker === 'function';

const PROJECT_TYPES = [{ description: 'Projeto Free My TV Studio', accept: { 'application/json': [PROJECT_EXTENSION] } }];

export async function saveProject(project: Project, name: string, handle: Handle | null, saveAs = false): Promise<{ name: string; handle: Handle | null }> {
    const text = serializeProject(project);
    if (hasPicker()) {
        let h = handle;
        if (!h || saveAs) {
            h = await (window as any).showSaveFilePicker({ suggestedName: ensureExt(name, PROJECT_EXTENSION), types: PROJECT_TYPES });
        }
        const w = await h.createWritable();
        await w.write(text);
        await w.close();
        return { name: h.name, handle: h };
    }
    download(new Blob([text], { type: 'application/json' }), ensureExt(name, PROJECT_EXTENSION));
    return { name: ensureExt(name, PROJECT_EXTENSION), handle: null };
}

export async function openProject(): Promise<OpenedFile | null> {
    if (typeof (window as any).showOpenFilePicker === 'function') {
        let handles: Handle[];
        try {
            handles = await (window as any).showOpenFilePicker({ types: [...PROJECT_TYPES, { description: 'Layout (layout.json)', accept: { 'application/json': ['.json'] } }] });
        } catch {
            return null; // cancelled
        }
        const file = await handles[0].getFile();
        return { project: parseProject(await file.text()), name: file.name, handle: file.name.endsWith(PROJECT_EXTENSION) ? handles[0] : null };
    }
    const file = await pickFile(PROJECT_EXTENSION + ',.json');
    if (!file) return null;
    return { project: parseProject(await file.text()), name: file.name, handle: null };
}

export function pickFile(accept: string, multiple = false): Promise<File | null> {
    return pickFiles(accept, multiple).then((f) => f[0] || null);
}

export function pickFiles(accept: string, multiple = true): Promise<File[]> {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = accept;
        input.multiple = multiple;
        input.onchange = () => resolve(Array.from(input.files || []));
        input.click();
    });
}

export function download(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function ensureExt(name: string, ext: string) {
    const base = name.replace(/\.(fmtvproj|json)$/i, '').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'layout';
    return base + ext;
}

/* ---------------- autosave (IndexedDB) ---------------- */

interface AutosaveRecord {
    project: Project;
    name: string;
    savedAt: number;
}

function db(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('fmtv-studio', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('kv');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

export async function writeAutosave(project: Project, name: string) {
    try {
        const d = await db();
        await new Promise<void>((resolve, reject) => {
            const tx = d.transaction('kv', 'readwrite');
            tx.objectStore('kv').put({ project, name, savedAt: Date.now() } satisfies AutosaveRecord, 'autosave');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch {
        // Autosave is best effort (private windows may block IndexedDB).
    }
}

export async function readAutosave(): Promise<AutosaveRecord | null> {
    try {
        const d = await db();
        return await new Promise((resolve) => {
            const req = d.transaction('kv').objectStore('kv').get('autosave');
            req.onsuccess = () => resolve((req.result as AutosaveRecord) || null);
            req.onerror = () => resolve(null);
        });
    } catch {
        return null;
    }
}

export async function clearAutosave() {
    try {
        const d = await db();
        d.transaction('kv', 'readwrite').objectStore('kv').delete('autosave');
    } catch {
        /* ignore */
    }
}
