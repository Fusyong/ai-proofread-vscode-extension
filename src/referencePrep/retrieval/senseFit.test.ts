import { describe, expect, it } from 'vitest';
import { senseFitScore } from './senseFit';

describe('senseFitScore', () => {
    const spyTarget =
        '李白被派赴上海开展地下情报工作。裘慧英做李白的妻子。红色电波为抗战立下功绩。';
    const poetTarget = '唐代著名诗人李白写有著名诗篇《蜀道难》，难于上青天。';

    it('prefers spy sense for modern target', () => {
        const spyHit = '李白（1910—1949）。湖南浏阳人。加入中国共产党。电台。烈士。';
        const poetHit = '李白（701—762）。唐诗人。字太白。蜀道难。';
        expect(senseFitScore(spyTarget, spyHit)).toBeGreaterThan(senseFitScore(spyTarget, poetHit));
    });

    it('prefers poet sense for classical target', () => {
        const spyHit = '李白（1910—1949）。情报人员。特工。';
        const poetHit = '李白（701—762）。唐诗人。太白。蜀道难。创作背景。';
        expect(senseFitScore(poetTarget, poetHit)).toBeGreaterThan(senseFitScore(poetTarget, spyHit));
    });
});
