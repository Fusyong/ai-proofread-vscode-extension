/**
 * 提示词调度标注（与 outputType 正交）：并行 / 串行，用于入口过滤与侧栏展示。
 * 内部仍保留细粒度 PromptTask；展示层只区分并行|串行。
 * 注意：本模块不依赖 PromptManager，避免循环引用。
 */

import type { ExtensionContext } from 'vscode';
import * as vscode from 'vscode';

export type PromptTask = 'proofread' | 'translate' | 'annotate' | 'restructure' | 'other';

/** 调度方式：并行=校对管线；串行=翻译管线 */
export type PromptExecution = 'parallel' | 'serial';

/** @deprecated 仅兼容旧代码；用户可见请用 promptExecutionLabel */
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

export function promptExecutionOf(task: PromptTask): PromptExecution {
    return task === 'translate' ? 'serial' : 'parallel';
}

/** 用户可见：并行 | 串行 */
export function promptExecutionLabel(task: PromptTask): '并行' | '串行' {
    return promptExecutionOf(task) === 'serial' ? '串行' : '并行';
}

export function entryExecutionOf(entryTask: PromptTask): PromptExecution {
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
 * 入口工作流与当前提示词调度（并行/串行）不一致时警告。
 * 并行族（proofread/annotate/restructure/other）互认；串行仅 translate。
 * @returns true 表示可继续；false 表示用户取消
 */
export async function assertPromptMatchesEntry(
    context: ExtensionContext,
    entryTask: PromptTask,
    options?: { hard?: boolean }
): Promise<boolean> {
    const currentName = context.globalState.get<string>('currentPrompt', '') ?? '';
    const currentTask = resolvePromptTask(currentName);
    if (executionsMatch(currentTask, entryTask)) {
        return true;
    }
    const curExec = promptExecutionLabel(currentTask);
    const entryExec = promptExecutionLabel(entryTask);
    const promptLabel = currentName || '系统默认提示词（full）';
    const workflowHint =
        entryExec === '串行' ? '串行（翻译等）工作流' : '并行（校对等）工作流';
    if (options?.hard) {
        await vscode.window.showWarningMessage(
            `当前提示词「${promptLabel}」为「${curExec}」，本入口属于「${workflowHint}」（须「${entryExec}」提示词）。请先在提示词侧栏选择匹配的提示词。`,
            { modal: true }
        );
        return false;
    }
    const choice = await vscode.window.showWarningMessage(
        `当前提示词「${promptLabel}」为「${curExec}」，与「${workflowHint}」不一致。仍要继续吗？`,
        { modal: true },
        '继续',
        '取消'
    );
    return choice === '继续';
}
