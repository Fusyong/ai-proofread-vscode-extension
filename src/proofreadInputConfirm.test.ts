import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => ({
            get: (_key: string, defaultValue: unknown) => defaultValue
        })
    },
    window: {
        showInformationMessage: async () => undefined
    }
}));

import {
    buildBatchCriticalRiskLines,
    evaluateProofreadInputConfirm,
    formatConfirmTriggerReasons,
    SINGLE_REQUEST_OVERFLOW_CHARS,
    SINGLE_TARGET_OVERFLOW_CHARS,
    type ProofreadInputConfirmSettings
} from './proofreadInputConfirm';
import {
    estimateSingleRequestInputChars,
    findMaxJsonBatchItemStats,
    summarizeProofreadFieldStats
} from './tokenEstimate';

const baseSettings = (
    overrides: Partial<ProofreadInputConfirmSettings> = {}
): ProofreadInputConfirmSettings => ({
    mode: 'aboveThreshold',
    aboveChars: 100,
    byField: { target: 0, reference: 0, context: 0 },
    ...overrides
});

describe('evaluateProofreadInputConfirm', () => {
    const small = summarizeProofreadFieldStats('短', '', '');
    const largeTarget = summarizeProofreadFieldStats('甲'.repeat(200), '', '');

    it('never never confirms', () => {
        const r = evaluateProofreadInputConfirm(largeTarget, baseSettings({ mode: 'never' }));
        expect(r.shouldConfirm).toBe(false);
        expect(r.reasons).toEqual([]);
    });

    it('always always confirms', () => {
        const r = evaluateProofreadInputConfirm(small, baseSettings({ mode: 'always' }));
        expect(r.shouldConfirm).toBe(true);
        expect(r.reasons).toEqual([{ kind: 'always' }]);
    });

    it('aboveThreshold triggers on total', () => {
        const r = evaluateProofreadInputConfirm(
            largeTarget,
            baseSettings({ aboveChars: 100 })
        );
        expect(r.shouldConfirm).toBe(true);
        expect(r.reasons.some((x) => x.kind === 'total')).toBe(true);
    });

    it('aboveThreshold skips when under total and fields disabled', () => {
        const r = evaluateProofreadInputConfirm(
            small,
            baseSettings({ aboveChars: 10000 })
        );
        expect(r.shouldConfirm).toBe(false);
    });

    it('aboveThreshold triggers on field threshold', () => {
        const stats = summarizeProofreadFieldStats('短', '参考'.repeat(50), '');
        const r = evaluateProofreadInputConfirm(
            stats,
            baseSettings({
                aboveChars: 0,
                byField: { target: 0, reference: 20, context: 0 }
            })
        );
        expect(r.shouldConfirm).toBe(true);
        expect(r.reasons).toEqual([
            expect.objectContaining({ kind: 'field', field: 'reference' })
        ]);
    });

    it('counts additionalChars toward total threshold', () => {
        const r = evaluateProofreadInputConfirm(
            small,
            baseSettings({ aboveChars: 50 }),
            { additionalChars: 100 }
        );
        expect(r.shouldConfirm).toBe(true);
        expect(r.reasons[0]).toMatchObject({ kind: 'total', chars: 101 });
    });

    it('zero thresholds disable criteria', () => {
        const r = evaluateProofreadInputConfirm(
            largeTarget,
            baseSettings({
                aboveChars: 0,
                byField: { target: 0, reference: 0, context: 0 }
            })
        );
        expect(r.shouldConfirm).toBe(false);
    });
});

describe('formatConfirmTriggerReasons', () => {
    it('skips always and formats total/field', () => {
        const lines = formatConfirmTriggerReasons([
            { kind: 'always' },
            { kind: 'total', chars: 1000, threshold: 800 },
            { kind: 'field', field: 'target', chars: 500, threshold: 400 }
        ]);
        expect(lines).toHaveLength(2);
        expect(lines[0]).toContain('合计');
        expect(lines[1]).toContain('target');
    });
});

