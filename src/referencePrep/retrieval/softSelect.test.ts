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
});
