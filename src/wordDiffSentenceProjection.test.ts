/**
 * 词流反解句对 + alignDocuments 接线测试
 * 运行：npx vitest run src/wordDiffSentenceProjection.test.ts src/documentAligner.test.ts
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => ({
            get: (_key: string, defaultValue: unknown) => defaultValue
        })
    }
}));

import {
    detectSentenceReorder,
    projectSentencePairsFromWordDiff
} from './wordDiffSentenceProjection';
import { alignDocuments } from './documentAligner';

function pairs(textA: string, textB: string, threshold = 0.4) {
    return projectSentencePairsFromWordDiff(textA, textB, {
        similarityThreshold: threshold,
        removeInnerWhitespace: true,
        ngramGranularity: 'char',
        ngramSize: 1
    }).map(item => ({
        type: item.type,
        a: item.a?.trim(),
        b: item.b?.trim(),
        b_indices: item.b_indices,
        similarity: item.similarity
    }));
}

describe('projectSentencePairsFromWordDiff', () => {
    it('微调：反解出原句↔改句', () => {
        const a = '这是第一句话。这里有一处修改！Hello world, this is a test. 第三句话保持原样……';
        const b = '这是第一句话。这里做了一点点修改！Hello world, this is a modified test. 第三句话保持原样……';
        const r = pairs(a, b);

        expect(r.some(x => x.type === 'match' && x.a?.includes('这是第一句话') && x.b?.includes('这是第一句话'))).toBe(true);
        expect(r.some(x =>
            x.type === 'match' &&
            x.a?.includes('这里有一处修改') &&
            x.b?.includes('这里做了一点点修改')
        )).toBe(true);
        expect(r.some(x =>
            x.type === 'match' &&
            x.a?.includes('this is a test') &&
            x.b?.includes('modified test')
        )).toBe(true);
    });

    it('低相似门槛：无关句替换拆成 delete+insert', () => {
        const a = '苹果是一种水果。天空是蓝色的。';
        const b = '量子计算正在发展。天空是蓝色的。';
        const r = pairs(a, b, 0.4);
        expect(r.some(x => x.type === 'delete' && x.a?.includes('苹果'))).toBe(true);
        expect(r.some(x => x.type === 'insert' && x.b?.includes('量子'))).toBe(true);
        expect(r.some(x => x.type === 'match' && x.a?.includes('天空') && x.b?.includes('天空'))).toBe(true);
        expect(r.some(x => x.type === 'match' && x.a?.includes('苹果') && x.b?.includes('量子'))).toBe(false);
    });

    it('空白差异：仍能配成句对', () => {
        const a = '社  址在北京。渊源关 系十分密切。';
        const b = '社址在北京。渊源关系十分密切。';
        const r = pairs(a, b);
        expect(r.filter(x => x.type === 'match').length).toBeGreaterThanOrEqual(2);
        expect(r.every(x => x.type === 'match')).toBe(true);
    });

    it('一句拆两句：允许 1:n', () => {
        const a = '他去了北京然后立刻回来。';
        const b = '他去了北京。然后立刻回来。';
        const r = pairs(a, b);
        const m = r.find(x => x.type === 'match' && x.a?.includes('他去了北京'));
        expect(m).toBeTruthy();
        expect((m!.b ?? '').includes('北京') && (m!.b ?? '').includes('回来')).toBe(true);
    });

    it('detectSentenceReorder：句袋相同但顺序不同', () => {
        const a = ['第一句在原位。', '第二句稍后会被挪走。', '第三句末尾。'];
        const b = ['第一句在原位。', '第三句末尾。', '第二句稍后会被挪走。'];
        expect(detectSentenceReorder([], {}, a, b)).toBe(true);
        expect(detectSentenceReorder([], {}, a, a)).toBe(false);
    });

    it('detectSentenceReorder：同句既删又增', () => {
        const alignment = [
            { type: 'delete' as const, a: '第二句稍后会被挪走。' },
            { type: 'insert' as const, b: '第二句稍后会被挪走。' }
        ];
        expect(detectSentenceReorder(alignment)).toBe(true);
        expect(detectSentenceReorder([
            { type: 'delete' as const, a: '苹果。' },
            { type: 'insert' as const, b: '量子。' }
        ])).toBe(false);
    });
});

describe('alignDocuments', () => {
    it('anchor 为默认', () => {
        const r = alignDocuments('甲。乙。', '甲。乙。', { algorithm: 'anchor' });
        expect(r.usedAlgorithm).toBe('anchor');
        expect(r.fellBackToAnchor).toBe(false);
        expect(r.alignment.every(i => i.type === 'match')).toBe(true);
    });

    it('wordDiff 微调不回退', () => {
        const a = '这是第一句话。这里有一处修改！';
        const b = '这是第一句话。这里做了一点点修改！';
        const r = alignDocuments(a, b, {
            algorithm: 'wordDiff',
            similarityThreshold: 0.4,
            wordDiffFallbackToAnchor: true
        });
        expect(r.usedAlgorithm).toBe('wordDiff');
        expect(r.fellBackToAnchor).toBe(false);
        expect(r.alignment.some(i =>
            i.type === 'match' && (i.a ?? '').includes('这里有一处') && (i.b ?? '').includes('一点点')
        )).toBe(true);
    });

    it('wordDiff 调序时回退锚点', () => {
        const a = '第一句在原位。第二句稍后会被挪走。第三句末尾。';
        const b = '第一句在原位。第三句末尾。第二句稍后会被挪走。';
        const r = alignDocuments(a, b, {
            algorithm: 'wordDiff',
            similarityThreshold: 0.4,
            wordDiffFallbackToAnchor: true
        });
        expect(r.fellBackToAnchor).toBe(true);
        expect(r.usedAlgorithm).toBe('anchor');
        expect(r.alignment.some(i => i.type === 'movein' || i.type === 'moveout')).toBe(true);
    });

    it('关闭回退时调序不切换算法', () => {
        const a = '第一句在原位。第二句稍后会被挪走。第三句末尾。';
        const b = '第一句在原位。第三句末尾。第二句稍后会被挪走。';
        const r = alignDocuments(a, b, {
            algorithm: 'wordDiff',
            similarityThreshold: 0.4,
            wordDiffFallbackToAnchor: false
        });
        expect(r.usedAlgorithm).toBe('wordDiff');
        expect(r.fellBackToAnchor).toBe(false);
    });
});
