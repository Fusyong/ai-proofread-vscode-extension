import { describe, expect, it } from 'vitest';
import { sanitizeDictControlChars, stripHtmlToText } from './htmlToText';
import { limitCleanText } from './dictLookupShared';

describe('dict text sanitization', () => {
    it('strips NUL from sanitizeDictControlChars', () => {
        expect(sanitizeDictControlChars('標記\u0000')).toBe('標記');
        expect(sanitizeDictControlChars('a\u0000b\u0001c')).toBe('abc');
    });

    it('stripHtmlToText removes trailing NUL from MDX-like definition', () => {
        const html = '<p>標明。</p>\u0000';
        expect(stripHtmlToText(html)).toBe('標明。');
        expect(stripHtmlToText(html).includes('\0')).toBe(false);
    });

    it('limitCleanText strips NUL before truncating', () => {
        const cleaned = limitCleanText('龍睛魚\u0000', 100);
        expect(cleaned).toBe('龍睛魚');
        expect(cleaned.includes('\0')).toBe(false);
    });
});
