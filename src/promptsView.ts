/**
 * 提示词 TreeView：单选（当前）、新建、编辑、删除
 * 仿照字词检查的检查项目管理，仅能选一条为当前。
 */

import * as vscode from 'vscode';
import {
    PromptManager,
    SYSTEM_PROMPT_NAME_FULL,
    SYSTEM_PROMPT_NAME_ITEM,
    SYSTEM_PROMPT_NAME_NORMALIZATION_FULL,
    SYSTEM_PROMPT_NAME_NORMALIZATION_ITEM,
    SYSTEM_PROMPT_NAME_HARD_ISSUE_ITEM,
    SYSTEM_PROMPT_NAME_CORRESPONDENCE_CHECK_ITEM,
    SYSTEM_PROMPT_NAME_PINYIN_PROOFREAD_FULL,
    SYSTEM_PROMPT_NAME_PINYIN_ANNOTATION_FULL,
    SYSTEM_PROMPT_NAME_KNOWLEDGE_VERIFY_ITEM,
    SYSTEM_PROMPT_NAME_KNOWLEDGE_VERIFY_FULL,
} from './promptManager';
import type { Prompt } from './promptManager';

export const PROMPTS_VIEW_ID = 'ai-proofread.prompts';

/** 系统默认（全文）在树中的 id */
const SYSTEM_FULL_ITEM_ID = '__system__';
/** 系统默认（条目式）在树中的 id */
const SYSTEM_ITEM_ITEM_ID = '__system_item__';

export interface PromptTreeItem {
    /** 系统项为 __system__ / __system_item__，否则为 prompt.name */
    id: string;
    label: string;
    prompt?: Prompt;
    /** 系统全文 / 系统条目，用于 description */
    systemOutputType?: 'full' | 'item';
}

export class PromptsTreeDataProvider implements vscode.TreeDataProvider<PromptTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(
        private context: vscode.ExtensionContext,
        private promptManager: PromptManager
    ) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getChildren(_element?: PromptTreeItem): PromptTreeItem[] {
        const prompts = this.promptManager.getPrompts();
        const items: PromptTreeItem[] = [
            { id: SYSTEM_FULL_ITEM_ID, label: '系统默认提示词（full）', systemOutputType: 'full' },
            { id: SYSTEM_ITEM_ITEM_ID, label: '系统默认提示词（item）', systemOutputType: 'item' },
            {
                id: SYSTEM_PROMPT_NAME_NORMALIZATION_FULL,
                label: '表述正常化（full）',
                systemOutputType: 'full',
            },
            {
                id: SYSTEM_PROMPT_NAME_NORMALIZATION_ITEM,
                label: '表述正常化（item）',
                systemOutputType: 'item',
            },
            {
                id: SYSTEM_PROMPT_NAME_KNOWLEDGE_VERIFY_ITEM,
                label: '知识核查（item）',
                systemOutputType: 'item',
            },
            {
                id: SYSTEM_PROMPT_NAME_KNOWLEDGE_VERIFY_FULL,
                label: '知识核查（full）',
                systemOutputType: 'full',
            },
            {
                id: SYSTEM_PROMPT_NAME_HARD_ISSUE_ITEM,
                label: '硬伤发现（item）',
                systemOutputType: 'item',
            },
            {
                id: SYSTEM_PROMPT_NAME_CORRESPONDENCE_CHECK_ITEM,
                label: '对应关系核对（item）',
                systemOutputType: 'item',
            },
            {
                id: SYSTEM_PROMPT_NAME_PINYIN_PROOFREAD_FULL,
                label: '拼音审校（full）',
                systemOutputType: 'full',
            },
            {
                id: SYSTEM_PROMPT_NAME_PINYIN_ANNOTATION_FULL,
                label: '拼音加注（full）',
                systemOutputType: 'full',
            },
            ...prompts.map((p) => ({ id: p.name, label: p.name, prompt: p })),
        ];
        return items;
    }

    getTreeItem(element: PromptTreeItem): vscode.TreeItem {
        const current = this.promptManager.getCurrentPromptName();
        const isCurrent =
            (element.id === SYSTEM_FULL_ITEM_ID && current === SYSTEM_PROMPT_NAME_FULL) ||
            (element.id === SYSTEM_ITEM_ITEM_ID && current === SYSTEM_PROMPT_NAME_ITEM) ||
            (element.id === SYSTEM_PROMPT_NAME_NORMALIZATION_FULL && current === SYSTEM_PROMPT_NAME_NORMALIZATION_FULL) ||
            (element.id === SYSTEM_PROMPT_NAME_NORMALIZATION_ITEM && current === SYSTEM_PROMPT_NAME_NORMALIZATION_ITEM) ||
            (element.id === SYSTEM_PROMPT_NAME_KNOWLEDGE_VERIFY_ITEM && current === SYSTEM_PROMPT_NAME_KNOWLEDGE_VERIFY_ITEM) ||
            (element.id === SYSTEM_PROMPT_NAME_KNOWLEDGE_VERIFY_FULL && current === SYSTEM_PROMPT_NAME_KNOWLEDGE_VERIFY_FULL) ||
            (element.id === SYSTEM_PROMPT_NAME_HARD_ISSUE_ITEM && current === SYSTEM_PROMPT_NAME_HARD_ISSUE_ITEM) ||
            (element.id === SYSTEM_PROMPT_NAME_CORRESPONDENCE_CHECK_ITEM && current === SYSTEM_PROMPT_NAME_CORRESPONDENCE_CHECK_ITEM) ||
            (element.id === SYSTEM_PROMPT_NAME_PINYIN_PROOFREAD_FULL && current === SYSTEM_PROMPT_NAME_PINYIN_PROOFREAD_FULL) ||
            (element.id === SYSTEM_PROMPT_NAME_PINYIN_ANNOTATION_FULL && current === SYSTEM_PROMPT_NAME_PINYIN_ANNOTATION_FULL) ||
            (!!element.prompt && current === element.id);
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.id = element.id;
        const systemLabel = element.systemOutputType === 'full' ? '全文' : element.systemOutputType === 'item' ? '条目' : undefined;
        const userOutputLabel =
            element.prompt?.outputType === 'item' ? '条目' : element.prompt?.outputType === 'other' ? '其他' : '全文';
        const outputTypeLabel = systemLabel ?? userOutputLabel;
        item.description = [outputTypeLabel, isCurrent ? '当前' : undefined].filter(Boolean).join(' · ') || undefined;
        item.contextValue = element.prompt ? 'promptUser' : 'promptSystem';
        if (element.prompt?.content) {
            const preview = element.prompt.content.slice(0, 60).replace(/\s+/g, ' ');
            let tooltip = preview + (element.prompt.content.length > 60 ? '…' : '');
            tooltip += `\n输出类型: ${outputTypeLabel}`;
            item.tooltip = tooltip;
        } else if (element.systemOutputType) {
            if (element.id === SYSTEM_FULL_ITEM_ID) {
                item.tooltip = '系统默认提示词（full）';
            } else if (element.id === SYSTEM_ITEM_ITEM_ID) {
                item.tooltip = '系统默认提示词（item）';
            } else {
                item.tooltip = element.label;
            }
        }
        return item;
    }
}

