/**
 * 文件切分命令处理器
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import {
    DEFAULT_MIN_LENGTH_RATIO,
    DEFAULT_SPLIT_LENGTH,
    DEFAULT_THRESHOLD_RATIO,
    deriveTitleAndLengthParams,
    handleFileSplit
} from '../splitter';
import { parseHeadingLevels } from '../headingAligner';
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
            { label: '按长度切分，按长度扩展前后文为上下文', value: 'paragraphContext' },
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
                beforeMinLength?: number;
                afterMinLength?: number;
                includeTargetInContext?: boolean;
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

    private getTitleAndLengthRatios(config: vscode.WorkspaceConfiguration): {
        thresholdRatio: number;
        minLengthRatio: number;
    } {
        return {
            thresholdRatio: config.get<number>(
                'titleAndLengthSplit.thresholdRatio',
                DEFAULT_THRESHOLD_RATIO
            ),
            minLengthRatio: config.get<number>(
                'titleAndLengthSplit.minLengthRatio',
                DEFAULT_MIN_LENGTH_RATIO
            )
        };
    }

    /**
     * 处理按长度切分模式
     */
    private async handleLengthMode(config: vscode.WorkspaceConfiguration, options: any): Promise<any> {
        // 获取配置中的默认切分长度
        const defaultLength = config.get<number>('defaultSplitLength', DEFAULT_SPLIT_LENGTH);

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
                const parsed = parseHeadingLevels(value);
                return 'error' in parsed ? parsed.error : null;
            }
        });

        if (!inputLevels) {
            return null;
        }
        const parsedLevels = parseHeadingLevels(inputLevels);
        if ('error' in parsedLevels) {
            return null;
        }
        options.levels = [...parsedLevels.levels].sort((a, b) => a - b);

        if (mode === 'titleContext') {
            // 获取带上下文切分的配置
            const defaultCutBy = config.get<number>('defaultSplitLength', DEFAULT_SPLIT_LENGTH);

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
            const { thresholdRatio, minLengthRatio } = this.getTitleAndLengthRatios(config);
            const defaultCutBy = config.get<number>('defaultSplitLength', DEFAULT_SPLIT_LENGTH);
            Object.assign(
                options,
                deriveTitleAndLengthParams(defaultCutBy, thresholdRatio, minLengthRatio)
            );

            // 让用户确认或修改参数
            const message = `将使用以下参数进行标题加长度切分：\n\n` +
                `- 标题级别: ${options.levels.join(',')}\n` +
                `- 切分长度: ${options.cutBy} 字符\n` +
                `- 长度阈值: ${options.threshold} 字符（切分长度 × ${thresholdRatio}）\n` +
                `- 最小长度: ${options.minLength} 字符（切分长度 × ${minLengthRatio}）\n\n` +
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
                // 先改切分长度，再按比例预填阈值与最小长度
                const inputCutBy = await vscode.window.showInputBox({
                    prompt: '请输入切分长度（切分长段落时的目标长度）',
                    value: options.cutBy.toString(),
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
                if (!inputCutBy) return null;
                const derived = deriveTitleAndLengthParams(
                    parseInt(inputCutBy),
                    thresholdRatio,
                    minLengthRatio
                );
                options.cutBy = derived.cutBy;

                const inputThreshold = await vscode.window.showInputBox({
                    prompt: `请输入长度阈值（超过此长度的段落将被切分；默认 = 切分长度 × ${thresholdRatio}）`,
                    value: derived.threshold.toString(),
                    validateInput: (value: string) => {
                        const num = parseInt(value);
                        return isNaN(num) ? '请输入有效的数字' : null;
                    }
                });
                if (!inputThreshold) return null;
                options.threshold = parseInt(inputThreshold);

                const inputMinLength = await vscode.window.showInputBox({
                    prompt: `请输入最小长度（过短片段若以不深于最低切分级别的标题开头则并入后一段，否则并入前一段；默认 = 切分长度 × ${minLengthRatio}）`,
                    value: derived.minLength.toString(),
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
     * 处理按前后文最小长度扩展上下文的切分模式
     */
    private async handleParagraphContextMode(config: vscode.WorkspaceConfiguration, options: any): Promise<any> {
        const defaultCutBy = config.get<number>('defaultSplitLength', DEFAULT_SPLIT_LENGTH);
        const defaultBeforeMinLength = config.get<number>('paragraphContextSplit.beforeMinLength', 200);
        const defaultAfterMinLength = config.get<number>('paragraphContextSplit.afterMinLength', 200);
        const defaultIncludeTarget = config.get<boolean>(
            'paragraphContextSplit.includeTargetInContext',
            false
        );

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

        const inputBeforeMinLength = await vscode.window.showInputBox({
            prompt: '请输入上文最小长度（字符数；达到后向前找到第一个合法切分点：空行或 Markdown 标题前；0 表示不要上文）',
            value: defaultBeforeMinLength.toString(),
            validateInput: (value: string) => {
                const num = parseInt(value);
                if (isNaN(num) || num < 0) {
                    return '请输入有效的非负整数';
                }
                return null;
            }
        });

        if (inputBeforeMinLength === undefined) {
            return null;
        }
        options.beforeMinLength = parseInt(inputBeforeMinLength, 10);

        const inputAfterMinLength = await vscode.window.showInputBox({
            prompt: '请输入下文最小长度（字符数；达到后向后找到第一个合法切分点：空行或 Markdown 标题前；0 表示不要下文）',
            value: defaultAfterMinLength.toString(),
            validateInput: (value: string) => {
                const num = parseInt(value);
                if (isNaN(num) || num < 0) {
                    return '请输入有效的非负整数';
                }
                return null;
            }
        });

        if (inputAfterMinLength === undefined) {
            return null;
        }
        options.afterMinLength = parseInt(inputAfterMinLength, 10);

        const includeTargetPick = await vscode.window.showQuickPick(
            [
                { label: '否', description: 'context 仅为 <before> + <after>', picked: !defaultIncludeTarget },
                { label: '是', description: 'context 为 <before> + <target> + <after>', picked: defaultIncludeTarget }
            ],
            {
                placeHolder: '是否在上下文中间保留 target？',
                ignoreFocusOut: true
            }
        );
        if (!includeTargetPick) {
            return null;
        }
        options.includeTargetInContext = includeTargetPick.label === '是';

        return options;
    }
}
