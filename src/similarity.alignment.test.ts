import { describe, expect, it } from 'vitest';
import { alignmentSimilarity, jaccardSimilarity } from './similarity';

const bigram = { n: 2, granularity: 'char' as const };

describe('alignmentSimilarity', () => {
    it('一端包含：<! 与 <！ 得 0.5，不把全半角折成同一个字符', () => {
        expect(jaccardSimilarity('<!', '<！', bigram)).toBe(0);
        expect(alignmentSimilarity('<!', '<！', bigram)).toBe(0.5);
    });

    it('一端包含同样承认公共后缀：<! 与 >! 也是 0.5', () => {
        expect(alignmentSimilarity('<!', '>!', bigram)).toBe(0.5);
    });

    it('两端包含：较短句的头和尾盖住整句', () => {
        const a = '南宋诗人、理学家。';
        const b = '南宋诗人。';
        expect(jaccardSimilarity(a, b, bigram)).toBeLessThan(0.4);
        expect(alignmentSimilarity(a, b, bigram)).toBe(1);
    });

    it('头尾合计占较短句的比例，不必盖住每一个字', () => {
        expect(alignmentSimilarity('#一〇六一年', '#一六〇一年', bigram)).toBeCloseTo(4 / 6, 5);
        expect(alignmentSimilarity('曾任南洋公学教习。', '曾任浙江大学堂教习。', bigram)).toBeCloseTo(5 / 9, 5);
    });

    it('无关短句不会因为多层而升高', () => {
        expect(alignmentSimilarity('苹果是一种水果。', '量子计算正在发展。', bigram)).toBeLessThan(0.4);
    });
});
