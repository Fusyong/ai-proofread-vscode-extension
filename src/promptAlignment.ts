/**
 * 提示词对齐语义与批处理调度（与 PromptTask 细项、outputType 正交）。
 * - AlignmentKind：编辑（可 diff）| 转换（辅助对齐）
 * - ExecutionMode：并行 | 串行（批处理默认；选段另有入口）
 */

import type { ExtensionContext } from 'vscode';
import * as vscode from 'vscode';

export type AlignmentKind = 'edit' | 'convert';

/** 与 PromptTask 同形；此处自包含以免与 promptTask 循环依赖 */
type TaskHint = 'proofread' | 'translate' | 'annotate' | 'restructure' | 'other';

/** 批处理调度：并行 | 串行（选段入口不由此字段单独表达） */
export type ExecutionMode = 'parallel' | 'serial';

/** 转换类辅助对齐策略 */
export type ConvertAlignPolicy = {
    /** 模型是否输出原文（如 bitext &lt;s&gt;） */
    emitSource: boolean;
    /** 是否输出转换标记（如 &lt;term&gt;） */
    emitConvertMarkers: boolean;
    /** 未输出原文时用输入回填；默认 true，可关 */
    programBackfillSource: boolean;
};

export const DEFAULT_CONVERT_POLICY: ConvertAlignPolicy = {
    emitSource: false,
    emitConvertMarkers: false,
    programBackfillSource: true,
};

/** 图书翻译默认：输出原文 + 转换标记 */
export const BOOK_TRANSLATE_CONVERT_POLICY: ConvertAlignPolicy = {
    emitSource: true,
    emitConvertMarkers: true,
    programBackfillSource: true,
};

/** 预置存值 → 对齐类（可被配置 alignmentKind 覆盖） */
const PRESET_ALIGNMENT: Record<string, AlignmentKind> = {
    '': 'edit',
    __system_item__: 'edit',
    __preset_normalization_full__: 'edit',
    __preset_normalization_item__: 'edit',
    __preset_hard_issue_item__: 'edit',
    __preset_correspondence_check_item__: 'edit',
    __preset_pinyin_proofread_full__: 'edit',
    __preset_pinyin_annotation_full__: 'convert',
    __preset_knowledge_verify_item__: 'edit',
    __preset_knowledge_verify_full__: 'edit',
    __preset_para_restructure_full__: 'edit',
    __preset_book_translate_full__: 'convert',
    __preset_term_check_full__: 'convert',
};

/** 预置存值 → 批处理默认调度 */
const PRESET_EXECUTION: Record<string, ExecutionMode> = {
    '': 'parallel',
    __system_item__: 'parallel',
    __preset_normalization_full__: 'parallel',
    __preset_normalization_item__: 'parallel',
    __preset_hard_issue_item__: 'parallel',
    __preset_correspondence_check_item__: 'parallel',
    __preset_pinyin_proofread_full__: 'parallel',
    __preset_pinyin_annotation_full__: 'parallel',
    __preset_knowledge_verify_item__: 'parallel',
    __preset_knowledge_verify_full__: 'parallel',
    __preset_para_restructure_full__: 'parallel',
    __preset_book_translate_full__: 'serial',
    __preset_term_check_full__: 'serial',
};

function normalizeTaskHint(raw: unknown): TaskHint {
    const t = String(raw ?? '').trim();
    if (t === 'translate' || t === 'annotate' || t === 'restructure' || t === 'other' || t === 'proofread') {
        return t;
    }
    return 'proofread';
}

/** 由旧 task 推断对齐类（迁移缺省） */
export function alignmentKindFromTask(task: TaskHint | string): AlignmentKind {
    const t = normalizeTaskHint(task);
    return t === 'translate' || t === 'annotate' ? 'convert' : 'edit';
}

/** 由旧 task 推断批处理调度（迁移缺省） */
export function executionFromTask(task: TaskHint | string): ExecutionMode {
    return normalizeTaskHint(task) === 'translate' ? 'serial' : 'parallel';
}

export function normalizeAlignmentKind(raw: unknown): AlignmentKind | undefined {
    const t = String(raw ?? '').trim();
    if (t === 'edit' || t === 'convert') {
        return t;
    }
    return undefined;
}

export function normalizeExecutionMode(raw: unknown): ExecutionMode | undefined {
    const t = String(raw ?? '').trim();
    if (t === 'parallel' || t === 'serial') {
        return t;
    }
    return undefined;
}

export function normalizeConvertPolicy(
    raw: unknown,
    fallback: ConvertAlignPolicy = DEFAULT_CONVERT_POLICY
): ConvertAlignPolicy {
    if (!raw || typeof raw !== 'object') {
        return { ...fallback };
    }
    const o = raw as Record<string, unknown>;
    return {
        emitSource: typeof o.emitSource === 'boolean' ? o.emitSource : fallback.emitSource,
        emitConvertMarkers:
            typeof o.emitConvertMarkers === 'boolean' ? o.emitConvertMarkers : fallback.emitConvertMarkers,
        programBackfillSource:
            typeof o.programBackfillSource === 'boolean'
                ? o.programBackfillSource
                : fallback.programBackfillSource,
    };
}

type PromptConfigRow = {
    name: string;
    task?: string;
    alignmentKind?: string;
    execution?: string;
    convertPolicy?: ConvertAlignPolicy;
};

