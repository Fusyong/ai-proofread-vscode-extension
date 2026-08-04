import { describe, expect, it } from 'vitest';
import { applySoftSelectToHits, capCandidateHitsPerQuery } from './softSelect';
import type { CorpusHit } from '../schema';

function hit(partial: Partial<CorpusHit> & { hitId: string; queryId: string }): CorpusHit {
    return {
        source: 'dict',
        baseValue: 0.5,
        aggregatedValue: 0.5,
        snippet: 's',
        digest: partial.hitId,
        referenceBlock: 'x'.repeat(100),
        status: 'active',
        kind: 'evidence',
        ...partial,
    };
}

describe('softSelect', () => {
    it('marks top scoring hits within caps', () => {
        const hits = [
            hit({ hitId: 'a', queryId: 'q1', finalScore: 0.9, referenceBlock: 'a'.repeat(100) }),
            hit({ hitId: 'b', queryId: 'q1', finalScore: 0.4, referenceBlock: 'b'.repeat(100) }),
            hit({ hitId: 'c', queryId: 'q1', finalScore: 0.2, referenceBlock: 'c'.repeat(100) }),
        ];
        applySoftSelectToHits(hits, {
            minSelectScore: 0.3,
            maxSelectedPerQuery: 2,
            maxSelectedCharsPerQuery: 10000,
        });
        expect(hits.find((h) => h.hitId === 'a')?.suggestedForExport).toBe(true);
        expect(hits.find((h) => h.hitId === 'b')?.suggestedForExport).toBe(true);
        expect(hits.find((h) => h.hitId === 'c')?.suggestedForExport).toBe(false);
    });

    it('caps candidates per query', () => {
        const hits = [
            hit({ hitId: 'a', queryId: 'q1', finalScore: 0.9 }),
            hit({ hitId: 'b', queryId: 'q1', finalScore: 0.8 }),
            hit({ hitId: 'c', queryId: 'q1', finalScore: 0.1 }),
        ];
        const capped = capCandidateHitsPerQuery(hits, 2);
        expect(capped.map((h) => h.hitId).sort()).toEqual(['a', 'b']);
    });

    it('does not suggest short noisy grep; strips time codes from long grep', () => {
        const shortSn =
            '8作者简介\n### 作品原文\n蜀道难①\n噫吁嚱②，危乎高哉！蜀道之难，难于上青天！\n02:42';
        const longSn = [
            '《蜀道难》是唐代大诗人李白的代表诗作。此诗袭用乐府旧题，以浪漫主义的手法，展开丰富的想象，艺术地再现了蜀道峥嵘。',
            '02:42',
            '蚕丛及鱼凫③，开国何茫然④！尔来四万八千岁，不与秦塞通人烟。西当太白有鸟道，可以横绝峨眉巅。',
        ].join('\n');
        const hits = [
            hit({
                hitId: 'noise',
                queryId: 'q1',
                source: 'grep_md',
                finalScore: 0.95,
                snippet: shortSn,
                referenceBlock:
                    '<!-- ai-proofread:grepHit begin sha1=a -->\n【文献摘录】f:1\n\n' +
                    shortSn +
                    '\n<!-- ai-proofread:grepHit end -->',
            }),
            hit({
                hitId: 'long',
                queryId: 'q1',
                source: 'grep_md',
                finalScore: 0.9,
                snippet: longSn,
                referenceBlock:
                    '<!-- ai-proofread:grepHit begin sha1=b -->\n【文献摘录】f:2\n\n' +
                    longSn +
                    '\n<!-- ai-proofread:grepHit end -->',
            }),
            hit({
                hitId: 'ok',
                queryId: 'q1',
                source: 'dict',
                finalScore: 0.65,
                referenceBlock: 'd'.repeat(80),
            }),
        ];
        applySoftSelectToHits(hits, {
            minSelectScore: 0.3,
            maxSelectedPerQuery: 3,
            maxSelectedCharsPerQuery: 10000,
        });
        expect(hits.find((h) => h.hitId === 'noise')?.suggestedForExport).toBe(false);
        expect(hits.find((h) => h.hitId === 'long')?.suggestedForExport).toBe(true);
        expect(hits.find((h) => h.hitId === 'long')?.snippet).not.toMatch(/02:42/);
        expect(hits.find((h) => h.hitId === 'ok')?.suggestedForExport).toBe(true);
    });

    it('boosts dict over long grep for entity_name', () => {
        const hits = [
            hit({
                hitId: 'grep',
                queryId: 'q1',
                source: 'grep_md',
                finalScore: 0.55,
                snippet: '李白此诗影响颇大。唐以前的《蜀道难》作品简短单薄，李白对乐府古题有所创新和发展。',
                referenceBlock: 'g'.repeat(200),
            }),
            hit({
                hitId: 'dict',
                queryId: 'q1',
                source: 'dict',
                finalScore: 0.5,
                referenceBlock: 'd'.repeat(80),
            }),
        ];
        applySoftSelectToHits(
            hits,
            {
                minSelectScore: 0.3,
                maxSelectedPerQuery: 1,
                maxSelectedCharsPerQuery: 10000,
            },
            {
                intentByQuery: new Map([['q1', 'entity_name']]),
            }
        );
        expect(hits.find((h) => h.hitId === 'dict')?.suggestedForExport).toBe(true);
        expect(hits.find((h) => h.hitId === 'grep')?.suggestedForExport).toBe(false);
    });
});
