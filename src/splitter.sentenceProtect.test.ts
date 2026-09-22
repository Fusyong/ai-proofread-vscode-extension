import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => ({
            get: (_key: string, defaultValue: unknown) => defaultValue
        })
    }
}));

import { mergeShortSentenceFragments, splitChineseSentencesSimple } from './splitter';

describe('splitChineseSentencesSimple period guards', () => {
    it('does not split file extension .md', () => {
        const text = '## 2011-T3-E01_浅谈中印思想的原始区别节选.md\n\n正文。';
        const sents = splitChineseSentencesSimple(text).map(s => s.trim()).filter(Boolean);
        expect(sents.some(s => s === 'md')).toBe(false);
        expect(sents.some(s => s.includes('节选.md'))).toBe(true);
    });

    it('does not split I.V. abbreviation dots', () => {
        const text = '出版法-汇编-中国-资格考试-自学参考资料 I.V.后文。';
        const sents = splitChineseSentencesSimple(text).map(s => s.trim()).filter(Boolean);
        expect(sents.some(s => s === 'V.')).toBe(false);
        expect(sents.some(s => s.includes('I.V.'))).toBe(true);
    });

    it('still splits normal English sentence end', () => {
        const text = 'Hello world. Next sentence.';
        const sents = splitChineseSentencesSimple(text, 0).map(s => s.trim()).filter(Boolean);
        expect(sents.length).toBeGreaterThanOrEqual(2);
    });
});

describe('mergeShortSentenceFragments', () => {
    it('merges short trailing fragment into previous', () => {
        const merged = mergeShortSentenceFragments(['长句子在这里。', 'II.'], 8);
        expect(merged).toEqual(['长句子在这里。II.']);
    });

    it('does not merge across markdown headings', () => {
        const merged = mergeShortSentenceFragments(['## 标题', '短'], 8);
        expect(merged[0]).toContain('## 标题');
        expect(merged.some(s => s.trim() === '短' || s.endsWith('短'))).toBe(true);
    });

    it('does not merge short complete Chinese sentences', () => {
        const merged = mergeShortSentenceFragments(['苹果是一种水果。', '天空是蓝色的。'], 8);
        expect(merged).toHaveLength(2);
        expect(merged[1].trim()).toBe('天空是蓝色的。');
    });
});