export interface PromptsViewRegistration {
    provider: PromptsTreeDataProvider;
    treeView: vscode.TreeView<PromptTreeItem>;
}

export function registerPromptsView(
    context: vscode.ExtensionContext,
    promptManager: PromptManager
): PromptsViewRegistration {
    const provider = new PromptsTreeDataProvider(context, promptManager);
    const treeView = vscode.window.createTreeView(PROMPTS_VIEW_ID, {
        treeDataProvider: provider,
        showCollapseAll: false,
        canSelectMany: false,
    });

    context.subscriptions.push(
        treeView,
        treeView.onDidChangeSelection(async (e) => {
            const sel = e.selection[0];
            if (!sel) return;
            const id = (sel.id ?? '') as string;
            const labelText = typeof sel.label === 'string' ? sel.label : (sel.label as { label?: string }).label ?? '';
            let name: string;
            if (id === SYSTEM_FULL_ITEM_ID) name = SYSTEM_PROMPT_NAME_FULL;
            else if (id === SYSTEM_ITEM_ITEM_ID) name = SYSTEM_PROMPT_NAME_ITEM;
            else if (id === SYSTEM_PROMPT_NAME_NORMALIZATION_FULL) name = SYSTEM_PROMPT_NAME_NORMALIZATION_FULL;
            else if (id === SYSTEM_PROMPT_NAME_NORMALIZATION_ITEM) name = SYSTEM_PROMPT_NAME_NORMALIZATION_ITEM;
            else if (id === SYSTEM_PROMPT_NAME_KNOWLEDGE_VERIFY_ITEM) name = SYSTEM_PROMPT_NAME_KNOWLEDGE_VERIFY_ITEM;
            else if (id === SYSTEM_PROMPT_NAME_KNOWLEDGE_VERIFY_FULL) name = SYSTEM_PROMPT_NAME_KNOWLEDGE_VERIFY_FULL;
            else if (id === SYSTEM_PROMPT_NAME_HARD_ISSUE_ITEM) name = SYSTEM_PROMPT_NAME_HARD_ISSUE_ITEM;
            else if (id === SYSTEM_PROMPT_NAME_CORRESPONDENCE_CHECK_ITEM) name = SYSTEM_PROMPT_NAME_CORRESPONDENCE_CHECK_ITEM;
            else if (id === SYSTEM_PROMPT_NAME_PINYIN_PROOFREAD_FULL) name = SYSTEM_PROMPT_NAME_PINYIN_PROOFREAD_FULL;
            else if (id === SYSTEM_PROMPT_NAME_PINYIN_ANNOTATION_FULL) name = SYSTEM_PROMPT_NAME_PINYIN_ANNOTATION_FULL;
            else if (labelText === '系统默认提示词（full）') name = SYSTEM_PROMPT_NAME_FULL;
            else if (labelText === '系统默认提示词（item）') name = SYSTEM_PROMPT_NAME_ITEM;
            else if (labelText === '表述正常化（full）') name = SYSTEM_PROMPT_NAME_NORMALIZATION_FULL;
            else if (labelText === '表述正常化（item）') name = SYSTEM_PROMPT_NAME_NORMALIZATION_ITEM;
            else if (labelText === '知识核查（item）') name = SYSTEM_PROMPT_NAME_KNOWLEDGE_VERIFY_ITEM;
            else if (labelText === '知识核查（full）') name = SYSTEM_PROMPT_NAME_KNOWLEDGE_VERIFY_FULL;
            else if (labelText === '硬伤发现（item）') name = SYSTEM_PROMPT_NAME_HARD_ISSUE_ITEM;
            else if (labelText === '对应关系核对（item）') name = SYSTEM_PROMPT_NAME_CORRESPONDENCE_CHECK_ITEM;
            else if (labelText === '拼音审校（full）') name = SYSTEM_PROMPT_NAME_PINYIN_PROOFREAD_FULL;
            else if (labelText === '拼音加注（full）') name = SYSTEM_PROMPT_NAME_PINYIN_ANNOTATION_FULL;
            else name = id;
            await promptManager.setCurrentPrompt(name);
            provider.refresh();
        })
    );

    return { provider, treeView };
}
