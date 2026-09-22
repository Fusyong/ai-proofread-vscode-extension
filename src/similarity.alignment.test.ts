import { describe, expect, it } from 'vitest';
import { alignmentSimilarity, jaccardSimilarity, normalizeForSimilarity } from './similarity';

const bigram = { n: 2, granularity: 'char' as const };

describe('alignmentSimilarity', () => {
    it('一端包含：<! 与 <！ 得 0.5，不把全半角折成同一个字符', () => {
        expect(jaccardSimilarity('<!', '<！', bigram)).toBe(0);
        expect(alignmentSimilarity('<!', '<！', bigram)).toBe(0.5);
    });

    it('一端包含同样承认公共后缀：<! 与 >! 也是 0.5', () => {
        expect(alignmentSimilarity('<!', '>!', bigram)).toBe(0.5);
    });

    it('两端包含按较长侧计分，仍可过默认阈值', () => {
        const a = '南宋诗人、理学家。';
        const b = '南宋诗人。';
        expect(jaccardSimilarity(a, b, bigram)).toBeLessThan(0.4);
        // 较短 5 字全被头尾盖住，分母为较长 9 → 5/9
        expect(alignmentSimilarity(a, b, bigram)).toBeCloseTo(5 / 9, 5);
        expect(alignmentSimilarity(a, b, bigram)).toBeGreaterThanOrEqual(0.4);
    });

    it('头尾合计占较长句的比例', () => {
        expect(alignmentSimilarity('#一〇六一年', '#一六〇一年', bigram)).toBeCloseTo(4 / 6, 5);
        // 覆盖 5，较长侧 10 → 0.5
        expect(alignmentSimilarity('曾任南洋公学教习。', '曾任浙江大学堂教习。', bigram)).toBeCloseTo(0.5, 5);
    });

    it('长句对短半截：按较长侧分母，不易抢锁', () => {
        const long = normalizeForSimilarity(
            '参考文献\n[1] 钱伟明、李国庆、袁芳等编著，《有机农业与有机食品》[M]，科学出版社，2009年，第2-19页。'
        );
        const short = normalizeForSimilarity('参考文献\n[1] 钱伟明, 李国庆, 袁芳, 等.');
        const s = alignmentSimilarity(long, short, bigram);
        expect(s).toBeLessThan(0.4);
    });

    it('无关短句不会因为多层而升高', () => {
        expect(alignmentSimilarity('苹果是一种水果。', '量子计算正在发展。', bigram)).toBeLessThan(0.4);
    });
});
