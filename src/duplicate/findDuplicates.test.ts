import { describe, expect, it, vi, beforeEach } from 'vitest';
import { findDuplicatesInText } from './findDuplicates';

vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => ({
            get: (_key: string, defaultValue: unknown) => defaultValue
        })
    }
}));

describe('findDuplicatesInText', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('detects exact duplicate sentences after normalization', () => {
        const text = '完全相同的句子在这里。完全相同的句子在这里。另一句。';
        const r = findDuplicatesInText({
            text,
            useSimpleSplitter: true,
            minCitationLength: 3,
            lenDeltaRatio: 0.2,
            similarityThreshold: 0.4,
            ngramSize: 1,
            ngramGranularity: 'char',
            cutMode: 'default',
            jieba: undefined,
            openccT2cnBeforeSimilarity: false,
            mode: 'exact'
        });
        expect(r.exactGroups.length).toBeGreaterThanOrEqual(1);
        const g = r.exactGroups.find((x) => x.occurrences.length >= 2);
        expect(g).toBeDefined();
        expect(g!.occurrences.length).toBe(2);
    });

    it('filters sentences shorter than minCitationLength', () => {
        const text = '好。好。';
        const r = findDuplicatesInText({
            text,
            useSimpleSplitter: true,
            minCitationLength: 5,
            lenDeltaRatio: 0.2,
            similarityThreshold: 0.4,
            ngramSize: 1,
            ngramGranularity: 'char',
            cutMode: 'default',
            jieba: undefined,
            openccT2cnBeforeSimilarity: false,
            mode: 'both'
        });
        expect(r.exactGroups.length).toBe(0);
        expect(r.fuzzyGroups.length).toBe(0);
    });

    it('fuzzy mode links similar but not identical sentences', () => {
        const text = '一二三四五六七八九十。一二三四五六七八十甲。';
        const r = findDuplicatesInText({
            text,
            useSimpleSplitter: true,
            minCitationLength: 4,
            lenDeltaRatio: 0.4,
            similarityThreshold: 0.45,
            ngramSize: 1,
            ngramGranularity: 'char',
            cutMode: 'default',
            jieba: undefined,
            openccT2cnBeforeSimilarity: false,
            mode: 'fuzzy'
        });
        expect(r.fuzzyGroups.length).toBeGreaterThanOrEqual(1);
    });
});
