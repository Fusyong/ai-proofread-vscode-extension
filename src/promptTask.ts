/**
 * 提示词细项 PromptTask（业务预置标签）与调度兼容层。
 * 批处理调度（并行/串行）与对齐语义（编辑/转换）见 promptAlignment.ts；
 * 本模块保留 PromptTask 与旧入口校验，缺省时由 task 推断 execution。
 */

import type { ExtensionContext } from 'vscode';
import * as vscode from 'vscode';
import {
    assertExecutionMatchesEntry,
    executionFromTask,
    executionModeLabel,
    resolveExecutionMode,
    type ExecutionMode,
} from './promptAlignment';

export type PromptTask = 'proofread' | 'translate' | 'annotate' | 'restructure' | 'other';

/** @deprecated 使用 ExecutionMode（promptAlignment）；保留别名以免大范围改 import */
export type PromptExecution = ExecutionMode;

/** @deprecated 仅兼容旧代码；用户可见请用 executionModeLabel / promptExecutionLabel */
export const PROMPT_TASK_LABELS: Record<PromptTask, string> = {
    proofread: '并行',
    translate: '串行',
    annotate: '并行',
    restructure: '并行',
    other: '并行',
};

/** 与 promptManager 中 SYSTEM_PROMPT_NAME_* 存值一致 */
const PRESET_TASK: Record<string, PromptTask> = {
    '': 'proofread',
    __system_item__: 'proofread',
    __preset_normalization_full__: 'proofread',
    __preset_normalization_item__: 'proofread',
    __preset_hard_issue_item__: 'proofread',
    __preset_correspondence_check_item__: 'proofread',
    __preset_pinyin_proofread_full__: 'proofread',
    __preset_pinyin_annotation_full__: 'annotate',
    __preset_knowledge_verify_item__: 'proofread',
    __preset_knowledge_verify_full__: 'proofread',
    __preset_para_restructure_full__: 'restructure',
    __preset_book_translate_full__: 'translate',
    __preset_term_check_full__: 'translate',
};

export function normalizePromptTask(raw: unknown): PromptTask {
    const t = String(raw ?? '').trim();
    if (t === 'translate' || t === 'annotate' || t === 'restructure' || t === 'other' || t === 'proofread') {
        return t;
    }
    return 'proofread';
}

/**
 * 由 task 推断批处理调度（迁移缺省）。
 * 自定义提示词若配置了 execution，请用 resolveExecutionMode(storageName)。
 */
export function promptExecutionOf(task: PromptTask): ExecutionMode {
    return executionFromTask(task);
}

/** 用户可见：并行 | 串行（由 task 推断；优先用 resolveExecutionMode） */
export function promptExecutionLabel(task: PromptTask): '并行' | '串行' {
    return executionModeLabel(promptExecutionOf(task));
}

export function entryExecutionOf(entryTask: PromptTask): ExecutionMode {
    return promptExecutionOf(entryTask);
}

export function executionsMatch(a: PromptTask, b: PromptTask): boolean {
    return promptExecutionOf(a) === promptExecutionOf(b);
}

/** 内置/预置存值 → task；自定义从配置读取 */
export function resolvePromptTask(promptStorageName: string): PromptTask {
    if (Object.prototype.hasOwnProperty.call(PRESET_TASK, promptStorageName)) {
        return PRESET_TASK[promptStorageName]!;
    }
    const config = vscode.workspace.getConfiguration('ai-proofread');
    const prompts = config.get<Array<{ name: string; task?: string }>>('prompts', []) ?? [];
    const hit = prompts.find((p) => p.name === promptStorageName);
    return normalizePromptTask(hit?.task);
}

export function getCurrentPromptTask(context: ExtensionContext): PromptTask {
    const name = context.globalState.get<string>('currentPrompt', '') ?? '';
    return resolvePromptTask(name);
}

/**
 * 入口工作流与当前提示词批处理调度不一致时警告。
 * 优先按提示词的 execution（含显式配置）；不再仅用 translate≡串行硬绑。
 * @returns true 表示可继续；false 表示用户取消
 */
export async function assertPromptMatchesEntry(
    context: ExtensionContext,
    entryTask: PromptTask,
    options?: { hard?: boolean }
): Promise<boolean> {
    const entryMode = promptExecutionOf(entryTask);
    return assertExecutionMatchesEntry(context, entryMode, options);
}

/** 供侧栏等：按存值解析展示用调度标签 */
export function promptExecutionLabelForStorage(promptStorageName: string): '并行' | '串行' {
    return executionModeLabel(resolveExecutionMode(promptStorageName));
}
