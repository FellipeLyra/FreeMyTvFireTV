// Starting point for customizing each screen: the launcher's original arrangement,
// rebuilt with its real widgets, so "Personalizar esta tela" changes nothing until
// the user edits it.
import type { LayoutNode } from './types';

export interface PageDef {
    root: LayoutNode;
    panel?: { placement?: string; width?: number; height?: number };
}

export const PAGE_HINTS: Record<string, string> = {
    weather: 'Painel aberto pelo widget de clima. OK ou Voltar fecham.',
    settings: 'Janela Personalizar (tecla ≡). Preferências e botões Salvar/Cancelar são obrigatórios.',
    screensaver: 'Aparece depois de 3 minutos sem uso. O relógio muda de lugar sozinho para proteger telas OLED.',
    messages: 'Aviso rápido (ex.: "Abrindo Netflix…"). Só o visual e a posição mudam.',
};

export function defaultPage(pid: string): PageDef | null {
    switch (pid) {
        case 'weather':
            return {
                panel: { placement: 'right', width: 460 },
                root: {
                    id: 'weather-root', type: 'stack', name: 'Painel de clima',
                    layout: { direction: 'vertical', gap: 20, align: 'stretch' },
                    children: [
                        { id: 'weather-header', type: 'weather.header' },
                        { id: 'weather-current', type: 'weather.current' },
                        { id: 'weather-hourly', type: 'weather.hourly' },
                        { id: 'weather-sun', type: 'weather.sun' },
                        { id: 'weather-close', type: 'weather.close' },
                    ],
                },
            };
        case 'settings':
            return {
                panel: { placement: 'center', width: 960 },
                root: {
                    id: 'settings-root', type: 'stack', name: 'Janela Personalizar',
                    layout: { direction: 'vertical', gap: 22, align: 'stretch' },
                    children: [
                        { id: 'settings-header', type: 'settings.header' },
                        { id: 'settings-apps', type: 'settings.apps' },
                        { id: 'settings-preferences', type: 'settings.preferences' },
                        { id: 'settings-actions', type: 'settings.actions' },
                    ],
                },
            };
        case 'screensaver':
            return {
                root: {
                    id: 'screensaver-root', type: 'stack', name: 'Protetor de tela',
                    style: { background: { type: 'solid', color: '#000000' } },
                    layout: { direction: 'vertical', justify: 'center', align: 'center' },
                    children: [{ id: 'screensaver-clock', type: 'screensaver.clock', props: { showDate: true, clockSize: 132, dateSize: 22 } }],
                },
            };
        case 'messages':
            return {
                panel: { placement: 'top-right' },
                root: {
                    id: 'message', type: 'frame', name: 'Mensagem',
                    style: { background: { type: 'solid', color: 'rgba(20,24,35,0.92)' }, radius: 14, border: { width: 1, color: 'rgba(255,255,255,0.22)' }, blur: 25 },
                    text: { size: 14, weight: 600 },
                    layout: { padding: [12, 20, 12, 20] },
                },
            };
    }
    return null;
}
