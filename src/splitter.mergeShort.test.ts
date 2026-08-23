import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => ({
            get: (_key: string, defaultValue: unknown) => defaultValue
        })
    }
}));

import { getLeadingMarkdownHeadingLevel, mergeShortParagraphs, splitText } from './splitter';

describe('getLeadingMarkdownHeadingLevel', () => {
    it('reads ATX heading level from the first non-empty line', () => {
        expect(getLeadingMarkdownHeadingLevel('## 第一章')).toBe(2);
        expect(getLeadingMarkdownHeadingLevel('\n\n# 绪论\n正文')).toBe(1);
        expect(getLeadingMarkdownHeadingLevel('###### 附录')).toBe(6);
    });

    it('returns null when the head is not a heading', () => {
        expect(getLeadingMarkdownHeadingLevel('这是正文')).toBeNull();
        expect(getLeadingMarkdownHeadingLevel('#hashtag')).toBeNull();
        expect(getLeadingMarkdownHeadingLevel('')).toBeNull();
    });
});

describe('mergeShortParagraphs', () => {
    const minLength = 20;
    const levels = [2];
    const longA = 'A'.repeat(30);
    const longB = 'B'.repeat(30);
    const shortBody = '短正文';
    const shortH2 = '## 短节\n一两句';
    const shortH1 = '# 短编\n一两句';
    const shortH3 = '### 小节\n一两句';

    it('merges a short body leftover backward onto the previous fragment', () => {
        expect(mergeShortParagraphs([longA, shortBody, longB], minLength, levels)).toEqual([
            `${longA}\n${shortBody}`,
            longB,
        ]);
    });

    it('merges a short fragment starting with a split-level heading onto the following fragment', () => {
        expect(mergeShortParagraphs([longA, shortH2, longB], minLength, levels)).toEqual([
            longA,
            `${shortH2}\n${longB}`,
        ]);
    });

    it('merges a trailing short body leftover backward', () => {
        expect(mergeShortParagraphs([longA, shortBody], minLength, levels)).toEqual([
            `${longA}\n${shortBody}`,
        ]);
    });

    it('keeps a trailing short heading fragment standalone instead of merging backward', () => {
        expect(mergeShortParagraphs([longA, shortH2], minLength, levels)).toEqual([
            longA,
            shortH2,
        ]);
    });

    it('merges consecutive short heading fragments onto the next long fragment', () => {
        const shortH2b = '## 另一短节\n也短';
        expect(mergeShortParagraphs([shortH2, shortH2b, longA], minLength, levels)).toEqual([
            `${shortH2}\n${shortH2b}\n${longA}`,
        ]);
    });

    it('merges headings from level 1 down to the lowest split level onto the following fragment', () => {
        expect(mergeShortParagraphs([longA, shortH1, longB], minLength, levels)).toEqual([
            longA,
            `${shortH1}\n${longB}`,
        ]);
    });

    it('merges a heading deeper than the lowest split level backward onto the previous fragment', () => {
        expect(mergeShortParagraphs([longA, shortH3, longB], minLength, levels)).toEqual([
            `${longA}\n${shortH3}`,
            longB,
        ]);
    });

    it('falls back to merging forward when a backward short fragment has no predecessor', () => {
        expect(mergeShortParagraphs([shortBody, longA], minLength, levels)).toEqual([
            `${shortBody}\n${longA}`,
        ]);
    });

    it('joins trailing forward shorts into one piece', () => {
        const shortH2b = '## 另一短节\n也短';
        expect(mergeShortParagraphs([longA, shortH2, shortH2b], minLength, levels)).toEqual([
            longA,
            `${shortH2}\n${shortH2b}`,
        ]);
    });

    it('for split levels [2,4], merges headings 1–4 forward and deeper headings backward', () => {
        const shortH4 = '#### 细目\n一两句';
        const shortH5 = '##### 更细\n一两句';
        expect(mergeShortParagraphs([longA, shortH1, longB], minLength, [2, 4])).toEqual([
            longA,
            `${shortH1}\n${longB}`,
        ]);
        expect(mergeShortParagraphs([longA, shortH4, longB], minLength, [2, 4])).toEqual([
            longA,
            `${shortH4}\n${longB}`,
        ]);
        expect(mergeShortParagraphs([longA, shortH5, longB], minLength, [2, 4])).toEqual([
            `${longA}\n${shortH5}`,
            longB,
        ]);
        expect(mergeShortParagraphs([longA, shortH1, longB], minLength, [4, 2])).toEqual([
            longA,
            `${shortH1}\n${longB}`,
        ]);
        expect(mergeShortParagraphs([longA, shortH4, longB], minLength, [4, 2])).toEqual(
            mergeShortParagraphs([longA, shortH4, longB], minLength, [2, 4])
        );
    });
});

describe('splitText title-length merge direction', () => {
    it('does not attach a length-split leftover to the next heading section', () => {
        const body1 = '甲'.repeat(80);
        const leftover = '乙'.repeat(10);
        const body2 = '丙'.repeat(80);
        const text = `## 一\n\n${body1}\n\n${leftover}\n\n## 二\n\n${body2}\n`;
        const { segments } = splitText(text, {
            mode: 'title-length',
            levels: [2],
            threshold: 50,
            cutBy: 50,
            minLength: 40,
        });
        const joined = segments.map(s => s.target).join('\n---\n');
        expect(joined).toContain('乙');
        expect(segments.some(s => s.target.includes('乙') && s.target.includes('## 二'))).toBe(false);
        expect(segments.some(s => s.target.includes('乙') && s.target.includes('## 一'))).toBe(true);
    });
});

describe('splitText drops leading whitespace-only fragments', () => {
    const body = '正文内容若干字。';

    it.each([
        ['title', { mode: 'title' as const, levels: [2] }],
        ['length', { mode: 'length' as const, cutBy: 600 }],
        ['title-length', { mode: 'title-length' as const, levels: [2], threshold: 1000, cutBy: 600, minLength: 20 }],
        ['titleContext', { mode: 'titleContext' as const, levels: [2], cutBy: 600 }],
        ['paragraphContext', { mode: 'paragraphContext' as const, cutBy: 600, beforeParagraphs: 1, afterParagraphs: 1 }],
    ])('mode %s discards a blank preamble before the first heading/body', (_mode, options) => {
        const text = `\n\n   \n\n## 第一章\n\n${body}\n`;
        const { segments } = splitText(text, options);
        expect(segments.length).toBeGreaterThan(0);
        expect(segments[0].target.trim()).not.toBe('');
        expect(segments[0].target).toContain('第一章');
    });

    it('keeps a first fragment that has real text after leading newlines', () => {
        const { segments } = splitText(`\n\n${body}`, { mode: 'length', cutBy: 600 });
        expect(segments).toHaveLength(1);
        expect(segments[0].target).toContain(body);
    });
});
