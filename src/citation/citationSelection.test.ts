import { describe, expect, it } from 'vitest';
import { stripLeadingBlockquoteMarkers } from './stripBlockquote';

describe('stripLeadingBlockquoteMarkers', () => {
    it('strips leading > and whitespace from each line', () => {
        const raw = '> 春眠不觉晓，\n> 处处闻啼鸟。';
        expect(stripLeadingBlockquoteMarkers(raw)).toBe('春眠不觉晓，\n处处闻啼鸟。');
    });

    it('strips nested markers and leading blank', () => {
        const raw = '  >> 引文一行';
        expect(stripLeadingBlockquoteMarkers(raw)).toBe('引文一行');
    });

    it('leaves ordinary paragraphs unchanged except leading whitespace', () => {
        expect(stripLeadingBlockquoteMarkers('  李白乘舟将欲行')).toBe('李白乘舟将欲行');
    });
});
