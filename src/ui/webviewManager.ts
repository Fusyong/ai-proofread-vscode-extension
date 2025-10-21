/**
 * Webview 面板管理器
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { showFileDiff, jsDiffJsonFiles } from '../differ';
import { ErrorUtils, FilePathUtils } from '../utils';
import { ProgressTracker } from '../progressTracker';

// 接口定义
export interface SplitResult {
    jsonFilePath: string;
    markdownFilePath: string;
    logFilePath: string;
    originalFilePath: string;
    stats?: {
        segmentCount: number;
        maxSegmentLength: number;
        minSegmentLength: number;
    };
}

export interface ProofreadResult {
    outputFilePath: string;
    logFilePath: string;
    originalFilePath: string;
    markdownFilePath: string;
    stats: {
        totalCount: number;
        processedCount: number;
        processedLength: number;
        totalLength: number;
    };
}

export interface ProcessResult {
    title: string;
    message: string;
    splitResult?: SplitResult;
    proofreadResult?: ProofreadResult;
    progressTracker?: ProgressTracker;
    actions: {
        showJson?: boolean;
        showLog?: boolean;
        showDiff?: boolean;
    };
}

export class WebviewManager {
    private static instance: WebviewManager;
    private currentPanel: vscode.WebviewPanel | undefined;
    private currentProcessResult: ProcessResult | undefined;

    private constructor() {}

    /**
     * 将绝对路径转换为相对路径
     */
    private getRelativePath(absolutePath: string): string {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return absolutePath;
        }
        
        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        if (absolutePath.startsWith(workspaceRoot)) {
            return path.relative(workspaceRoot, absolutePath);
        }
        
        return absolutePath;
    }

    public static getInstance(): WebviewManager {
        if (!WebviewManager.instance) {
            WebviewManager.instance = new WebviewManager();
        }
        return WebviewManager.instance;
    }

    /**
     * 创建 Webview 面板
     */
    public createWebviewPanel(result: ProcessResult): vscode.WebviewPanel {
        // 如果已有面板且未被dispose，先关闭它
        if (this.currentPanel) {
            this.currentPanel.dispose();
        }

        const panel = vscode.window.createWebviewPanel(
            'processResult',
            result.title,
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        // 监听面板关闭事件
        panel.onDidDispose(() => {
            if (this.currentPanel === panel) {
                this.currentPanel = undefined;
                this.currentProcessResult = undefined;
            }
        });

        // 保存当前面板和结果
        this.currentPanel = panel;
        this.currentProcessResult = result;

        // 生成切分结果HTML
        const splitHtml = result.splitResult ? this.generateSplitResultHtml(result.splitResult) : '';

        // 生成校对结果HTML
        const proofreadHtml = result.proofreadResult ? this.generateProofreadResultHtml(result.proofreadResult) : '';

        // 生成进度条HTML
        const progressHtml = result.progressTracker ? result.progressTracker.generateProgressBarHtml() : '';

        panel.webview.html = this.generateWebviewHtml(result, splitHtml, proofreadHtml, progressHtml);

        return panel;
    }

    /**
     * 更新面板内容
     */
    public updatePanelContent(result: ProcessResult): void {
        if (this.currentPanel && this.currentProcessResult) {
            try {
                // 检查Webview是否已被dispose
                if (!this.currentPanel) {
                    console.warn('Webview已被dispose，无法更新内容');
                    return;
                }

                // 更新当前结果
                this.currentProcessResult = result;
                
                // 重新生成HTML内容
                const splitHtml = result.splitResult ? this.generateSplitResultHtml(result.splitResult) : '';
                const proofreadHtml = result.proofreadResult ? this.generateProofreadResultHtml(result.proofreadResult) : '';
                const progressHtml = result.progressTracker ? result.progressTracker.generateProgressBarHtml() : '';

                // 更新面板HTML
                this.currentPanel.webview.html = this.generateWebviewHtml(result, splitHtml, proofreadHtml, progressHtml);
            } catch (error) {
                console.error('更新Webview内容时出错:', error);
                // 如果更新失败，尝试重新创建面板
                this.createWebviewPanel(result);
            }
        }
    }

    /**
     * 重新打开结果面板
     */
    public reopenResultPanel(context: vscode.ExtensionContext): void {
        if (this.currentProcessResult) {
            const panel = this.createWebviewPanel(this.currentProcessResult);
            
            // 监听Webview消息
            panel.webview.onDidReceiveMessage(
                (message) => this.handleWebviewMessage(message, panel, context),
                undefined,
                context.subscriptions
            );
        } else {
            vscode.window.showInformationMessage('没有可显示的处理结果');
        }
    }

    /**
     * 处理 Webview 消息
     */
    public async handleWebviewMessage(message: any, panel: vscode.WebviewPanel, context: vscode.ExtensionContext): Promise<void> {
        const { command, data } = message;

        try {
            switch (command) {
                case 'showSplitJson':
                    const splitJsonPath = this.currentProcessResult?.splitResult?.jsonFilePath;
                    if (splitJsonPath) {
                        const outputUri = vscode.Uri.file(splitJsonPath);
                        await vscode.workspace.openTextDocument(outputUri);
                        await vscode.window.showTextDocument(outputUri);
                    }
                    break;
                case 'showSplitLog':
                    const splitLogPath = this.currentProcessResult?.splitResult?.logFilePath;
                    if (splitLogPath) {
                        const logUri = vscode.Uri.file(splitLogPath);
                        const document = await vscode.workspace.openTextDocument(logUri);
                        const editor = await vscode.window.showTextDocument(document);
                        
                        // 滚动到文件末端
                        const lastLine = document.lineCount - 1;
                        const lastLineLength = document.lineAt(lastLine).text.length;
                        const endPosition = new vscode.Position(lastLine, lastLineLength);
                        editor.selection = new vscode.Selection(endPosition, endPosition);
                        editor.revealRange(new vscode.Range(endPosition, endPosition), vscode.TextEditorRevealType.InCenter);
                    }
                    break;
                case 'showSplitDiff':
                    const splitOriginalPath = this.currentProcessResult?.splitResult?.originalFilePath;
                    const splitMarkdownPath = this.currentProcessResult?.splitResult?.markdownFilePath;
                    if (splitOriginalPath && splitMarkdownPath) {
                        await showFileDiff(splitOriginalPath, splitMarkdownPath);
                    }
                    break;
                case 'proofreadJson':
                    const jsonPath = this.currentProcessResult?.splitResult?.jsonFilePath;
                    if (jsonPath) {
                        // 直接调用校对JSON文件的回调函数
                        if ((this as any).proofreadJsonCallback) {
                            await (this as any).proofreadJsonCallback(jsonPath, context);
                        }
                    }
                    break;
                case 'showProofreadJson':
                    const proofreadJsonPath = this.currentProcessResult?.proofreadResult?.outputFilePath;
                    if (proofreadJsonPath) {
                        const outputUri = vscode.Uri.file(proofreadJsonPath);
                        await vscode.workspace.openTextDocument(outputUri);
                        await vscode.window.showTextDocument(outputUri);
                    }
                    break;
                case 'showProofreadLog':
                    const proofreadLogPath = this.currentProcessResult?.proofreadResult?.logFilePath;
                    if (proofreadLogPath) {
                        const logUri = vscode.Uri.file(proofreadLogPath);
                        const document = await vscode.workspace.openTextDocument(logUri);
                        const editor = await vscode.window.showTextDocument(document);
                        
                        // 滚动到文件末端
                        const lastLine = document.lineCount - 1;
                        const lastLineLength = document.lineAt(lastLine).text.length;
                        const endPosition = new vscode.Position(lastLine, lastLineLength);
                        editor.selection = new vscode.Selection(endPosition, endPosition);
                        editor.revealRange(new vscode.Range(endPosition, endPosition), vscode.TextEditorRevealType.InCenter);
                    }
                    break;
                case 'showProofreadDiff':
                    const proofreadOriginalPath = this.currentProcessResult?.proofreadResult?.originalFilePath;
                    const proofreadMarkdownPath = this.currentProcessResult?.proofreadResult?.markdownFilePath;
                    if (proofreadOriginalPath && proofreadMarkdownPath) {
                        await showFileDiff(proofreadOriginalPath, proofreadMarkdownPath);
                    }
                    break;
                case 'generateDiff':
                    // 直接生成JSON文件的差异文件
                    const originalJsonPath = this.currentProcessResult?.splitResult?.jsonFilePath;
                    const proofreadJsonFilePath = this.currentProcessResult?.proofreadResult?.outputFilePath;
                    
                    if (originalJsonPath && proofreadJsonFilePath) {
                        try {
                            // 让用户输入每次比较的片段数量
                            const segmentCountInput = await vscode.window.showInputBox({
                                prompt: '请输入每次比较的JSON片段数量',
                                placeHolder: '输入数字，0表示一次性比较所有片段',
                                title: '生成差异文件',
                                validateInput: (value) => {
                                    if (value === undefined || value === '') {
                                        return '请输入一个数字';
                                    }
                                    const num = parseInt(value);
                                    if (isNaN(num) || num < 0) {
                                        return '请输入一个大于等于0的整数';
                                    }
                                    return null;
                                }
                            });

                            if (segmentCountInput !== undefined) {
                                const segmentCount = parseInt(segmentCountInput);
                                
                                // 生成输出文件路径
                                const outputFile = FilePathUtils.getFilePath(originalJsonPath, '.diff', '.html');
                                const title = `${path.basename(originalJsonPath)} ↔ ${path.basename(proofreadJsonFilePath)}`;
                                
                                // 生成差异文件
                                await jsDiffJsonFiles(originalJsonPath, proofreadJsonFilePath, outputFile, title, segmentCount);
                                
                                vscode.window.showInformationMessage('差异文件生成完成！');
                            }
                        } catch (error) {
                            vscode.window.showErrorMessage(`生成差异文件时出错：${error instanceof Error ? error.message : String(error)}`);
                        }
                    } else {
                        vscode.window.showErrorMessage('无法找到原始JSON文件或校对后的JSON文件！');
                    }
                    break;
            }
        } catch (error) {
            ErrorUtils.showError(error, `执行操作时出错：`);
        }
    }

    /**
     * 设置校对JSON文件的回调函数
     */
    public setProofreadJsonCallback(callback: (jsonFilePath: string, context: vscode.ExtensionContext) => Promise<void>): void {
        // 存储回调函数，在 handleWebviewMessage 中使用
        (this as any).proofreadJsonCallback = callback;
    }

    /**
     * 获取当前面板
     */
    public getCurrentPanel(): vscode.WebviewPanel | undefined {
        return this.currentPanel;
    }

    /**
     * 获取当前处理结果
     */
    public getCurrentProcessResult(): ProcessResult | undefined {
        return this.currentProcessResult;
    }

    /**
     * 检查当前面板是否有效
     */
    public isCurrentPanelValid(): boolean {
        return this.currentPanel !== undefined;
    }

    /**
     * 生成切分结果HTML
     */
    private generateSplitResultHtml(splitResult: SplitResult): string {
        const statsHtml = splitResult.stats ? `
            <div class="stats-section">
                <h4>处理统计</h4>
                <div class="stats-inline">
                    <span class="stat-item">切分片段数: <span class="stat-value">${splitResult.stats.segmentCount}</span></span>
                    <span class="stat-item">最长: <span class="stat-value">${splitResult.stats.maxSegmentLength}</span></span>
                    <span class="stat-item">最短: <span class="stat-value">${splitResult.stats.minSegmentLength}</span></span>
                </div>
            </div>
        ` : '';

        return `
            <div class="process-section">
                <h3>📄 切分结果</h3>
                ${statsHtml}
                <div class="file-paths-compact">
                    <div class="file-path-row">
                        <span class="file-label">原始文件:</span>
                        <span class="file-path">${this.getRelativePath(splitResult.originalFilePath)}</span>
                    </div>
                    <div class="file-path-row">
                        <span class="file-label">JSON结果:</span>
                        <span class="file-path">${this.getRelativePath(splitResult.jsonFilePath)}</span>
                    </div>
                    <div class="file-path-row">
                        <span class="file-label">Markdown结果:</span>
                        <span class="file-path">${this.getRelativePath(splitResult.markdownFilePath)}</span>
                    </div>
                    <div class="file-path-row">
                        <span class="file-label">日志文件:</span>
                        <span class="file-path">${this.getRelativePath(splitResult.logFilePath)}</span>
                    </div>
                </div>
                <div class="section-actions">
                    ${splitResult.jsonFilePath ? '<button class="action-button" onclick="handleAction(\'showSplitJson\')">查看JSON文件</button>' : ''}
                    ${splitResult.jsonFilePath ? '<button class="action-button" onclick="handleAction(\'proofreadJson\')">校对JSON文件</button>' : ''}
                    ${splitResult.logFilePath ? '<button class="action-button" onclick="handleAction(\'showSplitLog\')">查看切分日志</button>' : ''}
                    ${splitResult.originalFilePath && splitResult.markdownFilePath ? '<button class="action-button" onclick="handleAction(\'showSplitDiff\')">比较前后差异</button>' : ''}
                </div>
            </div>
        `;
    }

    /**
     * 生成校对结果HTML
     */
    private generateProofreadResultHtml(proofreadResult: ProofreadResult): string {
        return `
            <div class="process-section">
                <h3>✏️ 校对结果</h3>
                <div class="file-paths-compact">
                    <div class="file-path-row">
                        <span class="file-label">JSON结果:</span>
                        <span class="file-path">${this.getRelativePath(proofreadResult.outputFilePath)}</span>
                    </div>
                    <div class="file-path-row">
                        <span class="file-label">Markdown结果:</span>
                        <span class="file-path">${this.getRelativePath(proofreadResult.markdownFilePath)}</span>
                    </div>
                    <div class="file-path-row">
                        <span class="file-label">日志文件:</span>
                        <span class="file-path">${this.getRelativePath(proofreadResult.logFilePath)}</span>
                    </div>
                </div>
                <div class="section-actions">
                    ${proofreadResult.outputFilePath ? '<button class="action-button" onclick="handleAction(\'showProofreadJson\')">查看JSON文件</button>' : ''}
                    ${proofreadResult.logFilePath ? '<button class="action-button" onclick="handleAction(\'showProofreadLog\')">查看校对日志</button>' : ''}
                    ${proofreadResult.originalFilePath && proofreadResult.markdownFilePath ? '<button class="action-button" onclick="handleAction(\'showProofreadDiff\')">比较前后差异</button>' : ''}
                    ${proofreadResult.outputFilePath ? '<button class="action-button" onclick="handleAction(\'generateDiff\')">生成差异文件</button>' : ''}
                </div>
            </div>
        `;
    }

    /**
     * 生成完整的 Webview HTML
     */
    private generateWebviewHtml(result: ProcessResult, splitHtml: string, proofreadHtml: string, progressHtml: string): string {
        return `
            <!DOCTYPE html>
            <html lang="zh-CN">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>${result.title}</title>
                <style>
                    body {
                        font-family: var(--vscode-font-family);
                        font-size: var(--vscode-font-size);
                        color: var(--vscode-foreground);
                        background-color: var(--vscode-editor-background);
                        padding: 16px;
                        line-height: 1.4;
                    }
                    .header {
                        margin-bottom: 16px;
                        padding-bottom: 12px;
                        border-bottom: 1px solid var(--vscode-panel-border);
                    }
                    .message {
                        font-size: 15px;
                        margin-bottom: 16px;
                        color: #6B8E9A;
                        font-weight: 500;
                    }
                    .process-section {
                        margin-bottom: 20px;
                        padding: 16px;
                        background-color: var(--vscode-editor-background);
                        border: 1px solid var(--vscode-panel-border);
                        border-radius: 6px;
                    }
                    .process-section h3 {
                        margin-top: 0;
                        margin-bottom: 12px;
                        color: #5A7A85;
                        font-size: 16px;
                        border-bottom: 1px solid #E8F0F2;
                        padding-bottom: 6px;
                    }
                    .process-section h4 {
                        margin-top: 0;
                        margin-bottom: 8px;
                        color: #6B8E9A;
                        font-size: 13px;
                        font-weight: 500;
                    }
                    .stats-section {
                        margin-bottom: 12px;
                        padding: 12px;
                        background-color: #F8FAFB;
                        border: 1px solid #E8F0F2;
                        border-radius: 4px;
                    }
                    .stats-inline {
                        display: flex;
                        flex-wrap: wrap;
                        gap: 16px;
                        align-items: center;
                    }
                    .stats-grid {
                        display: grid;
                        grid-template-columns: 1fr 1fr;
                        gap: 8px;
                    }
                    .stat-item {
                        display: inline-flex;
                        align-items: center;
                        gap: 4px;
                        font-size: 13px;
                    }
                    .stat-label {
                        font-weight: 500;
                        color: #6B8E9A;
                    }
                    .stat-value {
                        color: #4A6B7A;
                        font-weight: 600;
                    }
                    .file-paths-compact {
                        margin-bottom: 16px;
                        padding: 12px;
                        background-color: #F8FAFB;
                        border: 1px solid #E8F0F2;
                        border-radius: 4px;
                    }
                    .file-paths {
                        margin-bottom: 16px;
                        padding: 12px;
                        background-color: #F8FAFB;
                        border: 1px solid #E8F0F2;
                        border-radius: 4px;
                    }
                    .file-path-row {
                        margin-bottom: 6px;
                        display: flex;
                        align-items: center;
                        font-size: 12px;
                    }
                    .file-path-item {
                        margin-bottom: 6px;
                        display: flex;
                        align-items: center;
                        font-size: 12px;
                    }
                    .file-label {
                        font-weight: 500;
                        min-width: 100px;
                        color: #6B8E9A;
                    }
                    .file-path {
                        color: #4A6B7A;
                        font-family: var(--vscode-editor-font-family);
                        font-size: 11px;
                        word-break: break-all;
                        margin-left: 8px;
                    }
                    .section-actions {
                        display: flex;
                        flex-wrap: wrap;
                        gap: 8px;
                        margin-top: 12px;
                        padding-top: 12px;
                        border-top: 1px solid #E8F0F2;
                    }
                    .actions {
                        display: flex;
                        flex-wrap: wrap;
                        gap: 8px;
                    }
                    .action-button {
                        padding: 6px 12px;
                        background-color: #7A9BA8;
                        color: white;
                        border: none;
                        border-radius: 4px;
                        cursor: pointer;
                        font-size: 12px;
                        transition: background-color 0.2s;
                        font-weight: 500;
                    }
                    .action-button:hover {
                        background-color: #6B8E9A;
                    }
                    .action-button:disabled {
                        background-color: #B8C5CA;
                        color: #8A9BA0;
                        cursor: not-allowed;
                    }
                    
                    ${ProgressTracker.generateProgressBarCss()}
                </style>
            </head>
            <body>
                <div class="header">
                    <div class="message">${result.message}</div>
                </div>
                
                ${splitHtml}
                ${progressHtml}
                ${proofreadHtml}
                

                <script>
                    const vscode = acquireVsCodeApi();
                    
                    function handleAction(action) {
                        vscode.postMessage({
                            command: action
                        });
                    }
                </script>
            </body>
            </html>
        `;
    }
}
