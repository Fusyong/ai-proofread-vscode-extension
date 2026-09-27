/**
 * 提示词任务类别（与 outputType 正交）：校对 / 翻译等入口过滤与校验。
 * 注意：本模块不依赖 PromptManager，避免循环引用。
 */

import type { ExtensionContext } from 'vscode';
import * as vscode from 'vscode';

export type PromptTask = 'proofread' | 'translate' | 'annotate' | 'restructure' | 'other';

export const PROMPT_TASK_LABELS: Record<PromptTask, string> = {
    proofread: '校对',
    translate: '翻译',
    annotate: '注释/加注',
    restructure: '重组',
    other: '其他',
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
};

export function normalizePromptTask(raw: unknown): PromptTask {
    const t = String(raw ?? '').trim();
    if (t === 'translate' || t === 'annotate' || t === 'restructure' || t === 'other' || t === 'proofread') {
        return t;
    }
    return 'proofread';
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
 * 入口与当前提示词 task 不一致时警告。
 * @returns true 表示可继续；false 表示用户取消
 */
export async function assertPromptMatchesEntry(
    context: ExtensionContext,
    entryTask: PromptTask,
    options?: { hard?: boolean }
): Promise<boolean> {
    const currentName = context.globalState.get<string>('currentPrompt', '') ?? '';
    const currentTask = resolvePromptTask(currentName);
    if (currentTask === entryTask) {
        return true;
    }
    const curLabel = PROMPT_TASK_LABELS[currentTask];
    const entryLabel = PROMPT_TASK_LABELS[entryTask];
    const promptLabel = currentName || '系统默认提示词（full）';
    if (options?.hard) {
        await vscode.window.showWarningMessage(
            `当前提示词「${promptLabel}」任务为「${curLabel}」，本入口要求「${entryLabel}」。请先在提示词侧栏选择匹配的提示词。`,
            { modal: true }
        );
        return false;
    }
    const choice = await vscode.window.showWarningMessage(
        `当前提示词「${promptLabel}」任务为「${curLabel}」，与本入口「${entryLabel}」不一致。仍要继续吗？`,
        { modal: true },
        '继续',
        '取消'
    );
    return choice === '继续';
}
