/**
 * 校对条目 TreeView：展示 .proofread-item.json 中的条目（段落 → 每条修改）
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { parseItemOutput, type ProofreadItem } from './itemOutputParser';

export const PROOFREAD_ITEMS_VIEW_ID = 'ai-proofread.proofreadItems';

export interface SegmentNode {
    type: 'segment';
    index: number;
    raw: string | null;
    items: ProofreadItem[];
}

export interface ItemNode {
    type: 'item';
    segmentIndex: number;
    itemIndex: number;
    item: ProofreadItem;
}

export type ProofreadItemsNode = SegmentNode | ItemNode;

export class ProofreadItemsTreeDataProvider implements vscode.TreeDataProvider<ProofreadItemsNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private segments: { raw: string | null; items: ProofreadItem[] }[] = [];
    private sourcePath: string | null = null;

    refresh(uri?: vscode.Uri): void {
        const doc = uri ? vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString()) : vscode.window.activeTextEditor?.document;
        const path = doc?.uri.fsPath;
        if (path && (path.endsWith('.proofread-item.json') || path.endsWith('proofread-item.json'))) {
            this.sourcePath = path;
            try {
                const content = doc.getText();
                const arr = JSON.parse(content) as (string | null)[];
                if (!Array.isArray(arr)) {
                    this.segments = [];
                    this._onDidChangeTreeData.fire();
                    return;
                }
                this.segments = arr.map(raw => ({
                    raw,
                    items: raw ? parseItemOutput(raw) : [],
                }));
            } catch {
                this.segments = [];
            }
        } else if (path && path.endsWith('.proofread.json')) {
            this.sourcePath = path.replace(/\.proofread\.json$/i, '.proofread-item.json');
            if (fs.existsSync(this.sourcePath)) {
                try {
                    const content = fs.readFileSync(this.sourcePath, 'utf8');
                    const arr = JSON.parse(content) as (string | null)[];
                    if (!Array.isArray(arr)) {
                        this.segments = [];
                    } else {
                        this.segments = arr.map(raw => ({
                            raw,
                            items: raw ? parseItemOutput(raw) : [],
                        }));
                    }
                } catch {
                    this.segments = [];
                }
            } else {
                this.segments = [];
            }
        } else {
            this.sourcePath = null;
            this.segments = [];
        }
        this._onDidChangeTreeData.fire();
    }

    getChildren(element?: ProofreadItemsNode): ProofreadItemsNode[] {
        if (!element) {
            return this.segments.map((seg, index) => ({
                type: 'segment' as const,
                index,
                raw: seg.raw,
                items: seg.items,
            }));
        }
        if (element.type === 'segment') {
            return element.items.map((item, itemIndex) => ({
                type: 'item' as const,
                segmentIndex: element.index,
                itemIndex,
                item,
            }));
        }
        return [];
    }

    getTreeItem(element: ProofreadItemsNode): vscode.TreeItem {
        if (element.type === 'segment') {
            const label = `No.${element.index + 1}`;
            const hasItems = element.items.length > 0;
            const item = new vscode.TreeItem(
                label,
                hasItems ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
            );
            item.id = `seg:${element.index}`;
            item.description = `${element.items.length} 条修改`;
            item.tooltip = this.sourcePath ?? undefined;
            return item;
        }
        const { original, corrected, explanation } = element.item;
        const shortOriginal = original.length > 30 ? original.slice(0, 30) + '…' : original;
        const correctedLabel = corrected != null ? (corrected.length > 30 ? corrected.slice(0, 30) + '…' : corrected) : '(无)';
        const treeItem = new vscode.TreeItem(
            `${shortOriginal} → ${correctedLabel}`,
            vscode.TreeItemCollapsibleState.None
        );
        treeItem.id = `item:${element.segmentIndex}:${element.itemIndex}`;
        treeItem.tooltip = explanation
            ? `原文: ${original}\n改后: ${corrected ?? '(无)'}\n说明: ${explanation}`
            : `原文: ${original}\n改后: ${corrected ?? '(无)'}`;
        return treeItem;
    }
}

export function registerProofreadItemsView(context: vscode.ExtensionContext): {
    provider: ProofreadItemsTreeDataProvider;
    treeView: vscode.TreeView<ProofreadItemsNode>;
} {
    const provider = new ProofreadItemsTreeDataProvider();
    const treeView = vscode.window.createTreeView(PROOFREAD_ITEMS_VIEW_ID, {
        treeDataProvider: provider,
        showCollapseAll: true,
    });
    context.subscriptions.push(treeView);

    const refreshWhenActiveEditor = () => provider.refresh();
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(refreshWhenActiveEditor));
    refreshWhenActiveEditor();

    return { provider, treeView };
}
