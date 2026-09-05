import { describe, expect, it } from 'vitest';
import {
    addStats,
    countRequestableItems,
    estimateTokenCount,
    formatCharTokenLine,
    scaleStats,
    statsFromText,
    summarizeJsonBatchContentStats,
    summarizeProofreadFieldStats
} from './tokenEstimate';

describe('estimateTokenCount', () => {
    it('returns 0 for empty', () => {
        expect(estimateTokenCount('')).toBe(0);
    });

    it('estimates CJK higher than Latin of same char length', () => {
        const cjk = estimateTokenCount('校对文本');
        const latin = estimateTokenCount('abcd');
        expect(cjk).toBeGreaterThan(latin);
        expect(cjk).toBe(Math.ceil(4 * 1.5));
    });
});

describe('summarizeProofreadFieldStats', () => {
    it('builds stats for a single item', () => {
        const stats = summarizeProofreadFieldStats('甲甲', '乙', '丙丙丙');
        expect(stats.target.chars).toBe(2);
        expect(stats.reference.chars).toBe(1);
        expect(stats.context.chars).toBe(3);
        expect(stats.total.chars).toBe(6);
    });
});

describe('summarizeJsonBatchContentStats', () => {
    it('sums target/reference/context across items', () => {
        const stats = summarizeJsonBatchContentStats([
            { target: '甲', reference: '乙乙', context: '丙丙丙' },
            { target: '丁', reference: '', context: undefined }
        ]);
        expect(stats.target.chars).toBe(2);
        expect(stats.reference.chars).toBe(2);
        expect(stats.context.chars).toBe(3);
        expect(stats.total.chars).toBe(7);
        expect(stats.total.tokens).toBe(
            stats.target.tokens + stats.reference.tokens + stats.context.tokens
        );
    });

    it('ignores non-string fields', () => {
        const stats = summarizeJsonBatchContentStats([{ target: 1, reference: null }]);
        expect(stats.total.chars).toBe(0);
    });
});

describe('formatCharTokenLine', () => {
    it('formats label with chars and tokens', () => {
        expect(formatCharTokenLine('target', { chars: 1000, tokens: 1500 })).toContain('target');
        expect(formatCharTokenLine('target', { chars: 1000, tokens: 1500 })).toContain('字符');
        expect(formatCharTokenLine('target', { chars: 1000, tokens: 1500 })).toContain('token');
    });
});

describe('prompt batch helpers', () => {
    it('statsFromText and scale/add for prompt×N', () => {
        const once = statsFromText('提示词');
        expect(once.chars).toBe(3);
        const batch = scaleStats(once, 10);
        expect(batch.chars).toBe(30);
        expect(batch.tokens).toBe(once.tokens * 10);
        expect(addStats(once, batch).chars).toBe(33);
    });

    it('countRequestableItems skips empty target', () => {
        expect(
            countRequestableItems([
                { target: '有' },
                { target: '  ' },
                { target: '' },
                { reference: '无 target' }
            ])
        ).toBe(1);
    });
});
