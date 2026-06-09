import { describe, expect, it } from 'vitest';
import { summarizeSession, targetsMatch } from './continuationLogic';
import type { ReferencePrepProcessFileV020 } from './schema';

describe('targetsMatch', () => {
    it('matches normalized whitespace', () => {
        expect(targetsMatch('李白 生平', '李白\n生平')).toBe(true);
    });

    it('detects mismatch', () => {
        expect(targetsMatch('李白', '杜甫')).toBe(false);
    });

    it('treats empty stored as match', () => {
        expect(targetsMatch('', 'anything')).toBe(true);
        expect(targetsMatch(undefined, 'anything')).toBe(true);
    });
});

describe('summarizeSession', () => {
    it('counts active hits', () => {
        const proc: ReferencePrepProcessFileV020 = {
            version: '0.2.0',
            enabledSources: ['grep_md'],
            strength: 'standard',
            rounds: [{ roundId: 'r1', startedAt: '2020-01-01', plan: { sufficient: false, queries: [], prune: [] }, queryCount: 0 }],
            corpus: [
                {
                    hitId: 'h1',
                    source: 'grep_md',
                    queryId: 'q1',
                    baseValue: 0.8,
                    aggregatedValue: 0.8,
                    snippet: 'test',
                    digest: 'd1',
                    referenceBlock: 'block',
                    status: 'active',
                },
                {
                    hitId: 'h2',
                    source: 'grep_md',
                    queryId: 'q1',
                    baseValue: 0.2,
                    aggregatedValue: 0.2,
                    snippet: 'x',
                    digest: 'd2',
                    referenceBlock: 'block2',
                    status: 'pruned',
                },
            ],
            userInput: '李白',
            targetPreview: '李白',
        };
        const s = summarizeSession('/tmp/doc.md', proc);
        expect(s.activeHits).toBe(1);
        expect(s.roundCount).toBe(1);
    });
});
