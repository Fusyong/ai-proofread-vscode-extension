import { describe, expect, it } from 'vitest';
import {
    parseReferencePrepPlan,
    extractFallbackGrepPatterns,
    extractFallbackSearchPhrases,
    buildReferencePrepUserPrompt,
} from './referencePrepPrompt';

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

    it('drops queries without dict, grep, wikipedia or web', () => {
        const raw = JSON.stringify({
            sufficient: true,
            queries: [{ queryId: 'q1', intent: 'general_fact', priority: 0.5 }],
            prune: [],
        });
        const plan = parseReferencePrepPlan(raw, [...intents]);
        expect(plan.queries).toHaveLength(0);
    });

    it('parses wikipedia block only', () => {
        const raw = JSON.stringify({
            sufficient: false,
            queries: [
                {
                    queryId: 'q2',
                    intent: 'general_fact',
                    priority: 0.9,
                    wikipedia: { searchTerms: ['李白'], lang: 'zh' },
                },
            ],
            prune: [],
        });
        const plan = parseReferencePrepPlan(raw, [...intents]);
        expect(plan.queries).toHaveLength(1);
        expect(plan.queries[0].wikipedia?.searchTerms).toEqual(['李白']);
        expect(plan.queries[0].wikipedia?.lang).toBe('zh');
    });

    it('parses web block only', () => {
        const raw = JSON.stringify({
            sufficient: false,
            queries: [
                {
                    queryId: 'q3',
                    intent: 'general_fact',
                    priority: 0.7,
                    web: { searchTerms: ['某史实'], why: '外网' },
                },
            ],
            prune: [],
        });
        const plan = parseReferencePrepPlan(raw, [...intents]);
        expect(plan.queries).toHaveLength(1);
        expect(plan.queries[0].web?.searchTerms).toEqual(['某史实']);
    });
});

describe('buildReferencePrepUserPrompt', () => {
    it('wraps search intent in dedicated tags', () => {
        const prompt = buildReferencePrepUserPrompt({
            target: '查找李白籍贯',
            dicts: [],
            corpusSummary: '',
            roundIndex: 0,
            maxRounds: 3,
            targetKind: 'search_intent',
        });
        expect(prompt).toContain('<search_intent>');
        expect(prompt).not.toContain('<target>');
    });

    it('wraps citation selection in dedicated tags', () => {
        const prompt = buildReferencePrepUserPrompt({
            target: '李白，字太白，号青莲居士。',
            dicts: [],
            corpusSummary: '',
            roundIndex: 0,
            maxRounds: 3,
            targetKind: 'citation_selection',
        });
        expect(prompt).toContain('<citation_selection>');
        expect(prompt).not.toContain('<target>');
    });
});

describe('extractFallbackGrepPatterns', () => {
    it('extracts quoted and book title fragments', () => {
        const p = extractFallbackGrepPatterns('据「史记」记载，《李白传》颇详。');
        expect(p).toContain('史记');
        expect(p).toContain('李白传');
    });
});

describe('extractFallbackSearchPhrases', () => {
    it('extracts heading and CJK name-like runs', () => {
        const text =
            '## 张大千\n\n张大千（1899—1983年），原名权，改名爰，字季爰，号大千，斋名大风堂。生于四川省内江。';
        const p = extractFallbackSearchPhrases(text);
        expect(p.some((x) => x.includes('张大千') || x === '张大千')).toBe(true);
        expect(p.length).toBeGreaterThan(0);
    });
});
