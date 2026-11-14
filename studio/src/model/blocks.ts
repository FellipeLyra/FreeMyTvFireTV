// Ready-made blocks for the component library. A block is a small node tree;
// inserting it copies the tree with fresh ids. Users can save their own blocks
// (stored in the project file), which are inserted the same way.
import type { LayoutNode } from './types';

export interface Block {
    id: string;
    name: string;
    description?: string;
    /** Put it behind everything and stretch it over the container (backgrounds). */
    fill?: boolean;
    node: LayoutNode;
}

const title = (text: string): LayoutNode => ({ id: 't', type: 'text', props: { text }, text: { size: 28, weight: 700 } });

export const BUILTIN_BLOCKS: Block[] = [
    {
        id: 'movies-row', name: 'Filmes em alta', description: 'Título + carrossel de filmes (TMDB ou lista curada)',
        node: {
            id: 'b', type: 'stack', name: 'Filmes em alta', layout: { direction: 'vertical', gap: 8, align: 'stretch' },
            size: { width: { mode: 'fixed', value: 1800 }, height: { mode: 'fixed', value: 420 } },
            children: [title('Filmes em alta'), { id: 'r', type: 'content-row', props: { source: 'movies', cardStyle: 'poster', maxItems: 10, showTitles: true } }],
        },
    },
    {
        id: 'shows-row', name: 'Séries em alta', description: 'Título + carrossel de séries (TMDB ou TVMaze)',
        node: {
            id: 'b', type: 'stack', name: 'Séries em alta', layout: { direction: 'vertical', gap: 8, align: 'stretch' },
            size: { width: { mode: 'fixed', value: 1800 }, height: { mode: 'fixed', value: 320 } },
            children: [title('Séries em alta'), { id: 'r', type: 'content-row', props: { source: 'shows', cardStyle: 'wide', maxItems: 10, showTitles: true } }],
        },
    },
    {
        id: 'apps-grid', name: 'Aplicativos instalados', description: 'Grade com todos os apps do Fire TV',
        node: {
            id: 'b', type: 'stack', name: 'Aplicativos', layout: { direction: 'vertical', gap: 8, align: 'stretch' },
            size: { width: { mode: 'fixed', value: 1400 }, height: { mode: 'fixed', value: 500 } },
            children: [title('Aplicativos'), { id: 'g', type: 'content-grid', size: { height: { mode: 'fill' } }, props: { source: 'apps', columns: 5, cardStyle: 'app', maxItems: 15, showTitles: true } }],
        },
    },
    {
        id: 'favorites-row', name: 'Apps favoritos (carrossel)', description: 'Os favoritos do Personalizar num carrossel',
        node: { id: 'r', type: 'content-row', name: 'Favoritos', props: { source: 'favorites', cardStyle: 'app', maxItems: 12, showTitles: false } },
    },
    {
        id: 'banner', name: 'Banner de destaque', description: 'Destaque grande com botão, alternando títulos',
        node: { id: 'b', type: 'banner', name: 'Destaque', size: { width: { mode: 'fixed', value: 1200 }, height: { mode: 'fixed', value: 400 } }, props: { source: 'movies', rotateSeconds: 8, buttonLabel: 'Assistir' } },
    },
    {
        id: 'weather-full', name: 'Clima completo', description: 'Agora, próximas horas, nascer e pôr do sol',
        node: { id: 'w', type: 'weather-full', name: 'Clima', size: { width: { mode: 'fixed', value: 580 }, height: { mode: 'fixed', value: 380 } }, props: { hours: 5, showSun: true, opensDrawer: true } },
    },
    {
        id: 'clock-header', name: 'Cabeçalho com relógio', description: 'Ícone, título, relógio e Personalizar',
        node: {
            id: 'h', type: 'stack', name: 'Cabeçalho', layout: { direction: 'horizontal', align: 'center', gap: 16 },
            size: { width: { mode: 'fixed', value: 1792 }, height: { mode: 'fixed', value: 64 } },
            children: [
                { id: 'i', type: 'icon', size: { width: { mode: 'fixed', value: 40 }, height: { mode: 'fixed', value: 40 } }, props: { name: 'tv', color: '$colors.accent', strokeWidth: 2 } },
                { id: 't', type: 'text', props: { text: 'Minha TV' }, text: { size: 34, weight: 800 } },
                { id: 's', type: 'spacer' },
                { id: 'c', type: 'clock-text', text: { size: 34, weight: 300 } },
            ],
        },
    },
    {
        id: 'settings-shortcut', name: 'Atalho: Configurações', description: 'Botão que abre as configurações do Fire TV',
        node: { id: 'b', type: 'button', name: 'Configurações', props: { label: '⚙ Configurações', action: { type: 'fire-settings' } }, text: { size: 24, weight: 600 } },
    },
    {
        id: 'amazon-shortcut', name: 'Atalho: Tela Amazon', description: 'Botão que abre a tela inicial da Amazon e a loja',
        node: { id: 'b', type: 'button', name: 'Tela Amazon', props: { label: '⌂ Tela Amazon', action: { type: 'amazon-home' } }, text: { size: 24, weight: 600 } },
    },
    {
        id: 'gradient', name: 'Gradiente', description: 'Faixa com degradê (sobreposição)',
        node: {
            id: 'g', type: 'frame', name: 'Gradiente', size: { width: { mode: 'fixed', value: 1920 }, height: { mode: 'fixed', value: 500 } },
            style: { background: { type: 'linear', angle: 180, stops: [{ color: 'rgba(0,0,0,0)', pos: 0 }, { color: 'rgba(4,6,12,0.9)', pos: 100 }] } },
            children: [],
        },
    },
    {
        id: 'bg-aurora', name: 'Fundo: Aurora', description: 'Fundo inteiro em degradê azul e violeta', fill: true,
        node: {
            id: 'f', type: 'frame', name: 'Fundo', children: [],
            style: { background: { type: 'linear', angle: 135, stops: [{ color: '#0b1a3a', pos: 0 }, { color: '#281a4f', pos: 50 }, { color: '#05060a', pos: 100 }] } },
        },
    },
    {
        id: 'bg-sunset', name: 'Fundo: Pôr do sol', description: 'Fundo inteiro em degradê quente', fill: true,
        node: {
            id: 'f', type: 'frame', name: 'Fundo', children: [],
            style: { background: { type: 'linear', angle: 160, stops: [{ color: '#3a1420', pos: 0 }, { color: '#1c0f24', pos: 55 }, { color: '#07060b', pos: 100 }] } },
        },
    },
    {
        id: 'bg-oled', name: 'Fundo: Preto OLED', description: 'Preto puro, bom para telas OLED', fill: true,
        node: { id: 'f', type: 'frame', name: 'Fundo', children: [], style: { background: { type: 'solid', color: '#000000' } } },
    },
];
