/**
 * 校对 LLM 调用前的输入体量确认：设置读取、阈值判定、模态弹窗。
 */

import * as vscode from 'vscode';
import {
    formatCharTokenLine,
    type FieldCharTokenStats,
    type JsonBatchContentStats
} from './tokenEstimate';

export type ProofreadConfirmMode = 'always' | 'aboveThreshold' | 'never';

export type ProofreadConfirmFieldThresholds = {
    target: number;
    reference: number;
    context: number;
};

export type ProofreadInputConfirmSettings = {
    mode: ProofreadConfirmMode;
    /** 合计字符阈值（含 optional additionalChars）；0 = 不按合计触发 */
    aboveChars: number;
    byField: ProofreadConfirmFieldThresholds;
};

export type ConfirmTriggerReason =
    | { kind: 'always' }
    | { kind: 'total'; chars: number; threshold: number }
    | {
          kind: 'field';
          field: keyof ProofreadConfirmFieldThresholds;
          chars: number;
          threshold: number;
      };

export type ProofreadInputConfirmEvaluation = {
    shouldConfirm: boolean;
    reasons: ConfirmTriggerReason[];
};

const FIELD_LABELS: Record<keyof ProofreadConfirmFieldThresholds, string> = {
    target: 'target',
    reference: 'reference',
    context: 'context'
};

/** 单次请求粗估字符数达到此值时，批量确认置顶「单次输入长度超限」 */
export const SINGLE_REQUEST_OVERFLOW_CHARS = 30000;

/** 单条 target 达到此值时，置顶「单次target长度超限，等量输出时可能出错」 */
export const SINGLE_TARGET_OVERFLOW_CHARS = 5000;

const DEFAULT_CONFIRM_MODE: ProofreadConfirmMode = 'aboveThreshold';
const DEFAULT_ABOVE_CHARS = 10000;
const DEFAULT_FIELD_THRESHOLDS: ProofreadConfirmFieldThresholds = {
    target: 5000,
    reference: 0,
    context: 0
};

const REPETITION_MODE_NAMES: Record<string, string> = {
    none: '不重复',
    target: '仅重复目标文档（target）',
    all: '重复完整对话流程（reference + context + target）'
};

function clampNonNegInt(n: unknown, fallback: number): number {
    const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : fallback;
    return v < 0 ? 0 : v;
}

/** 从工作区配置读取体量确认设置 */
export function getProofreadInputConfirmSettings(): ProofreadInputConfirmSettings {
    const config = vscode.workspace.getConfiguration('ai-proofread');
    const rawMode = config.get<string>('proofread.confirmMode', DEFAULT_CONFIRM_MODE);
    const mode: ProofreadConfirmMode =
        rawMode === 'aboveThreshold' || rawMode === 'never' || rawMode === 'always'
            ? rawMode
            : DEFAULT_CONFIRM_MODE;

    const byFieldRaw = config.get<Partial<ProofreadConfirmFieldThresholds>>(
        'proofread.confirmAboveCharsByField',
        {}
    );

    return {
        mode,
        aboveChars: clampNonNegInt(
            config.get('proofread.confirmAboveChars', DEFAULT_ABOVE_CHARS),
            DEFAULT_ABOVE_CHARS
        ),
        byField: {
            target: clampNonNegInt(byFieldRaw?.target, DEFAULT_FIELD_THRESHOLDS.target),
            reference: clampNonNegInt(byFieldRaw?.reference, DEFAULT_FIELD_THRESHOLDS.reference),
            context: clampNonNegInt(byFieldRaw?.context, DEFAULT_FIELD_THRESHOLDS.context)
        }
    };
}

/**
 * 判定是否需要弹出确认。
 * aboveThreshold：合计（含 additionalChars）或任一分字段达到对应阈值（阈值为 0 表示该项禁用）。
 */
export function evaluateProofreadInputConfirm(
    contentStats: JsonBatchContentStats,
    settings: ProofreadInputConfirmSettings,
    options?: { additionalChars?: number }
): ProofreadInputConfirmEvaluation {
    if (settings.mode === 'never') {
        return { shouldConfirm: false, reasons: [] };
    }
    if (settings.mode === 'always') {
        return { shouldConfirm: true, reasons: [{ kind: 'always' }] };
    }

    const reasons: ConfirmTriggerReason[] = [];
    const additional = Math.max(0, options?.additionalChars ?? 0);
    const totalChars = contentStats.total.chars + additional;

    if (settings.aboveChars > 0 && totalChars >= settings.aboveChars) {
        reasons.push({
            kind: 'total',
            chars: totalChars,
            threshold: settings.aboveChars
        });
    }

    for (const field of ['target', 'reference', 'context'] as const) {
        const threshold = settings.byField[field];
        const chars = contentStats[field].chars;
        if (threshold > 0 && chars >= threshold) {
            reasons.push({ kind: 'field', field, chars, threshold });
        }
    }

    return { shouldConfirm: reasons.length > 0, reasons };
}

