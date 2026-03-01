/**
 * 提示词 TreeView：单选（当前）、新建、编辑、删除
 * 仿照字词检查的检查项目管理，仅能选一条为当前。
 */

import * as vscode from 'vscode';
import { PromptManager, SYSTEM_PROMPT_NAME_FULL, SYSTEM_PROMPT_NAME_ITEM } from './promptManager';
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
            ...prompts.map((p) => ({ id: p.name, label: p.name, prompt: p })),
        ];
        return items;
    }

    getTreeItem(element: PromptTreeItem): vscode.TreeItem {
        const current = this.promptManager.getCurrentPromptName();
        const isSystemFull = element.id === SYSTEM_FULL_ITEM_ID;
        const isSystemItem = element.id === SYSTEM_ITEM_ITEM_ID;
        const isCurrent = isSystemFull ? current === SYSTEM_PROMPT_NAME_FULL : isSystemItem ? current === SYSTEM_PROMPT_NAME_ITEM : current === element.id;
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
            item.tooltip = element.systemOutputType === 'full' ? '系统默认提示词（full）' : '系统默认提示词（item）';
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
            else if (labelText === '系统默认提示词（full）') name = SYSTEM_PROMPT_NAME_FULL;
            else if (labelText === '系统默认提示词（item）') name = SYSTEM_PROMPT_NAME_ITEM;
            else name = id;
            await promptManager.setCurrentPrompt(name);
            provider.refresh();
        })
    );

    return { provider, treeView };
}
