/**
 * 文件切分命令处理器
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { handleFileSplit } from '../splitter';
import { ErrorUtils, FilePathUtils } from '../utils';
import { WebviewManager, ProcessResult } from '../ui/webviewManager';

export class FileSplitCommandHandler {
    private webviewManager: WebviewManager;

    constructor(webviewManager: WebviewManager) {
        this.webviewManager = webviewManager;
    }

    /**
     * 按主文件路径切分（供 Proofreading panel 调用）
     */
    public async handleFileSplitByPath(
        mainFilePath: string,
        context: vscode.ExtensionContext
    ): Promise<void> {
        const jsonPath = FilePathUtils.getFilePath(mainFilePath, '', '.json');
        if (fs.existsSync(jsonPath)) {
            const confirm = await vscode.window.showWarningMessage(
                '重新切分将覆盖现有切分结果（.json、.json.md、.log 等），是否继续？',
                { modal: true },
                '继续',
                '取消'
            );
            if (confirm !== '继续') return;
        }

        const config = vscode.workspace.getConfiguration('ai-proofread');
        const mode = await vscode.window.showQuickPick([
            { label: '按长度切分', value: 'length' },
            { label: '按标题切分', value: 'title' },
            { label: '按标题和长度切分', value: 'title-length' },
            { label: '按长度切分，以标题范围为上下文', value: 'titleContext' },
            { label: '按长度切分，以前后段落为上下文', value: 'paragraphContext' },
        ], { placeHolder: '请选择切分模式', canPickMany: false });
        if (!mode) return;

        let options: any = { mode: mode.value };
        if (mode.value === 'length') {
            options = await this.handleLengthMode(config, options);
        } else if (mode.value === 'title' || mode.value === 'title-length' || mode.value === 'titleContext') {
            options = await this.handleTitleMode(config, mode.value, options);
        } else if (mode.value === 'paragraphContext') {
            options = await this.handleParagraphContextMode(config, options);
        }
        if (!options) return;

        try {
            const result = await handleFileSplit(mainFilePath, options);
            const processResult: ProcessResult = {
                title: 'Proofreading panel',
                message: '文件已成功切分！',
                splitResult: {
                    jsonFilePath: result.jsonFilePath,
                    markdownFilePath: result.markdownFilePath,
                    logFilePath: result.logFilePath,
                    originalFilePath: mainFilePath,
                    stats: result.stats
                },
                mainFilePath,
                actions: { showJson: true, showLog: true, showDiff: true }
            };
            if (this.webviewManager.isCurrentPanelValid()) {
                this.webviewManager.updatePanelContent(processResult);
                this.webviewManager.getCurrentPanel()?.reveal();
            } else {
                const panel = this.webviewManager.createWebviewPanel(processResult, context);
                panel.webview.onDidReceiveMessage(
                    (message) => this.webviewManager.handleWebviewMessage(message, panel, context),
                    undefined,
                    context.subscriptions
                );
                panel.reveal();
            }
        } catch (error) {
            ErrorUtils.showError(error, '切分文件时出错：');
        }
    }

    /**
     * 处理文件切分命令
     */
    public async handleFileSplitCommand(
        mode: 'length' | 'title' | 'title-length' | 'titleContext' | 'paragraphContext',
        editor: vscode.TextEditor,
        document: vscode.TextDocument,
        context: vscode.ExtensionContext
    ): Promise<void> {
        const config = vscode.workspace.getConfiguration('ai-proofread');

        try {
            let options: {
                mode: 'length' | 'title' | 'title-length' | 'titleContext' | 'paragraphContext';
                cutBy?: number;
                levels?: number[];
                threshold?: number;
                minLength?: number;
                beforeParagraphs?: number;
                afterParagraphs?: number;
            } = { mode };

            if (mode === 'length') {
                options = await this.handleLengthMode(config, options);
                if (!options) return;
            } else if (mode === 'title' || mode === 'title-length' || mode === 'titleContext') {
                options = await this.handleTitleMode(config, mode, options);
                if (!options) return;
            } else if (mode === 'paragraphContext') {
                options = await this.handleParagraphContextMode(config, options);
                if (!options) return;
            }

            // 调用splitter模块中的handleFileSplit函数
            const result = await handleFileSplit(document.uri.fsPath, options);

            // 创建或更新智能面板
            const processResult: ProcessResult = {
                title: 'Proofreading panel',
                message: '文件已成功切分！',
                splitResult: {
                    jsonFilePath: result.jsonFilePath,
                    markdownFilePath: result.markdownFilePath,
                    logFilePath: result.logFilePath,
                    originalFilePath: document.uri.fsPath,
                    stats: result.stats
                },
                actions: {
                    showJson: true,
                    showLog: true,
                    showDiff: true
                }
            };

            if (this.webviewManager.isCurrentPanelValid()) {
                // 如果已有有效面板，更新内容
                this.webviewManager.updatePanelContent(processResult);
                // 激活面板
                this.webviewManager.getCurrentPanel()?.reveal();
            } else {
                // 如果没有面板或面板已被dispose，创建新面板
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
            ErrorUtils.showError(error, '切分文件时出错：');
        }
    }

    /**
     * 处理按长度切分模式
     */
    private async handleLengthMode(config: vscode.WorkspaceConfiguration, options: any): Promise<any> {
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
            return null;
        }
        options.cutBy = parseInt(inputLength);
        return options;
    }

    /**
     * 处理按标题切分模式
     */
    private async handleTitleMode(
        config: vscode.WorkspaceConfiguration, 
        mode: string, 
        options: any
    ): Promise<any> {
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
            return null;
        }
        options.levels = inputLevels.split(',').map(x => parseInt(x.trim()));

        if (mode === 'titleContext') {
            // 获取带上下文切分的配置
            const defaultCutBy = config.get<number>('defaultSplitLength', 600);

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
                return null;
            }
            options.cutBy = parseInt(inputCutBy);

        } else if (mode === 'title-length') {
            // 获取标题加长度切分的配置
            options.threshold = config.get<number>('titleAndLengthSplit.threshold', 1000);
            options.cutBy = config.get<number>('defaultSplitLength', 600);
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
                return null;
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
                if (!inputThreshold) return null;
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
                if (!inputCutBy) return null;
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
                if (!inputMinLength) return null;
                options.minLength = parseInt(inputMinLength);
            }
        }
        return options;
    }

    /**
     * 处理按段落上下文切分模式
     */
    private async handleParagraphContextMode(config: vscode.WorkspaceConfiguration, options: any): Promise<any> {
        // 获取前后段落上下文切分的配置
        const defaultCutBy = config.get<number>('defaultSplitLength', 600);
        const defaultBeforeParagraphs = config.get<number>('paragraphContextSplit.beforeParagraphs', 1);
        const defaultAfterParagraphs = config.get<number>('paragraphContextSplit.afterParagraphs', 1);

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
            return null;
        }
        options.cutBy = parseInt(inputCutBy);

        // 让用户选择前文段落数
        const inputBeforeParagraphs = await vscode.window.showInputBox({
            prompt: '请输入前文段落数',
            value: defaultBeforeParagraphs.toString(),
            validateInput: (value: string) => {
                const num = parseInt(value);
                if (isNaN(num) || num < 0) {
                    return '请输入有效的非负整数';
                }
                return null;
            }
        });

        if (!inputBeforeParagraphs) {
            return null;
        }
        options.beforeParagraphs = parseInt(inputBeforeParagraphs);

        // 让用户选择后文段落数
        const inputAfterParagraphs = await vscode.window.showInputBox({
            prompt: '请输入后文段落数',
            value: defaultAfterParagraphs.toString(),
            validateInput: (value: string) => {
                const num = parseInt(value);
                if (isNaN(num) || num < 0) {
                    return '请输入有效的非负整数';
                }
                return null;
            }
        });

        if (!inputAfterParagraphs) {
            return null;
        }
        options.afterParagraphs = parseInt(inputAfterParagraphs);

        return options;
    }
}
