/**
 * 词典检查类型 / 通规检查类型 TreeView：排序、勾选并记住，不可删除
 */

import * as vscode from 'vscode';
import {
    DICT_CHECK_TYPES,
    TGSCC_CHECK_TYPES,
    CHECK_TYPE_LABELS,
    type CheckType,
} from './types';

export const DICT_CHECK_TYPES_VIEW_ID = 'ai-proofread.dictCheckTypes';
export const TGSCC_CHECK_TYPES_VIEW_ID = 'ai-proofread.tgsccCheckTypes';

export const KEY_DICT_TYPE_ORDER = 'ai-proofread.wordCheck.dictTypeOrder';
export const KEY_DICT_TYPE_SELECTED_IDS = 'ai-proofread.wordCheck.dictTypeSelectedIds';
export const KEY_TGSCC_TYPE_ORDER = 'ai-proofread.wordCheck.tgsccTypeOrder';
export const KEY_TGSCC_TYPE_SELECTED_IDS = 'ai-proofread.wordCheck.tgsccTypeSelectedIds';

export interface CheckTypeTreeItem {
    id: CheckType;
    label: string;
}

function getOrder(context: vscode.ExtensionContext, keyOrder: string, defaultOrder: CheckType[]): CheckType[] {
    const raw = context.workspaceState.get<string[]>(keyOrder);
    if (Array.isArray(raw) && raw.length > 0) {
        return raw.filter((id): id is CheckType => defaultOrder.includes(id as CheckType));
    }
    return [...defaultOrder];
}

function saveOrder(context: vscode.ExtensionContext, keyOrder: string, order: string[]): void {
    context.workspaceState.update(keyOrder, order);
}

/** 未保存过时默认只选中第一条 */
function getSelectedIds(context: vscode.ExtensionContext, keySelected: string, defaultOrder?: CheckType[]): CheckType[] {
    const raw = context.workspaceState.get<string[]>(keySelected);
    if (Array.isArray(raw) && raw.length > 0) return raw as CheckType[];
    return defaultOrder?.length ? [defaultOrder[0]] : [];
}

function saveSelectedIds(context: vscode.ExtensionContext, keySelected: string, ids: string[]): void {
    context.workspaceState.update(keySelected, ids);
}

/** 共用逻辑：按顺序返回项，勾选状态持久化，支持上移/下移 */
abstract class BaseCheckTypesTreeDataProvider implements vscode.TreeDataProvider<CheckTypeTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(
        protected context: vscode.ExtensionContext,
        protected keyOrder: string,
        protected keySelected: string,
        protected defaultOrder: CheckType[]
    ) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getChildren(_element?: CheckTypeTreeItem): CheckTypeTreeItem[] {
        const order = getOrder(this.context, this.keyOrder, this.defaultOrder);
        const validSet = new Set(this.defaultOrder);
        const items: CheckTypeTreeItem[] = [];
        const seen = new Set<string>();
        for (const id of order) {
            if (!validSet.has(id) || seen.has(id)) continue;
            seen.add(id);
            items.push({ id, label: CHECK_TYPE_LABELS[id] });
        }
        for (const id of this.defaultOrder) {
            if (!seen.has(id)) items.push({ id, label: CHECK_TYPE_LABELS[id] });
        }
        return items;
    }

    getTreeItem(element: CheckTypeTreeItem): vscode.TreeItem {
        const selectedIds = getSelectedIds(this.context, this.keySelected, this.defaultOrder);
        const checked = selectedIds.includes(element.id);
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.id = element.id;
        item.checkboxState = checked ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
        item.contextValue = 'checkType';
        return item;
    }

    moveInOrder(id: string, delta: number): void {
        const order = getOrder(this.context, this.keyOrder, this.defaultOrder);
        const idx = order.indexOf(id as CheckType);
        if (idx < 0) return;
        const next = idx + delta;
        if (next < 0 || next >= order.length) return;
        [order[idx], order[next]] = [order[next], order[idx]];
        saveOrder(this.context, this.keyOrder, order);
        this.refresh();
    }

    setChecked(id: string, checked: boolean): void {
        let ids = getSelectedIds(this.context, this.keySelected, this.defaultOrder);
        if (checked) {
            if (!ids.includes(id as CheckType)) ids = [...ids, id as CheckType];
        } else {
            ids = ids.filter((x) => x !== id);
        }
        saveSelectedIds(this.context, this.keySelected, ids);
        this.refresh();
    }

    getOrderedSelectedTypes(): CheckType[] {
        const order = getOrder(this.context, this.keyOrder, this.defaultOrder);
        const selectedSet = new Set(getSelectedIds(this.context, this.keySelected, this.defaultOrder));
        return order.filter((id) => selectedSet.has(id));
    }
}

export class DictCheckTypesTreeDataProvider extends BaseCheckTypesTreeDataProvider {
    constructor(context: vscode.ExtensionContext) {
        super(context, KEY_DICT_TYPE_ORDER, KEY_DICT_TYPE_SELECTED_IDS, DICT_CHECK_TYPES);
    }
}

export class TgsccCheckTypesTreeDataProvider extends BaseCheckTypesTreeDataProvider {
    constructor(context: vscode.ExtensionContext) {
        super(context, KEY_TGSCC_TYPE_ORDER, KEY_TGSCC_TYPE_SELECTED_IDS, TGSCC_CHECK_TYPES);
    }
}

function registerCheckTypesView(
    context: vscode.ExtensionContext,
    viewId: string,
    provider: BaseCheckTypesTreeDataProvider
): { provider: BaseCheckTypesTreeDataProvider; treeView: vscode.TreeView<CheckTypeTreeItem> } {
    const treeView = vscode.window.createTreeView(viewId, {
        treeDataProvider: provider,
        showCollapseAll: false,
        canSelectMany: false,
    });

    context.subscriptions.push(
        treeView,
        treeView.onDidChangeCheckboxState((e: vscode.TreeCheckboxChangeEvent<CheckTypeTreeItem>) => {
            for (const [item, state] of e.items) {
                provider.setChecked(item.id, state === vscode.TreeItemCheckboxState.Checked);
            }
        })
    );

    return { provider, treeView };
}

export interface CheckTypesViewRegistration {
    provider: BaseCheckTypesTreeDataProvider;
    treeView: vscode.TreeView<CheckTypeTreeItem>;
}

export function registerDictCheckTypesView(context: vscode.ExtensionContext): CheckTypesViewRegistration {
    const provider = new DictCheckTypesTreeDataProvider(context);
    return registerCheckTypesView(context, DICT_CHECK_TYPES_VIEW_ID, provider);
}

export function registerTgsccCheckTypesView(context: vscode.ExtensionContext): CheckTypesViewRegistration {
    const provider = new TgsccCheckTypesTreeDataProvider(context);
    return registerCheckTypesView(context, TGSCC_CHECK_TYPES_VIEW_ID, provider);
}
