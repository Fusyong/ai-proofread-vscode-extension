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
import { ProgressTracker } from '../progressTracker';

export class ProofreadCommandHandler {
    private webviewManager: WebviewManager;
    private configManager: ConfigManager;

    constructor(webviewManager: WebviewManager) {
        this.webviewManager = webviewManager;
        this.configManager = ConfigManager.getInstance();
    }

    /**
     * 执行核心校对逻辑（统一的核心逻辑）
     */
    private async executeProofreadJsonFile(
        jsonFilePath: string,
        jsonContent: any[],
        context: vscode.ExtensionContext
    ): Promise<void> {
        // 生成输出文件路径
        const outputFilePath = FilePathUtils.getFilePath(jsonFilePath, '.proofread', '.json');
        const logFilePath = FilePathUtils.getFilePath(jsonFilePath, '.proofread', '.log');
        const originalMarkdownFilePath = FilePathUtils.getFilePath(jsonFilePath, '', '.md');
        const proofreadMarkdownFilePath = FilePathUtils.getFilePath(jsonFilePath, '.proofread.json', '.md');

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

        // 显示参数确认对话框（在备份之前，如果用户不同意参数则不进行备份）
        const confirmResult = await this.showJsonBatchConfirmation({
            jsonFilePath,
            totalCount: jsonContent.length,
            platform,
            model,
            rpm,
            maxConcurrent,
            temperature,
            context
        });

        if (!confirmResult) {
            return; // 用户取消操作，不进行备份
        }

        // 用户已确认参数，现在检查并备份输出文件（统一逻辑）
        const shouldContinue = await this.checkAndBackupOutputFile(
            jsonFilePath,
            jsonContent,
            outputFilePath,
            proofreadMarkdownFilePath
        );

        if (!shouldContinue) {
            return; // 用户取消操作（例如长度不一致时选择取消）
        }

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

        // 显示进度
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "正在校对文件...",
            cancellable: true
        }, async (progress, token) => {
            try {
                // 创建进度跟踪器
                let progressTracker: ProgressTracker | undefined;

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
                    onProgressUpdate: (progressTracker) => {
                        // 更新进度条显示（始终保留切分结果板块）
                        const existingSplitResult = this.webviewManager.getCurrentProcessResult()?.splitResult;
                        const splitResult =
                            existingSplitResult ??
                            (() => {
                                const dir = path.dirname(jsonFilePath);
                                const base = path.basename(jsonFilePath, '.json');
                                return {
                                    jsonFilePath,
                                    markdownFilePath: path.join(dir, `${base}.json.md`),
                                    logFilePath: path.join(dir, `${base}.log`),
                                    originalFilePath: originalMarkdownFilePath
                                };
                            })();
                        const processResult: ProcessResult = {
                            title: 'Proofreading panel',
                            message: '正在校对文件...',
                            splitResult,
                            progressTracker: progressTracker,
                            actions: {
                                showJson: false,
                                showLog: false,
                                showDiff: false
                            }
                        };

                        if (this.webviewManager.getCurrentPanel()) {
                            this.webviewManager.updatePanelContent(processResult);
                        } else {
                            const panel = this.webviewManager.createWebviewPanel(processResult, context);
                            panel.webview.onDidReceiveMessage(
                                (message) => this.webviewManager.handleWebviewMessage(message, panel, context),
                                undefined,
                                context.subscriptions
                            );
                            panel.reveal();
                        }
                    },
                    token, // 传递取消令牌
                    context // 传递扩展上下文
                });

                progressTracker = stats.progressTracker;

                // 标记进度跟踪完成
                if (progressTracker) {
                    progressTracker.complete();
                }

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

