/**
 * 文件比较命令处理器
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { showFileDiff, jsDiffMarkdown, jsDiffJsonFiles } from '../differ';
import { FilePathUtils, ErrorUtils } from '../utils';
import { alignSentencesAnchor, getAlignmentStatistics, AlignmentOptions } from '../sentenceAligner';
import { splitChineseSentencesWithLineNumbers } from '../splitter';
import { generateHtmlReport } from '../alignmentReportGenerator';

export class FileCompareCommandHandler {
    /**
     * 处理比较两个文件命令
     */
    public async handleDiffItWithAnotherFileCommand(editor: vscode.TextEditor): Promise<void> {
        const currentFile = editor.document.uri.fsPath;
        const currentLanguageId = editor.document.languageId;

        // 检查当前文件类型
        if (currentLanguageId !== 'markdown' && currentLanguageId !== 'json') {
            vscode.window.showInformationMessage('请打开一个markdown或JSON文件！');
            return;
        }

        // 句子对齐功能只支持 markdown 文件
        const isMarkdown = currentLanguageId === 'markdown';

        // 根据文件类型决定比较方式
        let diffMethod: string;
        if (currentLanguageId === 'json') {
            // JSON文件直接使用jsdiff方式
            diffMethod = '生成jsDiff结果文件';
        } else {
            // markdown文件让用户选择比较方式
            const options = isMarkdown
                ? ['使用diff编辑器比较', '生成jsDiff结果文件', '对齐句子生成勘误表']
                : ['使用diff编辑器比较', '生成jsDiff结果文件'];

            const selectedMethod = await vscode.window.showQuickPick(
                options,
                {
                    placeHolder: '请选择比较方式'
                }
            );

            if (!selectedMethod) {
                return;
            }
            diffMethod = selectedMethod;
        }

        // 如果是句子对齐，使用不同的处理逻辑
        if (diffMethod === '对齐句子生成勘误表') {
            await this.handleSentenceAlignment(currentFile);
            return;
        }

        // 根据文件类型设置文件过滤器
        let filters: { [key: string]: string[] };
        if (currentLanguageId === 'json') {
            filters = {
                'JSON文件': ['json'],
                '所有文件': ['*']
            };
        } else {
            filters = {
                'Markdown文件': ['md', 'markdown'],
                'Context文件': ['tex', 'lmtx'],
                'Text文件': ['txt'],
                'Tex文件': ['tex'],
                '所有文件': ['*']
            };
        }

        // 让用户选择第二个文件
        const fileUris = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: filters
        });

        if (!fileUris || fileUris.length === 0) {
            return;
        }

        const anotherFile = fileUris[0].fsPath;
        const anotherLanguageId = path.extname(anotherFile).toLowerCase() === '.json' ? 'json' : 'markdown';

        // 如果两个文件都是JSON，提供特殊选项
        let segmentCount = 0;
        if (currentLanguageId === 'json' && anotherLanguageId === 'json') {
            if (diffMethod === '生成jsDiff结果文件') {
                // 让用户选择比较的片段数量
                const segmentInput = await vscode.window.showInputBox({
                    prompt: '请输入每次比较的片段数量（0表示所有片段）',
                    value: '0',
                    validateInput: (value: string) => {
                        const num = parseInt(value);
                        if (isNaN(num) || num < 0) {
                            return '请输入有效的非负数字';
                        }
                        return null;
                    }
                });

                if (segmentInput === undefined) {
                    return;
                }
                segmentCount = parseInt(segmentInput);
            }
        }

        try {
            if (diffMethod === '使用diff编辑器比较') {
                await showFileDiff(currentFile, anotherFile);
            } else {
                // 在第一个文件的位置生成jsdiff结果文件
                const outputFile = FilePathUtils.getFilePath(currentFile, '.diff', '.html');
                const title = `${path.basename(currentFile)} ↔ ${path.basename(anotherFile)}`;

                if (currentLanguageId === 'json' && anotherLanguageId === 'json') {
                    // 处理JSON文件比较
                    await jsDiffJsonFiles(currentFile, anotherFile, outputFile, title, segmentCount);
                } else {
                    // 处理普通文件比较
                    await jsDiffMarkdown(currentFile, anotherFile, outputFile, title);
                }
            }
        } catch (error) {
            ErrorUtils.showError(error, '比较文件时出错：');
        }
    }

    /**
     * 处理句子对齐
     */
    private async handleSentenceAlignment(fileA: string): Promise<void> {
        try {
            // 让用户选择b文件（校对后）
            const fileUrisB = await vscode.window.showOpenDialog({
                canSelectMany: false,
                filters: {
                    'Markdown文件': ['md', 'markdown'],
                    'Text文件': ['txt'],
                    'Context文件': ['tex', 'lmtx'],
                    'Tex文件': ['tex'],
                    '所有文件': ['*']
                },
                title: '选择修改后的文件（文件B）'
            });

            if (!fileUrisB || fileUrisB.length === 0) {
                return;
            }

            const fileB = fileUrisB[0].fsPath;

            // 读取对齐参数配置
            const config = vscode.workspace.getConfiguration('ai-proofread.alignment');
            const defaultSimilarityThreshold = config.get<number>('similarityThreshold', 0.6);

            // 让用户输入相似度阈值
            const similarityThresholdInput = await vscode.window.showInputBox({
                prompt: '请输入相似度阈值（0-1之间，用于判断句子是否匹配）',
                value: defaultSimilarityThreshold.toString(),
                validateInput: (value: string) => {
                    const num = parseFloat(value);
                    if (isNaN(num)) {
                        return '请输入有效的数字';
                    }
                    if (num < 0 || num > 1) {
                        return '相似度阈值必须在0-1之间';
                    }
                    return null;
                }
            });

            if (similarityThresholdInput === undefined) {
                return; // 用户取消
            }

            const similarityThreshold = parseFloat(similarityThresholdInput);

            const options: AlignmentOptions = {
                windowSize: config.get<number>('windowSize', 10),
                similarityThreshold: similarityThreshold,
                ngramSize: config.get<number>('ngramSize', 2),
                offset: config.get<number>('offset', 1),
                maxWindowExpansion: config.get<number>('maxWindowExpansion', 3),
                consecutiveFailThreshold: config.get<number>('consecutiveFailThreshold', 3)
            };

            // 显示进度
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: '正在对齐句子...',
                cancellable: false
            }, async (progress) => {
                // 记录开始时间
                const startTime = Date.now();

                progress.report({ increment: 0, message: '读取文件...' });

                // 读取文件内容
                const textA = fs.readFileSync(fileA, 'utf8');
                const textB = fs.readFileSync(fileB, 'utf8');

                progress.report({ increment: 30, message: '切分句子...' });

                // 切分句子并获取行号
                const sentencesAWithLines = splitChineseSentencesWithLineNumbers(textA, true);
                const sentencesBWithLines = splitChineseSentencesWithLineNumbers(textB, true);

                // 提取句子列表
                const sentencesA = sentencesAWithLines.map(([s]) => s);
                const sentencesB = sentencesBWithLines.map(([s]) => s);

                // 创建行号映射
                const lineNumbersA = sentencesAWithLines.map(([, startLine]) => startLine);
                const lineNumbersB = sentencesBWithLines.map(([, startLine]) => startLine);

                progress.report({ increment: 50, message: '执行对齐算法...' });

                // 执行对齐
                const alignment = alignSentencesAnchor(sentencesA, sentencesB, options);

                progress.report({ increment: 80, message: '添加行号信息...' });

                // 为对齐结果添加行号信息
                for (const item of alignment) {
                    // 处理原文行号
                    if (item.a_indices && item.a_indices.length > 0) {
                        // 多个句子合并，取首行的行号
                        item.a_line_numbers = item.a_indices.map(i => lineNumbersA[i]);
                        item.a_line_number = lineNumbersA[item.a_indices[0]];
                    } else if (item.a_index !== undefined && item.a_index !== null) {
                        item.a_line_number = lineNumbersA[item.a_index];
                        item.a_line_numbers = [lineNumbersA[item.a_index]];
                    }

                    // 处理校对后行号
                    if (item.b_indices && item.b_indices.length > 0) {
                        // 多个句子合并，取首行的行号
                        item.b_line_numbers = item.b_indices.map(i => lineNumbersB[i]);
                        item.b_line_number = lineNumbersB[item.b_indices[0]];
                    } else if (item.b_index !== undefined && item.b_index !== null) {
                        item.b_line_number = lineNumbersB[item.b_index];
                        item.b_line_numbers = [lineNumbersB[item.b_index]];
                    }
                }

                progress.report({ increment: 90, message: '生成报告...' });

                // 计算运行时间（秒）
                const endTime = Date.now();
                const runtime = (endTime - startTime) / 1000;

                // 生成HTML报告
                const stats = getAlignmentStatistics(alignment);
                const titleA = path.basename(fileA);
                const titleB = path.basename(fileB);

                // 生成输出文件路径（与文件A同目录）
                const outputFile = FilePathUtils.getFilePath(fileA, '.alignment', '.html');

                // 生成HTML报告
                generateHtmlReport(alignment, outputFile, titleA, titleB, options, runtime);

                progress.report({ increment: 100, message: '完成' });

                // 显示统计信息
                const statsMessage = `对齐完成！\n` +
                    `总计: ${stats.total}\n` +
                    `匹配: ${stats.match}\n` +
                    `删除: ${stats.delete}\n` +
                    `新增: ${stats.insert}\n` +
                    `移出: ${stats.moveout}\n` +
                    `移入: ${stats.movein}`;

                vscode.window.showInformationMessage(statsMessage + `\n报告已保存至: ${path.basename(outputFile)}`);
            });

        } catch (error) {
            ErrorUtils.showError(error, '对齐句子时出错：');
        }
    }
}
