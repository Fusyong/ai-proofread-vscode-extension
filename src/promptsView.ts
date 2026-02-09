/**
 * 提示词 TreeView：单选（当前）、新建、编辑、删除
 * 仿照字词检查的检查项目管理，仅能选一条为当前。
 */

import * as vscode from 'vscode';
import { PromptManager } from './promptManager';
import type { Prompt } from './promptManager';

export const PROMPTS_VIEW_ID = 'ai-proofread.prompts';

/** 系统默认在树中的 id（TreeItem.id 不宜为空，故用固定字符串） */
const SYSTEM_ITEM_ID = '__system__';

export interface PromptTreeItem {
    /** 空字符串表示系统默认，否则为 prompt.name */
    id: string;
    label: string;
    prompt?: Prompt;
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
            { id: SYSTEM_ITEM_ID, label: '系统默认提示词' },
            ...prompts.map((p) => ({ id: p.name, label: p.name, prompt: p })),
        ];
        return items;
    }

    getTreeItem(element: PromptTreeItem): vscode.TreeItem {
        const current = this.promptManager.getCurrentPromptName();
        const isCurrent = element.id === SYSTEM_ITEM_ID ? current === '' : current === element.id;
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.id = element.id === SYSTEM_ITEM_ID ? SYSTEM_ITEM_ID : element.id;
        item.description = isCurrent ? '当前' : undefined;
        item.contextValue = element.prompt ? 'promptUser' : 'promptSystem';
        if (element.prompt?.content) {
            const preview = element.prompt.content.slice(0, 60).replace(/\s+/g, ' ');
            item.tooltip = preview + (element.prompt.content.length > 60 ? '…' : '');
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
            const name = sel.id === SYSTEM_ITEM_ID ? '' : (sel.id ?? '');
            await promptManager.setCurrentPrompt(name);
            provider.refresh();
        })
    );

    return { provider, treeView };
}
