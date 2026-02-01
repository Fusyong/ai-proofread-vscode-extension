/**
 * 引文核对 TreeView 数据提供者（仅展示整块引文与整体匹配）
 * 计划见 docs/citation-verification-plan.md 阶段 4
 */

import * as vscode from 'vscode';
import * as path from 'path';
import type { BlockMatchResult, BlockMatchCandidate } from './citationMatcher';
import type { RefSentenceRow } from './referenceStore';

const PREVIEW_LEN = 36;

export type CitationTreeBlockNode = { kind: 'block'; data: BlockMatchResult; blockIndex: number };
export type CitationTreeMatchNode = { kind: 'match'; data: BlockMatchCandidate; blockIndex: number; matchIndex: number };
export type CitationTreeNode = CitationTreeBlockNode | CitationTreeMatchNode;

/** 用于「查看 diff」与「在 PDF 中搜索」的匹配数据（整块引文 vs 整段文献） */
export interface MatchDataForCommands {
    citationText: string;
    refFragment: RefSentenceRow[];
    refFilePath: string;
}

export class CitationTreeDataProvider implements vscode.TreeDataProvider<CitationTreeNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<CitationTreeNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private blockResults: BlockMatchResult[] = [];
    private documentUri: vscode.Uri | null = null;
    /** 最后选中的匹配节点（右键/焦点在菜单时 selection 可能为空，用此回退） */
    private lastSelectedMatchNode: CitationTreeMatchNode | null = null;

    refresh(blockResults: BlockMatchResult[], documentUri: vscode.Uri | null): void {
        this.blockResults = blockResults;
        this.documentUri = documentUri;
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: CitationTreeNode): vscode.TreeItem {
        if (element.kind === 'block') {
            const entry = element.data.block.entry;
            const label = `L${entry.startLine}-${entry.endLine} ${this.preview(entry.text)}`;
            const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
            item.id = `block:${element.blockIndex}`;
            const firstMatch = element.data.matches[0];
            item.description = entry.confidence === 'likely_not'
                ? '可能非引文'
                : (firstMatch ? `${(firstMatch.score * 100).toFixed(0)}% ${path.basename(firstMatch.file_path)}` : (entry.footnoteMarker ?? ''));
            item.tooltip = entry.text;
            item.contextValue = 'citationBlock';
            item.iconPath = entry.type === 'blockquote' ? new vscode.ThemeIcon('quote') : new vscode.ThemeIcon('text-size');
            return item;
        }
        const match = element.data;
        const fileName = path.basename(match.file_path);
        const item = new vscode.TreeItem(`${fileName} ${(match.score * 100).toFixed(0)}%`, vscode.TreeItemCollapsibleState.None);
        item.id = `match:${element.blockIndex}:${element.matchIndex}`;
        item.description = match.file_path;
        const refText = match.refFragment.map((r) => r.content).join('');
        item.tooltip = refText;
        item.contextValue = 'citationMatch';
        return item;
    }

    getChildren(element?: CitationTreeNode): CitationTreeNode[] {
        if (!element) {
            return this.blockResults.map((data, blockIndex) => ({ kind: 'block' as const, data, blockIndex }));
        }
        if (element.kind === 'block') {
            const matches = element.data.matches;
            return matches.map((data, matchIndex) => ({
                kind: 'match' as const,
                data,
                blockIndex: element.blockIndex,
                matchIndex
            }));
        }
        return [];
    }

    setLastSelectedMatchNode(node: CitationTreeMatchNode | null): void {
        this.lastSelectedMatchNode = node;
    }

    /** 从最后选中的匹配节点取数据（当 treeView.selection 在菜单触发时为空时使用） */
    getMatchDataFromLastSelected(): MatchDataForCommands | undefined {
        if (!this.lastSelectedMatchNode) return undefined;
        return this.getMatchDataByItemId(
            `match:${this.lastSelectedMatchNode.blockIndex}:${this.lastSelectedMatchNode.matchIndex}`
        );
    }

    /** 根据树项 id 解析出「整块引文 + 文献片段」，供「查看 diff」「在 PDF 中搜索」使用 */
    getMatchDataByItemId(itemId: string | undefined): MatchDataForCommands | undefined {
        if (!itemId || !itemId.startsWith('match:')) return undefined;
        const parts = itemId.split(':');
        if (parts.length !== 3) return undefined;
        const blockIndex = parseInt(parts[1], 10);
        const matchIndex = parseInt(parts[2], 10);
        const block = this.blockResults[blockIndex];
        if (!block) return undefined;
        const match = block.matches[matchIndex];
        if (!match) return undefined;
        return {
            citationText: block.block.entry.text,
            refFragment: match.refFragment,
            refFilePath: match.file_path
        };
    }

    getBlockResult(node: CitationTreeNode): BlockMatchResult | undefined {
        if (node.kind === 'block') return node.data;
        if (node.kind === 'match') return this.blockResults[node.blockIndex];
        return undefined;
    }

    getDocumentUri(): vscode.Uri | null {
        return this.documentUri;
    }

    private preview(text: string): string {
        const t = text.replace(/\s+/g, ' ').trim();
        return t.length <= PREVIEW_LEN ? t : t.slice(0, PREVIEW_LEN) + '…';
    }
}
