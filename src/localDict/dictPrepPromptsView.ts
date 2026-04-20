/**
 * 词典查询提示词 TreeView：单选（当前）、新建、编辑、删除
 * 结构仿照 promptsView.ts
 */

import * as vscode from 'vscode';
import { DictPrepPromptManager, SYSTEM_DICT_PREP_PROMPT_NAME, type DictPrepPrompt } from './dictPrepPromptManager';

export const DICT_PREP_PROMPTS_VIEW_ID = 'ai-proofread.dictPrepPrompts';

const SYSTEM_ITEM_ID = '__system_dictprep__';

export interface DictPrepPromptTreeItem {
    id: string;
    label: string;
    prompt?: DictPrepPrompt;
    isSystem?: boolean;
}

export class DictPrepPromptsTreeDataProvider implements vscode.TreeDataProvider<DictPrepPromptTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private manager: DictPrepPromptManager) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getChildren(): DictPrepPromptTreeItem[] {
        const prompts = this.manager.getPrompts();
        return [
            { id: SYSTEM_ITEM_ID, label: '系统默认提示词（词典查询）', isSystem: true },
            ...prompts.map((p) => ({ id: p.name, label: p.name, prompt: p })),
        ];
    }

    getTreeItem(element: DictPrepPromptTreeItem): vscode.TreeItem {
        const current = this.manager.getCurrentPromptName();
        const isCurrent = element.isSystem ? current === SYSTEM_DICT_PREP_PROMPT_NAME : current === element.id;
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.id = element.id;
        item.contextValue = element.prompt ? 'dictPrepPromptUser' : 'dictPrepPromptSystem';
        item.description = isCurrent ? '当前' : undefined;
        if (element.prompt?.content) {
            const preview = element.prompt.content.slice(0, 60).replace(/\s+/g, ' ');
            item.tooltip = preview + (element.prompt.content.length > 60 ? '…' : '');
        } else if (element.isSystem) {
            item.tooltip = '系统默认词典查询提示词';
        }
        return item;
    }
}

export function registerDictPrepPromptsView(
    context: vscode.ExtensionContext,
    manager: DictPrepPromptManager
): { provider: DictPrepPromptsTreeDataProvider; treeView: vscode.TreeView<DictPrepPromptTreeItem> } {
    const provider = new DictPrepPromptsTreeDataProvider(manager);
    const treeView = vscode.window.createTreeView(DICT_PREP_PROMPTS_VIEW_ID, {
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
            const name = id === SYSTEM_ITEM_ID || labelText === '系统默认提示词（词典查询）' ? SYSTEM_DICT_PREP_PROMPT_NAME : id;
            await manager.setCurrentPrompt(name);
            provider.refresh();
        })
    );

    return { provider, treeView };
}

