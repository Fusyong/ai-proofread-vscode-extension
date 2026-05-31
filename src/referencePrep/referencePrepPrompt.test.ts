import { describe, expect, it } from 'vitest';
import { parseReferencePrepPlan, extractFallbackGrepPatterns } from './referencePrepPrompt';

describe('parseReferencePrepPlan', () => {
    const intents = ['entity_name', 'general_fact'] as const;

    it('parses sufficient and queries', () => {
        const raw = JSON.stringify({
            sufficient: false,
            queries: [
                {
                    queryId: 'q1',
                    intent: 'entity_name',
                    priority: 0.8,
                    dict: { dictId: 'd1', candidates: ['李白'] },
                },
            ],
            prune: [],
        });
        const plan = parseReferencePrepPlan(raw, [...intents]);
        expect(plan.sufficient).toBe(false);
        expect(plan.queries).toHaveLength(1);
        expect(plan.queries[0].dict?.candidates).toEqual(['李白']);
    });

    it('drops queries without dict or grep', () => {
        const raw = JSON.stringify({
            sufficient: true,
            queries: [{ queryId: 'q1', intent: 'general_fact', priority: 0.5 }],
            prune: [],
        });
        const plan = parseReferencePrepPlan(raw, [...intents]);
        expect(plan.queries).toHaveLength(0);
    });
});

describe('extractFallbackGrepPatterns', () => {
    it('extracts quoted and book title fragments', () => {
        const p = extractFallbackGrepPatterns('据「史记」记载，《李白传》颇详。');
        expect(p).toContain('史记');
        expect(p).toContain('李白传');
    });
});
