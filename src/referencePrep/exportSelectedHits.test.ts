import { describe, expect, it } from 'vitest';
import type { CorpusHit } from './schema';
import {
    citationTextForDiff,
    formatGroupedHitsAsJsonDocument,
    formatGroupedHitsAsMarkdown,
    formatSelectedHitsAsMarkdown,
    literatureTextForDiff,
} from './exportSelectedHits';

function hit(partial: Partial<CorpusHit> & Pick<CorpusHit, 'hitId'>): CorpusHit {
    return {
        source: 'grep_md',
        queryId: 'q1',
        baseValue: 1,
        aggregatedValue: 1,
        snippet: partial.snippet ?? 'snip',
        digest: partial.digest ?? partial.hitId,
        referenceBlock: partial.referenceBlock ?? `block-${partial.hitId}`,
        status: 'active',
        ...partial,
    };
}

describe('exportSelectedHits grouped', () => {
    it('single group markdown has no heading', () => {
        const md = formatGroupedHitsAsMarkdown([
            { target: '李白', hits: [hit({ hitId: 'h1', referenceBlock: '甲' })] },
        ]);
        expect(md).toBe('甲');
        expect(md).toBe(formatSelectedHitsAsMarkdown([hit({ hitId: 'h1', referenceBlock: '甲' })]));
    });

    it('multi group markdown uses target headings', () => {
        const md = formatGroupedHitsAsMarkdown([
            { target: '李白', hits: [hit({ hitId: 'h1', referenceBlock: '甲' })] },
            { target: '杜甫', hits: [hit({ hitId: 'h2', referenceBlock: '乙' })] },
        ]);
        expect(md).toContain('## 李白');
        expect(md).toContain('甲');
        expect(md).toContain('## 杜甫');
        expect(md).toContain('乙');
    });

    it('multi group json is target/reference array', () => {
        const doc = formatGroupedHitsAsJsonDocument([
            { target: '李白', hits: [hit({ hitId: 'h1', referenceBlock: '甲' })] },
            { target: '杜甫', hits: [hit({ hitId: 'h2', referenceBlock: '乙' })] },
        ]);
        expect(Array.isArray(doc)).toBe(true);
        expect(doc).toEqual([
            { target: '李白', reference: '甲' },
            { target: '杜甫', reference: '乙' },
        ]);
    });

    it('single group json keeps { reference } shape', () => {
        const doc = formatGroupedHitsAsJsonDocument([
            { target: '李白', hits: [hit({ hitId: 'h1', referenceBlock: '甲' })] },
        ]);
        expect(doc).toEqual({ reference: '甲' });
    });
});

describe('hit text for diff', () => {
    it('uses userInput then targetPreview', () => {
        expect(citationTextForDiff({ userInput: '  天时不如地利  ', targetPreview: '短' })).toBe(
            '天时不如地利'
        );
        expect(citationTextForDiff({ targetPreview: '  地利  ' })).toBe('地利');
        expect(citationTextForDiff({})).toBe('');
    });

    it('strips grep wrapper and 文献摘录 header', () => {
        const text = literatureTextForDiff(
            hit({
                hitId: 'g1',
                snippet: 'truncated',
                referenceBlock:
                    '<!-- ai-proofread:grepHit begin sha1=abc -->\n【文献摘录】孟子.md:12\n\n天时不如地利，地利不如人和。\n<!-- ai-proofread:grepHit end -->',
            })
        );
        expect(text).toBe('天时不如地利，地利不如人和。');
    });

    it('strips dict wrapper and 本地词典 header', () => {
        const text = literatureTextForDiff(
            hit({
                hitId: 'd1',
                source: 'dict',
                snippet: 'short',
                referenceBlock:
                    '<!-- ai-proofread:localDictEntry begin sha1=abc -->\n【本地词典】汉语大词典｜人和\n\n人心所向。\n<!-- ai-proofread:localDictEntry end -->',
            })
        );
        expect(text).toBe('人心所向。');
    });

    it('strips wikipedia metadata and 摘录 prefix', () => {
        const text = literatureTextForDiff(
            hit({
                hitId: 'w1',
                source: 'wikipedia',
                snippet: 'short',
                referenceBlock:
                    '<!-- ai-proofread:wikipediaHit begin sha1=abc -->\n【维基百科·zh】孟子\nURL: https://zh.wikipedia.org/wiki/孟子\nWikidata: Q123\n摘录：孟子，名轲。\n<!-- ai-proofread:wikipediaHit end -->',
            })
        );
        expect(text).toBe('孟子，名轲。');
    });

    it('falls back to snippet when block is empty', () => {
        expect(
            literatureTextForDiff(
                hit({ hitId: 's1', snippet: '  片段  ', referenceBlock: '' })
            )
        ).toBe('片段');
    });
});
