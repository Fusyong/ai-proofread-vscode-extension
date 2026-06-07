import { describe, expect, it } from 'vitest';
import {
    getHitsForRoundQuery,
    getQueryIdsWithHits,
    roundHasVisibleHits,
} from './referencePrepResultsTree';
import type { ReferencePrepProcessFileV020 } from './schema';

function proc(partial: Partial<ReferencePrepProcessFileV020>): ReferencePrepProcessFileV020 {
    return {
        version: '0.2',
        corpus: [],
        rounds: [],
        ...partial,
    } as ReferencePrepProcessFileV020;
}

describe('referencePrepResultsTree', () => {
    it('only attributes orphan hits to first round with same queryId', () => {
        const p = proc({
            rounds: [
                {
                    roundId: 'r1',
                    startedAt: 't1',
                    plan: { sufficient: false, queries: [{ queryId: 'q2', intent: 'term_norm', priority: 0.5 }], prune: [] },
                    queryCount: 1,
                },
                {
                    roundId: 'r2',
                    startedAt: 't2',
                    plan: { sufficient: false, queries: [{ queryId: 'q2', intent: 'term_norm', priority: 0.5 }], prune: [] },
                    queryCount: 1,
                },
            ],
            corpus: [
                {
                    hitId: 'h1',
                    source: 'dict',
                    queryId: 'q2',
                    baseValue: 1,
                    aggregatedValue: 1,
                    snippet: '地支',
                    digest: 'd',
                    referenceBlock: 'block',
                    status: 'active',
                },
            ],
        });
        expect(getHitsForRoundQuery(p, 0, 'q2')).toHaveLength(1);
        expect(getHitsForRoundQuery(p, 1, 'q2')).toHaveLength(0);
        expect(getQueryIdsWithHits(p, p.rounds[1], 1)).toEqual([]);
        expect(roundHasVisibleHits(p, 0)).toBe(true);
        expect(roundHasVisibleHits(p, 1)).toBe(false);
    });

    it('strict roundId match when hit has roundId', () => {
        const p = proc({
            rounds: [
                {
                    roundId: 'r1',
                    startedAt: 't1',
                    plan: { sufficient: false, queries: [{ queryId: 'q2', intent: 'x', priority: 0.5 }], prune: [] },
                    queryCount: 1,
                },
                {
                    roundId: 'r2',
                    startedAt: 't2',
                    plan: { sufficient: false, queries: [{ queryId: 'q2', intent: 'x', priority: 0.5 }], prune: [] },
                    queryCount: 1,
                },
            ],
            corpus: [
                {
                    hitId: 'h1',
                    source: 'dict',
                    queryId: 'q2',
                    roundId: 'r2',
                    baseValue: 1,
                    aggregatedValue: 1,
                    snippet: 'hit',
                    digest: 'd',
                    referenceBlock: 'b',
                    status: 'active',
                },
            ],
        });
        expect(getHitsForRoundQuery(p, 0, 'q2')).toHaveLength(0);
        expect(getQueryIdsWithHits(p, p.rounds[0], 0)).toEqual([]);
        expect(getQueryIdsWithHits(p, p.rounds[1], 1)).toEqual(['q2']);
    });
});
