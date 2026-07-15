import * as vscode from 'vscode';
import {
    PromptManager,
    SYSTEM_PROMPT_NAME_CORRESPONDENCE_CHECK_ITEM,
    SYSTEM_PROMPT_NAME_FULL,
    SYSTEM_PROMPT_NAME_HARD_ISSUE_ITEM,
    SYSTEM_PROMPT_NAME_ITEM,
    SYSTEM_PROMPT_NAME_KNOWLEDGE_VERIFY_FULL,
    SYSTEM_PROMPT_NAME_KNOWLEDGE_VERIFY_ITEM,
    SYSTEM_PROMPT_NAME_NORMALIZATION_FULL,
    SYSTEM_PROMPT_NAME_NORMALIZATION_ITEM,
    SYSTEM_PROMPT_NAME_PINYIN_ANNOTATION_FULL,
    SYSTEM_PROMPT_NAME_PINYIN_PROOFREAD_FULL,
    SYSTEM_PROMPT_NAME_PARA_RESTRUCTURE_FULL,
    getPromptDisplayName,
} from './promptManager';

const KEY_LAST_KV_PROMPT = 'ai-proofread.referencePrep.lastProofreadPrompt';

export interface ProofreadPromptPickOption {
    label: string;
    description?: string;
    storageName: string;
}

/** 与 prompts 侧栏一致的可选校对提示词（供知识核查等一次性选用） */
export function listProofreadPromptPickOptions(context: vscode.ExtensionContext): ProofreadPromptPickOption[] {
    const pm = PromptManager.getInstance(context);
    const custom = pm.getPrompts().map((p) => ({
        label: p.name,
        description: p.outputType === 'item' ? '条目' : p.outputType === 'other' ? '其他' : '全文',
        storageName: p.name,
    }));
    const builtins: ProofreadPromptPickOption[] = [
        {
            label: '知识核查（item）',
            description: '推荐 · 依据 reference 核查，条目输出',
            storageName: SYSTEM_PROMPT_NAME_KNOWLEDGE_VERIFY_ITEM,
        },
        {
            label: '知识核查（full）',
            description: '推荐 · 依据 reference 核查，全文输出',
            storageName: SYSTEM_PROMPT_NAME_KNOWLEDGE_VERIFY_FULL,
        },
        { label: '系统默认提示词（full）', description: '全文', storageName: SYSTEM_PROMPT_NAME_FULL },
        { label: '系统默认提示词（item）', description: '条目', storageName: SYSTEM_PROMPT_NAME_ITEM },
        {
            label: '表述正常化（full）',
            description: '全文',
            storageName: SYSTEM_PROMPT_NAME_NORMALIZATION_FULL,
        },
        {
            label: '表述正常化（item）',
            description: '条目',
            storageName: SYSTEM_PROMPT_NAME_NORMALIZATION_ITEM,
        },
        {
            label: '段内重组与重述（full）',
            description: '全文 · 理顺混乱段落，必要时可增删拆合段',
            storageName: SYSTEM_PROMPT_NAME_PARA_RESTRUCTURE_FULL,
        },
        { label: '硬伤发现（item）', description: '条目', storageName: SYSTEM_PROMPT_NAME_HARD_ISSUE_ITEM },
        {
            label: '对应关系核对（item）',
            description: '条目',
            storageName: SYSTEM_PROMPT_NAME_CORRESPONDENCE_CHECK_ITEM,
        },
        { label: '拼音审校（full）', description: '全文', storageName: SYSTEM_PROMPT_NAME_PINYIN_PROOFREAD_FULL },
        { label: '拼音加注（full）', description: '全文', storageName: SYSTEM_PROMPT_NAME_PINYIN_ANNOTATION_FULL },
    ];
    return [...builtins, ...custom];
}

export function loadLastKnowledgeVerifyProofreadPrompt(context: vscode.ExtensionContext): string {
    const last = context.workspaceState.get<string>(KEY_LAST_KV_PROMPT);
    if (last) return last;
    return SYSTEM_PROMPT_NAME_KNOWLEDGE_VERIFY_ITEM;
}

export async function saveLastKnowledgeVerifyProofreadPrompt(
    context: vscode.ExtensionContext,
    storageName: string
): Promise<void> {
    await context.workspaceState.update(KEY_LAST_KV_PROMPT, storageName);
}

export async function pickProofreadPromptForKnowledgeVerify(
    context: vscode.ExtensionContext
): Promise<string | undefined> {
    const options = listProofreadPromptPickOptions(context);
    const defaultName = loadLastKnowledgeVerifyProofreadPrompt(context);
    const picked = await vscode.window.showQuickPick(
        options.map((o) => ({
            ...o,
            picked: o.storageName === defaultName,
        })),
        {
            title: '选择校对提示词（阶段 B）',
            placeHolder: `默认：${getPromptDisplayName(defaultName)}`,
            ignoreFocusOut: true,
        }
    );
    if (!picked) return undefined;
    await saveLastKnowledgeVerifyProofreadPrompt(context, picked.storageName);
    return picked.storageName;
}

/** 临时切换 currentPrompt 执行 fn，结束后恢复 */
export async function withTemporaryProofreadPrompt<T>(
    context: vscode.ExtensionContext,
    storageName: string,
    fn: () => Promise<T>
): Promise<T> {
    const pm = PromptManager.getInstance(context);
    const previous = pm.getCurrentPromptName();
    await pm.setCurrentPrompt(storageName);
    try {
        return await fn();
    } finally {
        await pm.setCurrentPrompt(previous);
    }
}
