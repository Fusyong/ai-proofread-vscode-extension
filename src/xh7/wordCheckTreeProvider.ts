/**
 * 检查字词：TreeView 数据提供者，仅一级条目，无子节点
 * 规划见 docs/xh7-word-check-plan.md
 */

import * as vscode from 'vscode';
import type { WordCheckEntry } from './types';
import { getShortNotesForPreferred } from './notesResolver';

export class WordCheckTreeDataProvider implements vscode.TreeDataProvider<WordCheckEntry> {
    private _onDidChangeTreeData = new vscode.EventEmitter<WordCheckEntry | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private entries: WordCheckEntry[] = [];
    private documentUri: vscode.Uri | null = null;

    refresh(entries: WordCheckEntry[], documentUri: vscode.Uri | null): void {
        this.entries = entries;
        this.documentUri = documentUri;
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: WordCheckEntry): vscode.TreeItem {
        const label = `${element.variant}：${element.preferred}`;
        const count = element.ranges.length;
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.id = `${element.variant}|${element.preferred}`;
        item.description = ` ${count}`;
        const shortNotes = getShortNotesForPreferred(element.preferred);
        item.tooltip = shortNotes ? `${label}\n\n${shortNotes}` : label;
        item.contextValue = 'wordCheckEntry';
        // 双击/激活条目时：先揭示当前处再前进（单击时 selection 已把索引置 0，故第一次激活定位第一处，再次激活定位下一处）
        item.command = { command: 'ai-proofread.wordCheck.revealCurrentAndAdvance', title: '下一处' };
        return item;
    }

    getChildren(_element?: WordCheckEntry): WordCheckEntry[] {
        if (_element) return [];
        return this.entries;
    }

    getDocumentUri(): vscode.Uri | null {
        return this.documentUri;
    }

    getEntries(): WordCheckEntry[] {
        return this.entries;
    }

    getEntryById(itemId: string | undefined): WordCheckEntry | undefined {
        if (!itemId || !itemId.includes('|')) return undefined;
        return this.entries.find((e) => `${e.variant}|${e.preferred}` === itemId);
    }
}
