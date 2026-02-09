/**
 * 替换表 TreeView：预置 + 自定义表列表，支持勾选、排序、右键删除（仅自定义）
 * 与 KEY_LAST_SELECTED_TABLE_IDS、KEY_TABLE_ORDER 配合使用。
 */

import * as vscode from 'vscode';
import { getCustomTables } from './customTableCache';
import { getCustomPresetLabel, CUSTOM_PRESET_IDS, type CustomPresetId } from './tableLoader';

export const CUSTOM_TABLES_VIEW_ID = 'ai-proofread.customTables';

export const KEY_TABLE_ORDER = 'ai-proofread.wordCheck.tableOrder';
export const KEY_LAST_SELECTED_TABLE_IDS = 'ai-proofread.wordCheck.lastSelectedTableIds';

export interface CustomTableTreeItem {
    id: string;
    label: string;
    isPreset: boolean;
}

function getOrder(context: vscode.ExtensionContext): string[] {
    const raw = context.workspaceState.get<string[]>(KEY_TABLE_ORDER);
    if (Array.isArray(raw) && raw.length > 0) return raw;
    const customIds = getCustomTables().map((t) => t.id);
    return [...CUSTOM_PRESET_IDS, ...customIds];
}

function saveOrder(context: vscode.ExtensionContext, order: string[]): void {
    context.workspaceState.update(KEY_TABLE_ORDER, order);
}

/** 未保存过时默认只选中第一条（按 order 顺序） */
function getSelectedIds(context: vscode.ExtensionContext): string[] {
    const raw = context.workspaceState.get<string[]>(KEY_LAST_SELECTED_TABLE_IDS);
    if (Array.isArray(raw) && raw.length > 0) return raw;
    const order = getOrder(context);
    return order.length > 0 ? [order[0]] : [];
}

function saveSelectedIds(context: vscode.ExtensionContext, ids: string[]): void {
    context.workspaceState.update(KEY_LAST_SELECTED_TABLE_IDS, ids);
}

export class CustomTablesTreeDataProvider implements vscode.TreeDataProvider<CustomTableTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private context: vscode.ExtensionContext) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getChildren(_element?: CustomTableTreeItem): CustomTableTreeItem[] {
        const order = getOrder(this.context);
        const tables = getCustomTables();
        const idToTable = new Map(tables.map((t) => [t.id, t]));
        const items: CustomTableTreeItem[] = [];
        const seen = new Set<string>();
        for (const id of order) {
            if (seen.has(id)) continue;
            seen.add(id);
            const presetId = CUSTOM_PRESET_IDS.includes(id as CustomPresetId) ? (id as CustomPresetId) : null;
            if (presetId) {
                items.push({
                    id: presetId,
                    label: getCustomPresetLabel(presetId),
                    isPreset: true,
                });
            } else {
                const t = idToTable.get(id);
                if (t) {
                    items.push({ id: t.id, label: t.name, isPreset: false });
                }
            }
        }
        for (const t of tables) {
            if (!seen.has(t.id)) {
                items.push({ id: t.id, label: t.name, isPreset: false });
            }
        }
        return items;
    }

    getTreeItem(element: CustomTableTreeItem): vscode.TreeItem {
        const selectedIds = getSelectedIds(this.context);
        const checked = selectedIds.includes(element.id);
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.id = element.id;
        item.checkboxState = checked ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
        item.contextValue = element.isPreset ? 'customTablePreset' : 'customTableUser';
        if (element.isPreset) {
            item.description = '预置';
        } else {
            const table = getCustomTables().find((t) => t.id === element.id);
            item.description = table
                ? table.isRegex
                    ? `正则 · ${table.rules.length}`
                    : `字面 · ${table.rules.length}`
                : undefined;
        }
        return item;
    }

    getOrderedIds(): string[] {
        return this.getChildren().map((e) => e.id);
    }

    moveInOrder(id: string, delta: number): void {
        const order = getOrder(this.context);
        const idx = order.indexOf(id);
        if (idx < 0) return;
        const next = idx + delta;
        if (next < 0 || next >= order.length) return;
        [order[idx], order[next]] = [order[next], order[idx]];
        saveOrder(this.context, order);
        this.refresh();
    }

    removeFromOrder(id: string): void {
        const order = getOrder(this.context).filter((x) => x !== id);
        saveOrder(this.context, order);
        const selected = getSelectedIds(this.context).filter((x) => x !== id);
        saveSelectedIds(this.context, selected);
        this.refresh();
    }

    setChecked(id: string, checked: boolean): void {
        let ids = getSelectedIds(this.context);
        if (checked) {
            if (!ids.includes(id)) ids = [...ids, id];
        } else {
            ids = ids.filter((x) => x !== id);
        }
        saveSelectedIds(this.context, ids);
        this.refresh();
    }
}

export interface CustomTablesViewRegistration {
    provider: CustomTablesTreeDataProvider;
    treeView: vscode.TreeView<CustomTableTreeItem>;
}

export function registerCustomTablesView(context: vscode.ExtensionContext): CustomTablesViewRegistration {
    const provider = new CustomTablesTreeDataProvider(context);
    const treeView = vscode.window.createTreeView(CUSTOM_TABLES_VIEW_ID, {
        treeDataProvider: provider,
        showCollapseAll: false,
        canSelectMany: false,
    });

    context.subscriptions.push(
        treeView,
        treeView.onDidChangeCheckboxState((e: vscode.TreeCheckboxChangeEvent<CustomTableTreeItem>) => {
            for (const [item, state] of e.items) {
                provider.setChecked(item.id, state === vscode.TreeItemCheckboxState.Checked);
            }
        })
    );

    return { provider, treeView };
}
