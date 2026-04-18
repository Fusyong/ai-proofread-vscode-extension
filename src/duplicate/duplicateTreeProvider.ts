/**
 * 文档内重复句 TreeView
 */

import * as vscode from 'vscode';
import type { DuplicateExactGroup, DuplicateFuzzyGroup, DuplicateOccurrence } from './types';

const PREVIEW_LEN = 24;

export type DuplicateTreeGroupNode =
    | { kind: 'exact'; groupIndex: number }
    | { kind: 'fuzzy'; groupIndex: number };

export type DuplicateTreeNode = DuplicateTreeGroupNode | DuplicateTreeOccurrenceNode;

export type DuplicateTreeOccurrenceNode = {
    kind: 'occurrence';
    parent: 'exact' | 'fuzzy';
    groupIndex: number;
    occIndex: number;
};

export class DuplicateTreeDataProvider implements vscode.TreeDataProvider<DuplicateTreeNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<DuplicateTreeNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private exactGroups: DuplicateExactGroup[] = [];
    private fuzzyGroups: DuplicateFuzzyGroup[] = [];
    private documentUri: vscode.Uri | null = null;
    /** 扫描文本在文档中的起始偏移（选区扫描时为选区起点） */
    private offsetBase = 0;

    refresh(
        exactGroups: DuplicateExactGroup[],
        fuzzyGroups: DuplicateFuzzyGroup[],
        documentUri: vscode.Uri | null,
        offsetBase = 0
    ): void {
        this.exactGroups = exactGroups;
        this.fuzzyGroups = fuzzyGroups;
        this.documentUri = documentUri;
        this.offsetBase = offsetBase;
        this._onDidChangeTreeData.fire();
    }

    getDocumentUri(): vscode.Uri | null {
        return this.documentUri;
    }

    getOffsetBase(): number {
        return this.offsetBase;
    }

    getExactGroups(): DuplicateExactGroup[] {
        return this.exactGroups;
    }

    getFuzzyGroups(): DuplicateFuzzyGroup[] {
        return this.fuzzyGroups;
    }

    getTreeItem(element: DuplicateTreeNode): vscode.TreeItem {
        if (element.kind === 'occurrence') {
            const occ = this.getOccurrence(element);
            const label = `L${occ.startLine}-${occ.endLine} ${this.preview(occ.text)}`;
            const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
            item.id = `occ:${element.parent}:${element.groupIndex}:${element.occIndex}`;
            item.tooltip = occ.text;
            item.contextValue = 'duplicateOccurrence';
            item.iconPath = new vscode.ThemeIcon('location');
            return item;
        }
        if (element.kind === 'exact') {
            const g = this.exactGroups[element.groupIndex];
            const label = `[相同] ${g.preview}`;
            const item = new vscode.TreeItem(
                label,
                g.occurrences.length > 0
                    ? vscode.TreeItemCollapsibleState.Expanded
                    : vscode.TreeItemCollapsibleState.None
            );
            item.id = `exact:${element.groupIndex}`;
            item.description = `${g.occurrences.length} 处`;
            item.tooltip = g.occurrences.map((o) => o.text).join('\n---\n');
            item.contextValue = 'duplicateExactGroup';
            item.iconPath = new vscode.ThemeIcon('copy');
            return item;
        }
        const g = this.fuzzyGroups[element.groupIndex];
        const label = `[≈${(g.score * 100).toFixed(0)}%] ${this.preview(g.occurrences[0]?.text ?? '')}`;
        const item = new vscode.TreeItem(
            label,
            g.occurrences.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
        );
        item.id = `fuzzy:${element.groupIndex}`;
        item.description = `${g.occurrences.length} 处`;
        item.tooltip = g.occurrences.map((o) => o.text).join('\n---\n');
        item.contextValue = 'duplicateFuzzyGroup';
        item.iconPath = new vscode.ThemeIcon('git-compare');
        return item;
    }

    getChildren(element?: DuplicateTreeNode): DuplicateTreeNode[] {
        if (!element) {
            const nodes: DuplicateTreeNode[] = [];
            for (let i = 0; i < this.exactGroups.length; i++) {
                nodes.push({ kind: 'exact', groupIndex: i });
            }
            for (let i = 0; i < this.fuzzyGroups.length; i++) {
                nodes.push({ kind: 'fuzzy', groupIndex: i });
            }
            return nodes;
        }
        if (element.kind === 'exact') {
            const g = this.exactGroups[element.groupIndex];
            return g.occurrences.map((_, occIndex) => ({
                kind: 'occurrence' as const,
                parent: 'exact' as const,
                groupIndex: element.groupIndex,
                occIndex
            }));
        }
        if (element.kind === 'fuzzy') {
            const g = this.fuzzyGroups[element.groupIndex];
            return g.occurrences.map((_, occIndex) => ({
                kind: 'occurrence' as const,
                parent: 'fuzzy' as const,
                groupIndex: element.groupIndex,
                occIndex
            }));
        }
        return [];
    }

    getOccurrence(node: DuplicateTreeOccurrenceNode): DuplicateOccurrence {
        if (node.parent === 'exact') {
            return this.exactGroups[node.groupIndex].occurrences[node.occIndex];
        }
        return this.fuzzyGroups[node.groupIndex].occurrences[node.occIndex];
    }

    private preview(s: string): string {
        const t = s.trim();
        return t.length > PREVIEW_LEN ? t.slice(0, PREVIEW_LEN) + '…' : t;
    }
}
