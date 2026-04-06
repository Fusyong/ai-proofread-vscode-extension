/**
 * 源文本特性提示词 TreeView：展示内置 + 用户自定义，仅用户项可编辑删除
 */

import * as vscode from 'vscode';
import { BUILTIN_SOURCE_TEXT_CHARACTERISTICS } from './sourceTextCharacteristics';
import type { UserSourceTextCharacteristicPrompt } from './sourceTextCharacteristics';
import { SourceTextCharacteristicManager } from './sourceTextCharacteristicManager';

export const SOURCE_TEXT_CHARACTERISTICS_VIEW_ID = 'ai-proofread.sourceTextCharacteristics';

const BUILTIN_PREFIX = '__src_builtin__:';

export interface SourceCharacteristicTreeItem {
    id: string;
    label: string;
    builtinId?: string;
    userPrompt?: UserSourceTextCharacteristicPrompt;
}

export class SourceTextCharacteristicsTreeDataProvider implements vscode.TreeDataProvider<SourceCharacteristicTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private manager: SourceTextCharacteristicManager) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getChildren(): SourceCharacteristicTreeItem[] {
        const builtins: SourceCharacteristicTreeItem[] = BUILTIN_SOURCE_TEXT_CHARACTERISTICS.map((b) => ({
            id: `${BUILTIN_PREFIX}${b.id}`,
            label: b.name,
            builtinId: b.id,
        }));
        const users: SourceCharacteristicTreeItem[] = this.manager.getUserPrompts().map((p) => ({
            id: p.name,
            label: p.name,
            userPrompt: p,
        }));
        return [...builtins, ...users];
    }

    getTreeItem(element: SourceCharacteristicTreeItem): vscode.TreeItem {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.id = element.id;
        if (element.userPrompt) {
            item.contextValue = 'sourceCharUser';
            const preview = element.userPrompt.content.slice(0, 60).replace(/\s+/g, ' ');
            item.tooltip = `${preview}${element.userPrompt.content.length > 60 ? '…' : ''}`;
            item.description = '自定义';
        } else {
            item.contextValue = 'sourceCharBuiltin';
            const builtin = BUILTIN_SOURCE_TEXT_CHARACTERISTICS.find((b) => b.id === element.builtinId);
            item.tooltip = builtin?.content ?? element.label;
            item.description = '内置';
        }
        return item;
    }
}

export function registerSourceTextCharacteristicsView(
    context: vscode.ExtensionContext,
    manager: SourceTextCharacteristicManager
): { provider: SourceTextCharacteristicsTreeDataProvider; treeView: vscode.TreeView<SourceCharacteristicTreeItem> } {
    const provider = new SourceTextCharacteristicsTreeDataProvider(manager);
    const treeView = vscode.window.createTreeView(SOURCE_TEXT_CHARACTERISTICS_VIEW_ID, {
        treeDataProvider: provider,
        showCollapseAll: false,
    });
    context.subscriptions.push(treeView);
    return { provider, treeView };
}
