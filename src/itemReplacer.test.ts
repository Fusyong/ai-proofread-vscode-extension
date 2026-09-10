import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => ({
            get: (_k: string, def: unknown) => def,
        }),
    },
}));

import { applyItemReplacements, findOriginalSpanInSegment } from './itemReplacer';

describe('applyItemReplacements', () => {
    it('does not leave duplicate trailing quotes and periods after merge', () => {
        const text = '中华文化源远流长”。下一句';
        const result = applyItemReplacements(text, [
            { original: '源远流长', corrected: '源远流长”。' },
        ]);
        expect(result).toBe('中华文化源远流长”。下一句');
        expect(result).not.toContain('”。”。');
    });

    it('handles the reported leftover punctuation pattern with leading ellipsis', () => {
        const text = '……源远流长”。';
        const result = applyItemReplacements(text, [
            { original: '源远流长', corrected: '源远流长”。' },
        ]);
        expect(result).toBe('……源远流长”。');
    });

    it('when original includes trailing punctuation but quotes differ, still consumes the original punct', () => {
        const text = '……源远流长”。';
        const span = findOriginalSpanInSegment(text, '源远流长"。');
        expect(span).toEqual({ start: 2, end: text.length });
        const result = applyItemReplacements(text, [
            { original: '源远流长"。', corrected: '源远流长。”' },
        ]);
        expect(result).toBe('……源远流长。”');
    });

    it('keeps following punctuation that is not a duplicate of the replacement', () => {
        const text = '你好，世界';
        const result = applyItemReplacements(text, [{ original: '你好', corrected: '您好' }]);
        expect(result).toBe('您好，世界');
    });

    it('does not swallow a following comma when replacement ends with a period', () => {
        const text = '你好，世界';
        const result = applyItemReplacements(text, [{ original: '你好', corrected: '您好。' }]);
        expect(result).toBe('您好。，世界');
    });

    it('trims duplicate leading quotes on the left seam', () => {
        const text = '“好”坏';
        const result = applyItemReplacements(text, [{ original: '好', corrected: '“好”' }]);
        expect(result).toBe('“好”坏');
    });

    it('applies exact replacements', () => {
        const text = '这是错别字。';
        const result = applyItemReplacements(text, [{ original: '错别字', corrected: '错别字已改' }]);
        expect(result).toBe('这是错别字已改。');
    });

    it('matches ignoring internal whitespace and punctuation, expanding original trailing punct', () => {
        const text = '源远、流长”。完';
        const result = applyItemReplacements(text, [
            { original: '源远流长”。', corrected: '源远流长。”' },
        ]);
        expect(result).toBe('源远流长。”完');
    });

    it('applies items in order and only the first occurrence of each', () => {
        const text = '甲甲乙';
        const result = applyItemReplacements(text, [
            { original: '甲', corrected: 'A' },
            { original: '乙', corrected: 'B' },
        ]);
        expect(result).toBe('A甲B');
    });

    it('drops leftover period when quote and period order in corrected differs', () => {
        const text = '……源远流长”。';
        const result = applyItemReplacements(text, [
            { original: '源远流长', corrected: '源远流长。”' },
        ]);
        expect(result).toBe('……源远流长。”');
    });
});

describe('findOriginalSpanInSegment', () => {
    it('returns the exact substring when present', () => {
        const text = '……源远流长”。';
        expect(findOriginalSpanInSegment(text, '源远流长”。')).toEqual({
            start: 2,
            end: text.length,
        });
    });

    it('does not stop at the shortest punctuation-stripped window', () => {
        const text = '……源远流长”。';
        const span = findOriginalSpanInSegment(text, '源远流长”。');
        expect(text.slice(span!.start, span!.end)).toBe('源远流长”。');
    });
});
