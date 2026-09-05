/**
 * 校对命令处理器
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
    assembleProofreadSelectionInput,
    processJsonFileAsync,
    proofreadSelection,
    getSystemPrompt,
    getOutputType
} from '../proofreader';
import { showSelectionProofreadDiffWithApply } from '../differ';
import { runEditorialMemoryAfterAccept } from '../editorialMemory/service';
import { FilePathUtils, ErrorUtils, ConfigManager } from '../utils';
import { getPromptDisplayName } from '../promptManager';
import { isUsingSystemDefaultPrompt, pickSourceTextCharacteristicsInjection } from '../sourceTextCharacteristicsPicker';
import {
    formatSourceCharacteristicsForLog,
    summarizeSourceCharacteristicsForLog,
} from '../sourceTextCharacteristics';
import {
    buildDefaultProofreadSelectionWithMemoryConfig,
    mapConfigToSelectionContext,
    readOrCreateProofreadSelectionWithMemoryConfig,
    resolveReferenceFileUris,
    resolveSourceTextHint,
    type ProofreadSelectionWithMemoryConfig
} from '../proofreadSelectionWithMemoryConfig';
import { WebviewManager, ProcessResult } from '../ui/webviewManager';
import { showQuickPickWithDefault } from '../ui/quickPickDefault';
import {
    loadProofreadSelectionLastRun,
    PROOFREAD_SELECTION_CONTEXT_BUILD_METHODS,
    PROOFREAD_SELECTION_HEADING_LEVELS,
    saveProofreadSelectionLastRun,
    type ProofreadSelectionContextBuildMethod,
    type ProofreadSelectionHeadingLevel,
    type ProofreadSelectionLastRun,
    type ProofreadSelectionRepetitionMode
} from '../proofreadSelectionLastRun';
import { ProgressTracker } from '../progressTracker';
import {
    confirmProofreadInputIfNeeded,
    getProofreadInputConfirmSettings,
    SINGLE_TARGET_OVERFLOW_CHARS
} from '../proofreadInputConfirm';
import { resolveProofreadModel } from '../modelRoutes/modelRouteResolver';
import {
    addStats,
    countRequestableItems,
    estimateSingleRequestInputChars,
    findMaxJsonBatchItemStats,
    scaleStats,
    statsFromText,
    summarizeJsonBatchContentStats,
    summarizeProofreadFieldStats
} from '../tokenEstimate';

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

        // 源文本特性注入仅在使用内置全文/条目模板（系统默认、表述正常化等）时询问；先于参数确认，便于在确认框中展示注入选择
        const useSystemDefaultPrompt = !!(context && isUsingSystemDefaultPrompt(context));
        let sourceTextCharacteristics = '';
        let sourceCharacteristicsDisplayTitle: string | undefined;
        if (useSystemDefaultPrompt) {
            const picked = await pickSourceTextCharacteristicsInjection(context!);
            if (picked === undefined) {
                return;
            }
            sourceTextCharacteristics = picked.injectText;
            sourceCharacteristicsDisplayTitle = picked.displayTitle;
        }

        const confirmResult = await this.showJsonBatchConfirmation({
            jsonFilePath,
            jsonContent,
            totalCount: jsonContent.length,
            platform,
            model,
            rpm,
            maxConcurrent,
            temperature,
            context,
            sourceTextCharacteristics,
            sourceCharacteristicsInjectSummary: useSystemDefaultPrompt
                ? sourceCharacteristicsDisplayTitle ??
                  summarizeSourceCharacteristicsForLog(sourceTextCharacteristics)
                : undefined
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
        const currentPromptName = context
            ? getPromptDisplayName(context.globalState.get<string>('currentPrompt', ''))
            : '系统默认提示词（full）';

        const startTime = new Date().toLocaleString();
        let logMessage = `\n${'='.repeat(50)}\n`;
        logMessage += `Start: ${startTime}\n`;
        logMessage += `Prompt: ${currentPromptName}\n`;
        logMessage += `SrcHint: ${formatSourceCharacteristicsForLog(sourceTextCharacteristics, sourceCharacteristicsDisplayTitle)}\n`;
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
                    sourceTextCharacteristics,
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
     * 处理校对选中文本命令
     * @param options.presetReferenceFile 已选定的参考文件（跳过「是否使用参考文件」与文件选择对话框）
     */
    public async handleProofreadSelectionCommand(
        editor: vscode.TextEditor,
        context: vscode.ExtensionContext,
        options?: { presetReferenceFile?: vscode.Uri }
    ): Promise<void> {
        await this.executeProofreadSelectionFlow(editor, context, undefined, options);
    }

    /**
     * 校对选中并启用编辑记忆：`editorial-memory.json` / `editorial-memory-archive.json`（v2）注入与接受写回。
     */
    public async handleProofreadSelectionWithMemoryCommand(
        editor: vscode.TextEditor,
        context: vscode.ExtensionContext
    ): Promise<void> {
        await this.executeProofreadSelectionFlow(editor, context, true);
    }

    /**
     * 执行校对选中文本的核心流程
     * @param editorialMemoryForceEnabled 为 true：与「Proofread Selection with Memory」等价；为 false/undefined：普通选段不写记忆。
     * @param options.presetReferenceFile 预设参考文件时跳过参考文件相关交互，其余步骤不变。
     */
    private async executeProofreadSelectionFlow(
        editor: vscode.TextEditor,
        context: vscode.ExtensionContext,
        editorialMemoryForceEnabled?: boolean,
        options?: { presetReferenceFile?: vscode.Uri }
    ): Promise<void> {
        try {
            const platform = this.configManager.getPlatform();
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

            if (editorialMemoryForceEnabled === true) {
                await this.executeProofreadSelectionWithMemoryFromConfig(editor, context);
                return;
            }

            const lastRun = loadProofreadSelectionLastRun(context);

            const contextBuildPick = await showQuickPickWithDefault(
                PROOFREAD_SELECTION_CONTEXT_BUILD_METHODS.map((label) => ({ label })),
                {
                    placeHolder: '选择上下文构建方式',
                    ignoreFocusOut: true,
                    lastValue: lastRun?.contextBuildMethod
                }
            );

            if (contextBuildPick === undefined) {
                return;
            }
            const contextBuildMethod = contextBuildPick.label as ProofreadSelectionContextBuildMethod;

            let contextLevel: string | undefined;
            let beforeParagraphs: number = 0;
            let afterParagraphs: number = 0;

            if (contextBuildMethod === '前后增加段落') {
                const beforeDefault =
                    lastRun?.beforeParagraphs !== undefined ? String(lastRun.beforeParagraphs) : '1';
                const beforeParagraphsInput = await vscode.window.showInputBox({
                    prompt: '前文增加段落个数',
                    value: beforeDefault,
                    validateInput: (value: string) => {
                        const num = parseInt(value);
                        if (isNaN(num) || num < 0 || num > 10) {
                            return '请输入一个[0:10]之间的数字';
                        }
                        return null;
                    }
                });
                if (beforeParagraphsInput === undefined) {
                    return;
                }
                beforeParagraphs = beforeParagraphsInput ? parseInt(beforeParagraphsInput) : 2;

                const afterDefault =
                    lastRun?.afterParagraphs !== undefined ? String(lastRun.afterParagraphs) : '1';
                const afterParagraphsInput = await vscode.window.showInputBox({
                    prompt: '后文增加段落个数',
                    value: afterDefault,
                    validateInput: (value: string) => {
                        const num = parseInt(value);
                        if (isNaN(num) || num < 0 || num > 10) {
                            return '请输入一个[0:10]之间的数字';
                        }
                        return null;
                    }
                });
                if (afterParagraphsInput === undefined) {
                    return;
                }
                afterParagraphs = afterParagraphsInput ? parseInt(afterParagraphsInput) : 2;

                contextLevel = '前后增加段落';
            } else if (contextBuildMethod === '使用所在标题范围') {
                const headingPick = await showQuickPickWithDefault(
                    PROOFREAD_SELECTION_HEADING_LEVELS.map((label) => ({ label })),
                    {
                        placeHolder: '选择上下文范围（可选）',
                        ignoreFocusOut: true,
                        lastValue: lastRun?.headingLevel
                    }
                );
                if (headingPick === undefined) {
                    return;
                }
                contextLevel = headingPick.label;
            }

            let referenceFile: vscode.Uri[] | undefined;
            if (options?.presetReferenceFile) {
                referenceFile = [options.presetReferenceFile];
            } else {
                const useReferenceLast =
                    lastRun?.useReference === true ? '是' : lastRun?.useReference === false ? '否' : undefined;
                const useReferencePick = await showQuickPickWithDefault(
                    [{ label: '否' }, { label: '是' }],
                    {
                        placeHolder: '是否使用参考文件？',
                        ignoreFocusOut: true,
                        lastValue: useReferenceLast
                    }
                );

                if (useReferencePick === undefined) {
                    return;
                }

                if (useReferencePick.label === '是') {
                    referenceFile = await vscode.window.showOpenDialog({
                        canSelectFiles: true,
                        canSelectFolders: false,
                        canSelectMany: false,
                        filters: {
                            'Text files': ['txt', 'md']
                        },
                        title: '选择参考文件',
                        defaultUri: this.resolveReferenceDialogDefaultUri(lastRun?.referenceFilePath)
                    });
                    if (referenceFile === undefined) {
                        return;
                    }
                }
            }

            const temperatureDefault =
                lastRun?.temperature !== undefined
                    ? lastRun.temperature.toString()
                    : this.configManager.getTemperature().toString();
            const userTemperature = await vscode.window.showInputBox({
                prompt: '请输入温度',
                value: temperatureDefault,
                validateInput: (value: string) => {
                    const temperature = parseFloat(value);
                    if (isNaN(temperature) || temperature < 0 || temperature >= 2) {
                        return '请输入一个[0:2)之间的数字';
                    }
                    return null;
                }
            });

            if (userTemperature === undefined) {
                return;
            }

            type RepetitionPick = vscode.QuickPickItem & { value: ProofreadSelectionRepetitionMode };
            const repetitionMode = await showQuickPickWithDefault<RepetitionPick>(
                [
                    { label: '不重复', value: 'none', description: '不启用重复功能' },
                    { label: '仅重复目标文档', value: 'target', description: '只重复要修改的目标文档（target）' },
                    { label: '重复完整对话流程', value: 'all', description: '重复参考文档、语境和目标文档（完整对话流程）' }
                ],
                {
                    placeHolder: '选择提示词重复模式（基于谷歌研究：重复提示词可提高准确度）',
                    ignoreFocusOut: true,
                    lastValue: lastRun?.repetitionMode,
                    getValue: (item) => item.value
                }
            );

            if (repetitionMode === undefined) {
                return;
            }

            const actualRepetitionMode = repetitionMode.value;

            await saveProofreadSelectionLastRun(context, this.buildProofreadSelectionLastRun({
                lastRun,
                contextBuildMethod,
                contextLevel,
                beforeParagraphs,
                afterParagraphs,
                referenceFile,
                temperature: parseFloat(userTemperature),
                repetitionMode: actualRepetitionMode
            }));

            let sourceTextCharacteristics = '';
            let sourceCharacteristicsDisplayTitle: string | undefined;
            if (context && isUsingSystemDefaultPrompt(context)) {
                const picked = await pickSourceTextCharacteristicsInjection(context);
                if (picked === undefined) {
                    return;
                }
                sourceTextCharacteristics = picked.injectText;
                sourceCharacteristicsDisplayTitle = picked.displayTitle;
            }

            await this.runProofreadSelectionWithResolvedParams(
                editor,
                context,
                {
                    contextLevel,
                    beforeParagraphs,
                    afterParagraphs,
                    referenceFile,
                    userTemperature: parseFloat(userTemperature),
                    actualRepetitionMode,
                    sourceTextCharacteristics,
                    sourceCharacteristicsDisplayTitle
                },
                editorialMemoryForceEnabled
            );
        } catch (error) {
            ErrorUtils.showError(error, '校对过程中出错：');
        }
    }

    /**
     * 「Proofread Selection with Memory」：从工作区 `.proofread/proofread-selection-with-memory.json` 读参（缺失则生成默认）。
     */
    private async executeProofreadSelectionWithMemoryFromConfig(
        editor: vscode.TextEditor,
        context: vscode.ExtensionContext
    ): Promise<void> {
        const folder =
            vscode.workspace.getWorkspaceFolder(editor.document.uri) ?? vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            await vscode.window.showErrorMessage(
                '「Proofread Selection with Memory」需要打开工作区文件夹，以便读取或生成 .proofread/proofread-selection-with-memory.json。'
            );
            return;
        }

        const wsCfg = vscode.workspace.getConfiguration('ai-proofread');
        const repRaw = wsCfg.get<string>('proofread.promptRepetition', 'none');
        const repetitionDefault = (repRaw === 'target' || repRaw === 'all' ? repRaw : 'none') as
            | 'none'
            | 'target'
            | 'all';

        const defaults = buildDefaultProofreadSelectionWithMemoryConfig(
            this.configManager.getTemperature(),
            repetitionDefault
        );

        let cfgBundle: { config: ProofreadSelectionWithMemoryConfig; configPath: string; created: boolean };
        try {
            cfgBundle = readOrCreateProofreadSelectionWithMemoryConfig(editor.document.uri, defaults);
        } catch (e) {
            ErrorUtils.showError(e, '校对参数配置文件：');
            return;
        }

        const { config, created, configPath } = cfgBundle;
        if (created) {
            void vscode.window.showInformationMessage(`已生成默认参数文件，可按需编辑后再运行：${configPath}`);
        }

        const { contextLevel, beforeParagraphs, afterParagraphs } = mapConfigToSelectionContext(config);

        let referenceFile: vscode.Uri[] | undefined;
        try {
            const uris = resolveReferenceFileUris(folder, config.referenceFiles);
            referenceFile = uris.length > 0 ? uris : undefined;
        } catch (e) {
            ErrorUtils.showError(e, '参考文件路径：');
            return;
        }

        const st = resolveSourceTextHint(config.sourceTextHint, context);
        if (!st.ok) {
            const action = await vscode.window.showErrorMessage(st.message, '管理提示词');
            if (action === '管理提示词') {
                await vscode.commands.executeCommand('ai-proofread.managePrompts');
            }
            return;
        }

        await this.runProofreadSelectionWithResolvedParams(
            editor,
            context,
            {
                contextLevel,
                beforeParagraphs,
                afterParagraphs,
                referenceFile,
                userTemperature: config.temperature,
                actualRepetitionMode: config.repetitionMode,
                sourceTextCharacteristics: st.result.injectText,
                sourceCharacteristicsDisplayTitle: st.result.displayTitle
            },
            true
        );
    }

    private resolveReferenceDialogDefaultUri(filePath: string | undefined): vscode.Uri | undefined {
        if (!filePath) {
            return undefined;
        }
        if (fs.existsSync(filePath)) {
            return vscode.Uri.file(filePath);
        }
        const dir = path.dirname(filePath);
        if (dir && fs.existsSync(dir)) {
            return vscode.Uri.file(dir);
        }
        return undefined;
    }

    private buildProofreadSelectionLastRun(params: {
        lastRun?: ProofreadSelectionLastRun;
        contextBuildMethod: ProofreadSelectionContextBuildMethod;
        contextLevel?: string;
        beforeParagraphs: number;
        afterParagraphs: number;
        referenceFile?: vscode.Uri[];
        temperature: number;
        repetitionMode: ProofreadSelectionRepetitionMode;
    }): ProofreadSelectionLastRun {
        const { lastRun, contextBuildMethod } = params;
        const headingLevel =
            contextBuildMethod === '使用所在标题范围' &&
            params.contextLevel &&
            (PROOFREAD_SELECTION_HEADING_LEVELS as readonly string[]).includes(params.contextLevel)
                ? (params.contextLevel as ProofreadSelectionHeadingLevel)
                : lastRun?.headingLevel;
        return {
            contextBuildMethod,
            beforeParagraphs:
                contextBuildMethod === '前后增加段落' ? params.beforeParagraphs : lastRun?.beforeParagraphs,
            afterParagraphs:
                contextBuildMethod === '前后增加段落' ? params.afterParagraphs : lastRun?.afterParagraphs,
            headingLevel,
            useReference: !!params.referenceFile?.length,
            referenceFilePath: params.referenceFile?.[0]?.fsPath ?? lastRun?.referenceFilePath,
            temperature: params.temperature,
            repetitionMode: params.repetitionMode
        };
    }

    private async runProofreadSelectionWithResolvedParams(
        editor: vscode.TextEditor,
        context: vscode.ExtensionContext,
        params: {
            contextLevel?: string;
            beforeParagraphs: number;
            afterParagraphs: number;
            referenceFile?: vscode.Uri[];
            userTemperature: number;
            actualRepetitionMode: 'none' | 'target' | 'all';
            sourceTextCharacteristics: string;
            sourceCharacteristicsDisplayTitle: string | undefined;
        },
        editorialMemoryForceEnabled?: boolean
    ): Promise<void> {
        const platform = this.configManager.getPlatform();
        const model = this.configManager.getModel(platform);
        const {
            contextLevel,
            beforeParagraphs,
            afterParagraphs,
            referenceFile,
            userTemperature,
            actualRepetitionMode,
            sourceTextCharacteristics,
            sourceCharacteristicsDisplayTitle
        } = params;

        const range = new vscode.Range(editor.selection.start, editor.selection.end);
        const sel = new vscode.Selection(range.start, range.end);
        const originalText = editor.document.getText(range);
        const fileExt = path.extname(editor.document.fileName);
        let rawItemOutput: string | undefined;
        let itemChanges: Array<{ original: string; corrected: string }> | undefined;

        const assembled = await assembleProofreadSelectionInput({
            editor,
            selection: sel,
            contextLevel,
            referenceFile,
            beforeParagraphs,
            afterParagraphs,
            editorialMemoryForceEnabled
        });

        if (!assembled.isBlankTarget) {
            const contentStats = summarizeProofreadFieldStats(
                assembled.targetText,
                assembled.referenceText,
                assembled.contextText
            );
            const memoryStats = statsFromText(assembled.editorialMemoryXml);
            const promptOnce = statsFromText(
                getSystemPrompt(context, sourceTextCharacteristics)
            );
            const contentPlusMemory = addStats(contentStats.total, memoryStats);
            const estimatedInputTotal = addStats(contentPlusMemory, promptOnce);
            const currentPromptName = getPromptDisplayName(
                context.globalState.get<string>('currentPrompt', '')
            );
            const confirmSettings = getProofreadInputConfirmSettings();
            const targetOverflowChars =
                confirmSettings.byField.target > 0
                    ? confirmSettings.byField.target
                    : SINGLE_TARGET_OVERFLOW_CHARS;
            const outputType = getOutputType(context);
            const thinkingEnabled = !resolveProofreadModel().disableThinking;
            const requestContentChars = contentPlusMemory.chars;
            const maxItemRequestChars = estimateSingleRequestInputChars(
                requestContentChars,
                contentStats.target.chars,
                promptOnce.chars,
                actualRepetitionMode
            );

            const confirmed = await confirmProofreadInputIfNeeded({
                title: '📋 选区校对参数确认',
                headerLines: [
                    `📄 文件: ${editor.document.fileName}`,
                    `📌 上下文: ${contextLevel || '不使用'}`,
                    referenceFile?.[0]
                        ? `📎 参考: ${referenceFile[0].fsPath}`
                        : '📎 参考: 无'
                ],
                promptName: currentPromptName,
                sourceCharacteristicsInjectSummary: sourceCharacteristicsDisplayTitle,
                repetitionMode: actualRepetitionMode,
                platform,
                model,
                temperature: userTemperature,
                settings: confirmSettings,
                selection: {
                    targetChars: contentStats.target.chars,
                    targetOverflowChars,
                    outputType,
                    thinkingEnabled,
                    requestContentChars,
                    maxItemRequestChars
                },
                contentStats,
                contentTotalForDisplay: contentPlusMemory,
                promptOnce,
                promptScaled: promptOnce,
                estimatedInputTotal,
                extraFieldLines:
                    memoryStats.chars > 0
                        ? [
                              `   • editorial_memory: ${memoryStats.chars.toLocaleString('zh-CN')} 字符 ≈ ${memoryStats.tokens.toLocaleString('zh-CN')} token`
                          ]
                        : undefined,
                additionalCharsForThreshold: memoryStats.chars,
                confirmButtonLabel: '确认开始'
            });
            if (!confirmed) {
                return;
            }
        }

        const result = await proofreadSelection(
            editor,
            sel,
            platform,
            model,
            contextLevel,
            referenceFile,
            userTemperature,
            context,
            beforeParagraphs,
            afterParagraphs,
            actualRepetitionMode,
            sourceTextCharacteristics,
            sourceCharacteristicsDisplayTitle,
            (items) => {
                itemChanges = items
                    .filter((i) => i.corrected != null)
                    .map((i) => ({ original: i.original, corrected: i.corrected! }));
            },
            (raw) => {
                rawItemOutput = raw;
            },
            editorialMemoryForceEnabled,
            undefined,
            assembled
        );

        if (result) {
            const currentPromptName = context
                ? getPromptDisplayName(context.globalState.get<string>('currentPrompt', ''))
                : '系统默认提示词（full）';

            const repetitionModeNames: { [key: string]: string } = {
                none: '不重复',
                target: '仅重复目标文档',
                all: '重复完整对话流程'
            };
            const repetitionModeName =
                actualRepetitionMode ? repetitionModeNames[actualRepetitionMode] || '不重复' : '不重复';

            const logFilePath = FilePathUtils.getFilePath(editor.document.uri.fsPath, '.proofread', '.log');
            const resultForLog = rawItemOutput !== undefined ? rawItemOutput : result;
            const logMessage = `\n${'='.repeat(50)}\nPrompt: ${currentPromptName}\nSrcHint: ${formatSourceCharacteristicsForLog(sourceTextCharacteristics, sourceCharacteristicsDisplayTitle)}\nRepetitionMode: ${repetitionModeName}\nModel: ${platform}, ${model}, T. ${userTemperature}\nContextLevel: ${contextLevel}\nReference: ${referenceFile}\nResult:\n\n${resultForLog}\n${'='.repeat(50)}\n\n`;
            fs.appendFileSync(logFilePath, logMessage, 'utf8');

            await new Promise<void>((resolve) => setImmediate(resolve));

            const targetLength = editor.document.getText(editor.selection).length;
            const contextLength = contextLevel ? '已设置' : 'none';
            const referenceLength = referenceFile ? '已设置' : 'none';
            vscode.window.showInformationMessage(
                `校对完成 | Prompt: ${currentPromptName} Src. ${sourceCharacteristicsDisplayTitle ?? summarizeSourceCharacteristicsForLog(sourceTextCharacteristics)} Rep. ${actualRepetitionMode} | ` +
                    `Context: R. ${referenceLength}, C. ${contextLength}, T. ${targetLength} | ` +
                    `Model: ${platform}, ${model}, T. ${userTemperature}`
            );

            const diffRes = await showSelectionProofreadDiffWithApply(
                context,
                editor.document,
                range,
                originalText,
                result,
                fileExt
            );
            if (diffRes.applied && editorialMemoryForceEnabled === true) {
                try {
                    await runEditorialMemoryAfterAccept({
                        documentUri: editor.document.uri,
                        fullText: editor.document.getText(),
                        selectionStartLine: range.start.line,
                        selectionRangeLabel: `L${range.start.line + 1}C${range.start.character}–L${range.end.line + 1}C${range.end.character}`,
                        originalSelected: originalText,
                        finalSelected: diffRes.finalText,
                        modelOutput: result,
                        platform,
                        model,
                        items: itemChanges,
                        editorialMemoryForceEnabled: true
                    });
                } catch {
                    /* 记忆更新失败不阻断 */
                }
            }
        } else {
            vscode.window.showErrorMessage('校对失败，请重试。');
        }
    }

    /**
     * JSON 批量校对：按 confirmMode / 阈值决定是否弹出参数确认
     */
    private async showJsonBatchConfirmation(params: {
        jsonFilePath: string;
        jsonContent: unknown[];
        totalCount: number;
        platform: string;
        model: string;
        rpm: number;
        maxConcurrent: number;
        temperature: number;
        context?: vscode.ExtensionContext;
        /** 实际注入系统提示词的源文本特性正文（与批量请求一致） */
        sourceTextCharacteristics?: string;
        /** 系统默认提示词时：已在上一环节选择的源文本特性注入摘要（如「无」、预设名） */
        sourceCharacteristicsInjectSummary?: string;
    }): Promise<boolean> {
        const {
            jsonFilePath,
            jsonContent,
            totalCount,
            platform,
            model,
            rpm,
            maxConcurrent,
            temperature,
            context,
            sourceTextCharacteristics = '',
            sourceCharacteristicsInjectSummary
        } = params;

        const currentPromptName = context
            ? getPromptDisplayName(context.globalState.get<string>('currentPrompt', ''))
            : '系统默认提示词（full）';

        const config = vscode.workspace.getConfiguration('ai-proofread');
        const timeout = config.get<number>('proofread.timeout', 50);
        const retryDelay = config.get<number>('proofread.retryDelay', 1);
        const retryAttempts = config.get<number>('proofread.retryAttempts', 3);
        const repetitionMode = config.get<string>('proofread.promptRepetition', 'none') || 'none';

        const contentStats = summarizeJsonBatchContentStats(jsonContent);
        const promptOnce = statsFromText(getSystemPrompt(context, sourceTextCharacteristics));
        const requestCount = countRequestableItems(jsonContent);
        const promptBatch = scaleStats(promptOnce, requestCount);
        const estimatedInputTotal = addStats(contentStats.total, promptBatch);
        const maxItem = findMaxJsonBatchItemStats(jsonContent);
        const maxItemRequestChars = estimateSingleRequestInputChars(
            maxItem.contentChars,
            maxItem.targetChars,
            promptOnce.chars,
            repetitionMode
        );
        const thinkingEnabled = !resolveProofreadModel().disableThinking;
        const confirmSettings = getProofreadInputConfirmSettings();
        const targetOverflowChars =
            confirmSettings.byField.target > 0
                ? confirmSettings.byField.target
                : SINGLE_TARGET_OVERFLOW_CHARS;
        const outputType = getOutputType(context);

        return confirmProofreadInputIfNeeded({
            title: '📋 JSON批量校对参数确认',
            headerLines: [`📁 文件路径: ${jsonFilePath}`],
            promptName: currentPromptName,
            sourceCharacteristicsInjectSummary,
            repetitionMode,
            platform,
            model,
            temperature,
            settings: confirmSettings,
            batch: {
                rpm,
                maxConcurrent,
                timeout,
                retryDelay,
                retryAttempts,
                totalCount,
                requestCount,
                thinkingEnabled,
                maxItemContentChars: maxItem.contentChars,
                maxItemIndex1: maxItem.index1,
                maxItemRequestChars,
                maxTargetChars: maxItem.maxTargetChars,
                maxTargetIndex1: maxItem.maxTargetIndex1,
                targetOverflowChars,
                outputType
            },
            contentStats,
            promptOnce,
            promptScaled: promptBatch,
            estimatedInputTotal,
            confirmButtonLabel: '确认开始'
        });
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
