import { describe, expect, it } from 'vitest';
import {
    parseReferencePrepPlan,
    extractFallbackGrepPatterns,
    extractFallbackSearchPhrases,
    buildCorpusSummary,
    buildPriorPlansSummary,
    buildReferencePrepMultiRoundAddendum,
    buildReferencePrepUserPrompt,
} from './referencePrepPrompt';
import type { CorpusHit, ReferencePrepRound } from './schema';

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

    it('includes prior_plans when provided', () => {
        const prompt = buildReferencePrepUserPrompt({
            target: '李白',
            dicts: [],
            corpusSummary: 'coverage: active=1',
            roundIndex: 1,
            maxRounds: 3,
            priorPlansSummary: 'round 1 sufficient=false queries=1\n  q1 intent=entity_name dict=?[李白]',
        });
        expect(prompt).toContain('prior_plans');
        expect(prompt).toContain('q1 intent=entity_name');
        expect(prompt).toContain('round=2/3');
    });
});

describe('buildPriorPlansSummary / corpus coverage', () => {
    it('summarizes prior rounds', () => {
        const rounds: ReferencePrepRound[] = [
            {
                roundId: 'r1',
                startedAt: '',
                plan: {
                    sufficient: false,
                    queries: [
                        {
                            queryId: 'q1',
                            intent: 'entity_name',
                            priority: 0.9,
                            dict: { dictId: 'cihai7', candidates: ['李白'] },
                        },
                    ],
                    prune: [],
                },
                queryCount: 1,
            },
        ];
        const s = buildPriorPlansSummary(rounds);
        expect(s).toContain('round 1');
        expect(s).toContain('李白');
        expect(s).toContain('entity_name');
    });

    it('prefixes corpus summary with coverage', () => {
        const hits: CorpusHit[] = [
            {
                hitId: 'h1',
                source: 'dict',
                queryId: 'q1',
                baseValue: 1,
                aggregatedValue: 1,
                finalScore: 0.97,
                snippet: '李白（1910—1949）湖南浏阳人',
                digest: 'd1',
                referenceBlock: 'x',
                status: 'active',
                kind: 'evidence',
                dictId: 'cihai7',
                suggestedForExport: true,
            },
        ];
        const s = buildCorpusSummary(hits);
        expect(s).toContain('coverage:');
        expect(s).toContain('covered_entities:');
        expect(s).toContain('suggested=1');
        expect(s).toContain('hitId=h1');
    });

    it('multi-round addendum mentions prior_plans', () => {
        expect(buildReferencePrepMultiRoundAddendum()).toContain('prior_plans');
        expect(buildReferencePrepMultiRoundAddendum(true)).toContain('续跑模式');
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