export function formatConfirmTriggerReasons(reasons: ConfirmTriggerReason[]): string[] {
    const lines: string[] = [];
    for (const r of reasons) {
        if (r.kind === 'always') {
            continue;
        }
        if (r.kind === 'total') {
            lines.push(
                `   • 合计 ${r.chars.toLocaleString('zh-CN')} 字符 ≥ 阈值 ${r.threshold.toLocaleString('zh-CN')}`
            );
        } else {
            lines.push(
                `   • ${FIELD_LABELS[r.field]} ${r.chars.toLocaleString('zh-CN')} 字符 ≥ 阈值 ${r.threshold.toLocaleString('zh-CN')}`
            );
        }
    }
    return lines;
}

export function getRepetitionModeDisplayName(repetitionMode: string): string {
    return REPETITION_MODE_NAMES[repetitionMode] || '不重复';
}

export function getRepetitionTokenWarning(repetitionMode: string): string {
    if (repetitionMode === 'target') {
        return '   ⚠️ 提示词重复模式：仅重复 target，会增加输入 token';
    }
    if (repetitionMode === 'all') {
        return '   ⚠️ 提示词重复模式：重复完整对话流程，会增加输入 token';
    }
    return '';
}

export type ProofreadInputConfirmDialogParams = {
    title: string;
    /** 主说明行（文件路径、选区摘要等） */
    headerLines: string[];
    promptName: string;
    sourceCharacteristicsInjectSummary?: string;
    repetitionMode: string;
    platform: string;
    model: string;
    temperature: number;
    /** 批量专用 */
    batch?: {
        rpm: number;
        maxConcurrent: number;
        timeout: number;
        retryDelay: number;
        retryAttempts: number;
        totalCount: number;
        requestCount: number;
        /** 思考/推理是否开启（开启时强调计费与出错风险） */
        thinkingEnabled?: boolean;
        /** 最长单条内容字符数（T+R+C） */
        maxItemContentChars?: number;
        /** 最长单条所在 1-based 序号 */
        maxItemIndex1?: number;
        /** 最长单条粗估请求输入字符（含 prompt 与 repetition） */
        maxItemRequestChars?: number;
        /** 单条最大 target 字符数 */
        maxTargetChars?: number;
        /** target 最长条目的 1-based 序号 */
        maxTargetIndex1?: number;
        /** 全文等量输出时 target 超限警示阈值（默认与 confirmAboveCharsByField.target 一致） */
        targetOverflowChars?: number;
        /** 当前输出类型；full 时强调等量输出风险 */
        outputType?: 'full' | 'item';
    };
    /** 选区校对专用（关键风险区） */
    selection?: {
        targetChars: number;
        targetOverflowChars?: number;
        outputType?: 'full' | 'item';
        thinkingEnabled?: boolean;
        /** target+reference+context(+memory 已计入 contentStats 展示侧) */
        requestContentChars?: number;
        maxItemRequestChars?: number;
    };
    contentStats: JsonBatchContentStats;
    /** 覆盖「内容合计」展示（如含编辑记忆）；不参与字段阈值判定 */
    contentTotalForDisplay?: FieldCharTokenStats;
    promptOnce: FieldCharTokenStats;
    promptScaled: FieldCharTokenStats;
    estimatedInputTotal: FieldCharTokenStats;
    /** 编辑记忆等额外体量（不计入 target/reference/context） */
    extraFieldLines?: string[];
    triggerReasons: ConfirmTriggerReason[];
    confirmButtonLabel: string;
    footerNotes?: string[];
};

