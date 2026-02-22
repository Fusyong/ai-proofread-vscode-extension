/**
 * 标题层级与连续性检查：TreeView 数据提供者
 * 规划见 docs/numbering-hierarchy-check-plan.md
 */

import * as vscode from 'vscode';
import type { NumberingNode, CheckIssue } from './types';

const PREVIEW_LEN = 20;

function collectAssignedLevels(roots: NumberingNode[]): number[] {
    const set = new Set<number>();
    function walk(n: NumberingNode) {
        set.add(n.assignedLevel);
        for (const c of n.children) walk(c);
    }
    for (const r of roots) walk(r);
    return [...set].sort((a, b) => a - b);
}

export class NumberingTreeDataProvider implements vscode.TreeDataProvider<NumberingNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<NumberingNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private roots: NumberingNode[] = [];
    private issues: CheckIssue[] = [];
    private documentUri: vscode.Uri | null = null;
    private useSimplifiedLevel = false;

    refresh(roots: NumberingNode[], issues: CheckIssue[], documentUri: vscode.Uri | null): void {
        this.roots = roots;
        this.issues = issues;
        this.documentUri = documentUri;
        this._onDidChangeTreeData.fire();
    }

    setUseSimplifiedLevel(use: boolean): void {
        if (this.useSimplifiedLevel !== use) {
            this.useSimplifiedLevel = use;
            this._onDidChangeTreeData.fire();
        }
    }

    getUseSimplifiedLevel(): boolean {
        return this.useSimplifiedLevel;
    }

    getTreeItem(element: NumberingNode): vscode.TreeItem {
        const issue = this.issues.find((i) => i.node === element);
        const idx = element.lineText.indexOf(element.numberingText);
        const suffix = (idx >= 0
            ? element.lineText.substring(idx)
            : element.lineText).trimStart();
        const preview = suffix.length > PREVIEW_LEN ? suffix.slice(0, PREVIEW_LEN) + '…' : suffix;
        const displayLevel = this.getDisplayLevel(element);
        const levelPrefix = element.category === 'heading'
            ? '#'.repeat(Math.min(6, displayLevel + 1)) + ' '
            : '';
        const label = `${levelPrefix}${preview}`;
        const hasChildren = (element.children?.length ?? 0) > 0;
        const collapsibleState = hasChildren
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.None;
        const item = new vscode.TreeItem(label, collapsibleState);
        item.id = `node:${element.lineNumber}:${element.numberingText}`;
        item.description = issue ? issue.type : '';
        item.tooltip = issue ? `${element.lineText}\n\n${issue.message}` : element.lineText;
        item.contextValue = element.category === 'heading' ? 'numberingHeading' : 'numberingIntext';
        return item;
    }

    getChildren(element?: NumberingNode): NumberingNode[] {
        if (!element) {
            return this.roots;
        }
        return element.children;
    }

    getDocumentUri(): vscode.Uri | null {
        return this.documentUri;
    }

    getRoots(): NumberingNode[] {
        return this.roots;
    }

    getIssues(): CheckIssue[] {
        return this.issues;
    }

    private getDisplayLevel(node: NumberingNode): number {
        if (!this.useSimplifiedLevel) return node.assignedLevel;
        const used = collectAssignedLevels(this.roots);
        const idx = used.indexOf(node.assignedLevel);
        return idx >= 0 ? idx : node.assignedLevel;
    }
}
