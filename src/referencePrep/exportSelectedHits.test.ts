import { describe, expect, it } from 'vitest';
import type { CorpusHit } from './schema';
import {
    formatGroupedHitsAsJsonDocument,
    formatGroupedHitsAsMarkdown,
    formatSelectedHitsAsMarkdown,
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
