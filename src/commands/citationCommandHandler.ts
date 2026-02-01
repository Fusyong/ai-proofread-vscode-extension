/**
 * 引文核对命令入口
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ReferenceStore, getCitationNormalizeOptions } from '../citation';
import { collectAllCitations, splitCitationBlocksIntoSentences } from '../citation';
import { matchCitationsToReferences } from '../citation/citationMatcher';
import { focusCitationView } from '../citation/citationView';
import type { CitationTreeDataProvider } from '../citation/citationTreeProvider';
import type { CitationTreeNode } from '../citation/citationTreeProvider';
import { showDiff } from '../differ';
import { searchTextInPDF } from '../pdfSearcher';

const OUTPUT_CHANNEL_NAME = '引文核对';

export class CitationCommandHandler {
    private outputChannel: vscode.OutputChannel | null = null;

    constructor(
        private context: vscode.ExtensionContext,
        private citationTreeProvider: CitationTreeDataProvider | null = null,
        private citationTreeView: vscode.TreeView<CitationTreeNode> | null = null
    ) {}

    private getOutputChannel(): vscode.OutputChannel {
        if (!this.outputChannel) {
            this.outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
        }
        return this.outputChannel;
    }

    /** 测试引文收集：对当前文档收集引文并分句，输出到「引文核对」输出通道 */
    async handleTestCollectorCommand(): Promise<void> {
        const doc = vscode.window.activeTextEditor?.document;
        if (!doc) {
            vscode.window.showWarningMessage('请先打开要核对的文档。');
            return;
        }
        const ch = this.getOutputChannel();
        ch.clear();
        ch.show();
        ch.appendLine(`=== 引文收集测试：${doc.fileName} ===`);
        const entries = collectAllCitations(doc);
        ch.appendLine(`共收集到 ${entries.length} 个引文块。`);
        for (let i = 0; i < entries.length; i++) {
            const e = entries[i];
            ch.appendLine(`\n[${i + 1}] ${e.type} L${e.startLine}-${e.endLine} ${e.confidence ?? 'citation'}${e.reason ? ` (${e.reason})` : ''}`);
            ch.appendLine(`  "${e.text.slice(0, 80)}${e.text.length > 80 ? '...' : ''}"`);
            if (e.footnoteMarker) ch.appendLine(`  注码: ${e.footnoteMarker}`);
        }
        const opts = getCitationNormalizeOptions();
        const blocks = splitCitationBlocksIntoSentences(entries, opts);
        let sentenceCount = 0;
        for (const blk of blocks) {
            sentenceCount += blk.sentences.length;
        }
        ch.appendLine(`\n分句后共 ${sentenceCount} 条引文句。`);
        for (const blk of blocks) {
            ch.appendLine(`  块 ${blk.entry.startLine}-${blk.entry.endLine}: ${blk.sentences.length} 句`);
            for (const s of blk.sentences) {
                ch.appendLine(`    句 ${s.sentenceIndex + 1} L${s.startLine}-${s.endLine} lenNorm=${s.lenNorm}: "${s.text.slice(0, 50)}${s.text.length > 50 ? '...' : ''}"`);
            }
        }
        ch.appendLine('\n=== 测试结束 ===');
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
                await focusCitationView();
            }
            return;
        }

        try {
            const entries = collectAllCitations(doc);
            const opts = getCitationNormalizeOptions();
            const blocks = splitCitationBlocksIntoSentences(entries, opts);
            const config = vscode.workspace.getConfiguration('ai-proofread.citation');
            const lenDelta = config.get<number>('lenDelta', 10);
            const matchesPerCitation = config.get<number>('matchesPerCitation', 2);

            const alignmentConfig = vscode.workspace.getConfiguration('ai-proofread.alignment');
            const similarityThreshold = alignmentConfig.get<number>('similarityThreshold', 0.4);
            const blockResults = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: '引文核对',
                    cancellable: true
                },
                async (progress, cancelToken) => {
                    return matchCitationsToReferences(blocks, refStore, {
                        lenDelta,
                        similarityThreshold,
                        matchesPerCitation,
                        cancelToken,
                        progress: (msg, cur, total) => progress.report({ message: msg, increment: total > 0 ? (100 / total) : 0 })
                    });
                }
            );

            if (this.citationTreeProvider) {
                this.citationTreeProvider.refresh(blockResults, doc.uri);
                await focusCitationView();
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(`引文核对失败: ${msg}`);
            if (this.citationTreeProvider) {
                this.citationTreeProvider.refresh([], null);
            }
        }
    }

    /** 查看 diff：整块引文 vs 整段文献（需在引文核对视图中选中一条「匹配」节点） */
    async handleShowDiffCommand(nodeOrItem?: CitationTreeNode | { id?: string }): Promise<void> {
        const data = this.getSelectedMatchData(nodeOrItem);
        if (!data) {
            vscode.window.showWarningMessage('请在引文核对视图中选中一条匹配结果（文献名 + 相似度）后再执行「查看 diff」。');
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
            vscode.window.showErrorMessage(`查看 diff 失败: ${msg}`);
        }
    }

    /** 在 PDF 中搜索：用文献片段首句在对应 PDF 中搜索（需在引文核对视图中选中一条「匹配」节点） */
    async handleSearchInPdfCommand(nodeOrItem?: CitationTreeNode | { id?: string }): Promise<void> {
        const data = this.getSelectedMatchData(nodeOrItem);
        if (!data) {
            vscode.window.showWarningMessage('请在引文核对视图中选中一条匹配结果后再执行「在 PDF 中搜索」。');
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
