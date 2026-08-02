import { describe, expect, it } from 'vitest';
import { selectDictEntries } from './dictSelect';

describe('selectDictEntries', () => {
    it('keeps primary then relevance then length', () => {
        const entries = [
            {
                dictId: 'primary',
                dictName: 'P',
                matchedKey: '李白',
                cleaned: 'short',
                digest: 'd1',
                block: 'b1',
                relevance: 0.5,
            },
            {
                dictId: 'primary',
                dictName: 'P',
                matchedKey: '李白',
                cleaned: 'longer primary entry text',
                digest: 'd2',
                block: 'b2',
                relevance: 0.5,
            },
            {
                dictId: 'other',
                dictName: 'O',
                matchedKey: '李白',
                cleaned: 'mid',
                digest: 'd3',
                block: 'b3',
                relevance: 0.9,
            },
            {
                dictId: 'other2',
                dictName: 'O2',
                matchedKey: '李白',
                cleaned: 'x'.repeat(200),
                digest: 'd4',
                block: 'b4',
                relevance: 0.1,
            },
        ];
        const picked = selectDictEntries(entries, 'primary', {
            maxEntriesPrimary: 1,
            maxEntriesRelevance: 1,
            maxEntriesLength: 1,
        });
        expect(picked.map((p) => p.digest)).toEqual(['d2', 'd3', 'd4']);
    });
});
