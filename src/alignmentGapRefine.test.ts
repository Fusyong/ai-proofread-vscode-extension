import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => ({
            get: (_key: string, defaultValue: unknown) => defaultValue
        })
    }
}));

import {
    absorbUnmatchedIntoMatches,
    refineAlignmentGaps,
    wordDiffEqualRatio
} from './alignmentGapRefine';
import { alignDocuments } from './documentAligner';
import { alignSentencesAnchor } from './sentenceAligner';
import { splitChineseSentencesSimple } from './splitter';

const anchorOpts = {
    similarityThreshold: 0.4,
    ngramSize: 2,
    ngramGranularity: 'char' as const,
    windowSize: 10
};

describe('wordDiffEqualRatio', () => {
    it('high overlap for near-identical bibliography text', () => {
        const a = '参考文献[1]钱伟明、李国庆、袁芳等编著，《有机农业与有机食品》[M]，科学出版社，2009年，第2-19页。';
        const b =
            '参考文献[1]钱伟明, 李国庆, 袁芳, 等.有机农业与有机食品[M].北京:科学出版社,2009:2-19。';
        expect(wordDiffEqualRatio(a, b)).toBeGreaterThanOrEqual(0.55);
    });

    it('near zero for unrelated true replace', () => {
        const a = '刘先生是近代著名教育家，曾创办多所学校。';
        const b = '胡适是新文化运动代表人物，提倡白话文。';
        expect(wordDiffEqualRatio(a, b)).toBeLessThan(0.3);
    });
});

describe('refineAlignmentGaps', () => {
    it('merges bilateral delete/insert gap into one match when equalRatio high', () => {
        const alignment = [
            {
                type: 'delete' as const,
                a: '参考文献[1]钱伟明、李国庆、袁芳等编著，《有机农业与有机食品》[M]，科学出版社，2009年，第2-19页。',
                a_index: 0
            },
            {
                type: 'insert' as const,
                b: '参考文献[1]钱伟明, 李国庆, 袁芳, 等.',
                b_index: 0
            },
            {
                type: 'insert' as const,
                b: '有机农业与有机食品[M].',
                b_index: 1
            },
            {
                type: 'insert' as const,
                b: '北京:科学出版社,2009:2-19。',
                b_index: 2
            }
        ];
        const refined = refineAlignmentGaps(alignment, { gapEqualRatio: 0.55 });
        expect(refined).toHaveLength(1);
        expect(refined[0].type).toBe('match');
        expect(refined[0].a_indices).toEqual([0]);
        expect(refined[0].b_indices).toEqual([0, 1, 2]);
    });

    it('keeps true replace as delete/insert when equalRatio low', () => {
        const alignment = [
            { type: 'delete' as const, a: '刘先生是近代著名教育家，曾创办多所学校。', a_index: 0 },
            { type: 'insert' as const, b: '胡适是新文化运动代表人物，提倡白话文。', b_index: 0 }
        ];
        const refined = refineAlignmentGaps(alignment, { gapEqualRatio: 0.55 });
        expect(refined.map(x => x.type)).toEqual(['delete', 'insert']);
    });
});

describe('absorbUnmatchedIntoMatches (N:1 半截抢配)', () => {
    it('absorbs preceding DELETE into MATCH when equalRatio rises', () => {
        const alignment = [
            {
                type: 'delete' as const,
                a: '数字技术的应用，推动了',
                a_index: 0
            },
            {
                type: 'match' as const,
                a: '传统媒体和新兴媒体的融合发展，形成了思想文化的传播能力。',
                b: '数字技术的应用，推动了传统媒体和新兴媒体的融合发展，提升了思想文化的传播能力。',
                similarity: 0.57,
                a_index: 1,
                b_index: 0
            }
        ];
        const refined = absorbUnmatchedIntoMatches(alignment);
        expect(refined).toHaveLength(1);
        expect(refined[0].type).toBe('match');
        expect(refined[0].a).toContain('数字技术的应用');
        expect(refined[0].a).toContain('传统媒体');
        expect(refined[0].similarity!).toBeGreaterThan(0.57);
        expect(refined[0].a_indices).toEqual([0, 1]);
    });

    it('absorbs deletes on both sides of a low-score MATCH', () => {
        const b =
            '媒体融合，既不是简单的传统媒体加上新兴媒体，也不是新兴媒体与传统媒体的嫁接；不是简单的“互联网+传统媒体”，也不是“传统媒体+互联网”。';
        const alignment = [
            { type: 'delete' as const, a: '媒体融合，既不是简单的传统媒', a_index: 0 },
            {
                type: 'match' as const,
                a: '体加上新兴媒体，也不是新兴媒体与传统媒体的嫁接；',
                b,
                similarity: 0.41,
                a_index: 1,
                b_index: 0
            },
            { type: 'delete' as const, a: '不是简单的“互联网+传统媒体”，', a_index: 2 },
            { type: 'delete' as const, a: '也不是“传统媒体+互联网”。', a_index: 3 }
        ];
        const refined = absorbUnmatchedIntoMatches(alignment);
        expect(refined).toHaveLength(1);
        expect(refined[0].type).toBe('match');
        expect(refined[0].a_indices).toEqual([0, 1, 2, 3]);
        expect(refined[0].similarity!).toBeGreaterThan(0.41);
    });

    it('does not absorb unrelated DELETE next to MATCH', () => {
        const alignment = [
            { type: 'delete' as const, a: '刘先生创办了学校。', a_index: 0 },
            {
                type: 'match' as const,
                a: '今天天气很好。',
                b: '今天天气很好。',
                similarity: 1,
                a_index: 1,
                b_index: 0
            }
        ];
        const refined = absorbUnmatchedIntoMatches(alignment);
        expect(refined.map(x => x.type)).toEqual(['delete', 'match']);
    });
});

