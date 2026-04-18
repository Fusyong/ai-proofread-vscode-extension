/**
 * 文档内重复句扫描命令
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { findDuplicatesInText } from '../duplicate/findDuplicates';
import { getJiebaWasm } from '../jiebaLoader';
import { focusDuplicateView } from '../duplicate/duplicateView';
import type { DuplicateTreeDataProvider } from '../duplicate/duplicateTreeProvider';
import { normalizeLineEndings, normIndexToRawIndex } from '../utils';
import type { DuplicateScanResult, DuplicateOccurrence } from '../duplicate/types';

const VIEW_BASE_TITLE = 'Duplicates';

function mapScanResultToDocumentOffsets(
    result: DuplicateScanResult,
    rawSlice: string,
    offsetBase: number
): DuplicateScanResult {
    const mapOcc = (occ: DuplicateOccurrence): DuplicateOccurrence => ({
        ...occ,
        startOffset: offsetBase + normIndexToRawIndex(rawSlice, occ.startOffset),
        endOffset: offsetBase + normIndexToRawIndex(rawSlice, occ.endOffset)
    });
    return {
        exactGroups: result.exactGroups.map((g) => ({
            ...g,
            occurrences: g.occurrences.map(mapOcc)
        })),
        fuzzyGroups: result.fuzzyGroups.map((g) => ({
            ...g,
            occurrences: g.occurrences.map(mapOcc)
        }))
    };
}

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

    async handleScanDocument(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('请先打开要扫描的文档。');
            return;
        }
        const rawSlice = editor.document.getText();
        await this.runScan(editor, normalizeLineEndings(rawSlice), rawSlice, 0);
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
        const range = editor.selection;
        const rawSlice = doc.getText(range);
        const text = normalizeLineEndings(rawSlice);
        const offsetBase = doc.offsetAt(range.start);
        await this.runScan(editor, text, rawSlice, offsetBase);
    }

    private async runScan(
        editor: vscode.TextEditor,
        text: string,
        rawSlice: string,
        offsetBase: number
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
        if (ngramGranularity === 'word') {
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
                        mode: 'both',
                        cancelToken: token,
                        progress: (msg, done, total) => {
                            progress.report({ message: msg, increment: total > 0 ? 0 : 0 });
                        }
                    });
                }
            );

            const mapped = mapScanResultToDocumentOffsets(result, rawSlice, offsetBase);

            if (this.duplicateTreeProvider) {
                this.duplicateTreeProvider.refresh(
                    mapped.exactGroups,
                    mapped.fuzzyGroups,
                    editor.document.uri
                );
                this.updateTitle(result.exactGroups.length, result.fuzzyGroups.length);
                await focusDuplicateView();
            }

            const nExact = mapped.exactGroups.length;
            const nFuzzy = mapped.fuzzyGroups.length;
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
                this.duplicateTreeProvider.refresh([], [], null);
                this.updateTitle(0, 0);
            }
        }
    }
}
