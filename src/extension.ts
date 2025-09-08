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
import { showDiff, showFileDiff, jsDiffMarkdown, jsDiffJsonFiles } from './differ';
import { TempFileManager, FilePathUtils, ErrorUtils, ConfigManager, Logger } from './utils';
import { searchSelectionInPDF } from './pdfSearcher';
import { convertDocxToMarkdown, convertMarkdownToDocx } from './docConverter';
import { convertQuotes } from './quoteConverter';

// Webview Panel 工具函数
interface SplitResult {
    jsonFilePath: string;
    markdownFilePath: string;
    logFilePath: string;
    originalFilePath: string;
}

interface ProofreadResult {
    outputFilePath: string;
    logFilePath: string;
    originalFilePath: string;
    markdownFilePath: string;
    jsdiffFilePath: string;
    stats: {
        totalCount: number;
        processedCount: number;
        processedLength: number;
        totalLength: number;
    };
}

interface ProcessResult {
    title: string;
    message: string;
    splitResult?: SplitResult;
    proofreadResult?: ProofreadResult;
    actions: {
        showJson?: boolean;
        showLog?: boolean;
        showDiff?: boolean;
        showJsdiff?: boolean;
    };
}

// 全局面板管理
let currentPanel: vscode.WebviewPanel | undefined;
let currentProcessResult: ProcessResult | undefined;

