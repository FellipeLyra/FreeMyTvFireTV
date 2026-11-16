import { describe, expect, it } from 'vitest';
import { normalizeServer, describe as say, seen, labelOf } from '../src/lib/cloud';

describe('cloud client', () => {
    it('accepts https servers and adds https:// when missing', () => {
        expect(normalizeServer('https://tv.example.com/')).toBe('https://tv.example.com');
        expect(normalizeServer('tv.example.com')).toBe('https://tv.example.com');
        expect(normalizeServer(' https://example.com/fmtv/ ')).toBe('https://example.com/fmtv');
    });

    it('refuses plain http, except on this computer (local testing)', () => {
        expect(() => normalizeServer('http://tv.example.com')).toThrow(/https/);
        expect(() => normalizeServer('http://192.168.0.10:8787')).toThrow(/https/);
        expect(normalizeServer('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
        expect(normalizeServer('http://localhost:8787')).toBe('http://localhost:8787');
        expect(() => normalizeServer('ftp://x')).toThrow();
    });

    it('says what the TV reported in plain words', () => {
        expect(say({ op: 'render', ok: true, at: 0 })).toBe('aplicado e confirmado na TV');
        expect(say({ op: 'import', ok: false, error: 'SHA-256 não confere: a.jpg', at: 0 })).toMatch(/recusou o pacote: SHA-256/);
        expect(say({ op: 'rollback', ok: true, restored: 'previous', reason: 'o layout x falhou: y', at: 0 })).toMatch(/falhou na TV e ela voltou para o layout anterior/);
        expect(say({ op: 'rollback', ok: true, restored: 'default', reason: 'pedido pela internet', at: 0 })).toBe('a TV voltou para a tela original');
    });

    it('friendly names and "last seen"', () => {
        expect(labelOf({ model: 'AFTKA', name: '' })).toBe('Fire TV Stick 4K Max (AFTKA)');
        expect(labelOf({ model: 'XYZ', name: 'Amazon XYZ' })).toBe('Amazon XYZ');
        const now = Date.now();
        expect(seen(now - 10_000, now)).toBe('agora');
        expect(seen(now - 5 * 60_000, now)).toBe('há 5 min');
        expect(seen(null, now)).toBe('nunca');
    });
});
