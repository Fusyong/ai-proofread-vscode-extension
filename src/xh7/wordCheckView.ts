/**
 * 检查字词：注册 TreeView、选中回调、当前条目与当前处索引、聚焦视图
 * 规划见 docs/xh7-word-check-plan.md
 */

import * as vscode from 'vscode';
import type { WordCheckEntry } from './types';
import { WordCheckTreeDataProvider } from './wordCheckTreeProvider';

export const VIEW_ID = 'ai-proofread.wordCheck';

export interface WordCheckViewRegistration {
    provider: WordCheckTreeDataProvider;
    treeView: vscode.TreeView<WordCheckEntry>;
}

/** 当前选中的条目与当前定位索引（用于上一处/下一处） */
let lastSelectedEntry: WordCheckEntry | null = null;
let currentOccurrenceIndex: number = 0;

export function getLastSelectedEntry(): WordCheckEntry | null {
    return lastSelectedEntry;
}

export function getCurrentOccurrenceIndex(): number {
    return currentOccurrenceIndex;
}

export function setCurrentOccurrenceIndex(index: number): void {
    currentOccurrenceIndex = index;
}

/**
 * 选中条目时：记录条目，并将「当前处」设为 0，定位到第一处。
 * 双击条目由 TreeItem.command 触发「下一处」命令。
 */
export function registerWordCheckView(
    context: vscode.ExtensionContext,
    onReveal: (entry: WordCheckEntry, index: number) => void
): WordCheckViewRegistration {
    const treeDataProvider = new WordCheckTreeDataProvider();
    const treeView = vscode.window.createTreeView(VIEW_ID, {
        treeDataProvider,
        showCollapseAll: true,
    });

    context.subscriptions.push(
        treeView,
        treeView.onDidChangeSelection((e) => {
            const entry = e.selection[0] ?? null;
            lastSelectedEntry = entry;
            currentOccurrenceIndex = 0;
            if (!entry) return;
            onReveal(entry, 0);
        })
    );

    return { provider: treeDataProvider, treeView };
}

/** 供外部更新「最后选中条目」（如从上下文菜单执行上一处/下一处时，selection 可能为空） */
export function setLastSelectedEntry(entry: WordCheckEntry | null): void {
    lastSelectedEntry = entry;
}

/** 聚焦字词检查视图 */
export async function focusWordCheckView(): Promise<void> {
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
}
