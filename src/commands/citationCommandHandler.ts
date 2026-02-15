/**
 * 引文核对命令入口
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ReferenceStore, getCitationNormalizeOptions } from '../citation';
import { collectAllCitations, splitCitationBlocksIntoSentences, type CitationEntry } from '../citation';
import { matchCitationsToReferences } from '../citation/citationMatcher';
import { getJiebaWasm } from '../jiebaLoader';
import { focusCitationView } from '../citation/citationView';
import type { CitationTreeDataProvider } from '../citation/citationTreeProvider';
import type { CitationTreeNode } from '../citation/citationTreeProvider';
import { showDiff } from '../differ';
import { searchTextInPDF } from '../pdfSearcher';
import { normalizeLineEndings } from '../utils';

const CITATION_VIEW_BASE_TITLE = 'Citation';

export class CitationCommandHandler {
    constructor(
        private context: vscode.ExtensionContext,
        private citationTreeProvider: CitationTreeDataProvider | null = null,
        private citationTreeView: vscode.TreeView<CitationTreeNode> | null = null
    ) {}

    /** 更新引文 TreeView 标题栏显示的条目数量 */
    private updateCitationViewTitle(entryCount: number): void {
        if (this.citationTreeView) {
            this.citationTreeView.title = `${CITATION_VIEW_BASE_TITLE} (${entryCount})`;
        }
    }

    async handleRebuildIndexCommand(): Promise<void> {
        const refStore = ReferenceStore.getInstance(this.context);
        const root = refStore.getReferencesRoot();
        if (!root) {
            vscode.window.showWarningMessage('请先在设置中配置「引文核对：参考文献根路径」（ai-proofread.citation.referencesPath），如 test/references');
            return;
        }
        if (!fs.existsSync(root)) {
            vscode.window.showErrorMessage(`参考文献路径不存在: ${root}`);
            return;
        }

        const choice = await vscode.window.showQuickPick(
            [
                { label: '仅新文件与变更', description: '只索引新增或修改过的文献', fullRebuild: false },
                { label: '全部重新索引', description: '清空后重新索引所有文献', fullRebuild: true }
            ],
            { placeHolder: '选择重建方式', title: '重建引文索引' }
        );
        if (choice === undefined) return;

        try {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: choice.fullRebuild ? '正在全部重建引文索引...' : '正在更新引文索引（仅新/变更）...',
                    cancellable: true
                },
                async (progress, cancelToken) => {
                    progress.report({ message: '扫描文献...' });
                    const { fileCount, sentenceCount } = await refStore.rebuildIndex(cancelToken, choice.fullRebuild);
                    progress.report({ increment: 100 });
                    vscode.window.showInformationMessage(
                        choice.fullRebuild
                            ? `引文索引已全部重建：${fileCount} 个文件，${sentenceCount} 条句子。`
                            : `引文索引已更新：${fileCount} 个文件有变更，共 ${sentenceCount} 条句子。更新文献后请手动执行「重建引文索引」以刷新。`
                    );
                }
            );
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(`重建引文索引失败: ${msg}`);
        }
    }

    async handleOpenViewCommand(): Promise<void> {
        const doc = vscode.window.activeTextEditor?.document;
        if (!doc) {
            vscode.window.showWarningMessage('请先打开要核对的文档。');
            return;
        }
        const refStore = ReferenceStore.getInstance(this.context);
        const root = refStore.getReferencesRoot();
        if (!root || !fs.existsSync(root)) {
            vscode.window.showWarningMessage('请先在设置中配置并确保「引文核对：参考文献根路径」存在，然后执行「重建引文索引」。');
            if (this.citationTreeProvider) {
                this.citationTreeProvider.refresh([], null);
                this.updateCitationViewTitle(0);
                await focusCitationView();
            }
            return;
        }

        try {
            const entries = collectAllCitations(doc);
            const opts = getCitationNormalizeOptions();
            const blocks = splitCitationBlocksIntoSentences(entries, opts);
            const config = vscode.workspace.getConfiguration('ai-proofread.citation');
            const lenDeltaRatio = config.get<number>('lenDeltaRatio', 0.2);
            const matchesPerCitation = config.get<number>('matchesPerCitation', 2);

            const alignmentConfig = vscode.workspace.getConfiguration('ai-proofread.alignment');
            const similarityThreshold = alignmentConfig.get<number>('similarityThreshold', 0.4);
            const ngramSize = alignmentConfig.get<number>('ngramSize', 1);
            const ngramGranularity = alignmentConfig.get<'word' | 'char'>('ngramGranularity', 'word');
            let jieba: import('../jiebaLoader').JiebaWasmModule | undefined;
            if (ngramGranularity === 'word') {
                try {
                    const customDictPath = vscode.workspace.getConfiguration('ai-proofread.jieba').get<string>('customDictPath', '');
                    jieba = getJiebaWasm(path.join(this.context.extensionPath, 'dist'), customDictPath || undefined);
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    vscode.window.showErrorMessage(`jieba 加载失败，引文核对已中止（当前配置为词级相似度，需要 jieba）：${msg}`);
                    return;
                }
            }
            const blockResults = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: '引文核对',
                    cancellable: true
                },
                async (progress, cancelToken) => {
                    const cutMode = vscode.workspace.getConfiguration('ai-proofread.jieba').get<'default' | 'search'>('cutMode', 'default');
                    return matchCitationsToReferences(blocks, refStore, {
                        lenDeltaRatio,
                        similarityThreshold,
                        matchesPerCitation,
                        ngramSize,
                        ngramGranularity: jieba ? 'word' : 'char',
                        cutMode,
                        jieba,
                        cancelToken,
                        progress: (msg, cur, total) => progress.report({ message: msg, increment: total > 0 ? (100 / total) : 0 })
                    });
                }
            );

            if (this.citationTreeProvider) {
                this.citationTreeProvider.refresh(blockResults, doc.uri);
                this.updateCitationViewTitle(blockResults.length);
                await focusCitationView();
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(`引文核对失败: ${msg}`);
            if (this.citationTreeProvider) {
                this.citationTreeProvider.refresh([], null);
                this.updateCitationViewTitle(0);
            }
        }
    }

    /** 核对选中引文：用当前选中的文本作为一条引文，走现有匹配逻辑，结果展示在 Citation 树中 */
    async handleVerifySelectionCommand(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        const doc = editor?.document;
        if (!doc || !editor.selection || editor.selection.isEmpty) {
            vscode.window.showWarningMessage('请先选中要核对的引文文本。');
            return;
        }
        const refStore = ReferenceStore.getInstance(this.context);
        const root = refStore.getReferencesRoot();
        if (!root || !fs.existsSync(root)) {
            vscode.window.showWarningMessage('请先在设置中配置并确保「引文核对：参考文献根路径」存在，然后执行「重建引文索引」。');
            if (this.citationTreeProvider) {
                this.citationTreeProvider.refresh([], null);
                this.updateCitationViewTitle(0);
                await focusCitationView();
            }
            return;
        }
        const range = editor.selection;
        let text = normalizeLineEndings(doc.getText(range));
        text = text.split('\n').map((line) => line.replace(/^[\s>]+/, '')).join('\n').replace(/^\s+/, '');
        if (!text.trim()) {
            vscode.window.showWarningMessage('选中的内容为空。');
            return;
        }
        const startLine = range.start.line + 1;
        const endLine = range.end.line + 1;
        /** 去除左侧空格和 > 后的文本作为原始引文，后续与全文引文一致：分句、归一化、匹配 */
        const entry: CitationEntry = {
            uri: doc.uri,
            text,
            startLine,
            endLine,
            range,
            type: 'quote',
            confidence: 'citation'
        };
        try {
            const opts = getCitationNormalizeOptions();
            const blocks = splitCitationBlocksIntoSentences([entry], opts);
            if (blocks.length === 0) {
                vscode.window.showInformationMessage('选中文本分句后无有效句子，无法匹配。');
                if (this.citationTreeProvider) {
                    this.citationTreeProvider.refresh([], doc.uri);
                    this.updateCitationViewTitle(0);
                    await focusCitationView();
                }
                return;
            }
            const config = vscode.workspace.getConfiguration('ai-proofread.citation');
            const lenDeltaRatio = config.get<number>('lenDeltaRatio', 0.2);
            const matchesPerCitation = config.get<number>('matchesPerCitation', 2);
            const alignmentConfig = vscode.workspace.getConfiguration('ai-proofread.alignment');
            const similarityThreshold = alignmentConfig.get<number>('similarityThreshold', 0.4);
            const ngramSize = alignmentConfig.get<number>('ngramSize', 1);
            const ngramGranularity = alignmentConfig.get<'word' | 'char'>('ngramGranularity', 'word');
            let jieba: import('../jiebaLoader').JiebaWasmModule | undefined;
            if (ngramGranularity === 'word') {
                try {
                    const customDictPath = vscode.workspace.getConfiguration('ai-proofread.jieba').get<string>('customDictPath', '');
                    jieba = getJiebaWasm(path.join(this.context.extensionPath, 'dist'), customDictPath || undefined);
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    vscode.window.showErrorMessage(`jieba 加载失败，核对选中引文已中止（当前配置为词级相似度，需要 jieba）：${msg}`);
                    return;
                }
            }
            const blockResults = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: '核对选中引文',
                    cancellable: true
                },
                async (progress, cancelToken) => {
                    const cutMode = vscode.workspace.getConfiguration('ai-proofread.jieba').get<'default' | 'search'>('cutMode', 'default');
                    return matchCitationsToReferences(blocks, refStore, {
                        lenDeltaRatio,
                        similarityThreshold,
                        matchesPerCitation,
                        ngramSize,
                        ngramGranularity: jieba ? 'word' : 'char',
                        cutMode,
                        jieba,
                        cancelToken,
                        progress: (msg) => progress.report({ message: msg })
                    });
                }
            );
            if (this.citationTreeProvider) {
                this.citationTreeProvider.refresh(blockResults, doc.uri);
                this.updateCitationViewTitle(blockResults.length);
                await focusCitationView();
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(`核对选中引文失败: ${msg}`);
            if (this.citationTreeProvider) {
                this.citationTreeProvider.refresh([], null);
                this.updateCitationViewTitle(0);
            }
        }
    }

    /** 查看 diff：整块引文 vs 整段文献（需在引文核对视图中选中一条「匹配」节点） */
    async handleShowDiffCommand(nodeOrItem?: CitationTreeNode | { id?: string }): Promise<void> {
        const data = this.getSelectedMatchData(nodeOrItem);
        if (!data) {
            vscode.window.showWarningMessage('请在引文核对视图中选中一条匹配结果后再执行「diff citations vs references」。');
            return;
        }
        const refText = data.refFragment.map((r) => r.content).join('\n');
        try {
            await showDiff(
                this.context,
                data.citationText,
                refText,
                '.md',
                true,
                'Citation ↔ Reference'
            );
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(`diff citations vs references failed: ${msg}`);
        }
    }

    /** 在 PDF 中搜索：用文献片段首句在对应 PDF 中搜索（需在引文核对视图中选中一条「匹配」节点） */
    async handleSearchInPdfCommand(nodeOrItem?: CitationTreeNode | { id?: string }): Promise<void> {
        const data = this.getSelectedMatchData(nodeOrItem);
        if (!data) {
            vscode.window.showWarningMessage('请在引文核对视图中选中一条匹配结果后再执行「search citation in PDF」。');
            return;
        }
        const refStore = ReferenceStore.getInstance(this.context);
        const root = refStore.getReferencesRoot();
        if (!root) {
            vscode.window.showWarningMessage('未配置参考文献根路径，无法定位 PDF。');
            return;
        }
        const refPath = path.isAbsolute(data.refFilePath)
            ? data.refFilePath
            : path.join(root, data.refFilePath);
        const pdfPath = path.join(
            path.dirname(refPath),
            path.basename(refPath, path.extname(refPath)) + '.pdf'
        );
        const searchText = data.refFragment.length > 0 ? data.refFragment[0].content : '';
        await searchTextInPDF(pdfPath, searchText);
    }

    /** 获取当前选中的匹配数据：优先用命令参数（菜单传入的 node 或 TreeItem.id），其次 treeView.selection，最后用 provider 保存的“最后选中” */
    private getSelectedMatchData(nodeOrItem?: CitationTreeNode | { id?: string }) {
        if (this.citationTreeProvider && nodeOrItem) {
            if ('id' in nodeOrItem && typeof (nodeOrItem as { id?: string }).id === 'string') {
                const data = this.citationTreeProvider.getMatchDataByItemId((nodeOrItem as { id: string }).id);
                if (data) return data;
            }
            if ('kind' in nodeOrItem && (nodeOrItem as CitationTreeNode).kind === 'match') {
                const node = nodeOrItem as CitationTreeNode;
                const data = this.citationTreeProvider.getMatchDataByItemId(
                    `match:${node.blockIndex}:${node.matchIndex}`
                );
                if (data) return data;
            }
        }
        if (!this.citationTreeProvider || !this.citationTreeView) return undefined;
        const node = this.citationTreeView.selection[0];
        if (node && node.kind === 'match') {
            return this.citationTreeProvider.getMatchDataByItemId(
                `match:${node.blockIndex}:${node.matchIndex}`
            );
        }
        return this.citationTreeProvider.getMatchDataFromLastSelected();
    }
}
