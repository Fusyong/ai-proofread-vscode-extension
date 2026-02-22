/**
 * 段内序号：TreeView 数据提供者
 * 一段一个根节点，子节点为段内序号
 */

import * as vscode from 'vscode';
import type { SegmentNode, NumberingNode, CheckIssue } from './types';

const PREVIEW_LEN = 20;

function collectAssignedLevels(nodes: NumberingNode[]): number[] {
    const set = new Set<number>();
    function walk(n: NumberingNode) {
        set.add(n.assignedLevel);
        for (const c of n.children) walk(c);
    }
    for (const r of nodes) walk(r);
    return [...set].sort((a, b) => a - b);
}

export type SegmentTreeElement = SegmentNode | NumberingNode;

function isSegmentNode(el: SegmentTreeElement): el is SegmentNode {
    return 'segmentIndex' in el;
}

export class SegmentTreeDataProvider implements vscode.TreeDataProvider<SegmentTreeElement> {
    private _onDidChangeTreeData = new vscode.EventEmitter<SegmentTreeElement | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private segments: SegmentNode[] = [];
    private issues: CheckIssue[] = [];
    private documentUri: vscode.Uri | null = null;
    private useSimplifiedLevel = false;

    refresh(segments: SegmentNode[], issues: CheckIssue[], documentUri: vscode.Uri | null): void {
        this.segments = segments;
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

    getTreeItem(element: SegmentTreeElement): vscode.TreeItem {
        if (isSegmentNode(element)) {
            const item = new vscode.TreeItem(
                `L${element.startLine}-${element.endLine}`,
                element.children.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
            );
            item.id = `seg:${element.segmentIndex}`;
            item.tooltip = `第 ${element.segmentIndex} 段，行 ${element.startLine}-${element.endLine}`;
            if (element.range) {
                (item as any).range = element.range;
            }
            return item;
        }

        const node = element as NumberingNode;
        const issue = this.issues.find((i) => i.node === node);
        const idx = node.lineText.indexOf(node.numberingText);
        const suffix = (idx >= 0 ? node.lineText.substring(idx) : node.lineText).trimStart();
        const preview = suffix.length > PREVIEW_LEN ? suffix.slice(0, PREVIEW_LEN) + '…' : suffix;
        const displayLevel = this.getDisplayLevel(node);
        const levelPrefix = '#'.repeat(Math.min(6, displayLevel + 1)) + ' ';
        const label = `${levelPrefix}${preview}`;
        const hasChildren = (node.children?.length ?? 0) > 0;
        const collapsibleState = hasChildren ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None;
        const item = new vscode.TreeItem(label, collapsibleState);
        item.id = `node:${node.lineNumber}:${node.numberingText}`;
        item.description = issue ? issue.type : '';
        item.tooltip = issue ? `${node.lineText}\n\n${issue.message}` : node.lineText;
        item.contextValue = 'numberingIntext';
        return item;
    }

    getChildren(element?: SegmentTreeElement): SegmentTreeElement[] {
        if (!element) return this.segments;
        if (isSegmentNode(element)) return element.children;
        return (element as NumberingNode).children;
    }

    getDocumentUri(): vscode.Uri | null {
        return this.documentUri;
    }

    getSegments(): SegmentNode[] {
        return this.segments;
    }

    getIssues(): CheckIssue[] {
        return this.issues;
    }

    private getDisplayLevel(node: NumberingNode): number {
        if (!this.useSimplifiedLevel) return node.assignedLevel;
        const allNodes: NumberingNode[] = [];
        for (const seg of this.segments) {
            function walk(n: NumberingNode) {
                allNodes.push(n);
                for (const c of n.children) walk(c);
            }
            for (const c of seg.children) walk(c);
        }
        const used = collectAssignedLevels(allNodes);
        const idx = used.indexOf(node.assignedLevel);
        return idx >= 0 ? idx : node.assignedLevel;
    }
}
