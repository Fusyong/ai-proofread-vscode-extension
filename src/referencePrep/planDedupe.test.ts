import { describe, expect, it } from 'vitest';
import {
    filterDuplicatePlanQueries,
    queryAnchorTerms,
    querySignature,
    queriesNearDuplicate,
} from './planDedupe';
import type { ReferencePrepPlan, ReferencePrepRound } from './schema';

function plan(queries: ReferencePrepPlan['queries']): ReferencePrepPlan {
    return { sufficient: false, queries, prune: [] };
}

describe('planDedupe', () => {
    it('builds stable exact signatures for same candidates order-insensitive', () => {
        const a = querySignature({
            queryId: 'q1',
            intent: 'entity_name',
            priority: 0.8,
            dict: { dictId: 'cihai7', candidates: ['李白（革命烈士）', '李白'] },
        });
        const b = querySignature({
            queryId: 'q2',
            intent: 'entity_name',
            priority: 0.5,
            dict: { dictId: 'other', candidates: ['李白', '李白（革命烈士）'] },
        });
        expect(a).toBe(b);
    });

    it('treats alias variants as near-duplicates', () => {
        const a = {
            queryId: 'q1',
            intent: 'entity_name' as const,
            priority: 1,
            dict: { dictId: 'cihai7', candidates: ['李白'] },
            grep: { patterns: ['李白', '李朴', '李侠'] },
        };
        const b = {
            queryId: 'q2',
            intent: 'entity_name' as const,
            priority: 1,
            dict: { dictId: 'cihai7', candidates: ['李白'] },
            grep: { patterns: ['李白', '李华初', '李侠'] },
        };
        expect(queryAnchorTerms(a)).toContain('李白');
        expect(queriesNearDuplicate(a, b)).toBe(true);
    });

    it('does not treat different intents as near-duplicates', () => {
        const a = {
            queryId: 'q1',
            intent: 'entity_name' as const,
            priority: 1,
            dict: { dictId: null, candidates: ['李白'] },
        };
        const b = {
            queryId: 'q2',
            intent: 'citation' as const,
            priority: 1,
            grep: { patterns: ['蜀道难', '李白'] },
        };
        expect(queriesNearDuplicate(a, b)).toBe(false);
    });

    it('drops near-duplicates against prior rounds', () => {
        const prior: ReferencePrepRound[] = [
            {
                roundId: 'r0',
                startedAt: '',
                plan: plan([
                    {
                        queryId: 'old',
                        intent: 'entity_name',
                        priority: 1,
                        dict: { dictId: null, candidates: ['李白'] },
                        grep: { patterns: ['李白', '李朴'] },
                    },
                    {
                        queryId: 'old2',
                        intent: 'general_fact',
                        priority: 0.6,
                        grep: { patterns: ['无线电', '电讯技术'] },
                    },
                ]),
                queryCount: 2,
            },
        ];
        const next = plan([
            {
                queryId: 'n1',
                intent: 'entity_name',
                priority: 1,
                dict: { dictId: null, candidates: ['李白'] },
                grep: { patterns: ['李白', '李华初'] },
            },
            {
                queryId: 'n2',
                intent: 'general_fact',
                priority: 0.6,
                grep: { patterns: ['李白 无线电', '李白 烈士'] },
            },
            {
                queryId: 'n3',
                intent: 'citation',
                priority: 1,
                grep: { patterns: ['蜀道难'] },
            },
        ]);
        const { plan: out, removed } = filterDuplicatePlanQueries(next, prior);
        expect(removed).toBe(2);
        expect(out.queries.map((q) => q.queryId)).toEqual(['n3']);
    });
});
