/**
 * 文档内重复句扫描命令
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { findDuplicatesInText } from '../duplicate/findDuplicates';
import type { DuplicateScanMode } from '../duplicate/types';
import { getJiebaWasm } from '../jiebaLoader';
import { focusDuplicateView } from '../duplicate/duplicateView';
import type { DuplicateTreeDataProvider } from '../duplicate/duplicateTreeProvider';
import { normalizeLineEndings } from '../utils';

const VIEW_BASE_TITLE = 'Duplicates';

export class DuplicateCommandHandler {
    constructor(
        private context: vscode.ExtensionContext,
        private duplicateTreeProvider: DuplicateTreeDataProvider | null = null,
        private duplicateTreeView: vscode.TreeView<import('../duplicate/duplicateTreeProvider').DuplicateTreeNode> | null = null
    ) {}

    private updateTitle(exactCount: number, fuzzyCount: number): void {
        if (this.duplicateTreeView) {
            const parts: string[] = [];
            if (exactCount > 0) parts.push(`相同 ${exactCount}`);
            if (fuzzyCount > 0) parts.push(`近似 ${fuzzyCount}`);
            this.duplicateTreeView.title = parts.length > 0 ? `${VIEW_BASE_TITLE} (${parts.join('，')})` : VIEW_BASE_TITLE;
        }
    }

    private async pickMode(): Promise<DuplicateScanMode | undefined> {
        const picked = await vscode.window.showQuickPick(
            [
                { label: '完全重复（归一化后相同）', value: 'exact' as const },
                { label: '近似重复（Jaccard 达阈值）', value: 'fuzzy' as const },
                { label: '两者都扫描', value: 'both' as const }
            ],
            { placeHolder: '选择重复检测方式', title: '文档内重复' }
        );
        return picked?.value;
    }

    async handleScanDocument(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('请先打开要扫描的文档。');
            return;
        }
        const mode = await this.pickMode();
        if (mode === undefined) return;
        await this.runScan(editor, normalizeLineEndings(editor.document.getText()), 0, mode);
    }

    async handleScanSelection(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        const doc = editor?.document;
        if (!editor || !doc) {
            vscode.window.showWarningMessage('请先打开文档。');
            return;
        }
        if (editor.selection.isEmpty) {
            vscode.window.showWarningMessage('请先选中要扫描的文本范围。');
            return;
        }
        const mode = await this.pickMode();
        if (mode === undefined) return;
        const range = editor.selection;
        const text = normalizeLineEndings(doc.getText(range));
        const offsetBase = doc.offsetAt(range.start);
        await this.runScan(editor, text, offsetBase, mode);
    }

    private async runScan(
        editor: vscode.TextEditor,
        text: string,
        offsetBase: number,
        mode: DuplicateScanMode
    ): Promise<void> {
        if (!text.trim()) {
            vscode.window.showWarningMessage('扫描范围为空。');
            return;
        }

        const citationCfg = vscode.workspace.getConfiguration('ai-proofread.citation');
        const alignmentCfg = vscode.workspace.getConfiguration('ai-proofread.alignment');
        const jiebaCfg = vscode.workspace.getConfiguration('ai-proofread.jieba');

        const minCitationLength = Math.max(0, citationCfg.get<number>('minCitationLength', 5));
        const lenDeltaRatio = citationCfg.get<number>('lenDeltaRatio', 0.2);
        const openccT2cn = citationCfg.get<boolean>('openccT2cnBeforeSimilarity', false);
        const similarityThreshold = alignmentCfg.get<number>('similarityThreshold', 0.4);
        const ngramSize = alignmentCfg.get<number>('ngramSize', 1);
        const ngramGranularity = alignmentCfg.get<'word' | 'char'>('ngramGranularity', 'word');
        const cutMode = jiebaCfg.get<'default' | 'search'>('cutMode', 'default');
        const customDictPath = jiebaCfg.get<string>('customDictPath', '');

        let jieba: import('../jiebaLoader').JiebaWasmModule | undefined;
        if (mode !== 'exact' && ngramGranularity === 'word') {
            try {
                jieba = getJiebaWasm(path.join(this.context.extensionPath, 'dist'), customDictPath || undefined);
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                vscode.window.showErrorMessage(`jieba 加载失败，无法使用词级相似度：${msg}`);
                return;
            }
        }

        try {
            const result = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: '文档内重复扫描',
                    cancellable: true
                },
                async (progress, token) => {
                    return findDuplicatesInText({
                        text,
                        useSimpleSplitter: true,
                        minCitationLength,
                        lenDeltaRatio,
                        similarityThreshold,
                        ngramSize,
                        ngramGranularity: jieba ? ngramGranularity : 'char',
                        cutMode,
                        jieba,
                        openccT2cnBeforeSimilarity: openccT2cn,
                        mode,
                        cancelToken: token,
                        progress: (msg, done, total) => {
                            progress.report({ message: msg, increment: total > 0 ? 0 : 0 });
                        }
                    });
                }
            );

            if (this.duplicateTreeProvider) {
                this.duplicateTreeProvider.refresh(
                    result.exactGroups,
                    result.fuzzyGroups,
                    editor.document.uri,
                    offsetBase
                );
                this.updateTitle(result.exactGroups.length, result.fuzzyGroups.length);
                await focusDuplicateView();
            }

            const nExact = result.exactGroups.length;
            const nFuzzy = result.fuzzyGroups.length;
            if (nExact === 0 && nFuzzy === 0) {
                vscode.window.showInformationMessage('未发现重复句。');
            } else {
                vscode.window.showInformationMessage(
                    `扫描完成：完全重复组 ${nExact}，近似重复组 ${nFuzzy}。`
                );
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(`重复扫描失败: ${msg}`);
            if (this.duplicateTreeProvider) {
                this.duplicateTreeProvider.refresh([], [], null, 0);
                this.updateTitle(0, 0);
            }
        }
    }
}
