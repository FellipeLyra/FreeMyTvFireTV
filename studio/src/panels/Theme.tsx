// Global design tokens of the layout. Components linked to a token ($colors.accent,
// $spacing.md...) follow every change here.
import { E } from '../engine';
import { useEditor } from '../store/editor';
import type { Tokens } from '../model/types';
import { ColorField, NumberField, Row, Section, Select } from '../ui/fields';
import { I } from '../ui/icons';
import { download, pickFile } from '../lib/storage';

const COLOR_LABEL: Record<string, string> = {
    primary: 'Primária', secondary: 'Secundária', accent: 'Destaque', background: 'Fundo', surface: 'Superfície',
    text: 'Texto', textMuted: 'Texto suave', border: 'Borda', focus: 'Foco', shadow: 'Sombra',
};

export function ThemeEditor() {
    const tokens = useEditor((s) => s.project.layout.tokens || {});
    const name = useEditor((s) => s.project.layout.name);
    const s = useEditor.getState();
    const D = E.DEFAULT_TOKENS;
    const set = (key: string, fn: (t: Tokens) => void) => s.commit('tema', (p) => {
        const t: Tokens = (p.layout.tokens = p.layout.tokens || {});
        fn(t);
        for (const g of ['colors', 'spacing', 'radius', 'fontSizes'] as const) if (t[g] && !Object.keys(t[g]!).length) delete t[g];
        if (!Object.keys(t).length) delete p.layout.tokens;
    }, 'theme.' + key);

    const exportTheme = () => download(new Blob([JSON.stringify({ format: 'fmtv-theme', tokens }, null, 2)], { type: 'application/json' }), (name || 'tema') + '.fmtvtheme.json');
    const importTheme = async () => {
        const f = await pickFile('.json');
        if (!f) return;
        try {
            const data = JSON.parse(await f.text());
            const t = data && data.format === 'fmtv-theme' ? data.tokens : null;
            if (!t) throw new Error('arquivo não é um tema do Free My TV');
            const probe = E.validate({ schemaVersion: 1, id: 'probe', name: 'probe', tokens: t, pages: { home: { root: { id: 'r', type: 'stack', children: [{ id: 'a', type: 'launcher.app-shelf' }] } } } });
            const bad = probe.errors.filter((e) => e.path.startsWith('tokens'));
            if (bad.length) throw new Error('tema inválido: ' + bad[0].path + ' ' + bad[0].message);
            s.commit('importar tema', (p) => { p.layout.tokens = t; });
            s.toast('tema importado', 'success');
        } catch (e) {
            s.toast((e as Error).message, 'error');
        }
    };

    return (
        <div className="props">
            <div className="props-head"><strong>Tema do layout</strong></div>
            <p className="panel-note">Nada selecionado. Estes tokens valem para o layout inteiro; os elementos ligados a um token mudam juntos.</p>
            <div className="btn-row">
                <button className="btn" onClick={importTheme}><I.Upload size={14} /> Importar tema</button>
                <button className="btn" onClick={exportTheme}><I.Export size={14} /> Exportar tema</button>
            </div>
            <Section title="Cores">
                {Object.keys(D.colors).map((k) => (
                    <Row key={k} label={COLOR_LABEL[k] || k}>
                        <ColorField allowEmpty value={tokens.colors?.[k] ?? D.colors[k]}
                            onChange={(c) => set('c.' + k, (t) => { t.colors = { ...(t.colors || {}) }; if (!c || c === D.colors[k]) delete t.colors[k]; else t.colors[k] = c; })} />
                    </Row>
                ))}
            </Section>
            <Section title="Tipografia">
                <Row label="Fonte">
                    <Select value={tokens.fontFamily || D.fontFamily} onChange={(v) => set('font', (t) => { if (v === D.fontFamily) delete t.fontFamily; else t.fontFamily = v; })}
                        options={Object.keys(E.FONT_FAMILIES).map((f) => ({ value: f, label: { system: 'Sistema', rounded: 'Arredondada', serif: 'Serifada', mono: 'Monoespaçada' }[f] || f }))} />
                </Row>
                {Object.keys(D.fontSizes).map((k) => (
                    <Row key={k} label={{ caption: 'Legenda', body: 'Corpo', title: 'Título', display: 'Destaque', hero: 'Gigante' }[k] || k}>
                        <NumberField value={tokens.fontSizes?.[k] ?? D.fontSizes[k]} min={6} max={400} suffix="px"
                            onChange={(v) => set('fs.' + k, (t) => { t.fontSizes = { ...(t.fontSizes || {}) }; if (v === undefined || v === D.fontSizes[k]) delete t.fontSizes[k]; else t.fontSizes[k] = v; })} />
                    </Row>
                ))}
            </Section>
            <Section title="Espaçamento e cantos" defaultOpen={false}>
                {(['spacing', 'radius'] as const).map((g) => Object.keys(D[g]).map((k) => (
                    <Row key={g + k} label={(g === 'spacing' ? 'Espaço ' : 'Canto ') + k}>
                        <NumberField value={tokens[g]?.[k] ?? D[g][k]} min={0} max={g === 'radius' ? 999 : 400} suffix="px"
                            onChange={(v) => set(g + '.' + k, (t) => { t[g] = { ...(t[g] || {}) }; if (v === undefined || v === D[g][k]) delete t[g]![k]; else t[g]![k] = v; })} />
                    </Row>
                )))}
            </Section>
        </div>
    );
}