                // 更新面板显示校对结果（始终保留切分结果板块）
                const existingSplitResult = this.webviewManager.getCurrentProcessResult()?.splitResult;
                const splitResult =
                    existingSplitResult ??
                    (() => {
                        // 从 proofread 路径反推切分结果路径，确保切分板块始终可展示
                        const dir = path.dirname(outputFilePath);
                        const base = path.basename(outputFilePath, '.proofread.json');
                        return {
                            jsonFilePath: path.join(dir, `${base}.json`),
                            markdownFilePath: path.join(dir, `${base}.json.md`),
                            logFilePath: path.join(dir, `${base}.log`),
                            originalFilePath: originalMarkdownFilePath
                        };
                    })();
                const relPath =
                    vscode.workspace.workspaceFolders?.[0] && originalMarkdownFilePath.startsWith(vscode.workspace.workspaceFolders[0].uri.fsPath)
                        ? path.relative(vscode.workspace.workspaceFolders[0].uri.fsPath, originalMarkdownFilePath)
                        : originalMarkdownFilePath;
                const processResult: ProcessResult = {
                    title: 'Proofreading panel',
                    message: `校对项目：${relPath}`,
                    splitResult,
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
                    progressTracker: stats.progressTracker, // 包含进度跟踪器
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
                    const panel = this.webviewManager.createWebviewPanel(processResult, context);

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
    }

    /**
     * 处理校对文件命令（从右键菜单/命令面板调用）
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
            const jsonFilePath = document.uri.fsPath;

            // 调用统一的核心校对逻辑
            await this.executeProofreadJsonFile(jsonFilePath, jsonContent, context);
        } catch (error) {
            ErrorUtils.showError(error, '解析JSON文件时出错：');
        }
    }

    /**
     * 处理校对选中文本命令（使用 examples.md 作为 reference）
     */
    public async handleProofreadSelectionWithExamplesCommand(
        editor: vscode.TextEditor,
        context: vscode.ExtensionContext
    ): Promise<void> {
        const examplesPath = FilePathUtils.getExamplesPath(editor.document.uri);
        let referenceFile: vscode.Uri[] | undefined;
        if (examplesPath && fs.existsSync(examplesPath)) {
            referenceFile = [vscode.Uri.file(examplesPath)];
        } else {
            vscode.window.showWarningMessage('examples.md 不存在，将不使用参考示例。可先运行「edit Proofreading examples」添加示例。');
        }
        await this.executeProofreadSelectionFlow(editor, context, referenceFile);
    }

    /**
     * 处理校对选中文本命令
     */
    public async handleProofreadSelectionCommand(
        editor: vscode.TextEditor,
        context: vscode.ExtensionContext
    ): Promise<void> {
        await this.executeProofreadSelectionFlow(editor, context);
    }

    /**
     * 执行校对选中文本的核心流程
     * @param referenceFileOverride 若提供，则跳过「是否使用参考文件」选择，直接使用
     */
    private async executeProofreadSelectionFlow(
        editor: vscode.TextEditor,
        context: vscode.ExtensionContext,
        referenceFileOverride?: vscode.Uri[]
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

            // 如果用户按 ESC 取消，立即中断
            if (contextBuildMethod === undefined) {
                return;
            }

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
                // 如果用户按 ESC 取消，立即中断
                if (beforeParagraphsInput === undefined) {
                    return;
                }
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
                // 如果用户按 ESC 取消，立即中断
                if (afterParagraphsInput === undefined) {
                    return;
                }
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
                // 如果用户按 ESC 取消，立即中断
                if (contextLevel === undefined) {
                    return;
                }
            }

            let referenceFile: vscode.Uri[] | undefined;
            if (referenceFileOverride !== undefined) {
                referenceFile = referenceFileOverride;
            } else {
                const useReference = await vscode.window.showQuickPick(
                    ['否', '是'],
                    {
                        placeHolder: '是否使用参考文件？',
                        ignoreFocusOut: true
                    }
                );

                // 如果用户按 ESC 取消，立即中断
                if (useReference === undefined) {
                    return;
                }

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
                    // 如果用户按 ESC 取消，立即中断
                    if (referenceFile === undefined) {
                        return;
                    }
                }
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

            // 如果用户按 ESC 取消，立即中断
            if (userTemperature === undefined) {
                return;
            }

            // 让用户选择提示词重复模式
            const repetitionMode = await vscode.window.showQuickPick([
                { label: '不重复', value: 'none', description: '不启用重复功能' },
                { label: '仅重复目标文档', value: 'target', description: '只重复要修改的目标文档（target）' },
                { label: '重复完整对话流程', value: 'all', description: '重复参考文档、语境和目标文档（完整对话流程）' }
            ], {
                placeHolder: '选择提示词重复模式（基于谷歌研究：重复提示词可提高准确度）',
                ignoreFocusOut: true
            });

