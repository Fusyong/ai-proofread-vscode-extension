/**
 * 校对命令处理器
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { processJsonFileAsync, proofreadSelection } from '../proofreader';
import { showDiff } from '../differ';
import { FilePathUtils, ErrorUtils, ConfigManager } from '../utils';
import { WebviewManager, ProcessResult } from '../ui/webviewManager';

export class ProofreadCommandHandler {
    private webviewManager: WebviewManager;
    private configManager: ConfigManager;

    constructor(webviewManager: WebviewManager) {
        this.webviewManager = webviewManager;
        this.configManager = ConfigManager.getInstance();
    }

    /**
     * 处理校对文件命令
     */
    public async handleProofreadFileCommand(
        editor: vscode.TextEditor,
        context: vscode.ExtensionContext
    ): Promise<void> {
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
            // 不再自动生成差异文件

            // 检查proofreadMarkdownFilePath文件是否存在
            if (fs.existsSync(proofreadMarkdownFilePath)) {
                // 备份旧文件，名字追加时间戳
                const backupFilePath = FilePathUtils.getFilePath(currentFilePath, `.proofread.json-${new Date().getTime()}`, '.md');
                fs.copyFileSync(proofreadMarkdownFilePath, backupFilePath);
            }

            // 获取配置
            const platform = this.configManager.getPlatform();
            const model = this.configManager.getModel(platform);
            const rpm = this.configManager.getRpm();
            const maxConcurrent = this.configManager.getMaxConcurrent();
            const temperature = this.configManager.getTemperature();

            // 写入开始日志
            // 获取当前使用的提示词名称
            let currentPromptName = '系统默认提示词';
            if (context) {
                const promptName = context.globalState.get<string>('currentPrompt', '');
                if (promptName !== '') {
                    currentPromptName = promptName;
                }
            }

            const startTime = new Date().toLocaleString();
            let logMessage = `\n${'='.repeat(50)}\n`;
            logMessage += `Start: ${startTime}\n`;
            logMessage += `Prompt: ${currentPromptName}\n`;
            logMessage += `Model: ${platform}, ${model}, T. ${temperature}\n`;
            logMessage += `RPM: ${rpm}\n`;
            logMessage += `MaxConcurrent: ${maxConcurrent}\n`;
            logMessage += `${'='.repeat(50)}\n`;
            fs.appendFileSync(logFilePath, logMessage, 'utf8');

            // 检查API密钥是否已配置
            const apiKey = this.configManager.getApiKey(platform);
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

            // 显示当前配置信息（模仿文件选段校对的显示方式）
            vscode.window.showInformationMessage(`Prompt: ${currentPromptName.slice(0, 4)}…; Model: ${platform}, ${model}, T. ${temperature}; RPM: ${rpm}, MaxConcurrent: ${maxConcurrent}`);

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

                    // 不再自动生成差异文件，改为在Webview中提供生成按钮

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

                    // 更新智能面板显示校对结果
                    const processResult: ProcessResult = {
                        title: '处理完成',
                        message: '文件切分和校对都已完成！',
                        splitResult: this.webviewManager.getCurrentProcessResult()?.splitResult, // 保留切分结果
                        proofreadResult: {
                            outputFilePath: outputFilePath,
                            logFilePath: logFilePath,
                            originalFilePath: originalMarkdownFilePath,
                            markdownFilePath: proofreadMarkdownFilePath,
                            stats: {
                                totalCount: stats.totalCount,
                                processedCount: stats.processedCount,
                                processedLength: stats.processedLength,
                                totalLength: stats.totalLength
                            }
                        },
                        actions: {
                            showJson: true,
                            showLog: true,
                            showDiff: true
                        }
                    };

                    if (this.webviewManager.getCurrentPanel()) {
                        // 如果已有面板，更新内容
                        this.webviewManager.updatePanelContent(processResult);
                        // 激活面板
                        this.webviewManager.getCurrentPanel()?.reveal();
                    } else {
                        // 如果没有面板，创建新面板
                        const panel = this.webviewManager.createWebviewPanel(processResult);
                        
                        // 监听Webview消息
                        panel.webview.onDidReceiveMessage(
                            (message) => this.webviewManager.handleWebviewMessage(message, panel, context),
                            undefined,
                            context.subscriptions
                        );
                        
                        // 激活面板
                        panel.reveal();
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
    }

    /**
     * 处理校对选中文本命令
     */
    public async handleProofreadSelectionCommand(
        editor: vscode.TextEditor,
        context: vscode.ExtensionContext
    ): Promise<void> {
        try {
            // 获取配置
            const platform = this.configManager.getPlatform();
            const model = this.configManager.getModel(platform);
            const temperature = this.configManager.getTemperature();

            // 检查API密钥是否已配置
            const apiKey = this.configManager.getApiKey(platform);
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

            // 让用户选择上下文构建方式
            const contextBuildMethod = await vscode.window.showQuickPick(
                ['不使用上下文', '前后增加段落', '使用所在标题范围'],
                {
                    placeHolder: '选择上下文构建方式',
                    ignoreFocusOut: true
                }
            );

            let contextLevel: string | undefined;
            let beforeParagraphs: number = 0;
            let afterParagraphs: number = 0;

            if (contextBuildMethod === '前后增加段落') {
                // 选择前文增加段落个数
                const beforeParagraphsInput = await vscode.window.showInputBox({
                    prompt: '前文增加段落个数',
                    value: '1',
                    validateInput: (value: string) => {
                        const num = parseInt(value);
                        if (isNaN(num) || num < 0 || num > 10) {
                            return '请输入一个[0:10]之间的数字';
                        }
                        return null;
                    }
                });
                beforeParagraphs = beforeParagraphsInput ? parseInt(beforeParagraphsInput) : 2;

                // 选择后文增加段落个数
                const afterParagraphsInput = await vscode.window.showInputBox({
                    prompt: '后文增加段落个数',
                    value: '1',
                    validateInput: (value: string) => {
                        const num = parseInt(value);
                        if (isNaN(num) || num < 0 || num > 10) {
                            return '请输入一个[0:10]之间的数字';
                        }
                        return null;
                    }
                });
                afterParagraphs = afterParagraphsInput ? parseInt(afterParagraphsInput) : 2;

                contextLevel = '前后增加段落';
            } else if (contextBuildMethod === '使用所在标题范围') {
                // 让用户选择是否使用上下文和参考文件
                contextLevel = await vscode.window.showQuickPick(
                    ['1 级标题', '2 级标题', '3 级标题', '4 级标题', '5 级标题', '6 级标题'],
                    {
                        placeHolder: '选择上下文范围（可选）',
                        ignoreFocusOut: true
                    }
                );
            }

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
                value: this.configManager.getTemperature().toString(),
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
                        // 获取当前使用的提示词名称
                        let currentPromptName = '系统默认提示词';
                        if (context) {
                            const promptName = context.globalState.get<string>('currentPrompt', '');
                            if (promptName !== '') {
                                currentPromptName = promptName;
                            }
                        }

                        // 把参数和校对结果写入日志文件
                        const logFilePath = FilePathUtils.getFilePath(editor.document.uri.fsPath, '.proofread', '.log');
                        const logMessage = `\n${'='.repeat(50)}\nPrompt: ${currentPromptName}\nModel: ${platform}, ${model}, T. ${userTemperature}\nContextLevel: ${contextLevel}\nReference: ${referenceFile}\nResult:\n\n${result}\n${'='.repeat(50)}\n\n`;
                        fs.appendFileSync(logFilePath, logMessage, 'utf8');

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
    }

    /**
     * 处理校对JSON文件命令（从Webview调用）
     */
    public async handleProofreadJsonFile(
        jsonFilePath: string,
        context: vscode.ExtensionContext
    ): Promise<void> {
        try {
            // 检查文件是否存在
            if (!fs.existsSync(jsonFilePath)) {
                vscode.window.showErrorMessage('JSON文件不存在！');
                return;
            }

            // 读取并验证JSON文件
            const content = fs.readFileSync(jsonFilePath, 'utf8');
            const jsonContent = JSON.parse(content);

            // 验证JSON格式是否符合要求
            if (!Array.isArray(jsonContent) || !jsonContent.every(item =>
                typeof item === 'object' && item !== null && 'target' in item
            )) {
                vscode.window.showErrorMessage('JSON文件格式不正确！需要包含target字段的对象数组。');
                return;
            }

            // 生成输出文件路径
            const outputFilePath = FilePathUtils.getFilePath(jsonFilePath, '.proofread', '.json');
            const logFilePath = FilePathUtils.getFilePath(jsonFilePath, '.proofread', '.log');
            const originalMarkdownFilePath = FilePathUtils.getFilePath(jsonFilePath, '', '.md');
            const proofreadMarkdownFilePath = FilePathUtils.getFilePath(jsonFilePath, '.proofread.json', '.md');

            // 检查proofreadMarkdownFilePath文件是否存在，如果存在则备份
            if (fs.existsSync(proofreadMarkdownFilePath)) {
                const backupFilePath = FilePathUtils.getFilePath(jsonFilePath, `.proofread.json-${new Date().getTime()}`, '.md');
                fs.copyFileSync(proofreadMarkdownFilePath, backupFilePath);
            }

            // 获取配置
            const platform = this.configManager.getPlatform();
            const model = this.configManager.getModel(platform);
            const rpm = this.configManager.getRpm();
            const maxConcurrent = this.configManager.getMaxConcurrent();
            const temperature = this.configManager.getTemperature();

            // 检查API密钥是否已配置
            const apiKey = this.configManager.getApiKey(platform);
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

            // 写入开始日志
            let currentPromptName = '系统默认提示词';
            if (context) {
                const promptName = context.globalState.get<string>('currentPrompt', '');
                if (promptName !== '') {
                    currentPromptName = promptName;
                }
            }

            const startTime = new Date().toLocaleString();
            let logMessage = `\n${'='.repeat(50)}\n`;
            logMessage += `Start: ${startTime}\n`;
            logMessage += `Prompt: ${currentPromptName}\n`;
            logMessage += `Model: ${platform}, ${model}, T. ${temperature}\n`;
            logMessage += `RPM: ${rpm}\n`;
            logMessage += `MaxConcurrent: ${maxConcurrent}\n`;
            logMessage += `${'='.repeat(50)}\n`;
            fs.appendFileSync(logFilePath, logMessage, 'utf8');

            // 显示进度
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "正在校对文件...",
                cancellable: true
            }, async (progress, token) => {
                try {
                    // 调用校对功能
                    const stats = await processJsonFileAsync(jsonFilePath, outputFilePath, {
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

                    // 不再自动生成差异文件，改为在Webview中提供生成按钮

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

                    // 更新面板显示校对结果
                    const processResult: ProcessResult = {
                        title: '处理完成',
                        message: '文件切分和校对都已完成！',
                        splitResult: this.webviewManager.getCurrentProcessResult()?.splitResult, // 保留切分结果
                        proofreadResult: {
                            outputFilePath: outputFilePath,
                            logFilePath: logFilePath,
                            originalFilePath: originalMarkdownFilePath,
                            markdownFilePath: proofreadMarkdownFilePath,
                            stats: {
                                totalCount: stats.totalCount,
                                processedCount: stats.processedCount,
                                processedLength: stats.processedLength,
                                totalLength: stats.totalLength
                            }
                        },
                        actions: {
                            showJson: true,
                            showLog: true,
                            showDiff: true
                        }
                    };

                    if (this.webviewManager.getCurrentPanel()) {
                        // 如果已有面板，更新内容
                        this.webviewManager.updatePanelContent(processResult);
                        // 激活面板
                        this.webviewManager.getCurrentPanel()?.reveal();
                    } else {
                        // 如果没有面板，创建新面板
                        const panel = this.webviewManager.createWebviewPanel(processResult);
                        
                        // 监听Webview消息
                        panel.webview.onDidReceiveMessage(
                            (message) => this.webviewManager.handleWebviewMessage(message, panel, context),
                            undefined,
                            context.subscriptions
                        );
                        
                        // 激活面板
                        panel.reveal();
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
            if (error instanceof Error && error.message.includes('未配置')) {
                const result = await vscode.window.showErrorMessage(
                    error.message + '，是否现在配置？',
                    '是',
                    '否'
                );
                if (result === '是') {
                    const { PromptManager } = await import('../promptManager');
                    PromptManager.getInstance(context).managePrompts();
                }
            } else {
                ErrorUtils.showError(error, '校对JSON文件时出错：');
            }
        }
    }
}
