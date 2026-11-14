// Studio projects (.fmtvproj): JSON with the layout and the bytes of its images.
import { E } from '../engine';
import type { Layout, Project } from './types';
import classic from '../../../examples/layouts/classic.json';
import cinema from '../../../examples/layouts/cinema.json';
import auroraUrl from '../../../examples/layouts/cinema-assets/aurora.jpg?url';
import { sha256Hex, bytesToBase64 } from '../lib/bytes';

export const PROJECT_EXTENSION = '.fmtvproj';

export function blankLayout(name = 'Novo layout'): Layout {
    return {
        schemaVersion: E.SCHEMA_VERSION,
        id: 'layout-' + Date.now().toString(36),
        name,
        generator: 'Free My TV Studio',
        pages: {
            home: {
                root: {
                    id: 'root', type: 'frame', name: 'Tela',
                    style: { background: { type: 'linear', angle: 160, stops: [{ color: '#171d33', pos: 0 }, { color: '#04060a', pos: 100 }] } },
                    children: [
                        {
                            id: 'apps', type: 'launcher.app-shelf', focus: { initial: true },
                            constraints: { h: { anchor: 'stretch', start: 54, end: 54 }, v: { anchor: 'end', offset: 260, size: 300 } },
                        },
                        {
                            id: 'customize', type: 'launcher.settings-button',
                            constraints: { h: { anchor: 'end', offset: 54, size: 190 }, v: { anchor: 'start', offset: 40, size: 50 } },
                        },
                    ],
                },
            },
        },
    };
}

export function newProject(layout: Layout = blankLayout(), assetData: Record<string, string> = {}): Project {
    return { format: 'fmtv-studio-project', formatVersion: 1, layout, assetData };
}

export interface Template {
    id: string;
    name: string;
    description: string;
    create(): Promise<Project>;
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

export const TEMPLATES: Template[] = [
    {
        id: 'blank', name: 'Em branco', description: 'Fundo, prateleira de apps e Personalizar',
        create: async () => newProject(blankLayout()),
    },
    {
        id: 'classic', name: 'Clássico', description: 'A tela original do Free My TV, montada com stacks',
        create: async () => {
            const l = clone(classic) as unknown as Layout;
            l.id = 'classic-' + Date.now().toString(36);
            return newProject(l);
        },
    },
    {
        id: 'cinema', name: 'Cinema', description: 'Imagem de fundo, relógio grande e atalhos',
        create: async () => {
            const l = clone(cinema) as unknown as Layout;
            l.id = 'cinema-' + Date.now().toString(36);
            const bytes = new Uint8Array(await (await fetch(auroraUrl)).arrayBuffer());
            const asset = l.assets!.find((a) => a.id === 'aurora')!;
            asset.bytes = bytes.length;
            asset.sha256 = await sha256Hex(bytes);
            return newProject(l, { aurora: bytesToBase64(bytes) });
        },
    },
];

/** Parse and check a project file. Throws a readable message. */
export function parseProject(text: string): Project {
    let data: unknown;
    try { data = JSON.parse(text); } catch { throw new Error('o arquivo não é um projeto válido (JSON inválido)'); }
    const p = data as Partial<Project>;
    if (!p || p.format !== 'fmtv-studio-project') {
        // Accept a bare layout.json too.
        const m = E.migrate(data);
        if (m.ok && m.layout && (data as Layout).pages) return newProject(m.layout);
        throw new Error('o arquivo não é um projeto do Free My TV Studio');
    }
    if (p.formatVersion !== 1) throw new Error(`projeto na versão ${p.formatVersion}; este Studio abre a versão 1`);
    const m = E.migrate(p.layout);
    if (!m.ok || !m.layout) throw new Error(m.error || 'layout inválido');
    const assetData: Record<string, string> = {};
    for (const [k, v] of Object.entries(p.assetData || {})) if (typeof v === 'string') assetData[k] = v;
    return { format: 'fmtv-studio-project', formatVersion: 1, layout: m.layout, assetData };
}

export function serializeProject(project: Project): string {
    return JSON.stringify(project);
}