            // 如果用户按 ESC 取消，立即中断
            if (repetitionMode === undefined) {
                return;
            }

            // 获取用户选择的重复模式（不更新配置，仅作为参数传递）
            let actualRepetitionMode: 'none' | 'target' | 'all' | undefined = undefined;
            if (repetitionMode) {
                actualRepetitionMode = repetitionMode.value as 'none' | 'target' | 'all';
            }

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
                        context,
                        beforeParagraphs,
                        afterParagraphs,
                        actualRepetitionMode
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

                        // 获取提示词重复模式显示名称（用于日志）
                        const repetitionModeNames: { [key: string]: string } = {
                            'none': '不重复',
                            'target': '仅重复目标文档',
                            'all': '重复完整对话流程'
                        };
                        const repetitionModeName = actualRepetitionMode ? repetitionModeNames[actualRepetitionMode] || '不重复' : '不重复';

                        // 把参数和校对结果写入日志文件
                        const logFilePath = FilePathUtils.getFilePath(editor.document.uri.fsPath, '.proofread', '.log');
                        const logMessage = `\n${'='.repeat(50)}\nPrompt: ${currentPromptName}\nRepetitionMode: ${repetitionModeName}\nModel: ${platform}, ${model}, T. ${userTemperature}\nContextLevel: ${contextLevel}\nReference: ${referenceFile}\nResult:\n\n${result}\n${'='.repeat(50)}\n\n`;
                        fs.appendFileSync(logFilePath, logMessage, 'utf8');

                        // 显示信息消息，包含提示词重复模式（使用键名）
                        const targetLength = editor.document.getText(editor.selection).length;
                        const contextLength = contextLevel ? '已设置' : 'none';
                        const referenceLength = referenceFile ? '已设置' : 'none';
                        vscode.window.showInformationMessage(
                            `校对完成 | Prompt: ${currentPromptName.slice(0, 4)}… Rep. ${actualRepetitionMode} | ` +
                            `Context: R. ${referenceLength}, C. ${contextLength}, T. ${targetLength} | ` +
                            `Model: ${platform}, ${model}, T. ${userTemperature}`
                        );

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
     * 显示JSON批量提交参数确认对话框
     */
    private async showJsonBatchConfirmation(params: {
        jsonFilePath: string;
        totalCount: number;
        platform: string;
        model: string;
        rpm: number;
        maxConcurrent: number;
        temperature: number;
        context?: vscode.ExtensionContext;
    }): Promise<boolean> {
        const { jsonFilePath, totalCount, platform, model, rpm, maxConcurrent, temperature, context } = params;

        // 获取当前提示词名称
        let currentPromptName = '系统默认提示词';
        if (context) {
            const promptName = context.globalState.get<string>('currentPrompt', '');
            if (promptName !== '') {
                currentPromptName = promptName;
            }
        }

        // 获取超时和重试配置
        const config = vscode.workspace.getConfiguration('ai-proofread');
        const timeout = config.get<number>('proofread.timeout', 50);
        const retryDelay = config.get<number>('proofread.retryDelay', 1);
        const retryAttempts = config.get<number>('proofread.retryAttempts', 3);

        // 获取提示词重复模式
        const repetitionMode = config.get<string>('proofread.promptRepetition', 'none');
        const repetitionModeNames: { [key: string]: string } = {
            'none': '不重复',
            'target': '仅重复目标文档（target）',
            'all': '重复完整对话流程（reference + context + target）'
        };
        const repetitionModeName = repetitionModeNames[repetitionMode] || '不重复';

        // 计算token和费用提示
        let tokenWarning = '';
        if (repetitionMode === 'target') {
            tokenWarning = '   ⚠️ 提示词重复模式：仅重复target，会增加输入token';
        } else if (repetitionMode === 'all') {
            tokenWarning = '   ⚠️ 提示词重复模式：重复完整对话流程，会增加输入token';
        }

        // 构建确认信息
        const confirmationMessage = [
            '📋 JSON批量校对参数确认',
            '',
            `📁 文件路径: ${jsonFilePath}`,
            `📊 总段落数: ${totalCount}`,
            '',
            '⚙️ 处理参数:',
            `   • 提示词: ${currentPromptName}`,
            `   • 提示词重复模式: ${repetitionModeName}`,
            tokenWarning ? tokenWarning : '',
            `   • 平台: ${platform}`,
            `   • 模型: ${model}`,
            `   • 温度: ${temperature}`,
            `   • 并发数: ${maxConcurrent}`,
            `   • 请求频率: ${rpm} 次/分钟`,
            `   • 请求超时: ${timeout} 秒`,
            `   • 重试间隔: ${retryDelay} 秒`,
            `   • 重试次数: ${retryAttempts} 次`,
            '',
            '⚠️ 注意事项:',
            '   • 💰批处理中使用思考/推理模型极易出错并形成高计费！！！',
            '   • 💰重复提示词会增加输入token，但可能提高校对准确度。如果API支持缓存（如Deepseek），重复内容可能享受缓存命中的低价',
            '   • 处理过程中可以随时取消',
            '   • 已处理的段落会跳过',
            '   • 结果会实时保存到输出文件',
            '',
            '是否确认开始批量校对？'
        ].filter(line => line !== '').join('\n');

        const result = await vscode.window.showInformationMessage(
            confirmationMessage,
            { modal: true },
            '确认开始'
        );

        return result === '确认开始';
    }