describe('buildBatchCriticalRiskLines', () => {
    it('always puts prompt first among risks', () => {
        const lines = buildBatchCriticalRiskLines({
            promptName: '系统默认提示词（full）',
            repetitionMode: 'none',
            maxItemContentChars: 100,
            maxItemIndex1: 1,
            maxItemRequestChars: 200
        });
        expect(lines[0]).toContain('关键风险');
        expect(lines[1]).toContain('提示词: 系统默认提示词（full）');
        expect(lines.some((l) => l.includes('单次输入长度超限'))).toBe(false);
    });

    it('highlights overflow and thinking', () => {
        const lines = buildBatchCriticalRiskLines({
            promptName: '条目校对',
            repetitionMode: 'all',
            thinkingEnabled: true,
            maxItemContentChars: 20000,
            maxItemIndex1: 3,
            maxItemRequestChars: SINGLE_REQUEST_OVERFLOW_CHARS
        });
        expect(lines.some((l) => l.includes('单次输入长度超限！！！'))).toBe(true);
        expect(lines.some((l) => l.includes('思考/推理模式已开启'))).toBe(true);
        expect(lines.some((l) => l.includes('提示词重复'))).toBe(true);
    });

    it('highlights single target overflow for equal-length output', () => {
        const lines = buildBatchCriticalRiskLines({
            promptName: '全文',
            repetitionMode: 'none',
            outputType: 'full',
            maxTargetChars: SINGLE_TARGET_OVERFLOW_CHARS,
            maxTargetIndex1: 2,
            targetOverflowChars: SINGLE_TARGET_OVERFLOW_CHARS,
            forBatch: true
        });
        expect(lines.some((l) => l.includes('单次target长度超限，等量输出时可能出错！！！'))).toBe(
            true
        );
        expect(lines.some((l) => l.includes('第 2 条'))).toBe(true);
        expect(lines.some((l) => l.includes('输出类型: 全文'))).toBe(true);
    });

    it('highlights target overflow for selection without item index', () => {
        const lines = buildBatchCriticalRiskLines({
            promptName: '全文',
            repetitionMode: 'none',
            outputType: 'full',
            maxTargetChars: 6000,
            targetOverflowChars: 5000,
            forBatch: false
        });
        expect(lines.some((l) => l.includes('单次target长度超限，等量输出时可能出错！！！'))).toBe(
            true
        );
        expect(lines.some((l) => l.includes('第 '))).toBe(false);
        expect(lines.some((l) => l.includes('target 6,000 字符') || l.includes('target 6000 字符'))).toBe(
            true
        );
    });
});

describe('findMaxJsonBatchItemStats', () => {
    it('picks the largest content item among requestable', () => {
        const max = findMaxJsonBatchItemStats([
            { target: '短', reference: '', context: '' },
            { target: '甲'.repeat(10), reference: '乙'.repeat(5), context: '' },
            { target: '  ', reference: '很长但不计' }
        ]);
        expect(max.index1).toBe(2);
        expect(max.contentChars).toBe(15);
        expect(max.targetChars).toBe(10);
    });

    it('tracks max target separately from max content', () => {
        const max = findMaxJsonBatchItemStats([
            { target: '甲'.repeat(20), reference: '', context: '' },
            { target: '乙'.repeat(5), reference: '丙'.repeat(30), context: '' }
        ]);
        expect(max.maxTargetIndex1).toBe(1);
        expect(max.maxTargetChars).toBe(20);
        expect(max.index1).toBe(2);
        expect(max.contentChars).toBe(35);
    });
});

describe('estimateSingleRequestInputChars', () => {
    it('applies repetition modes', () => {
        expect(estimateSingleRequestInputChars(100, 40, 50, 'none')).toBe(150);
        expect(estimateSingleRequestInputChars(100, 40, 50, 'target')).toBe(190);
        expect(estimateSingleRequestInputChars(100, 40, 50, 'all')).toBe(250);
    });
});