describe('acceptance: bibliography 1:n via full pipeline', () => {
    it('钱伟明参考文献收成一条 MATCH，无半截 MATCH+双 INSERT', () => {
        const aBlock = [
            '杜绝食品安全隐患。',
            '参考文献',
            '[1] 钱伟明、李国庆、袁芳等编著，《有机农业与有机食品》[M]，科学出版社，2009年，第2-19页。',
            '',
            '## 下一篇'
        ].join('\n');
        const bBlock = [
            '杜绝食品安全隐患。',
            '',
            '参考文献',
            '[1] 钱伟明, 李国庆, 袁芳, 等. 有机农业与有机食品[M]. 北京: 科学出版社, 2009: 2-19.',
            '',
            '## 下一篇'
        ].join('\n');

        const { alignment } = alignDocuments(aBlock, bBlock, anchorOpts);
        const refItems = alignment.filter(
            x =>
                (x.a && x.a.includes('钱伟明')) ||
                (x.b && x.b.includes('钱伟明'))
        );
        expect(refItems.length).toBeGreaterThanOrEqual(1);
        const halfLock = refItems.some(
            x =>
                x.type === 'match' &&
                x.a &&
                x.a.includes('钱伟明') &&
                x.b &&
                x.b.includes('钱伟明') &&
                !x.b.includes('有机农业') &&
                !x.b.includes('科学出版社')
        );
        expect(halfLock).toBe(false);

        const matchedRef = refItems.find(
            x =>
                x.type === 'match' &&
                x.a?.includes('钱伟明') &&
                x.b?.includes('钱伟明') &&
                (x.b.includes('有机农业') || x.b.includes('科学出版社') || (x.b_indices?.length ?? 0) > 1)
        );
        expect(matchedRef).toBeTruthy();
    });
});

describe('acceptance: I.V. vs IV.', () => {
    it('整句一句对一句 MATCH，无孤立 V.', () => {
        const a = '出版法-汇编-中国-资格考试-自学参考资料 I.V.\n\n后文一句。';
        const b = '出版法-汇编-中国-资格考试-自学参考资料 IV.\n\n后文一句。';

        const sa = splitChineseSentencesSimple(a);
        expect(sa.some(s => s.trim() === 'V.')).toBe(false);
        expect(sa.some(s => s.includes('I.V.'))).toBe(true);

        const { alignment } = alignDocuments(a, b, anchorOpts);
        expect(alignment.some(x => x.type === 'delete' && x.a?.trim() === 'V.')).toBe(false);
        const pair = alignment.find(
            x =>
                x.type === 'match' &&
                x.a?.includes('出版法') &&
                x.b?.includes('出版法')
        );
        expect(pair).toBeTruthy();
        expect(pair!.a).toContain('I.V.');
        expect(pair!.b).toContain('IV.');
    });
});

describe('acceptance: true replace stays unmatched', () => {
    it('刘先生 vs 胡适 不被 gap 强行合并', () => {
        const sentencesA = [
            '前文完。',
            '刘先生是近代著名教育家，曾创办多所学校，影响深远。',
            '后文起。'
        ];
        const sentencesB = [
            '前文完。',
            '胡适是新文化运动代表人物，提倡白话文与思想解放。',
            '后文起。'
        ];
        const alignment = alignSentencesAnchor(sentencesA, sentencesB, anchorOpts);
        const mid = alignment.filter(
            x =>
                (x.a && x.a.includes('刘先生')) ||
                (x.b && x.b.includes('胡适'))
        );
        expect(mid.every(x => x.type === 'delete' || x.type === 'insert')).toBe(true);
        expect(mid.some(x => x.type === 'match')).toBe(false);
    });
});

describe('acceptance: N:1 fragment via full pipeline', () => {
    it('数字技术前半 DELETE 并入后半 MATCH', () => {
        const a = [
            '数字技术的应用，推动了',
            '',
            '传统媒体和新兴媒体的融合发展，形成了思想文化的传播能力。',
            '后文一句完。'
        ].join('\n');
        const b = [
            '数字技术的应用，推动了传统媒体和新兴媒体的融合发展，提升了思想文化的传播能力。',
            '后文一句完。'
        ].join('\n');
        const { alignment } = alignDocuments(a, b, anchorOpts);
        expect(
            alignment.some(
                x =>
                    x.type === 'delete' &&
                    (x.a ?? '').includes('数字技术的应用') &&
                    !(x.a ?? '').includes('传统媒体')
            )
        ).toBe(false);
        const m = alignment.find(
            x => x.type === 'match' && (x.a ?? '').includes('数字技术') && (x.b ?? '').includes('数字技术')
        );
        expect(m).toBeTruthy();
        expect((m!.a ?? '').includes('传统媒体')).toBe(true);
    });
});
