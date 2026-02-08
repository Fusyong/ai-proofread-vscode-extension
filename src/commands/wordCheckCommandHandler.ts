/**
 * 检查字词：命令入口（检查字词、上一处、下一处、查看说明）
 * 规划见 docs/xh7-word-check-plan.md
 */

import * as vscode from 'vscode';
import type { WordCheckEntry } from '../xh7/types';
import type { WordCheckTreeDataProvider } from '../xh7/wordCheckTreeProvider';
import {
    registerWordCheckView,
    focusWordCheckView,
    getLastSelectedEntry,
    getCurrentOccurrenceIndex,
    setCurrentOccurrenceIndex,
} from '../xh7/wordCheckView';
import { initTableLoader, getDict } from '../xh7/tableLoader';
import { scanDocument } from '../xh7/documentScanner';
import { formatFullNotesAsHtml } from '../xh7/notesResolver';
import { CHECK_TYPE_LABELS, type CheckType } from '../xh7/types';

const VIEW_BASE_TITLE = 'checkWords';

export class WordCheckCommandHandler {
    private treeView: vscode.TreeView<WordCheckEntry> | null = null;
    private treeProvider: WordCheckTreeDataProvider | null = null;

    constructor(private context: vscode.ExtensionContext) {
        initTableLoader(context);
    }

    /** 注册视图并绑定选中回调；返回 provider 与 treeView 供扩展注册命令时使用 */
    registerView(): { provider: WordCheckTreeDataProvider; treeView: vscode.TreeView<WordCheckEntry> } {
        const reg = registerWordCheckView(this.context, (entry, index) => this.revealEntryAt(entry, index, true));
        this.treeProvider = reg.provider;
        this.treeView = reg.treeView;
        return reg;
    }

    private updateViewTitle(entryCount: number, occurrenceCount: number): void {
        if (this.treeView) {
            this.treeView.title = `${VIEW_BASE_TITLE} (${entryCount} 条 / ${occurrenceCount} 处)`;
        }
    }

    /**
     * 在编辑器中揭示并选中某条目的第 index 处。
     * @param preserveFocus true 时仅滚动/选中，焦点留在树（便于用方向键浏览）；false 时激活编辑器。
     */
    private revealEntryAt(entry: WordCheckEntry, index: number, preserveFocus = true): void {
        if (entry.ranges.length === 0) return;
        const docUri = this.treeProvider?.getDocumentUri();
        if (!docUri) return;
        const idx = ((index % entry.ranges.length) + entry.ranges.length) % entry.ranges.length;
        const range = entry.ranges[idx];
        setCurrentOccurrenceIndex(idx);
        vscode.window.showTextDocument(docUri, { selection: range, preserveFocus }).then((editor) => {
            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
            editor.selection = new vscode.Selection(range.start, range.end);
        });
    }

    async handleCheckWordsCommand(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('请先打开要检查的文档。');
            return;
        }

        const typeChoices = await vscode.window.showQuickPick(
            (Object.entries(CHECK_TYPE_LABELS) as [CheckType, string][]).map(([value, label]) => ({
                label,
                value,
                picked: value === 'variant_to_standard',
            })),
            { placeHolder: '勾选要检查的类型（可多选）', title: '检查字词', canPickMany: true }
        );
        if (!typeChoices?.length) return;

        const checkTypes = typeChoices.map((c) => c.value as CheckType);
        const scanRange = editor.selection.isEmpty ? undefined : new vscode.Range(editor.selection.start, editor.selection.end);

