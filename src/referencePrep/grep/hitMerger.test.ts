import { describe, expect, it } from 'vitest';
import { mergeGrepLineHits, type RawGrepLineHit } from './hitMerger';

describe('mergeGrepLineHits', () => {
    it('takes max pattern value per line', () => {
        const hits: RawGrepLineHit[] = [
            { file: 'a.md', line: 10, lineText: 'line10a', pattern: '李白', patternValue: 0.5 },
            { file: 'a.md', line: 10, lineText: 'line10b', pattern: '李太白', patternValue: 0.9 },
        ];
        const merged = mergeGrepLineHits(hits, { maxHits: 10 });
        expect(merged).toHaveLength(1);
        expect(merged[0].aggregatedValue).toBe(0.9);
    });

    it('merges nearby lines in same file', () => {
        const hits: RawGrepLineHit[] = [
            { file: 'b.md', line: 5, lineText: 'L5', pattern: 'x', patternValue: 0.6 },
            { file: 'b.md', line: 8, lineText: 'L8', pattern: 'x', patternValue: 0.7 },
        ];
        const merged = mergeGrepLineHits(hits, { maxHits: 10, proximityLines: 5 });
        expect(merged).toHaveLength(1);
        expect(merged[0].startLine).toBe(5);
        expect(merged[0].endLine).toBe(8);
    });

    it('sorts by value and truncates maxHits', () => {
        const hits: RawGrepLineHit[] = [
            { file: 'c.md', line: 1, lineText: 'low', pattern: 'a', patternValue: 0.2 },
            { file: 'c.md', line: 20, lineText: 'high', pattern: 'b', patternValue: 0.95 },
            { file: 'c.md', line: 40, lineText: 'mid', pattern: 'c', patternValue: 0.5 },
        ];
        const merged = mergeGrepLineHits(hits, { maxHits: 2 });
        expect(merged).toHaveLength(2);
        expect(merged[0].aggregatedValue).toBe(0.95);
        expect(merged[1].aggregatedValue).toBe(0.5);
    });
});