function findPromptConfig(storageName: string): PromptConfigRow | undefined {
    const config = vscode.workspace.getConfiguration('ai-proofread');
    const prompts = config.get<PromptConfigRow[]>('prompts', []) ?? [];
    return prompts.find((p) => p.name === storageName);
}

/** 解析提示词对齐类：显式字段 → 预置表 → 由 task 推断 */
export function resolveAlignmentKind(promptStorageName: string): AlignmentKind {
    if (Object.prototype.hasOwnProperty.call(PRESET_ALIGNMENT, promptStorageName)) {
        return PRESET_ALIGNMENT[promptStorageName]!;
    }
    const hit = findPromptConfig(promptStorageName);
    const explicit = normalizeAlignmentKind(hit?.alignmentKind);
    if (explicit) {
        return explicit;
    }
    return alignmentKindFromTask(hit?.task ?? 'proofread');
}

/** 解析批处理默认调度：显式字段 → 预置表 → 由 task 推断 */
export function resolveExecutionMode(promptStorageName: string): ExecutionMode {
    if (Object.prototype.hasOwnProperty.call(PRESET_EXECUTION, promptStorageName)) {
        return PRESET_EXECUTION[promptStorageName]!;
    }
    const hit = findPromptConfig(promptStorageName);
    const explicit = normalizeExecutionMode(hit?.execution);
    if (explicit) {
        return explicit;
    }
    return executionFromTask(hit?.task ?? 'proofread');
}

/** 解析转换策略；非 convert 时仍可返回默认（调用方按 kind 决定是否使用） */
export function resolveConvertPolicy(promptStorageName: string): ConvertAlignPolicy {
    if (promptStorageName === '__preset_book_translate_full__') {
        return { ...BOOK_TRANSLATE_CONVERT_POLICY };
    }
    if (Object.prototype.hasOwnProperty.call(PRESET_ALIGNMENT, promptStorageName)) {
        const kind = PRESET_ALIGNMENT[promptStorageName]!;
        return kind === 'convert' ? { ...DEFAULT_CONVERT_POLICY } : { ...DEFAULT_CONVERT_POLICY };
    }
    const hit = findPromptConfig(promptStorageName);
    const kind = resolveAlignmentKind(promptStorageName);
    const fallback =
        kind === 'convert' && hit?.name
            ? DEFAULT_CONVERT_POLICY
            : DEFAULT_CONVERT_POLICY;
    if (hit?.convertPolicy) {
        return normalizeConvertPolicy(hit.convertPolicy, fallback);
    }
    return { ...fallback };
}

export function alignmentKindLabel(kind: AlignmentKind): '编辑' | '转换' {
    return kind === 'convert' ? '转换' : '编辑';
}

export function executionModeLabel(mode: ExecutionMode): '并行' | '串行' {
    return mode === 'serial' ? '串行' : '并行';
}

export function getCurrentAlignmentKind(context: ExtensionContext): AlignmentKind {
    const name = context.globalState.get<string>('currentPrompt', '') ?? '';
    return resolveAlignmentKind(name);
}

export function getCurrentExecutionMode(context: ExtensionContext): ExecutionMode {
    const name = context.globalState.get<string>('currentPrompt', '') ?? '';
    return resolveExecutionMode(name);
}

/**
 * 入口要求的对齐类与当前提示词不一致时 hard 拒绝。
 * @returns true 可继续；false 已提示并应中止
 */
export async function assertAlignmentMatchesEntry(
    context: ExtensionContext,
    required: AlignmentKind
): Promise<boolean> {
    const currentName = context.globalState.get<string>('currentPrompt', '') ?? '';
    const current = resolveAlignmentKind(currentName);
    if (current === required) {
        return true;
    }
    const promptLabel = currentName || '系统默认提示词（full）';
    await vscode.window.showWarningMessage(
        `当前提示词「${promptLabel}」为「${alignmentKindLabel(current)}」，本入口要求「${alignmentKindLabel(required)}」提示词。请先在提示词侧栏选择匹配的提示词。`,
        { modal: true }
    );
    return false;
}

/**
 * 入口批处理调度与当前提示词默认 execution 不一致时警告。
 * @param hard 为 true 时拒绝继续（串行入口常用）
 */
export async function assertExecutionMatchesEntry(
    context: ExtensionContext,
    entryMode: ExecutionMode,
    options?: { hard?: boolean }
): Promise<boolean> {
    const currentName = context.globalState.get<string>('currentPrompt', '') ?? '';
    const current = resolveExecutionMode(currentName);
    if (current === entryMode) {
        return true;
    }
    const promptLabel = currentName || '系统默认提示词（full）';
    const entryLabel = executionModeLabel(entryMode);
    const curLabel = executionModeLabel(current);
    const workflowHint = entryMode === 'serial' ? '串行工作台' : '并行工作台';
    if (options?.hard) {
        await vscode.window.showWarningMessage(
            `当前提示词「${promptLabel}」批处理默认为「${curLabel}」，本入口属于「${workflowHint}」（须「${entryLabel}」）。请先在提示词侧栏选择匹配的提示词。`,
            { modal: true }
        );
        return false;
    }
    const choice = await vscode.window.showWarningMessage(
        `当前提示词「${promptLabel}」批处理默认为「${curLabel}」，与「${workflowHint}」不一致。仍要继续吗？`,
        { modal: true },
        '继续',
        '取消'
    );
    return choice === '继续';
}

/** @deprecated 兼容：由 task 得到展示用并行/串行；新代码请用 resolveExecutionMode */
export function promptExecutionOfTask(task: string): ExecutionMode {
    return executionFromTask(task);
}