        try {
            const entries = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: scanRange ? '字词检查（选中范围）' : '字词检查',
                    cancellable: true,
                },
                async (progress, cancelToken) => {
                    const merged = new Map<string, WordCheckEntry>();
                    for (let i = 0; i < checkTypes.length; i++) {
                        if (cancelToken.isCancellationRequested) break;
                        const type = checkTypes[i];
                        progress.report({ message: `加载字词表 (${i + 1}/${checkTypes.length})…` });
                        const dict = getDict(type);
                        if (Object.keys(dict).length === 0) continue;
                        progress.report({ message: scanRange ? '扫描选中文本…' : '扫描文档…' });
                        const list = scanDocument(editor.document, dict, cancelToken, scanRange);
                        for (const e of list) {
                            const key = `${e.variant}|${e.preferred}`;
                            const existing = merged.get(key);
                            if (existing) {
                                existing.ranges.push(...e.ranges);
                            } else {
                                merged.set(key, { ...e, ranges: [...e.ranges] });
                            }
                        }
                    }
                    return Array.from(merged.values());
                }
            );

            if (!this.treeProvider) return;
            this.treeProvider.refresh(entries, editor.document.uri);
            const totalOccurrences = entries.reduce((s, e) => s + e.ranges.length, 0);
            this.updateViewTitle(entries.length, totalOccurrences);
            await focusWordCheckView();
            if (entries.length === 0) {
                vscode.window.showInformationMessage('当前文档中未发现需要提示的字词。');
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(`字词检查失败：${msg}`);
            if (this.treeProvider) {
                this.treeProvider.refresh([], null);
                this.updateViewTitle(0, 0);
            }
        }
    }

    /** 上一处：在当前选中条目的多处之间循环（激活编辑器） */
    async handlePrevOccurrenceCommand(): Promise<void> {
        const entry = this.getSelectedEntry();
        if (!entry || entry.ranges.length === 0) {
            vscode.window.showWarningMessage('请先在字词检查视图中选中一条条目。');
            return;
        }
        let idx = getCurrentOccurrenceIndex();
        idx = (idx - 1 + entry.ranges.length) % entry.ranges.length;
        setCurrentOccurrenceIndex(idx);
        this.revealEntryAt(entry, idx, false);
    }

    /** 下一处（上下文菜单用：先前进再定位，激活编辑器） */
    async handleNextOccurrenceCommand(): Promise<void> {
        const entry = this.getSelectedEntry();
        if (!entry || entry.ranges.length === 0) {
            vscode.window.showWarningMessage('请先在字词检查视图中选中一条条目。');
            return;
        }
        let idx = getCurrentOccurrenceIndex();
        idx = (idx + 1) % entry.ranges.length;
        setCurrentOccurrenceIndex(idx);
        this.revealEntryAt(entry, idx, false);
    }

    /** 揭示当前处并前进（TreeItem 单击/Enter/双击时都会触发，保持焦点在树以便键盘浏览；需激活编辑器时用上下文菜单「上一处/下一处」） */
    async handleRevealCurrentAndAdvanceCommand(): Promise<void> {
        const entry = this.getSelectedEntry();
        if (!entry || entry.ranges.length === 0) return;
        const idx = getCurrentOccurrenceIndex();
        this.revealEntryAt(entry, idx, true);
        setCurrentOccurrenceIndex((idx + 1) % entry.ranges.length);
    }

    /** 查看说明：用 Webview 展示当前条目的完整注释 */
    async handleShowNotesCommand(): Promise<void> {
        const entry = this.getSelectedEntry();
        if (!entry) {
            vscode.window.showWarningMessage('请先在字词检查视图中选中一条条目。');
            return;
        }
        const html = formatFullNotesAsHtml(entry.preferred, entry.variant);
        const panel = vscode.window.createWebviewPanel(
            'wordCheckNotes',
            `说明：${entry.variant} → ${entry.preferred}`,
            vscode.ViewColumn.Beside,
            { enableScripts: false }
        );
        panel.webview.html = getNotesWebviewHtml(html);
    }

    private getSelectedEntry(): WordCheckEntry | null {
        if (this.treeView?.selection?.[0]) return this.treeView.selection[0];
        return getLastSelectedEntry();
    }
}

function getNotesWebviewHtml(bodyHtml: string): string {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); padding: 1em; line-height: 1.6; }
h4 { margin-top: 1em; margin-bottom: 0.4em; }
.notes { margin-bottom: 0.8em; }
sup, small { font-size: 0.85em; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}