/** 构建确认置顶的关键风险行（选区与批量共用；提示词、target 超限、思考模式等） */
export function buildCriticalRiskLines(params: {
    promptName: string;
    sourceCharacteristicsInjectSummary?: string;
    repetitionMode: string;
    thinkingEnabled?: boolean;
    /** 批量专用：最长单条内容等 */
    maxItemContentChars?: number;
    maxItemIndex1?: number;
    maxItemRequestChars?: number;
    maxTargetChars?: number;
    /** 批量时为条目序号；选区可不传 */
    maxTargetIndex1?: number;
    targetOverflowChars?: number;
    outputType?: 'full' | 'item';
    overflowChars?: number;
    /** true 时使用批处理向思考模式文案 */
    forBatch?: boolean;
}): string[] {
    const overflowAt = params.overflowChars ?? SINGLE_REQUEST_OVERFLOW_CHARS;
    const targetOverflowAt = params.targetOverflowChars ?? SINGLE_TARGET_OVERFLOW_CHARS;
    const lines: string[] = [
        '🚨 关键风险（请先核对；易导致失败 / 管线中断 / 高计费）:',
        `   ★ 提示词: ${params.promptName}`
    ];
    if (params.sourceCharacteristicsInjectSummary !== undefined) {
        lines.push(`   ★ 源文本特性注入: ${params.sourceCharacteristicsInjectSummary}`);
    }
    if (params.outputType) {
        lines.push(
            `   ★ 输出类型: ${params.outputType === 'full' ? '全文（等量输出）' : '条目'}`
        );
    }

    const maxTarget = params.maxTargetChars ?? 0;
    const maxTargetIdx = params.maxTargetIndex1 ?? 0;
    if (maxTarget >= targetOverflowAt) {
        const where =
            maxTargetIdx > 0
                ? `最长约第 ${maxTargetIdx} 条 target ${maxTarget.toLocaleString('zh-CN')} 字符`
                : `target ${maxTarget.toLocaleString('zh-CN')} 字符`;
        lines.push(
            `   ★★★ 单次target长度超限，等量输出时可能出错！！！ ${where}（阈值 ${targetOverflowAt.toLocaleString('zh-CN')}）——全文等量回写易截断/失败`
        );
    }

    const maxReq = params.maxItemRequestChars ?? 0;
    const maxContent = params.maxItemContentChars ?? 0;
    const idx = params.maxItemIndex1 ?? 0;
    if (maxReq >= overflowAt && (idx > 0 || !params.forBatch)) {
        const where =
            idx > 0
                ? `最长约第 ${idx} 条，粗估单次输入 ${maxReq.toLocaleString('zh-CN')} 字符`
                : `粗估单次输入 ${maxReq.toLocaleString('zh-CN')} 字符`;
        lines.push(
            `   ★★★ 单次输入长度超限！！！ ${where}（内容 ${maxContent.toLocaleString('zh-CN')} + prompt/重复；阈值 ${overflowAt.toLocaleString('zh-CN')}）——极易 API 失败或截断`
        );
    } else if (params.forBatch && maxContent > 0 && idx > 0) {
        lines.push(
            `   ★ 最长单条: 第 ${idx} 条，内容 ${maxContent.toLocaleString('zh-CN')} 字符，粗估单次输入 ${maxReq.toLocaleString('zh-CN')} 字符`
        );
    }

    if (params.thinkingEnabled) {
        lines.push(
            params.forBatch
                ? '   ★★★ 思考/推理模式已开启：批处理极易出错并形成高计费！！！建议关闭后再跑批量'
                : '   ★★★ 思考/推理模式已开启：易增加耗时与计费，长文等量输出时更易出错'
        );
    }

    const repWarn = getRepetitionTokenWarning(params.repetitionMode);
    if (repWarn) {
        lines.push(repWarn.replace(/^   ⚠️/, '   ★'));
    }

    return lines;
}

/** @deprecated 使用 buildCriticalRiskLines；保留别名以免外部引用断裂 */
export const buildBatchCriticalRiskLines = buildCriticalRiskLines;

