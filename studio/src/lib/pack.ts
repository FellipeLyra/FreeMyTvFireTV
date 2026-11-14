// Build a .fmtv package (layout.json + assets/) from a project, with the same
// strict validation the TV applies.
import { E } from '../engine';
import type { Issue, Layout, Project } from '../model/types';
import { base64ToBytes, sha256Hex, zip } from './bytes';

export interface PackResult {
    ok: boolean;
    bytes?: Uint8Array;
    layout?: Layout;
    errors: Issue[];
    warnings: Issue[];
}

/** Layout ready to publish: only used assets, with sizes and SHA-256 recomputed from the bytes. */
export async function finalizeLayout(project: Project): Promise<{ layout: Layout; files: { name: string; data: Uint8Array }[]; missing: string[] }> {
    const layout: Layout = JSON.parse(JSON.stringify(project.layout));
    const used = new Set<string>();
    for (const page of Object.values(layout.pages)) {
        E.walk(page.root, (n) => {
            const bg = n.style?.background;
            if (bg && bg.type === 'image') used.add(bg.asset);
            if (n.type === 'image' && n.props?.asset) used.add(n.props.asset);
        });
    }
    const files: { name: string; data: Uint8Array }[] = [];
    const missing: string[] = [];
    layout.assets = [];
    for (const a of project.layout.assets || []) {
        if (!used.has(a.id)) continue;
        const b64 = project.assetData[a.id];
        if (!b64) { missing.push(a.id); continue; }
        const data = base64ToBytes(b64);
        layout.assets.push({ ...a, bytes: data.length, sha256: await sha256Hex(data) });
        files.push({ name: 'assets/' + a.file, data });
    }
    if (!layout.assets.length) delete layout.assets;
    layout.generator = 'Free My TV Studio';
    return { layout, files, missing };
}

export async function buildPackage(project: Project): Promise<PackResult> {
    const { layout, files, missing } = await finalizeLayout(project);
    const v = E.validate(layout);
    const errors = [...v.errors, ...missing.map((id) => ({ path: 'assets', message: `imagem ${id} sem arquivo no projeto` }))];
    if (errors.length) return { ok: false, errors, warnings: v.warnings };
    const json = new TextEncoder().encode(JSON.stringify(layout, null, 2));
    return { ok: true, bytes: zip([{ name: 'layout.json', data: json }, ...files]), layout, errors: [], warnings: v.warnings };
}
