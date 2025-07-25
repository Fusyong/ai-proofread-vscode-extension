/**
 * 扩展入口
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {handleFileSplit } from './splitter';
import {processJsonFileAsync, proofreadSelection} from './proofreader';
import { PromptManager } from './promptManager';
import { mergeTwoFiles } from './merger';
import { showDiff, showFileDiff, generateJsDiff } from './differ';
import { TempFileManager, FilePathUtils, ErrorUtils, ConfigManager, Logger } from './utils';
import { searchSelectionInPDF } from './pdfSearcher';
import { convertDocxToMarkdown, convertMarkdownToDocx } from './docConverter';
import { convertQuotes } from './quoteConverter';

export function activate(context: vscode.ExtensionContext) {
    const logger = Logger.getInstance();
    const configManager = ConfigManager.getInstance();
    logger.info('AI Proofread extension is now active!');

    // 清理临时文件
    TempFileManager.getInstance(context).cleanup();

    // 通用的文件切分处理函数
    async function handleFileSplitCommand(
        mode: 'length' | 'title' | 'title-length' | 'context',
        editor: vscode.TextEditor,
        document: vscode.TextDocument
    ) {
        const config = vscode.workspace.getConfiguration('ai-proofread');

        try {
            let options: {
                mode: 'length' | 'title' | 'title-length' | 'context';
                cutBy?: number;
                levels?: number[];
                threshold?: number;
                minLength?: number;
            } = { mode };

            if (mode === 'length') {
                // 获取配置中的默认切分长度
                const defaultLength = config.get<number>('defaultSplitLength', 600);

                // 让用户选择切分长度
                const inputLength = await vscode.window.showInputBox({
                    prompt: '请输入切分长度（字符数）',
                    value: defaultLength.toString(),
                    validateInput: (value: string) => {
                        const num = parseInt(value);
                        if (isNaN(num)) {
                            return '请输入有效的数字';
                        }
                        if (num < 50) {
                            return '切分长度不能小于50字符';
                        }
                        return null;
                    }
                });

                if (!inputLength) {
                    return;
                }
                options.cutBy = parseInt(inputLength);
            } else if (mode === 'title' || mode === 'title-length' || mode === 'context') {
                // 获取配置中的默认标题级别
                const defaultLevels = config.get<number[]>('defaultTitleLevels', [2]);

                // 让用户选择标题级别
                const inputLevels = await vscode.window.showInputBox({
                    prompt: '请输入标题级别，用作文本或语境的切分点（如：1,2）',
                    value: defaultLevels.join(','),
                    validateInput: (value: string) => {
                        const levels = value.split(/[，,]/).map(x => parseInt(x.trim()));
                        if (levels.some(isNaN)) {
                            return '请输入有效的数字，用逗号分隔';
                        }
                        if (levels.some(x => x < 1 || x > 6)) {
                            return '标题级别必须在1到6之间';
                        }
                        return null;
                    }
                });

                if (!inputLevels) {
                    return;
                }
                options.levels = inputLevels.split(',').map(x => parseInt(x.trim()));

                if (mode === 'context') {
                    // 获取带上下文切分的配置
                    const defaultCutBy = config.get<number>('contextSplit.cutBy', 600);

                    // 让用户选择切分长度
                    const inputCutBy = await vscode.window.showInputBox({
                        prompt: '请输入切分长度（字符数）',
                        value: defaultCutBy.toString(),
                        validateInput: (value: string) => {
                            const num = parseInt(value);
                            if (isNaN(num)) {
                                return '请输入有效的数字';
                            }
                            if (num < 50) {
                                return '切分长度不能小于50字符';
                            }
                            return null;
                        }
                    });

                    if (!inputCutBy) {
                        return;
                    }
                    options.cutBy = parseInt(inputCutBy);

                } else if (mode === 'title-length') {
                    // 获取标题加长度切分的配置
                    options.threshold = config.get<number>('titleAndLengthSplit.threshold', 1500);
                    options.cutBy = config.get<number>('titleAndLengthSplit.cutBy', 800);
                    options.minLength = config.get<number>('titleAndLengthSplit.minLength', 120);

                    // 让用户确认或修改参数
                    const message = `将使用以下参数进行标题加长度切分：\n\n` +
                        `- 标题级别: ${options.levels.join(',')}\n` +
                        `- 长度阈值: ${options.threshold} 字符\n` +
                        `- 切分长度: ${options.cutBy} 字符\n` +
                        `- 最小长度: ${options.minLength} 字符\n\n` +
                        `是否继续？`;

                    const confirm = await vscode.window.showInformationMessage(
                        message,
                        { modal: true },
                        '继续',
                        '修改参数'
                    );

                    if (!confirm) {
                        return;
                    }

                    if (confirm === '修改参数') {
                        // 让用户修改阈值
                        const inputThreshold = await vscode.window.showInputBox({
                            prompt: '请输入长度阈值（超过此长度的段落将被切分）',
                            value: options.threshold.toString(),
                            validateInput: (value: string) => {
                                const num = parseInt(value);
                                return isNaN(num) ? '请输入有效的数字' : null;
                            }
                        });
                        if (!inputThreshold) return;
                        options.threshold = parseInt(inputThreshold);

                        // 让用户修改切分长度
                        const inputCutBy = await vscode.window.showInputBox({
                            prompt: '请输入切分长度（切分长段落时的目标长度）',
                            value: options.cutBy.toString(),
                            validateInput: (value: string) => {
                                const num = parseInt(value);
                                return isNaN(num) ? '请输入有效的数字' : null;
                            }
                        });
                        if (!inputCutBy) return;
                        options.cutBy = parseInt(inputCutBy);

                        // 让用户修改最小长度
                        const inputMinLength = await vscode.window.showInputBox({
                            prompt: '请输入最小长度（小于此长度的段落将被合并）',
                            value: options.minLength.toString(),
                            validateInput: (value: string) => {
                                const num = parseInt(value);
                                return isNaN(num) ? '请输入有效的数字' : null;
                            }
                        });
                        if (!inputMinLength) return;
                        options.minLength = parseInt(inputMinLength);
                    }
                }
            }

            // 调用splitter模块中的handleFileSplit函数
            const result = await handleFileSplit(document.uri.fsPath, options);

            // 显示成功消息
            // vscode.window.showInformationMessage(`文件已成功切分！\nJSON文件：${result.jsonFilePath}\nMarkdown文件：${result.markdownFilePath}`);

            // 提示用户查看结果
            const message = `文件已成功切分！`;
            const userChoice = await vscode.window.showInformationMessage(
                message,
                '比较前后差异',
                '查看JSON结果',
                '查看日志文件',
            );

            if (userChoice === '查看JSON结果') {
                // 打开校对后的JSON文件
                const outputUri = vscode.Uri.file(result.jsonFilePath);
                await vscode.workspace.openTextDocument(outputUri);
                await vscode.window.showTextDocument(outputUri);
            } else if (userChoice === '查看日志文件') {
                // 显示日志文件
                const logUri = vscode.Uri.file(result.logFilePath);
                await vscode.workspace.openTextDocument(logUri);
                await vscode.window.showTextDocument(logUri);
            } else if (userChoice === '比较前后差异') {
                // 比较前后差异
                try {
                    await showFileDiff(document.uri.fsPath, result.markdownFilePath);
                } catch (error) {
                    ErrorUtils.showError(error, '显示差异时出错：');
                }
            }

        } catch (error) {
            ErrorUtils.showError(error, '切分文件时出错：');
        }
    }

    // 注册所有命令
    let disposables = [
        vscode.commands.registerCommand('ai-proofread.splitFile', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('No active editor!');
                return;
            }

            // 让用户选择切分模式
            const mode = await vscode.window.showQuickPick([
                { label: '按长度切分', value: 'length' },
                { label: '按标题切分', value: 'title' },
                { label: '按标题和长度切分', value: 'title-length' },
                { label: '带上下文切分', value: 'context' }
            ], {
                placeHolder: '请选择切分模式',
                canPickMany: false
            });

            if (!mode) {
                return;
            }

            await handleFileSplitCommand(mode.value as 'length' | 'title' | 'title-length' | 'context', editor, editor.document);
        }),

        vscode.commands.registerCommand('ai-proofread.splitFileByLength', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('No active editor!');
                return;
            }
            await handleFileSplitCommand('length', editor, editor.document);
        }),

        vscode.commands.registerCommand('ai-proofread.splitFileByTitle', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('No active editor!');
                return;
            }
            await handleFileSplitCommand('title', editor, editor.document);
        }),

        vscode.commands.registerCommand('ai-proofread.splitFileWithContext', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('No active editor!');
                return;
            }
            await handleFileSplitCommand('context', editor, editor.document);
        }),

        vscode.commands.registerCommand('ai-proofread.splitFileByTitleAndLength', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('No active editor!');
                return;
            }
            await handleFileSplitCommand('title-length', editor, editor.document);
        }),

        vscode.commands.registerCommand('ai-proofread.proofreadFile', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('No active editor!');
                return;
            }

            const document = editor.document;

            // 检查文件是否为JSON
            if (document.languageId !== 'json') {
                vscode.window.showErrorMessage('请选择JSON文件进行校对！');
                return;
            }

            try {
                // 解析JSON文件以验证格式
                const content = document.getText();
                const jsonContent = JSON.parse(content);

                // 验证JSON格式是否符合要求
                if (!Array.isArray(jsonContent) || !jsonContent.every(item =>
                    typeof item === 'object' && item !== null && 'target' in item
                )) {
                    vscode.window.showErrorMessage('JSON文件格式不正确！需要包含target字段的对象数组。');
                    return;
                }

                // 获取当前文件路径
                const currentFilePath = document.uri.fsPath;
                const outputFilePath = FilePathUtils.getFilePath(currentFilePath, '.proofread', '.json');
                const logFilePath = FilePathUtils.getFilePath(currentFilePath, '.proofread', '.log');
                const originalMarkdownFilePath = FilePathUtils.getFilePath(currentFilePath, '', '.md');
                const proofreadMarkdownFilePath = FilePathUtils.getFilePath(currentFilePath, '.proofread.json', '.md');
                const jsdiffFilePath = FilePathUtils.getFilePath(currentFilePath, '.proofread', '.html');
                const diffTitle = path.basename(jsdiffFilePath, path.extname(jsdiffFilePath));

                // 检查proofreadMarkdownFilePath文件是否存在
                if (fs.existsSync(proofreadMarkdownFilePath)) {
                    // 备份旧文件，名字追加时间戳
                    const backupFilePath = FilePathUtils.getFilePath(currentFilePath, `.proofread.json-${new Date().getTime()}`, '.md');
                    fs.copyFileSync(proofreadMarkdownFilePath, backupFilePath);
                }

                // 获取配置
                const platform = configManager.getPlatform();
                const model = configManager.getModel(platform);
                const rpm = configManager.getRpm();
                const maxConcurrent = configManager.getMaxConcurrent();
                const temperature = configManager.getTemperature();

                // 写入开始日志
                const startTime = new Date().toLocaleString();
                let logMessage = `\n${'='.repeat(50)}\n`;
                logMessage += `开始校对时间: ${startTime}\n`;
                logMessage += `平台: ${platform}\n`;
                logMessage += `模型: ${model}\n`;
                logMessage += `RPM: ${rpm}\n`;
                logMessage += `最大并发数: ${maxConcurrent}\n`;
                logMessage += `温度: ${temperature}\n`;
                logMessage += `${'='.repeat(50)}\n`;
                fs.appendFileSync(logFilePath, logMessage, 'utf8');

                // 检查API密钥是否已配置
                const apiKey = configManager.getApiKey(platform);
                if (!apiKey) {
                    const result = await vscode.window.showErrorMessage(
                        `未配置${platform}平台的API密钥，是否现在配置？`,
                        '是',
                        '否'
                    );
                    if (result === '是') {
                        await vscode.commands.executeCommand('workbench.action.openSettings', 'ai-proofread.apiKeys');
                    }
                    return;
                }

                // 显示进度
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: "正在校对文件...",
                    cancellable: true
                }, async (progress, token) => {
                    try {
                        const stats = await processJsonFileAsync(currentFilePath, outputFilePath, {
                            platform,
                            model,
                            rpm,
                            maxConcurrent,
                            temperature,
                            onProgress: (info: string) => {
                                // 将进度信息写入日志
                                fs.appendFileSync(logFilePath, info + '\n', 'utf8');
                                progress.report({ message: info });
                            },
                            token, // 传递取消令牌
                            context // 传递扩展上下文
                        });

                        // 生成差异文件
                        await generateJsDiff(originalMarkdownFilePath, proofreadMarkdownFilePath, jsdiffFilePath, diffTitle);

                        // 写入完成日志
                        const endTime = new Date().toLocaleString();
                        logMessage = `\n${'='.repeat(50)}\n`;
                        logMessage += `校对结束时间: ${endTime}\n`;
                        logMessage += `总段落数: ${stats.totalCount}\n`;
                        logMessage += `已处理段落数、字数: ${stats.processedCount}/${stats.totalCount} (${(stats.processedCount/stats.totalCount*100).toFixed(2)}%), `;
                        logMessage += `${stats.processedLength}/${stats.totalLength} (${(stats.processedLength/stats.totalLength*100).toFixed(2)}%)\n`;
                        logMessage += `未处理段落数: ${stats.totalCount - stats.processedCount}/${stats.totalCount}\n`;

                        // 记录未处理的段落
                        if (stats.unprocessedParagraphs.length > 0) {
                            logMessage += '\n未处理的段落:\n';
                            stats.unprocessedParagraphs.forEach(p => {
                                logMessage += `No.${p.index} \n ${p.preview}...\n\n`;
                            });
                        }

                        logMessage += `${'='.repeat(50)}\n\n`;
                        fs.appendFileSync(logFilePath, logMessage, 'utf8');

                        // 显示处理结果
                        const message =
                            `校对完成！\n` +
                            `总段落数: ${stats.totalCount}\n` +
                            `已处理段落数: ${stats.processedCount} (${(stats.processedCount/stats.totalCount*100).toFixed(2)}%)\n` +
                            `已处理字数: ${stats.processedLength} (${(stats.processedLength/stats.totalLength*100).toFixed(2)}%)\n` +
                            `未处理段落数: ${stats.totalCount - stats.processedCount}`;

                        const result = await vscode.window.showInformationMessage(
                            message,
                            '比较前后差异',
                            '查看差异文件',
                            '查看JSON结果',
                            '查看日志文件',
                        );

                        if (result === '查看JSON结果') {
                            // 打开校对后的JSON文件
                            const outputUri = vscode.Uri.file(outputFilePath);
                            await vscode.workspace.openTextDocument(outputUri);
                            await vscode.window.showTextDocument(outputUri);
                        } else if (result === '查看日志文件') {
                            // 显示日志文件
                            const logUri = vscode.Uri.file(logFilePath);
                            await vscode.workspace.openTextDocument(logUri);
                            await vscode.window.showTextDocument(logUri);
                        } else if (result === '比较前后差异') {
                            // 比较前后差异
                            try {
                                await showFileDiff(originalMarkdownFilePath, proofreadMarkdownFilePath);
                            } catch (error) {
                                ErrorUtils.showError(error, '显示差异时出错：');
                            }
                        } else if (result === '查看差异文件') {
                            // 使用系统默认程序打开差异文件
                            const jsdiffUri = vscode.Uri.file(jsdiffFilePath);
                            await vscode.env.openExternal(jsdiffUri);
                        }
                    } catch (error) {
                        if (error instanceof Error && error.message.includes('未配置')) {
                            const result = await vscode.window.showErrorMessage(
                                error.message + '，是否现在配置？',
                                '是',
                                '否'
                            );
                            if (result === '是') {
                                await vscode.commands.executeCommand('workbench.action.openSettings', 'ai-proofread.apiKeys');
                            }
                        } else {
                            ErrorUtils.showError(error, '校对过程中出错：');
                        }
                    }
                });
            } catch (error) {
                ErrorUtils.showError(error, '解析JSON文件时出错：');
            }
        }),

        vscode.commands.registerCommand('ai-proofread.proofreadSelection', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('No active editor!');
                return;
            }

            try {
                // 获取配置
                const platform = configManager.getPlatform();
                const model = configManager.getModel(platform);
                const temperature = configManager.getTemperature();

                // 检查API密钥是否已配置
                const apiKey = configManager.getApiKey(platform);
                if (!apiKey) {
                    const result = await vscode.window.showErrorMessage(
                        `未配置${platform}平台的API密钥，是否现在配置？`,
                        '是',
                        '否'
                    );
                    if (result === '是') {
                        await vscode.commands.executeCommand('workbench.action.openSettings', 'ai-proofread.apiKeys');
                    }
                    return;
                }

                // 让用户选择是否使用上下文和参考文件
                const contextLevel = await vscode.window.showQuickPick(
                    ['不使用上下文', '1 级标题', '2 级标题', '3 级标题', '4 级标题', '5 级标题', '6 级标题'],
                    {
                        placeHolder: '选择上下文范围（可选）',
                        ignoreFocusOut: true
                    }
                );

                let referenceFile: vscode.Uri[] | undefined;
                const useReference = await vscode.window.showQuickPick(
                    ['否', '是'],
                    {
                        placeHolder: '是否使用参考文件？',
                        ignoreFocusOut: true
                    }
                );

                if (useReference === '是') {
                    referenceFile = await vscode.window.showOpenDialog({
                        canSelectFiles: true,
                        canSelectFolders: false,
                        canSelectMany: false,
                        filters: {
                            'Text files': ['txt', 'md']
                        },
                        title: '选择参考文件'
                    });
                }

                // 让用户选择温度
                const userTemperature = await vscode.window.showInputBox({
                    prompt: '请输入温度',
                    value: configManager.getTemperature().toString(),
                    validateInput: (value: string) => {
                        const temperature = parseFloat(value);
                        if (isNaN(temperature) || temperature < 0 || temperature >= 2) {
                            return '请输入一个[0:2)之间的数字';
                        }
                        return null;
                    }
                });

                // 显示进度
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: "正在校对文本...",
                    cancellable: false
                }, async (progress) => {
                    try {
                        // 固定原始文本以免用户操作
                        const originalText = editor.document.getText(editor.selection);
                        const fileExt = path.extname(editor.document.fileName);
                        const result = await proofreadSelection(
                            editor,
                            editor.selection,
                            platform,
                            model,
                            contextLevel,
                            referenceFile,
                            userTemperature ? parseFloat(userTemperature) : undefined,
                            context
                        );

                        if (result) {
                            // 把参数和校对结果写入日志文件
                            const logFilePath = FilePathUtils.getFilePath(editor.document.uri.fsPath, '.proofread', '.log');
                            const logMessage = `\n${'='.repeat(50)}\n平台: ${platform}\n模型: ${model}\n温度: ${userTemperature}\n上下文范围: ${contextLevel}\n参考文件: ${referenceFile}\n校对结果:\n\n${result}\n${'='.repeat(50)}\n\n`;
                            fs.appendFileSync(logFilePath, logMessage, 'utf8');

                            // 创建原始文本和校对后文本的临时文件

                            // 显示差异
                            await showDiff(context, originalText, result, fileExt, false);
                        } else {
                            vscode.window.showErrorMessage('校对失败，请重试。');
                        }
                    } catch (error) {
                        ErrorUtils.showError(error, '校对过程中出错：');
                    }
                });
            } catch (error) {
                ErrorUtils.showError(error, '校对过程中出错：');
            }
        }),

        // 注册提示词管理命令
        vscode.commands.registerCommand('ai-proofread.managePrompts', () => {
            PromptManager.getInstance(context).managePrompts();
        }),

        // 注册选择提示词命令
        vscode.commands.registerCommand('ai-proofread.selectPrompt', () => {
            PromptManager.getInstance(context).selectPrompt();
        }),

        // 注册合并文件命令
        vscode.commands.registerCommand('ai-proofread.mergeTwoFiles', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('No active editor!');
                return;
            }

            const document = editor.document;

            // 检查文件是否为JSON
            if (document.languageId !== 'json') {
                vscode.window.showErrorMessage('请选择JSON文件进行合并！');
                return;
            }

            try {
                // 让用户选择源文件
                const sourceFile = await vscode.window.showOpenDialog({
                    canSelectFiles: true,
                    canSelectFolders: false,
                    canSelectMany: false,
                    filters: {
                        'JSON files': ['json']
                    },
                    title: '选择源JSON文件'
                });

                if (!sourceFile || sourceFile.length === 0) {
                    return;
                }

                // 让用户选择要更新的字段
                const targetField = await vscode.window.showQuickPick(
                    ['target', 'reference', 'context'],
                    {
                        placeHolder: '选择要更新的字段',
                        ignoreFocusOut: true
                    }
                );

                if (!targetField) {
                    return;
                }

                // 让用户选择源文件中的字段
                const sourceField = await vscode.window.showQuickPick(
                    ['target', 'reference', 'context'],
                    {
                        placeHolder: '选择源文件中的字段',
                        ignoreFocusOut: true
                    }
                );

                if (!sourceField) {
                    return;
                }

                // 执行合并
                const result = await mergeTwoFiles(
                    document.uri.fsPath,
                    sourceFile[0].fsPath,
                    targetField as 'target' | 'reference' | 'context',
                    sourceField as 'target' | 'reference' | 'context'
                );

                // 显示结果
                vscode.window.showInformationMessage(
                    `合并完成！更新了 ${result.updated}/${result.total} 项`
                );
            } catch (error) {
                ErrorUtils.showError(error, '合并文件时出错：');
            }
        }),

        // 注册在PDF中搜索选中文本命令
        vscode.commands.registerCommand('ai-proofread.searchSelectionInPDF', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('请先打开PDF对应的Markdown文件并选择要搜索的文本');
                return;
            }

            try {
                await searchSelectionInPDF(editor);
            } catch (error) {
                ErrorUtils.showError(error, '搜索PDF时出错：');
            }
        }),

        // 注册比较两个文件命令
        vscode.commands.registerCommand('ai-proofread.diffItWithAnotherFile', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('请先打开一个文件！');
                return;
            }

            // 检查当前文件是否为markdown
            if (editor.document.languageId !== 'markdown') {
                vscode.window.showInformationMessage('请打开一个markdown文件！');
                return;
            }

            // 让用户选择比较方式
            const diffMethod = await vscode.window.showQuickPick(
                ['使用diff编辑器比较', '生成jsDiff结果文件并打开'],
                {
                    placeHolder: '请选择比较方式'
                }
            );

            if (!diffMethod) {
                return;
            }

            // 让用户选择第二个文件
            const fileUris = await vscode.window.showOpenDialog({
                canSelectMany: false,
                filters: {
                    'Markdown文件': ['md', 'markdown'],
                    'Context文件': ['tex', 'lmtx'],
                    'Text文件': ['txt'],
                    'Tex文件': ['tex']
                }
            });

            if (!fileUris || fileUris.length === 0) {
                return;
            }

            const currentFile = editor.document.uri.fsPath;
            const anotherFile = fileUris[0].fsPath;

            try {
                if (diffMethod === '使用diff编辑器比较') {
                    await showFileDiff(currentFile, anotherFile);
                } else {
                    // 在第一个文件的位置生成jsdiff结果文件
                    const outputFile = FilePathUtils.getFilePath(currentFile, '.diff', '.html');
                    const title = `${path.basename(currentFile)} ↔ ${path.basename(anotherFile)}`;
                    await generateJsDiff(currentFile, anotherFile, outputFile, title);

                    // 使用系统默认程序打开生成的diff.html文件
                    await vscode.env.openExternal(vscode.Uri.file(outputFile));
                }
            } catch (error) {
                ErrorUtils.showError(error, '比较文件时出错：');
            }
        }),

        // 注册docx转markdown命令
        vscode.commands.registerCommand('ai-proofread.convertDocxToMarkdown', async () => {

            // 让用户选择文件
            const fileUri = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: {
                    'Docx文件': ['docx']
                }
            });

            if (!fileUri || fileUri.length === 0) {
                return;
            }

            // 让用户选择转换模式
            const mode = await vscode.window.showQuickPick(
                ['默认模式', 'markdown_strict'],
                {
                    placeHolder: '请选择转换模式',
                    ignoreFocusOut: true
                }
            );

            if (!mode) {
                return;
            }

            // 检查是否已经存在同名的输出文件，存在则添加时间戳
            let outputPath = FilePathUtils.getFilePath(fileUri[0].fsPath, '', '.md');
            if (fs.existsSync(outputPath)) {
                const timestamp = new Date().getTime();
                outputPath = FilePathUtils.getFilePath(fileUri[0].fsPath, `-${timestamp}`, '.md');
            }

            // 等待文件写入完成的辅助函数
            async function waitForFile(filePath: string, maxTries = 10, interval = 100): Promise<boolean> {
                for (let i = 0; i < maxTries; i++) {
                    if (fs.existsSync(filePath)) return true;
                    await new Promise(res => setTimeout(res, interval));
                }
                return false;
            }

            try {
                outputPath = await convertDocxToMarkdown(
                    fileUri[0].fsPath,
                    mode === '默认模式' ? 'default' : 'markdown_strict',
                    outputPath
                );

                // 等待文件写入完成
                const fileReady = await waitForFile(outputPath, 20, 100);
                if (!fileReady) throw new Error('文件写入超时');

                // 打开转换后的文件
                const outputUri = vscode.Uri.file(outputPath);
                await vscode.workspace.openTextDocument(outputUri);
                await vscode.window.showTextDocument(outputUri);

                vscode.window.showInformationMessage('转换完成！');
            } catch (error) {
                ErrorUtils.showError(error, '转换文件时出错：');
            }
        }),

        // 注册markdown转docx命令
        vscode.commands.registerCommand('ai-proofread.convertMarkdownToDocx', async () => {
            let fileUri: vscode.Uri | undefined;

            // 让用户选择当前打开的文件或者重新选择文件
            const mode = await vscode.window.showQuickPick(
                ['当前文件', '选择文件'],
                {
                    placeHolder: '确定要转换当前文件吗？',
                    ignoreFocusOut: true
                }
            );

            if (!mode) {
                return;
            }

            if (mode === '当前文件') {
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    vscode.window.showInformationMessage('请先打开一个markdown文件！');
                    return;
                }

                // 检查当前文件是否为markdown
                if (editor.document.languageId !== 'markdown') {
                    vscode.window.showInformationMessage('请打开一个markdown文件！');
                    return;
                }

                fileUri = editor.document.uri;
            } else {
                // 让用户选择一个md文件
                const fileUris = await vscode.window.showOpenDialog({
                    canSelectFiles: true,
                    canSelectFolders: false,
                    canSelectMany: false,
                    filters: {
                        'Markdown文件': ['md', 'markdown']
                    }
                });

                if (!fileUris || fileUris.length === 0) {
                    return;
                }

                fileUri = fileUris[0];
            }

            if (!fileUri) {
                return;
            }

            // 检查是否已经存在同名的输出文件，存在则添加时间戳
            let outputPath = FilePathUtils.getFilePath(fileUri.fsPath, '', '.docx');
            if (fs.existsSync(outputPath)) {
                const timestamp = new Date().getTime();
                outputPath = FilePathUtils.getFilePath(fileUri.fsPath, `-${timestamp}`, '.docx');
            }

            try {
                outputPath = await convertMarkdownToDocx(fileUri.fsPath, outputPath);

                // 打开转换后的文件
                const outputUri = vscode.Uri.file(outputPath);
                await vscode.env.openExternal(outputUri);

                vscode.window.showInformationMessage('转换完成！');
            } catch (error) {
                ErrorUtils.showError(error, '转换文件时出错：');
            }
        }),

        // 注册引号转换命令
        vscode.commands.registerCommand('ai-proofread.convertQuotes', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('No active editor!');
                return;
            }

            try {
                const document = editor.document;
                const selection = editor.selection;
                const text = selection.isEmpty ? document.getText() : document.getText(selection);

                // 转换引号
                const convertedText = convertQuotes(text);

                // 替换文本
                await editor.edit(editBuilder => {
                    if (selection.isEmpty) {
                        const fullRange = new vscode.Range(
                            document.positionAt(0),
                            document.positionAt(document.getText().length)
                        );
                        editBuilder.replace(fullRange, convertedText);
                    } else {
                        editBuilder.replace(selection, convertedText);
                    }
                });

                vscode.window.showInformationMessage('引号转换完成！');
            } catch (error) {
                ErrorUtils.showError(error, '转换引号时出错：');
            }
        }),
    ];

    context.subscriptions.push(...disposables, configManager);
}

export function deactivate() {
    const logger = Logger.getInstance();
    const configManager = ConfigManager.getInstance();
    logger.dispose();
    configManager.dispose();
}