    /**
     * 检查并备份输出文件（统一的备份逻辑）
     * @param jsonFilePath 输入JSON文件路径
     * @param jsonContent 输入JSON内容（已解析）
     * @param outputFilePath 输出JSON文件路径
     * @param proofreadMarkdownFilePath 输出Markdown文件路径
     * @returns 如果用户取消操作返回false，否则返回true
     */
    private async checkAndBackupOutputFile(
        jsonFilePath: string,
        jsonContent: any[],
        outputFilePath: string,
        proofreadMarkdownFilePath: string
    ): Promise<boolean> {
        // 检查输出文件是否存在
        const inputLength = jsonContent.length;
        if (fs.existsSync(outputFilePath)) {
            // 如果输出文件存在，检查长度是否一致
            try {
                const outputContent = JSON.parse(fs.readFileSync(outputFilePath, 'utf8'));
                const outputLength = Array.isArray(outputContent) ? outputContent.length : 0;

                if (outputLength !== inputLength) {
                    // 长度不一致，提示用户选择
                    const result = await vscode.window.showWarningMessage(
                        `检测到输出文件长度不一致：\n` +
                        `输入文件长度: ${inputLength}\n` +
                        `输出文件长度: ${outputLength}\n\n` +
                        `请选择操作：`,
                        { modal: true },
                        '备份后重新校对'
                    );

                    // 如果用户点击Cancel或关闭对话框，result为undefined，不进行任何操作
                    if (result !== '备份后重新校对') {
                        return false; // 用户取消操作
                    }

                    // 用户选择备份后重新校对，备份并删除原文件
                    FilePathUtils.backupFileIfExists(outputFilePath, true);
                    // Markdown 文件也备份并删除
                    FilePathUtils.backupFileIfExists(proofreadMarkdownFilePath, true);
                } else {
                    // 长度一致，继续校对，不备份
                    // Markdown 文件删除，因为会被完全重新生成
                    FilePathUtils.backupFileIfExists(proofreadMarkdownFilePath, true);
                }
            } catch (error) {
                // 如果读取输出文件失败，提示用户
                const result = await vscode.window.showWarningMessage(
                    `无法读取输出文件，可能已损坏。是否备份后重新校对？`,
                    { modal: true },
                    '备份后重新校对'
                );

                // 如果用户点击Cancel或关闭对话框，result为undefined，不进行任何操作
                if (result !== '备份后重新校对') {
                    return false;
                }

                // 备份并删除原文件
                FilePathUtils.backupFileIfExists(outputFilePath, true);
                FilePathUtils.backupFileIfExists(proofreadMarkdownFilePath, true);
            }
        } else {
            // 输出文件不存在，从头开始校对
            // Markdown 文件如果存在也删除（因为会被重新生成）
            FilePathUtils.backupFileIfExists(proofreadMarkdownFilePath, true);
        }

        return true;
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

            // 调用统一的核心校对逻辑
            await this.executeProofreadJsonFile(jsonFilePath, jsonContent, context);
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
