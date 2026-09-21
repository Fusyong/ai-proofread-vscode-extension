/**
 * 句子对齐命令处理器
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getAlignmentStatistics, type AlignmentOptions } from '../sentenceAligner';
import { alignDocuments } from '../documentAligner';
import { promptAlignmentAlgorithm } from '../alignmentUi';
import { FilePathUtils, ErrorUtils } from '../utils';
import { alignmentJsonPath, generateHtmlReport } from '../alignmentReportGenerator';
import { getJiebaWasm } from '../jiebaLoader';
import { collectWordErrors, formatWordErrors, parseDelimitersFromConfig } from '../wordErrorCollector';

export class SentenceAlignmentCommandHandler {
    /**
     * 处理句子对齐命令
     */
    public async handleAlignSentencesCommand(
        editor: vscode.TextEditor | undefined,
        context: vscode.ExtensionContext
    ): Promise<void> {
        try {
            // 第一个提示界面：选择原文件
            const proceedA = await vscode.window.showQuickPick(
                [
                    { label: '选择原文件', description: '选择需要进行对齐的原文件（文件A）' },
                    { label: '取消', description: '取消操作' }
                ],
                {
                    placeHolder: '句子对齐：请选择原文件（文件A）',
                    ignoreFocusOut: true
                }
            );

            if (!proceedA || proceedA.label === '取消') {
                return;
            }

            // 让用户选择a文件（原文）
            const fileUrisA = await vscode.window.showOpenDialog({
                canSelectMany: false,
                filters: {
                    'Markdown文件': ['md', 'markdown'],
                    'Text文件': ['txt'],
                    '所有文件': ['*']
                },
                title: '选择原文件（文件A）'
            });

            if (!fileUrisA || fileUrisA.length === 0) {
                return;
            }

            const fileA = fileUrisA[0].fsPath;

            // 第二个提示界面：选择修改后的文件
            const proceedB = await vscode.window.showQuickPick(
                [
                    { label: '选择修改后的文件', description: '选择修改后的文件（文件B）' },
                    { label: '取消', description: '取消操作' }
                ],
                {
                    placeHolder: '句子对齐：请选择修改后的文件（文件B）',
                    ignoreFocusOut: true
                }
            );

            if (!proceedB || proceedB.label === '取消') {
                return;
            }

            // 让用户选择b文件（校对后）
            const fileUrisB = await vscode.window.showOpenDialog({
                canSelectMany: false,
                filters: {
                    'Markdown文件': ['md', 'markdown'],
                    'Text文件': ['txt'],
                    '所有文件': ['*']
                },
                title: '选择校对后文件（文件B）'
            });

            if (!fileUrisB || fileUrisB.length === 0) {
                return;
            }

            const fileB = fileUrisB[0].fsPath;

            // 读取对齐参数配置（归一化与引文核对共用 citation 配置）
            const config = vscode.workspace.getConfiguration('ai-proofread.alignment');
            const citationConfig = vscode.workspace.getConfiguration('ai-proofread.citation');

            const configuredAlgo = config.get<'anchor' | 'wordDiff'>('algorithm', 'anchor');
            const algorithm = await promptAlignmentAlgorithm(configuredAlgo);
            if (!algorithm) {
                return;
            }

            const collectWordErrorsChoice = await vscode.window.showQuickPick(
                [
                    { label: '否', description: '仅生成勘误表（默认）', value: false },
                    { label: '是', description: '同时收集常用词语错误', value: true }
                ],
                {
                    placeHolder: '是否同时收集常用词语错误？',
                    title: '常用词语错误',
                    ignoreFocusOut: true
                }
            );
            const shouldCollectWordErrors = collectWordErrorsChoice?.value ?? false;

            const ngramGranularity = config.get<'word' | 'char'>('ngramGranularity', 'word');
            let jieba: import('../jiebaLoader').JiebaWasmModule | undefined;
            if (ngramGranularity === 'word' || shouldCollectWordErrors) {
                try {
                    const customDictPath = vscode.workspace.getConfiguration('ai-proofread.jieba').get<string>('customDictPath', '');
                    jieba = getJiebaWasm(path.join(context.extensionPath, 'dist'), customDictPath || undefined);
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    vscode.window.showErrorMessage(`jieba 加载失败，${shouldCollectWordErrors ? '词语错误收集需要 jieba；' : ''}${ngramGranularity === 'word' ? '当前配置为词级相似度，需要 jieba；' : ''}已中止：${msg}`);
                    return;
                }
            }
            const options: AlignmentOptions = {
                algorithm,
                wordDiffFallbackToAnchor: config.get<boolean>('wordDiffFallbackToAnchor', true),
                windowSize: config.get<number>('windowSize', 10),
                similarityThreshold: config.get<number>('similarityThreshold', 0.6),
                ngramSize: config.get<number>('ngramSize', 1),
                ngramGranularity: jieba ? 'word' : 'char',
                cutMode: vscode.workspace.getConfiguration('ai-proofread.jieba').get<'default' | 'search'>('cutMode', 'default'),
                jieba,
                offset: config.get<number>('offset', 1),
                maxWindowExpansion: config.get<number>('maxWindowExpansion', 3),
                consecutiveFailThreshold: config.get<number>('consecutiveFailThreshold', 3),
                removeInnerWhitespace: config.get<boolean>('removeInnerWhitespace', true),
                removePunctuation: citationConfig.get<boolean>('normalizeIgnorePunctuation', false),
                removeDigits: config.get<boolean>('normalizeIgnoreDigits', false),
                removeLatin: config.get<boolean>('normalizeIgnoreLatin', false)
            };

            // 显示进度
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: '正在对齐句子...',
                cancellable: false
            }, async (progress) => {
                progress.report({ increment: 0, message: '读取文件...' });

                const textA = fs.readFileSync(fileA, 'utf8');
                const textB = fs.readFileSync(fileB, 'utf8');

                progress.report({ increment: 40, message: '执行对齐算法...' });

                const { alignment, fellBackToAnchor } = alignDocuments(textA, textB, options);

                progress.report({ increment: 85, message: '生成报告...' });

                const stats = getAlignmentStatistics(alignment);
                const titleA = path.basename(fileA);
                const titleB = path.basename(fileB);
                const outputFile = FilePathUtils.getFilePath(fileA, '.alignment', '.html');
                const runtime = 0;

                generateHtmlReport(alignment, outputFile, titleA, titleB, options, runtime);

                let wordErrorsMessage = '';
                if (shouldCollectWordErrors && jieba) {
                    progress.report({ increment: 95, message: '收集词语错误...' });
                    const weConfig = vscode.workspace.getConfiguration('ai-proofread.wordErrorCollector');
                    const delimitersStr = weConfig.get<string>('delimiters', '，；。？！');
                    const delimiters = parseDelimitersFromConfig(delimitersStr);
                    const clauseThreshold = weConfig.get<number>('clauseSimilarityThreshold', 0.4);
                    const cutMode = vscode.workspace.getConfiguration('ai-proofread.jieba').get<'default' | 'search'>('cutMode', 'default');
                    const entries = collectWordErrors(alignment, {
                        jieba,
                        cutMode,
                        delimiters,
                        clauseSimilarityThreshold: clauseThreshold
                    });
                    const wordErrorsPath = FilePathUtils.getFilePath(fileA, '.word-errors', '.csv');
                    fs.writeFileSync(wordErrorsPath, formatWordErrors(entries), 'utf8');
                    wordErrorsMessage = `\n词语错误已保存至: ${path.basename(wordErrorsPath)}（${entries.length} 条）`;
                }

                progress.report({ increment: 100, message: '完成' });

                const fallbackNote = fellBackToAnchor ? '\n（检测到调序，已回退锚点算法）' : '';
                const statsMessage = `对齐完成！${fallbackNote}\n` +
                    `算法: ${options.algorithmDisplayName ?? algorithm}\n` +
                    `总计: ${stats.total}\n` +
                    `匹配: ${stats.match}\n` +
                    `删除: ${stats.delete}\n` +
                    `新增: ${stats.insert}\n` +
                    `移出: ${stats.moveout}\n` +
                    `移入: ${stats.movein}`;

                vscode.window.showInformationMessage(
                    statsMessage +
                    `\n报告已保存至: ${path.basename(outputFile)}、${path.basename(alignmentJsonPath(outputFile))}` +
                    wordErrorsMessage
                );
            });

        } catch (error) {
            ErrorUtils.showError(error, '对齐句子时出错：');
        }
    }

}
