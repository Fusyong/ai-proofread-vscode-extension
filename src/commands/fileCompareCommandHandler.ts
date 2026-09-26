/**
 * 文件比较命令处理器
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { showFileDiff, jsDiffMarkdown, jsDiffJsonFiles } from '../differ';
import { FilePathUtils, ErrorUtils } from '../utils';
import { getAlignmentStatistics, AlignmentOptions } from '../sentenceAligner';
import { alignDocuments } from '../documentAligner';
import { promptAlignmentAlgorithm } from '../alignmentUi';
import { alignmentJsonPath, generateHtmlReport } from '../alignmentReportGenerator';
import { getJiebaWasm } from '../jiebaLoader';
import { collectWordErrors, formatWordErrors, parseDelimitersFromConfig } from '../wordErrorCollector';
import { mergeMarkdownProofreads } from '../multiAlignmentMerger';
import { generateMultiAlignmentReport } from '../multiAlignmentReportGenerator';

function isMarkdownPath(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return ext === '.md' || ext === '.markdown';
}

async function confirmProofreadOrder(paths: string[]): Promise<string[] | undefined> {
    if (paths.length === 0) {
        return undefined;
    }
    if (paths.length === 1) {
        return paths;
    }

    let order = [...paths];
    while (true) {
        const items: Array<vscode.QuickPickItem & { action: string; index?: number }> = [
            {
                label: '$(check) 完成（使用当前顺序）',
                description: order.map((p, i) => `${i + 1}.${path.basename(p)}`).join(' → '),
                action: 'done',
            },
            { label: '$(close) 取消', action: 'cancel' },
            ...order.map((p, i) => ({
                label: `${i + 1}. ${path.basename(p)}`,
                description: p,
                detail: '选择后可上移 / 下移 / 移除',
                action: 'item',
                index: i,
            })),
        ];

        const picked = await vscode.window.showQuickPick(items, {
            title: '调整校次 Markdown 顺序',
            placeHolder: '当前文件为原文；下列为各校次并入顺序',
            ignoreFocusOut: true,
        });
        if (!picked || picked.action === 'cancel') {
            return undefined;
        }
        if (picked.action === 'done') {
            if (order.length < 1) {
                vscode.window.showWarningMessage('请至少保留 1 份校对稿');
                continue;
            }
            return order;
        }

        const idx = picked.index!;
        const move = await vscode.window.showQuickPick(
            [
                {
                    label: '$(arrow-up) 上移',
                    action: 'up' as const,
                    description: idx === 0 ? '已在最前' : undefined,
                },
                {
                    label: '$(arrow-down) 下移',
                    action: 'down' as const,
                    description: idx >= order.length - 1 ? '已在最后' : undefined,
                },
                { label: '$(trash) 移除', action: 'remove' as const },
                { label: '返回', action: 'back' as const },
            ],
            {
                title: `调整：${path.basename(order[idx])}`,
                ignoreFocusOut: true,
            }
        );
        if (!move || move.action === 'back') {
            continue;
        }
        if (move.action === 'up' && idx > 0) {
            const t = order[idx - 1];
            order[idx - 1] = order[idx];
            order[idx] = t;
        } else if (move.action === 'down' && idx < order.length - 1) {
            const t = order[idx + 1];
            order[idx + 1] = order[idx];
            order[idx] = t;
        } else if (move.action === 'remove') {
            if (order.length <= 1) {
                vscode.window.showWarningMessage('至少需保留 1 份校对稿');
                continue;
            }
            order.splice(idx, 1);
        }
    }
}

export class FileCompareCommandHandler {
    constructor(private context: vscode.ExtensionContext) {}

    /**
     * 处理比较两个文件命令
     */
    public async handleDiffItWithAnotherFileCommand(editor: vscode.TextEditor): Promise<void> {
        const currentFile = editor.document.uri.fsPath;
        const currentLanguageId = editor.document.languageId;
        const currentIsMd =
            currentLanguageId === 'markdown' || isMarkdownPath(currentFile);

        // 检查当前文件类型
        if (currentLanguageId !== 'markdown' && currentLanguageId !== 'json' && !isMarkdownPath(currentFile)) {
            vscode.window.showInformationMessage('请打开一个 Markdown 或 JSON 文件！');
            return;
        }

        // 根据文件类型决定比较方式
        let diffMethod: string;
        if (currentLanguageId === 'json' && !currentIsMd) {
            diffMethod = '生成jsDiff结果文件';
        } else {
            const options = currentIsMd
                ? [
                      '使用diff编辑器比较',
                      '生成jsDiff结果文件',
                      '对齐句子生成勘误表（可多选校次 Markdown）',
                  ]
                : ['使用diff编辑器比较', '生成jsDiff结果文件'];

            const selectedMethod = await vscode.window.showQuickPick(options, {
                placeHolder: '请选择比较方式',
            });

            if (!selectedMethod) {
                return;
            }
            diffMethod = selectedMethod;
        }

        if (diffMethod.startsWith('对齐句子生成勘误表')) {
            await this.handleSentenceAlignment(currentFile);
            return;
        }

        // 根据文件类型设置文件过滤器
        let filters: { [key: string]: string[] };
        if (currentLanguageId === 'json' && !currentIsMd) {
            filters = {
                'JSON文件': ['json'],
                '所有文件': ['*'],
            };
        } else {
            filters = {
                'Markdown文件': ['md', 'markdown'],
                'Context文件': ['tex', 'lmtx'],
                'Text文件': ['txt'],
                'Tex文件': ['tex'],
                '所有文件': ['*'],
            };
        }

        const fileUris = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: filters,
        });

        if (!fileUris || fileUris.length === 0) {
            return;
        }

        const anotherFile = fileUris[0].fsPath;
        const anotherLanguageId =
            path.extname(anotherFile).toLowerCase() === '.json' ? 'json' : 'markdown';

        let segmentCount = 0;
        if (currentLanguageId === 'json' && anotherLanguageId === 'json' && !currentIsMd) {
            if (diffMethod === '生成jsDiff结果文件') {
                const segmentInput = await vscode.window.showInputBox({
                    prompt: '请输入每次比较的片段数量（0表示所有片段）',
                    value: '0',
                    validateInput: (value: string) => {
                        const num = parseInt(value);
                        if (isNaN(num) || num < 0) {
                            return '请输入有效的非负数字';
                        }
                        return null;
                    },
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
                const outputFile = FilePathUtils.getFilePath(currentFile, '.diff', '.html');
                const title = `${path.basename(currentFile)} ↔ ${path.basename(anotherFile)}`;

                if (currentLanguageId === 'json' && anotherLanguageId === 'json' && !currentIsMd) {
                    await jsDiffJsonFiles(currentFile, anotherFile, outputFile, title, segmentCount);
                } else {
                    await jsDiffMarkdown(currentFile, anotherFile, outputFile, title);
                }
            }
        } catch (error) {
            ErrorUtils.showError(error, '比较文件时出错：');
        }
    }

    /**
     * 句子对齐：当前文件为原文，多选校对稿 Markdown（任意 .md 后缀均可）。
     * 1 份校次 → 单份勘误表；多份 → 多校次对照表。
     */
    private async handleSentenceAlignment(fileA: string): Promise<void> {
        try {
            const fileUrisB = await vscode.window.showOpenDialog({
                canSelectMany: true,
                filters: {
                    'Markdown文件': ['md', 'markdown'],
                },
                title: '选择校对稿 Markdown（可多选校次；任意 .md 文件名均可）',
            });

            if (!fileUrisB || fileUrisB.length === 0) {
                return;
            }

            const selected = fileUrisB.map(u => u.fsPath).filter(isMarkdownPath);
            if (selected.length === 0) {
                vscode.window.showWarningMessage('请选择 Markdown（.md / .markdown）文件');
                return;
            }

            const ordered = await confirmProofreadOrder(selected);
            if (!ordered || ordered.length === 0) {
                return;
            }

            const config = vscode.workspace.getConfiguration('ai-proofread.alignment');
            const defaultSimilarityThreshold = config.get<number>('similarityThreshold', 0.6);

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
                },
            });

            if (similarityThresholdInput === undefined) {
                return;
            }

            const similarityThreshold = parseFloat(similarityThresholdInput);

            const removeInnerWhitespaceChoice = await vscode.window.showQuickPick(
                [
                    { label: '是（默认）', description: '忽略句中空白，仅用字面比较', value: true },
                    { label: '否', description: '保留句中空白参与比较', value: false },
                ],
                {
                    placeHolder: '相似度计算时是否忽略句中空白字符？',
                    title: '句中空白',
                    ignoreFocusOut: true,
                }
            );
            const removeInnerWhitespace = removeInnerWhitespaceChoice?.value ?? true;

            const configuredAlgo = config.get<'anchor' | 'wordDiff'>('algorithm', 'anchor');
            const algorithm = await promptAlignmentAlgorithm(configuredAlgo);
            if (!algorithm) {
                return;
            }

            const isMulti = ordered.length > 1;

            const writeJsonChoice = await vscode.window.showQuickPick(
                isMulti
                    ? [
                          { label: '是（默认）', description: '同时写入 alignment JSON（供评测/合并）', value: true },
                          { label: '否', description: '仅生成 HTML 勘误表与 CSV', value: false },
                      ]
                    : [
                          { label: '否（默认）', description: '仅生成 HTML 勘误表', value: false },
                          { label: '是', description: '同时写入 alignment JSON（供评测/合并）', value: true },
                      ],
                {
                    placeHolder: isMulti ? '是否生成 JSON？（多校次默认生成）' : '是否生成 JSON？',
                    title: '生成 JSON',
                    ignoreFocusOut: true,
                }
            );
            if (!writeJsonChoice) {
                return;
            }
            const writeJson = writeJsonChoice.value;

            let shouldCollectWordErrors = false;
            if (!isMulti) {
                const collectWordErrorsChoice = await vscode.window.showQuickPick(
                    [
                        { label: '否', description: '仅生成勘误表（默认）', value: false },
                        { label: '是', description: '同时收集常用词语错误', value: true },
                    ],
                    {
                        placeHolder: '是否同时收集常用词语错误？',
                        title: '常用词语错误',
                        ignoreFocusOut: true,
                    }
                );
                shouldCollectWordErrors = collectWordErrorsChoice?.value ?? false;
            }

            const citationConfig = vscode.workspace.getConfiguration('ai-proofread.citation');
            const ngramGranularity = config.get<'word' | 'char'>('ngramGranularity', 'word');
            let jieba: import('../jiebaLoader').JiebaWasmModule | undefined;
            if (ngramGranularity === 'word' || shouldCollectWordErrors) {
                try {
                    const customDictPath = vscode.workspace
                        .getConfiguration('ai-proofread.jieba')
                        .get<string>('customDictPath', '');
                    jieba = getJiebaWasm(
                        path.join(this.context.extensionPath, 'dist'),
                        customDictPath || undefined
                    );
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    vscode.window.showErrorMessage(
                        `jieba 加载失败，${shouldCollectWordErrors ? '词语错误收集需要 jieba；' : ''}${ngramGranularity === 'word' ? '当前配置为词级相似度，需要 jieba；' : ''}已中止：${msg}`
                    );
                    return;
                }
            }

            const options: AlignmentOptions = {
                algorithm,
                wordDiffFallbackToAnchor: config.get<boolean>('wordDiffFallbackToAnchor', true),
                windowSize: config.get<number>('windowSize', 10),
                similarityThreshold: similarityThreshold,
                ngramSize: config.get<number>('ngramSize', 1),
                ngramGranularity: jieba ? 'word' : 'char',
                cutMode: vscode.workspace
                    .getConfiguration('ai-proofread.jieba')
                    .get<'default' | 'search'>('cutMode', 'default'),
                jieba,
                offset: config.get<number>('offset', 1),
                maxWindowExpansion: config.get<number>('maxWindowExpansion', 3),
                consecutiveFailThreshold: config.get<number>('consecutiveFailThreshold', 3),
                removeInnerWhitespace,
                removePunctuation: citationConfig.get<boolean>('normalizeIgnorePunctuation', false),
                removeDigits: config.get<boolean>('normalizeIgnoreDigits', false),
                removeLatin: config.get<boolean>('normalizeIgnoreLatin', false),
                minSentenceChars: config.get<number>('minSentenceChars', 8),
                gapEqualRatio: config.get<number>('gapEqualRatio', 0.55),
            };

            if (isMulti) {
                await this.runMultiMarkdownAlignment(fileA, ordered, options, algorithm, writeJson);
            } else {
                await this.runSingleMarkdownAlignment(
                    fileA,
                    ordered[0],
                    options,
                    algorithm,
                    shouldCollectWordErrors,
                    jieba,
                    writeJson
                );
            }
        } catch (error) {
            ErrorUtils.showError(error, '对齐句子时出错：');
        }
    }

    private async runSingleMarkdownAlignment(
        fileA: string,
        fileB: string,
        options: AlignmentOptions,
        algorithm: string,
        shouldCollectWordErrors: boolean,
        jieba: import('../jiebaLoader').JiebaWasmModule | undefined,
        writeJson: boolean
    ): Promise<void> {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: '正在对齐句子...',
                cancellable: false,
            },
            async progress => {
                const startTime = Date.now();
                progress.report({ increment: 0, message: '读取文件...' });
                const textA = fs.readFileSync(fileA, 'utf8');
                const textB = fs.readFileSync(fileB, 'utf8');

                progress.report({ increment: 40, message: '执行对齐算法...' });
                const { alignment, fellBackToAnchor } = alignDocuments(textA, textB, options);

                progress.report({ increment: 85, message: '生成报告...' });
                const runtime = (Date.now() - startTime) / 1000;
                const stats = getAlignmentStatistics(alignment);
                const titleA = path.basename(fileA);
                const titleB = path.basename(fileB);
                const outputFile = FilePathUtils.getFilePath(fileA, '.alignment', '.html');
                generateHtmlReport(alignment, outputFile, titleA, titleB, options, runtime, writeJson);

                let wordErrorsMessage = '';
                if (shouldCollectWordErrors && jieba) {
                    progress.report({ increment: 95, message: '收集词语错误...' });
                    const weConfig = vscode.workspace.getConfiguration('ai-proofread.wordErrorCollector');
                    const delimitersStr = weConfig.get<string>('delimiters', '，；。？！');
                    const delimiters = parseDelimitersFromConfig(delimitersStr);
                    const clauseThreshold = weConfig.get<number>('clauseSimilarityThreshold', 0.4);
                    const cutMode = vscode.workspace
                        .getConfiguration('ai-proofread.jieba')
                        .get<'default' | 'search'>('cutMode', 'default');
                    const entries = collectWordErrors(alignment, {
                        jieba,
                        cutMode,
                        delimiters,
                        clauseSimilarityThreshold: clauseThreshold,
                    });
                    const wordErrorsPath = FilePathUtils.getFilePath(fileA, '.word-errors', '.csv');
                    fs.writeFileSync(wordErrorsPath, formatWordErrors(entries), 'utf8');
                    wordErrorsMessage = `\n词语错误已保存至: ${path.basename(wordErrorsPath)}（${entries.length} 条）`;
                }

                progress.report({ increment: 100, message: '完成' });
                const fallbackNote = fellBackToAnchor ? '\n（检测到调序，已回退锚点算法）' : '';
                const savedFiles = writeJson
                    ? `${path.basename(outputFile)}、${path.basename(alignmentJsonPath(outputFile))}`
                    : path.basename(outputFile);
                vscode.window.showInformationMessage(
                    `对齐完成！${fallbackNote}\n` +
                        `算法: ${options.algorithmDisplayName ?? algorithm}\n` +
                        `总计: ${stats.total}\n` +
                        `匹配: ${stats.match}\n` +
                        `删除: ${stats.delete}\n` +
                        `新增: ${stats.insert}\n` +
                        `移出: ${stats.moveout}\n` +
                        `移入: ${stats.movein}` +
                        `\n报告已保存至: ${savedFiles}` +
                        wordErrorsMessage
                );
            }
        );
    }

    private async runMultiMarkdownAlignment(
        fileA: string,
        fileBs: string[],
        options: AlignmentOptions,
        algorithm: string,
        writeJson: boolean
    ): Promise<void> {
        const defaultOut = FilePathUtils.getFilePath(fileA, '.multi-alignment', '.html');
        const outUri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(defaultOut),
            filters: { HTML: ['html'] },
            title: '保存多校次对齐对照表',
        });
        if (!outUri) {
            return;
        }

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: '正在对齐多校次 Markdown…',
                cancellable: false,
            },
            async progress => {
                const startTime = Date.now();
                progress.report({ message: '读取原文…' });
                const textA = fs.readFileSync(fileA, 'utf8');
                const titleA = path.basename(fileA);
                const proofreads = fileBs.map(p => ({
                    text: fs.readFileSync(p, 'utf8'),
                    label: path.basename(p),
                    path: p,
                }));

                progress.report({ message: `对齐 ${proofreads.length} 份校对稿并合并…` });
                const table = mergeMarkdownProofreads(textA, titleA, proofreads, {
                    ...options,
                    classifyNgramSize: 2,
                });

                const runtime = (Date.now() - startTime) / 1000;
                progress.report({ message: '生成报告…' });
                const { htmlPath, jsonPath, csvPath } = generateMultiAlignmentReport(
                    table,
                    outUri.fsPath,
                    runtime,
                    writeJson
                );

                const savedParts = [
                    path.basename(htmlPath),
                    ...(writeJson ? [path.basename(jsonPath)] : []),
                    path.basename(csvPath),
                ];
                vscode.window.showInformationMessage(
                    `多校次对齐完成！\n` +
                        `算法: ${options.algorithmDisplayName ?? algorithm}\n` +
                        `${table.rows.length} 行 · ${table.sources.length} 校次\n` +
                        `已保存: ${savedParts.join(' / ')}`
                );
            }
        );
    }
}