function createWebviewPanel(result: ProcessResult): vscode.WebviewPanel {
    // 如果已有面板，先关闭它
    if (currentPanel) {
        currentPanel.dispose();
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

    // 保存当前面板和结果
    currentPanel = panel;
    currentProcessResult = result;

    // 生成切分结果HTML
    const splitHtml = result.splitResult ? `
        <div class="process-section">
            <h3>📄 文件切分结果</h3>
            <div class="file-paths">
                <div class="file-path-item">
                    <span class="file-label">原始文件:</span>
                    <span class="file-path">${result.splitResult.originalFilePath}</span>
                </div>
                <div class="file-path-item">
                    <span class="file-label">JSON文件:</span>
                    <span class="file-path">${result.splitResult.jsonFilePath}</span>
                </div>
                <div class="file-path-item">
                    <span class="file-label">Markdown文件:</span>
                    <span class="file-path">${result.splitResult.markdownFilePath}</span>
                </div>
                <div class="file-path-item">
                    <span class="file-label">日志文件:</span>
                    <span class="file-path">${result.splitResult.logFilePath}</span>
                </div>
            </div>
            <div class="section-actions">
                ${result.splitResult.jsonFilePath ? '<button class="action-button" onclick="handleAction(\'showSplitJson\')">查看JSON文件</button>' : ''}
                ${result.splitResult.jsonFilePath ? '<button class="action-button" onclick="handleAction(\'proofreadJson\')">校对JSON文件</button>' : ''}
                ${result.splitResult.logFilePath ? '<button class="action-button" onclick="handleAction(\'showSplitLog\')">查看切分日志</button>' : ''}
                ${result.splitResult.originalFilePath && result.splitResult.markdownFilePath ? '<button class="action-button" onclick="handleAction(\'showSplitDiff\')">比较前后差异</button>' : ''}
            </div>
        </div>
    ` : '';

    // 生成校对结果HTML
    const proofreadHtml = result.proofreadResult ? `
        <div class="process-section">
            <h3>✏️ 校对结果</h3>
            <div class="stats-section">
                <h4>处理统计</h4>
                <div class="stats-grid">
                    <div class="stat-item">
                        <span class="stat-label">总段落数:</span>
                        <span class="stat-value">${result.proofreadResult.stats.totalCount}</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-label">已处理段落数:</span>
                        <span class="stat-value">${result.proofreadResult.stats.processedCount} (${(result.proofreadResult.stats.processedCount/result.proofreadResult.stats.totalCount*100).toFixed(2)}%)</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-label">已处理字数:</span>
                        <span class="stat-value">${result.proofreadResult.stats.processedLength} (${(result.proofreadResult.stats.processedLength/result.proofreadResult.stats.totalLength*100).toFixed(2)}%)</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-label">未处理段落数:</span>
                        <span class="stat-value">${result.proofreadResult.stats.totalCount - result.proofreadResult.stats.processedCount}</span>
                    </div>
                </div>
            </div>
            <div class="file-paths">
                <div class="file-path-item">
                    <span class="file-label">输出文件:</span>
                    <span class="file-path">${result.proofreadResult.outputFilePath}</span>
                </div>
                <div class="file-path-item">
                    <span class="file-label">校对后Markdown:</span>
                    <span class="file-path">${result.proofreadResult.markdownFilePath}</span>
                </div>
                <div class="file-path-item">
                    <span class="file-label">日志文件:</span>
                    <span class="file-path">${result.proofreadResult.logFilePath}</span>
                </div>
                <div class="file-path-item">
                    <span class="file-label">差异文件:</span>
                    <span class="file-path">${result.proofreadResult.jsdiffFilePath}</span>
                </div>
            </div>
            <div class="section-actions">
                ${result.proofreadResult.outputFilePath ? '<button class="action-button" onclick="handleAction(\'showProofreadJson\')">查看JSON文件</button>' : ''}
                ${result.proofreadResult.logFilePath ? '<button class="action-button" onclick="handleAction(\'showProofreadLog\')">查看校对日志</button>' : ''}
                ${result.proofreadResult.originalFilePath && result.proofreadResult.markdownFilePath ? '<button class="action-button" onclick="handleAction(\'showProofreadDiff\')">比较前后差异</button>' : ''}
                ${result.proofreadResult.jsdiffFilePath ? '<button class="action-button" onclick="handleAction(\'showJsdiff\')">查看差异文件</button>' : ''}
            </div>
        </div>
    ` : '';

    panel.webview.html = `
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
                    padding: 20px;
                    line-height: 1.6;
                }
                .header {
                    margin-bottom: 20px;
                    padding-bottom: 15px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                }
                .message {
                    font-size: 16px;
                    margin-bottom: 20px;
                    color: var(--vscode-textLink-foreground);
                }
                .process-section {
                    margin-bottom: 25px;
                    padding: 20px;
                    background-color: var(--vscode-editor-background);
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 6px;
                }
                .process-section h3 {
                    margin-top: 0;
                    margin-bottom: 15px;
                    color: var(--vscode-textLink-foreground);
                    font-size: 18px;
                    border-bottom: 2px solid var(--vscode-panel-border);
                    padding-bottom: 8px;
                }
                .process-section h4 {
                    margin-top: 0;
                    margin-bottom: 10px;
                    color: var(--vscode-textLink-foreground);
                    font-size: 14px;
                }
                .stats-section {
                    margin-bottom: 15px;
                    padding: 15px;
                    background-color: var(--vscode-editor-background);
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 4px;
                }
                .stats-grid {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 10px;
                }
                .stat-item {
                    display: flex;
                    justify-content: space-between;
                    padding: 5px 0;
                }
                .stat-label {
                    font-weight: 500;
                }
                .stat-value {
                    color: var(--vscode-textLink-foreground);
                }
                .file-paths {
                    margin-bottom: 20px;
                    padding: 15px;
                    background-color: var(--vscode-editor-background);
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 4px;
                }
                .file-path-item {
                    margin-bottom: 8px;
                    display: flex;
                    align-items: center;
                }
                .file-label {
                    font-weight: 500;
                    min-width: 120px;
                }
                .file-path {
                    color: var(--vscode-textLink-foreground);
                    font-family: var(--vscode-editor-font-family);
                    font-size: 12px;
                    word-break: break-all;
                }
                .section-actions {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 10px;
                    margin-top: 15px;
                    padding-top: 15px;
                    border-top: 1px solid var(--vscode-panel-border);
                }
                .actions {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 10px;
                }
                .action-button {
                    padding: 8px 16px;
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 14px;
                    transition: background-color 0.2s;
                }
                .action-button:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }
                .action-button:disabled {
                    background-color: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                    cursor: not-allowed;
                }
                .close-button {
                    background-color: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                }
                .close-button:hover {
                    background-color: var(--vscode-button-secondaryHoverBackground);
                }
            </style>
        </head>
        <body>
            <div class="header">
                <h2>${result.title}</h2>
                <div class="message">${result.message}</div>
            </div>
            
            ${splitHtml}
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

    return panel;
}

function getFileLabel(key: string): string {
    const labels: { [key: string]: string } = {
        jsonFilePath: 'JSON文件',
        markdownFilePath: 'Markdown文件',
        logFilePath: '日志文件',
        originalFilePath: '原始文件',
        outputFilePath: '输出文件',
        jsdiffFilePath: '差异文件'
    };
    return labels[key] || key;
}

async function handleWebviewMessage(message: any, panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    const { command, data } = message;

    try {
        switch (command) {
            case 'showSplitJson':
                const splitJsonPath = currentProcessResult?.splitResult?.jsonFilePath;
                if (splitJsonPath) {
                    const outputUri = vscode.Uri.file(splitJsonPath);
                    await vscode.workspace.openTextDocument(outputUri);
                    await vscode.window.showTextDocument(outputUri);
                }
                break;
            case 'showSplitLog':
                const splitLogPath = currentProcessResult?.splitResult?.logFilePath;
                if (splitLogPath) {
                    const logUri = vscode.Uri.file(splitLogPath);
                    await vscode.workspace.openTextDocument(logUri);
                    await vscode.window.showTextDocument(logUri);
                }
                break;
            case 'showSplitDiff':
                const splitOriginalPath = currentProcessResult?.splitResult?.originalFilePath;
                const splitMarkdownPath = currentProcessResult?.splitResult?.markdownFilePath;
                if (splitOriginalPath && splitMarkdownPath) {
                    await showFileDiff(splitOriginalPath, splitMarkdownPath);
                }
                break;
            case 'proofreadJson':
                const jsonPath = currentProcessResult?.splitResult?.jsonFilePath;
                if (jsonPath) {
                    await proofreadJsonFile(jsonPath, context);
                }
                break;
            case 'showProofreadJson':
                const proofreadJsonPath = currentProcessResult?.proofreadResult?.outputFilePath;
                if (proofreadJsonPath) {
                    const outputUri = vscode.Uri.file(proofreadJsonPath);
                    await vscode.workspace.openTextDocument(outputUri);
                    await vscode.window.showTextDocument(outputUri);
                }
                break;
            case 'showProofreadLog':
                const proofreadLogPath = currentProcessResult?.proofreadResult?.logFilePath;
                if (proofreadLogPath) {
                    const logUri = vscode.Uri.file(proofreadLogPath);
                    await vscode.workspace.openTextDocument(logUri);
                    await vscode.window.showTextDocument(logUri);
                }
                break;
            case 'showProofreadDiff':
                const proofreadOriginalPath = currentProcessResult?.proofreadResult?.originalFilePath;
                const proofreadMarkdownPath = currentProcessResult?.proofreadResult?.markdownFilePath;
                if (proofreadOriginalPath && proofreadMarkdownPath) {
                    await showFileDiff(proofreadOriginalPath, proofreadMarkdownPath);
                }
                break;
            case 'showJsdiff':
                const jsdiffPath = currentProcessResult?.proofreadResult?.jsdiffFilePath;
                if (jsdiffPath) {
                    const jsdiffUri = vscode.Uri.file(jsdiffPath);
                    await vscode.workspace.openTextDocument(jsdiffUri);
                    await vscode.window.showTextDocument(jsdiffUri);
                }
                break;
        }
    } catch (error) {
        ErrorUtils.showError(error, `执行操作时出错：`);
    }
}

async function proofreadJsonFile(jsonFilePath: string, context: vscode.ExtensionContext) {
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
        const jsdiffFilePath = FilePathUtils.getFilePath(jsonFilePath, '.proofread', '.html');

        // 检查proofreadMarkdownFilePath文件是否存在，如果存在则备份
        if (fs.existsSync(proofreadMarkdownFilePath)) {
            const backupFilePath = FilePathUtils.getFilePath(jsonFilePath, `.proofread.json-${new Date().getTime()}`, '.md');
            fs.copyFileSync(proofreadMarkdownFilePath, backupFilePath);
        }

        // 获取配置
        const configManager = ConfigManager.getInstance();
        const platform = configManager.getPlatform();
        const model = configManager.getModel(platform);
        const rpm = configManager.getRpm();
        const maxConcurrent = configManager.getMaxConcurrent();
        const temperature = configManager.getTemperature();

        // 调用校对功能
        const stats = await processJsonFileAsync(
            jsonFilePath,
            outputFilePath,
            logFilePath,
            originalMarkdownFilePath,
            proofreadMarkdownFilePath,
            jsdiffFilePath,
            platform,
            model,
            rpm,
            maxConcurrent,
            temperature
        );

        // 更新面板显示校对结果
        const processResult: ProcessResult = {
            title: '处理完成',
            message: '文件切分和校对都已完成！',
            splitResult: currentProcessResult?.splitResult, // 保留切分结果
            proofreadResult: {
                outputFilePath: outputFilePath,
                logFilePath: logFilePath,
                originalFilePath: originalMarkdownFilePath,
                markdownFilePath: proofreadMarkdownFilePath,
                jsdiffFilePath: jsdiffFilePath,
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
                showDiff: true,
                showJsdiff: true
            }
        };

        if (currentPanel) {
            // 如果已有面板，更新内容
            updatePanelContent(processResult);
            // 激活面板
            currentPanel.reveal();
        } else {
            // 如果没有面板，创建新面板
            const panel = createWebviewPanel(processResult);
            
            // 监听Webview消息
            panel.webview.onDidReceiveMessage(
                (message) => handleWebviewMessage(message, panel, context),
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
                PromptManager.getInstance(context).managePrompts();
            }
        } else {
            ErrorUtils.showError(error, '校对JSON文件时出错：');
        }
    }
}

function updatePanelContent(result: ProcessResult) {
    if (currentPanel && currentProcessResult) {
        // 更新当前结果
        currentProcessResult = result;
        
        // 重新生成HTML内容
        const splitHtml = result.splitResult ? `
            <div class="process-section">
                <h3>📄 文件切分结果</h3>
                <div class="file-paths">
                    <div class="file-path-item">
                        <span class="file-label">原始文件:</span>
                        <span class="file-path">${result.splitResult.originalFilePath}</span>
                    </div>
                    <div class="file-path-item">
                        <span class="file-label">JSON文件:</span>
                        <span class="file-path">${result.splitResult.jsonFilePath}</span>
                    </div>
                    <div class="file-path-item">
                        <span class="file-label">Markdown文件:</span>
                        <span class="file-path">${result.splitResult.markdownFilePath}</span>
                    </div>
                    <div class="file-path-item">
                        <span class="file-label">日志文件:</span>
                        <span class="file-path">${result.splitResult.logFilePath}</span>
                    </div>
                </div>
                <div class="section-actions">
                    ${result.splitResult.jsonFilePath ? '<button class="action-button" onclick="handleAction(\'showSplitJson\')">查看JSON文件</button>' : ''}
                    ${result.splitResult.jsonFilePath ? '<button class="action-button" onclick="handleAction(\'proofreadJson\')">校对JSON文件</button>' : ''}
                    ${result.splitResult.logFilePath ? '<button class="action-button" onclick="handleAction(\'showSplitLog\')">查看切分日志</button>' : ''}
                    ${result.splitResult.originalFilePath && result.splitResult.markdownFilePath ? '<button class="action-button" onclick="handleAction(\'showSplitDiff\')">比较前后差异</button>' : ''}
                </div>
            </div>
        ` : '';

        const proofreadHtml = result.proofreadResult ? `
            <div class="process-section">
                <h3>✏️ 校对结果</h3>
                <div class="stats-section">
                    <h4>处理统计</h4>
                    <div class="stats-grid">
                        <div class="stat-item">
                            <span class="stat-label">总段落数:</span>
                            <span class="stat-value">${result.proofreadResult.stats.totalCount}</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-label">已处理段落数:</span>
                            <span class="stat-value">${result.proofreadResult.stats.processedCount} (${(result.proofreadResult.stats.processedCount/result.proofreadResult.stats.totalCount*100).toFixed(2)}%)</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-label">已处理字数:</span>
                            <span class="stat-value">${result.proofreadResult.stats.processedLength} (${(result.proofreadResult.stats.processedLength/result.proofreadResult.stats.totalLength*100).toFixed(2)}%)</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-label">未处理段落数:</span>
                            <span class="stat-value">${result.proofreadResult.stats.totalCount - result.proofreadResult.stats.processedCount}</span>
                        </div>
                    </div>
                </div>
                <div class="file-paths">
                    <div class="file-path-item">
                        <span class="file-label">输出文件:</span>
                        <span class="file-path">${result.proofreadResult.outputFilePath}</span>
                    </div>
                    <div class="file-path-item">
                        <span class="file-label">校对后Markdown:</span>
                        <span class="file-path">${result.proofreadResult.markdownFilePath}</span>
                    </div>
                    <div class="file-path-item">
                        <span class="file-label">日志文件:</span>
                        <span class="file-path">${result.proofreadResult.logFilePath}</span>
                    </div>
                    <div class="file-path-item">
                        <span class="file-label">差异文件:</span>
                        <span class="file-path">${result.proofreadResult.jsdiffFilePath}</span>
                    </div>
                </div>
                <div class="section-actions">
                    ${result.proofreadResult.outputFilePath ? '<button class="action-button" onclick="handleAction(\'showProofreadJson\')">查看JSON文件</button>' : ''}
                    ${result.proofreadResult.logFilePath ? '<button class="action-button" onclick="handleAction(\'showProofreadLog\')">查看校对日志</button>' : ''}
                    ${result.proofreadResult.originalFilePath && result.proofreadResult.markdownFilePath ? '<button class="action-button" onclick="handleAction(\'showProofreadDiff\')">比较前后差异</button>' : ''}
                    ${result.proofreadResult.jsdiffFilePath ? '<button class="action-button" onclick="handleAction(\'showJsdiff\')">查看差异文件</button>' : ''}
                </div>
            </div>
        ` : '';

        // 更新面板HTML
        currentPanel.webview.html = `
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
                        padding: 20px;
                        line-height: 1.6;
                    }
                    .header {
                        margin-bottom: 20px;
                        padding-bottom: 15px;
                        border-bottom: 1px solid var(--vscode-panel-border);
                    }
                    .message {
                        font-size: 16px;
                        margin-bottom: 20px;
                        color: var(--vscode-textLink-foreground);
                    }
                    .process-section {
                        margin-bottom: 25px;
                        padding: 20px;
                        background-color: var(--vscode-editor-background);
                        border: 1px solid var(--vscode-panel-border);
                        border-radius: 6px;
                    }
                    .process-section h3 {
                        margin-top: 0;
                        margin-bottom: 15px;
                        color: var(--vscode-textLink-foreground);
                        font-size: 18px;
                        border-bottom: 2px solid var(--vscode-panel-border);
                        padding-bottom: 8px;
                    }
                    .process-section h4 {
                        margin-top: 0;
                        margin-bottom: 10px;
                        color: var(--vscode-textLink-foreground);
                        font-size: 14px;
                    }
                    .stats-section {
                        margin-bottom: 15px;
                        padding: 15px;
                        background-color: var(--vscode-editor-background);
                        border: 1px solid var(--vscode-panel-border);
                        border-radius: 4px;
                    }
                    .stats-grid {
                        display: grid;
                        grid-template-columns: 1fr 1fr;
                        gap: 10px;
                    }
                    .stat-item {
                        display: flex;
                        justify-content: space-between;
                        padding: 5px 0;
                    }
                    .stat-label {
                        font-weight: 500;
                    }
                    .stat-value {
                        color: var(--vscode-textLink-foreground);
                    }
                    .file-paths {
                        margin-bottom: 20px;
                        padding: 15px;
                        background-color: var(--vscode-editor-background);
                        border: 1px solid var(--vscode-panel-border);
                        border-radius: 4px;
                    }
                    .file-path-item {
                        margin-bottom: 8px;
                        display: flex;
                        align-items: center;
                    }
                    .file-label {
                        font-weight: 500;
                        min-width: 120px;
                    }
                    .file-path {
                        color: var(--vscode-textLink-foreground);
                        font-family: var(--vscode-editor-font-family);
                        font-size: 12px;
                        word-break: break-all;
                    }
                    .actions {
                        display: flex;
                        flex-wrap: wrap;
                        gap: 10px;
                    }
                    .action-button {
                        padding: 8px 16px;
                        background-color: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        border: none;
                        border-radius: 4px;
                        cursor: pointer;
                        font-size: 14px;
                        transition: background-color 0.2s;
                    }
                    .action-button:hover {
                        background-color: var(--vscode-button-hoverBackground);
                    }
                    .action-button:disabled {
                        background-color: var(--vscode-button-secondaryBackground);
                        color: var(--vscode-button-secondaryForeground);
                        cursor: not-allowed;
                    }
                    .close-button {
                        background-color: var(--vscode-button-secondaryBackground);
                        color: var(--vscode-button-secondaryForeground);
                    }
                    .close-button:hover {
                        background-color: var(--vscode-button-secondaryHoverBackground);
                    }
                </style>
            </head>
            <body>
                <div class="header">
                    <h2>${result.title}</h2>
                    <div class="message">${result.message}</div>
                </div>
                
                ${splitHtml}
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

function reopenResultPanel(context: vscode.ExtensionContext) {
    if (currentProcessResult) {
        const panel = createWebviewPanel(currentProcessResult);
        
        // 监听Webview消息
        panel.webview.onDidReceiveMessage(
            (message) => handleWebviewMessage(message, panel, context),
            undefined,
            context.subscriptions
        );
    } else {
        vscode.window.showInformationMessage('没有可显示的处理结果');
    }
}

export function activate(context: vscode.ExtensionContext) {
    const logger = Logger.getInstance();
    const configManager = ConfigManager.getInstance();
    logger.info('AI Proofread extension is now active!');

    // 清理临时文件
    TempFileManager.getInstance(context).cleanup();

    // 通用的文件切分处理函数
    async function handleFileSplitCommand(
        mode: 'length' | 'title' | 'title-length' | 'titleContext' | 'paragraphContext',
        editor: vscode.TextEditor,
        document: vscode.TextDocument
    ) {
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
            } else if (mode === 'title' || mode === 'title-length' || mode === 'titleContext') {
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
                        return;
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
            } else if (mode === 'paragraphContext') {
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
                    return;
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
                    return;
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
                    return;
                }
                options.afterParagraphs = parseInt(inputAfterParagraphs);
            }

            // 调用splitter模块中的handleFileSplit函数
            const result = await handleFileSplit(document.uri.fsPath, options);

            // 显示成功消息
            // vscode.window.showInformationMessage(`文件已成功切分！\nJSON文件：${result.jsonFilePath}\nMarkdown文件：${result.markdownFilePath}`);

            // 创建或更新智能面板
            const processResult: ProcessResult = {
                title: '处理结果',
                message: '文件已成功切分！',
                splitResult: {
                    jsonFilePath: result.jsonFilePath,
                    markdownFilePath: result.markdownFilePath,
                    logFilePath: result.logFilePath,
                    originalFilePath: document.uri.fsPath
                },
                actions: {
                    showJson: true,
                    showLog: true,
                    showDiff: true
                }
            };

            if (currentPanel) {
                // 如果已有面板，更新内容
                updatePanelContent(processResult);
                // 激活面板
                currentPanel.reveal();
            } else {
                // 如果没有面板，创建新面板
                const panel = createWebviewPanel(processResult);
                
                // 监听Webview消息
                panel.webview.onDidReceiveMessage(
                    (message) => handleWebviewMessage(message, panel, context),
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
                { label: '按长度切分，以标题范围为上下文', value: 'titleContext' },
                { label: '按长度切分，扩展前后段落为上下文', value: 'paragraphContext' },
            ], {
                placeHolder: '请选择切分模式',
                canPickMany: false
            });

            if (!mode) {
                return;
            }

            await handleFileSplitCommand(mode.value as 'length' | 'title' | 'title-length' | 'titleContext' | 'paragraphContext', editor, editor.document);
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

        vscode.commands.registerCommand('ai-proofread.splitFileWithTitleContext', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('No active editor!');
                return;
            }
            await handleFileSplitCommand('titleContext', editor, editor.document);
        }),

        vscode.commands.registerCommand('ai-proofread.splitFileWithParagraphContext', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('No active editor!');
                return;
            }
            await handleFileSplitCommand('paragraphContext', editor, editor.document);
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

                        // 生成差异文件
                        await jsDiffMarkdown(originalMarkdownFilePath, proofreadMarkdownFilePath, jsdiffFilePath, diffTitle);

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
                            splitResult: currentProcessResult?.splitResult, // 保留切分结果
                            proofreadResult: {
                                outputFilePath: outputFilePath,
                                logFilePath: logFilePath,
                                originalFilePath: originalMarkdownFilePath,
                                markdownFilePath: proofreadMarkdownFilePath,
                                jsdiffFilePath: jsdiffFilePath,
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
                                showDiff: true,
                                showJsdiff: true
                            }
                        };

                        if (currentPanel) {
                            // 如果已有面板，更新内容
                            updatePanelContent(processResult);
                            // 激活面板
                            currentPanel.reveal();
                        } else {
                            // 如果没有面板，创建新面板
                            const panel = createWebviewPanel(processResult);
                            
                            // 监听Webview消息
                            panel.webview.onDidReceiveMessage(
                                (message) => handleWebviewMessage(message, panel, context),
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

            const currentFile = editor.document.uri.fsPath;
            const currentLanguageId = editor.document.languageId;

            // 检查当前文件类型
            if (currentLanguageId !== 'markdown' && currentLanguageId !== 'json') {
                vscode.window.showInformationMessage('请打开一个markdown或JSON文件！');
                return;
            }

            // 根据文件类型决定比较方式
            let diffMethod: string;
            if (currentLanguageId === 'json') {
                // JSON文件直接使用jsdiff方式
                diffMethod = '生成jsDiff结果文件并打开';
            } else {
                // 其他文件类型让用户选择比较方式
                const selectedMethod = await vscode.window.showQuickPick(
                    ['使用diff编辑器比较', '生成jsDiff结果文件并打开'],
                    {
                        placeHolder: '请选择比较方式'
                    }
                );

                if (!selectedMethod) {
                    return;
                }
                diffMethod = selectedMethod;
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
                if (diffMethod === '生成jsDiff结果文件并打开') {
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
                        
                        // 根据是否分批处理来决定打开哪个文件
                        if (segmentCount > 0) {
                            // 分批处理时，打开第一个文件
                            const firstBatchFile = FilePathUtils.getFilePath(currentFile, '.diff-001', '.html');
                            if (fs.existsSync(firstBatchFile)) {
                                await vscode.env.openExternal(vscode.Uri.file(firstBatchFile));
                            } else {
                                // 如果第一个批次文件不存在，尝试打开原始输出文件
                                await vscode.env.openExternal(vscode.Uri.file(outputFile));
                            }
                        } else {
                            // 一次性比较所有片段时，打开原始输出文件
                            await vscode.env.openExternal(vscode.Uri.file(outputFile));
                        }
                    } else {
                        // 处理普通文件比较
                        await jsDiffMarkdown(currentFile, anotherFile, outputFile, title);

                        // 使用系统默认程序打开生成的diff.html文件
                        await vscode.env.openExternal(vscode.Uri.file(outputFile));
                    }
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

        // 注册重新打开结果面板命令
        vscode.commands.registerCommand('ai-proofread.reopenResultPanel', () => {
            reopenResultPanel(context);
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