/**
 * 引文核对命令入口
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { ReferenceStore, getCitationNormalizeOptions } from '../citation';
import { collectAllCitations, splitCitationBlocksIntoSentences } from '../citation';

const OUTPUT_CHANNEL_NAME = '引文核对';

export class CitationCommandHandler {
    private outputChannel: vscode.OutputChannel | null = null;

    constructor(private context: vscode.ExtensionContext) {}

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

        try {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: '正在重建引文参考文献索引...',
                    cancellable: true
                },
                async (progress, cancelToken) => {
                    progress.report({ message: '扫描文献...' });
                    const { fileCount, sentenceCount } = await refStore.rebuildIndex(cancelToken);
                    progress.report({ increment: 100 });
                    vscode.window.showInformationMessage(`引文索引已重建：${fileCount} 个文件，${sentenceCount} 条句子。`);
                }
            );
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(`重建引文索引失败: ${msg}`);
        }
    }

    async handleOpenViewCommand(): Promise<void> {
        vscode.window.showInformationMessage('引文核对视图将在后续阶段接入。');
    }
}