/** 构建并弹出模态确认；返回是否继续 */
export async function showProofreadInputConfirmDialog(
    params: ProofreadInputConfirmDialogParams
): Promise<boolean> {
    const repetitionModeName = getRepetitionModeDisplayName(params.repetitionMode);
    const reasonLines = formatConfirmTriggerReasons(params.triggerReasons);

    const criticalLines = params.batch
        ? buildCriticalRiskLines({
              promptName: params.promptName,
              sourceCharacteristicsInjectSummary: params.sourceCharacteristicsInjectSummary,
              repetitionMode: params.repetitionMode,
              thinkingEnabled: params.batch.thinkingEnabled,
              maxItemContentChars: params.batch.maxItemContentChars,
              maxItemIndex1: params.batch.maxItemIndex1,
              maxItemRequestChars: params.batch.maxItemRequestChars,
              maxTargetChars: params.batch.maxTargetChars,
              maxTargetIndex1: params.batch.maxTargetIndex1,
              targetOverflowChars: params.batch.targetOverflowChars,
              outputType: params.batch.outputType,
              forBatch: true
          })
        : buildCriticalRiskLines({
              promptName: params.promptName,
              sourceCharacteristicsInjectSummary: params.sourceCharacteristicsInjectSummary,
              repetitionMode: params.repetitionMode,
              thinkingEnabled: params.selection?.thinkingEnabled,
              maxItemContentChars: params.selection?.requestContentChars,
              maxItemRequestChars: params.selection?.maxItemRequestChars,
              maxTargetChars: params.selection?.targetChars,
              targetOverflowChars: params.selection?.targetOverflowChars,
              outputType: params.selection?.outputType,
              forBatch: false
          });

    const batchMetaLines = params.batch
        ? [
              `📊 总段落数: ${params.batch.totalCount}（将请求 ${params.batch.requestCount} 条）`,
              '',
              '⚙️ 处理参数:',
              `   • 提示词重复模式: ${repetitionModeName}`,
              `   • 平台: ${params.platform}`,
              `   • 模型: ${params.model}`,
              `   • 温度: ${params.temperature}`,
              `   • 并发数: ${params.batch.maxConcurrent}`,
              `   • 请求频率: ${params.batch.rpm} 次/分钟`,
              `   • 请求超时: ${params.batch.timeout} 秒`,
              `   • 重试间隔: ${params.batch.retryDelay} 秒`,
              `   • 重试次数: ${params.batch.retryAttempts} 次`
          ]
        : [
              '⚙️ 调用参数:',
              `   • 提示词重复模式: ${repetitionModeName}`,
              `   • 平台: ${params.platform}`,
              `   • 模型: ${params.model}`,
              `   • 温度: ${params.temperature}`
          ];

    const volumeLines = [
        '📏 内容体量（token 为粗估；不含提示词重复带来的加倍，单次超限见上方）:',
        formatCharTokenLine(
            params.batch ? 'prompt（单次）' : 'prompt',
            params.promptOnce
        ),
        params.batch
            ? formatCharTokenLine(`prompt×${params.batch.requestCount}`, params.promptScaled)
            : '',
        formatCharTokenLine('target', params.contentStats.target),
        formatCharTokenLine('reference', params.contentStats.reference),
        formatCharTokenLine('context', params.contentStats.context),
        ...(params.extraFieldLines ?? []),
        formatCharTokenLine(
            '内容合计',
            params.contentTotalForDisplay ?? params.contentStats.total
        ),
        formatCharTokenLine('预估输入合计', params.estimatedInputTotal)
    ];

    const defaultFooter = params.batch
        ? [
              'ℹ️ 其他说明:',
              '   • 处理过程中可以随时取消',
              '   • 已处理的段落会跳过',
              '   • 结果会实时保存到输出文件'
          ]
        : [
              'ℹ️ 其他说明:',
              '   • 取消则不发起本次校对请求'
          ];

    const confirmationMessage = [
        params.title,
        '',
        ...criticalLines,
        criticalLines.length ? '' : undefined,
        ...params.headerLines,
        params.headerLines.length ? '' : undefined,
        ...batchMetaLines,
        '',
        ...volumeLines,
        reasonLines.length ? '' : undefined,
        reasonLines.length ? '🚦 触发确认原因:' : undefined,
        ...reasonLines,
        '',
        ...(params.footerNotes ?? defaultFooter),
        '',
        params.batch ? '是否确认开始批量校对？' : '是否确认开始校对？'
    ]
        .filter((line): line is string => line !== undefined && line !== '')
        .join('\n');

    const result = await vscode.window.showInformationMessage(
        confirmationMessage,
        { modal: true },
        params.confirmButtonLabel
    );
    return result === params.confirmButtonLabel;
}

/** 低于阈值时跳过弹窗并返回 true；需要确认时弹窗并返回用户选择 */
export async function confirmProofreadInputIfNeeded(
    params: Omit<ProofreadInputConfirmDialogParams, 'triggerReasons'> & {
        settings?: ProofreadInputConfirmSettings;
        /** 计入合计阈值、但不计入 contentStats.total 的额外字符（如编辑记忆） */
        additionalCharsForThreshold?: number;
    }
): Promise<boolean> {
    const settings = params.settings ?? getProofreadInputConfirmSettings();
    const evaluation = evaluateProofreadInputConfirm(params.contentStats, settings, {
        additionalChars: params.additionalCharsForThreshold
    });
    if (!evaluation.shouldConfirm) {
        return true;
    }
    return showProofreadInputConfirmDialog({
        ...params,
        triggerReasons: evaluation.reasons
    });
}
