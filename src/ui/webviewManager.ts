/**
 * Webview 面板管理器
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { showFileDiff, jsDiffJsonFiles } from '../differ';
import { ErrorUtils, FilePathUtils } from '../utils';
import { ProgressTracker } from '../progressTracker';
import { alignSentencesAnchor, getAlignmentStatistics, AlignmentOptions } from '../sentenceAligner';
import { splitChineseSentencesWithLineNumbers } from '../splitter';
import { generateHtmlReport } from '../alignmentReportGenerator';
import { getJiebaWasm } from '../jiebaLoader';
import { collectWordErrors, formatWordErrors, parseDelimitersFromConfig } from '../wordErrorCollector';

// 接口定义
/** 配套文档检测结果 */
export interface CompanionFiles {
    json: string;
    jsonMd: string;
    log: string;
    /** 由切分 JSON 派生：basename.dictprep.json */
    dictPrepJson: string;
    dictPrepLog: string;
    proofreadJson: string;
    proofreadJsonMd: string;
    proofreadLog: string;
}

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
    mainFilePath?: string;
    companionFiles?: Partial<CompanionFiles>;
    splitResult?: SplitResult;
    proofreadResult?: ProofreadResult;
    progressTracker?: ProgressTracker;
    actions: {
        showJson?: boolean;
        showLog?: boolean;
        showDiff?: boolean;
    };
}

/** 检测主文件的配套文档 */
export function detectCompanionFiles(mainFilePath: string): Partial<CompanionFiles> {
    const dir = path.dirname(mainFilePath);
    const base = path.basename(mainFilePath, path.extname(mainFilePath));
    const result: Partial<CompanionFiles> = {};
    const candidates: (keyof CompanionFiles)[] = [
        'json',
        'jsonMd',
        'log',
        'dictPrepJson',
        'dictPrepLog',
        'proofreadJson',
        'proofreadJsonMd',
        'proofreadLog',
    ];
    const paths: Record<keyof CompanionFiles, string> = {
        json: path.join(dir, `${base}.json`),
        jsonMd: path.join(dir, `${base}.json.md`),
        log: path.join(dir, `${base}.log`),
        dictPrepJson: path.join(dir, `${base}.dictprep.json`),
        dictPrepLog: path.join(dir, `${base}.dictprep.log`),
        proofreadJson: path.join(dir, `${base}.proofread.json`),
        proofreadJsonMd: path.join(dir, `${base}.proofread.json.md`),
        proofreadLog: path.join(dir, `${base}.proofread.log`),
    };
    for (const key of candidates) {
        if (fs.existsSync(paths[key])) {
            (result as any)[key] = paths[key];
        }
    }
    return result;
}

/** 从 JSON 文件读取条目数 */
function getJsonArrayLength(filePath: string): number | undefined {
    try {
        const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return Array.isArray(content) ? content.length : undefined;
    } catch {
        return undefined;
    }
}

/** 从 proofread.json 读取 null 条目数（未完成校对） */
function getProofreadNullCount(filePath: string): number | undefined {
    try {
        const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!Array.isArray(content)) return undefined;
        return content.filter((item: unknown) => item === null).length;
    } catch {
        return undefined;
    }
}

export class WebviewManager {
    private static instance: WebviewManager;
    private currentPanel: vscode.WebviewPanel | undefined;
    private currentProcessResult: ProcessResult | undefined;
    private mainFilePath: string | undefined;
    private extensionContext: vscode.ExtensionContext | undefined;

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
    public createWebviewPanel(result: ProcessResult, context?: vscode.ExtensionContext): vscode.WebviewPanel {
        if (context) this.extensionContext = context;
        // 如果已有面板且未被dispose，先关闭它
        if (this.currentPanel) {
            this.currentPanel.dispose();
        }

        const panel = vscode.window.createWebviewPanel(
            'processResult',
            result.title === 'AI Proofreader Result Panel' ? 'Proofreading panel' : result.title,
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

        panel.webview.html = this.generateFullHtml(result, context);

        return panel;
    }

    /**
     * 更新面板内容
     */
    public updatePanelContent(result: ProcessResult): void {
        if (this.currentPanel) {
            try {
                this.currentProcessResult = result;
                this.currentPanel.webview.html = this.generateFullHtml(result, this.extensionContext);
            } catch (error) {
                console.error('更新Webview内容时出错:', error);
                this.createWebviewPanel(result, this.extensionContext);
            }
        }
    }

    /**
     * 打开校对面板（支持空面板）
     */
    public openProofreadingPanel(context: vscode.ExtensionContext): void {
        this.extensionContext = context;
        if (this.currentPanel) {
            this.currentPanel.reveal();
            this.refreshPanelContent(context);
            return;
        }
        // 无处理结果时，尝试恢复上次选择的主文件
        if (!this.currentProcessResult && !this.mainFilePath) {
            const last = context.workspaceState.get<string>('aiProofread.lastMainFile');
            if (last && fs.existsSync(last)) {
                this.mainFilePath = last;
            }
        }
        const result = this.currentProcessResult ?? this.buildEmptyOrMainFileResult();
        const panel = this.createOrRevealPanel(result, context);
        panel.webview.onDidReceiveMessage(
            (message) => this.handleWebviewMessage(message, panel, context),
            undefined,
            context.subscriptions
        );
    }

    /** 兼容旧命令 */
    public reopenResultPanel(context: vscode.ExtensionContext): void {
        this.openProofreadingPanel(context);
    }

    /** 构建空状态或仅主文件状态的结果 */
    private buildEmptyOrMainFileResult(): ProcessResult {
        const hasMain = !!this.mainFilePath;
        const companions = this.mainFilePath ? detectCompanionFiles(this.mainFilePath) : undefined;
        return {
            title: 'Proofreading panel',
            message: hasMain
                ? `校对项目：${this.getRelativePath(this.mainFilePath!)}`
                : '选择要校对的主文件，或等待切分/校对完成后查看结果。',
            mainFilePath: this.mainFilePath,
            companionFiles: companions,
            actions: {}
        };
    }

    /** 创建或显示面板 */
    private createOrRevealPanel(result: ProcessResult, context: vscode.ExtensionContext): vscode.WebviewPanel {
        if (this.currentPanel) {
            this.currentPanel.reveal();
            this.currentPanel.webview.html = this.generateFullHtml(result, context);
            return this.currentPanel;
        }
        return this.createWebviewPanel(result, context);
    }

    /** 刷新面板内容（根据当前状态） */
    public refreshPanelContent(context: vscode.ExtensionContext): void {
        if (!this.currentPanel) return;
        const result = this.currentProcessResult ?? this.buildEmptyOrMainFileResult();
        // 使用 buildEmptyOrMainFileResult 时需同步到 currentProcessResult，否则按钮无法获取 companionFiles 等路径
        if (!this.currentProcessResult) {
            this.currentProcessResult = result;
        }
        this.currentPanel.webview.html = this.generateFullHtml(result, context);
    }

    /** 设置主文件并刷新 */
    public setMainFile(mainFilePath: string, context: vscode.ExtensionContext): void {
        this.mainFilePath = mainFilePath;
        this.refreshPanelContent(context);
    }

    /** 从当前状态获取路径（支持 splitResult 或 companionFiles） */
    private getSplitJsonPath(): string | undefined {
        return this.currentProcessResult?.splitResult?.jsonFilePath ?? (this.currentProcessResult?.companionFiles as any)?.json;
    }
    private getSplitLogPath(): string | undefined {
        return this.currentProcessResult?.splitResult?.logFilePath ?? (this.currentProcessResult?.companionFiles as any)?.log;
    }
    private getSplitMarkdownPath(): string | undefined {
        return this.currentProcessResult?.splitResult?.markdownFilePath ?? (this.currentProcessResult?.companionFiles as any)?.jsonMd;
    }
    private getMainFilePath(): string | undefined {
        return this.currentProcessResult?.splitResult?.originalFilePath ?? this.currentProcessResult?.mainFilePath;
    }
    private getProofreadJsonPath(): string | undefined {
        return this.currentProcessResult?.proofreadResult?.outputFilePath ?? (this.currentProcessResult?.companionFiles as any)?.proofreadJson;
    }
    private getProofreadLogPath(): string | undefined {
        return this.currentProcessResult?.proofreadResult?.logFilePath ?? (this.currentProcessResult?.companionFiles as any)?.proofreadLog;
    }
    private getProofreadMarkdownPath(): string | undefined {
        return this.currentProcessResult?.proofreadResult?.markdownFilePath ?? (this.currentProcessResult?.companionFiles as any)?.proofreadJsonMd;
    }

    private getDictPrepJsonPath(): string | undefined {
        const j = this.getSplitJsonPath();
        return j ? FilePathUtils.getFilePath(j, '.dictprep', '.json') : undefined;
    }

    private getDictPrepLogPath(): string | undefined {
        const j = this.getSplitJsonPath();
        return j ? FilePathUtils.getFilePath(j, '.dictprep', '.log') : undefined;
    }

    /** 过程文件行：路径后紧跟「打开」 */
    private filePathRowWithOpenButton(label: string, absolutePath: string, openAction: string): string {
        const rel = this.getRelativePath(absolutePath);
        return `
                    <div class="file-path-row file-path-row--with-actions">
                        <span class="file-label">${label}</span>
                        <span class="file-path">${rel}</span>
                        <span class="file-row-actions">
                            <button type="button" class="action-button action-button--compact" onclick="handleAction('${openAction}')">打开</button>
                        </span>
                    </div>`;
    }

    /**
     * 仅当磁盘上已有该文件时渲染一行；尚未生成的过程文件不占位，避免无效按钮。
     */
    private filePathRowWithOpenButtonIfExists(label: string, absolutePath: string, openAction: string): string {
        if (!absolutePath || !fs.existsSync(absolutePath)) {
            return '';
        }
        return this.filePathRowWithOpenButton(label, absolutePath, openAction);
    }

    /**
     * 处理 Webview 消息
     */
    public async handleWebviewMessage(message: any, panel: vscode.WebviewPanel, context: vscode.ExtensionContext): Promise<void> {
        const { command, data } = message;

        try {
            switch (command) {
                case 'selectMainFile': {
                    const uris = await vscode.window.showOpenDialog({
                        canSelectFiles: true,
                        canSelectFolders: false,
                        canSelectMany: false,
                        filters: { 'Markdown/Text': ['md', 'markdown', 'txt'], 'TeX': ['tex', 'latex', 'context'], 'All': ['*'] },
                        title: '选择要校对的主文件'
                    });
                    if (uris?.length) {
                        this.currentProcessResult = undefined; // 切换主文件时清除当前结果
                        this.setMainFile(uris[0].fsPath, context);
                        context.workspaceState.update('aiProofread.lastMainFile', uris[0].fsPath);
                    }
                    break;
                }
                case 'selectMainFileFromWorkspace': {
                    const folders = vscode.workspace.workspaceFolders;
                    if (!folders?.length) {
                        vscode.window.showWarningMessage('请先打开工作区');
                        break;
                    }
                    const files = await vscode.workspace.findFiles('**/*.{md,markdown,txt}', '**/node_modules/**');
                    if (files.length === 0) {
                        vscode.window.showInformationMessage('工作区中未找到 .md / .txt 文件');
                        break;
                    }
                    const items = files.map(uri => ({
                        label: path.relative(folders[0].uri.fsPath, uri.fsPath),
                        description: uri.fsPath,
                        uri
                    }));
                    const picked = await vscode.window.showQuickPick(items, {
                        placeHolder: '选择要校对的主文件',
                        matchOnDescription: true
                    });
                    if (picked) {
                        this.currentProcessResult = undefined; // 切换主文件时清除当前结果
                        this.setMainFile(picked.uri.fsPath, context);
                        context.workspaceState.update('aiProofread.lastMainFile', picked.uri.fsPath);
                    }
                    break;
                }
                case 'formatParagraphs':
                case 'markTitlesFromToc': {
                    // 头部按钮：使用当前编辑窗口文件
                    await vscode.commands.executeCommand(
                        command === 'formatParagraphs' ? 'ai-proofread.formatParagraphs' : 'ai-proofread.markTitlesFromToc'
                    );
                    break;
                }
                case 'formatParagraphsUseMainFile':
                case 'markTitlesFromTocUseMainFile': {
                    // 主文件板块：使用主文件
                    const mainPath = this.mainFilePath ?? this.getMainFilePath();
                    if (!mainPath) {
                        vscode.window.showWarningMessage('请先选择主文件');
                        break;
                    }
                    const doc = await vscode.workspace.openTextDocument(mainPath);
                    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
                    await vscode.commands.executeCommand(
                        command === 'formatParagraphsUseMainFile' ? 'ai-proofread.formatParagraphs' : 'ai-proofread.markTitlesFromToc'
                    );
                    break;
                }
                case 'proofreadSelection':
                case 'proofreadSelectionWithExamples': {
                    // 头部按钮：使用当前编辑窗口文件
                    await vscode.commands.executeCommand(
                        command === 'proofreadSelection' ? 'ai-proofread.proofreadSelection' : 'ai-proofread.proofreadSelectionWithExamples'
                    );
                    break;
                }
                case 'convertDocxToMarkdown':
                    await vscode.commands.executeCommand('ai-proofread.convertDocxToMarkdown');
                    break;
                case 'convertPdfToMarkdown':
                    await vscode.commands.executeCommand('ai-proofread.convertPdfToMarkdown');
                    break;
                case 'managePrompts':
                    await vscode.commands.executeCommand('ai-proofread.managePrompts');
                    break;
                case 'openSettings':
                    await vscode.commands.executeCommand('workbench.action.openSettings', 'ai-proofread');
                    break;
                case 'splitDocument':
                case 'resplitDocument': {
                    const mainPath = this.mainFilePath ?? this.getMainFilePath();
                    if (!mainPath) {
                        vscode.window.showWarningMessage('请先选择主文件');
                        break;
                    }
                    if ((this as any).splitCallback) {
                        await (this as any).splitCallback(mainPath, context);
                    } else {
                        vscode.window.showWarningMessage('切分功能未就绪');
                    }
                    break;
                }
                case 'mergeContext': {
                    const jsonPath = this.getSplitJsonPath();
                    if (jsonPath && (this as any).mergeCallback) {
                        await (this as any).mergeCallback(jsonPath, context);
                    } else {
                        vscode.window.showWarningMessage('请先完成切分，或合并功能未就绪');
                    }
                    break;
                }
                case 'showSplitJson': {
                    const splitJsonPath = this.getSplitJsonPath();
                    if (splitJsonPath) {
                        const outputUri = vscode.Uri.file(splitJsonPath);
                        const splitDoc = await vscode.workspace.openTextDocument(outputUri);
                        await vscode.window.showTextDocument(splitDoc, { viewColumn: vscode.ViewColumn.Beside });
                    }
                    break;
                }
                case 'showSplitJsonMd': {
                    const mdPath = this.getSplitMarkdownPath();
                    if (mdPath) {
                        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(mdPath));
                        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
                    }
                    break;
                }
                case 'showSplitLog': {
                    const splitLogPath = this.getSplitLogPath();
                    if (splitLogPath) {
                        const logUri = vscode.Uri.file(splitLogPath);
                        const document = await vscode.workspace.openTextDocument(logUri);
                        const editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside });

                        // 滚动到文件末端
                        const lastLine = document.lineCount - 1;
                        const lastLineLength = document.lineAt(lastLine).text.length;
                        const endPosition = new vscode.Position(lastLine, lastLineLength);
                        editor.selection = new vscode.Selection(endPosition, endPosition);
                        editor.revealRange(new vscode.Range(endPosition, endPosition), vscode.TextEditorRevealType.InCenter);
                    }
                    break;
                }
                case 'showSplitDiff': {
                    const splitOriginalPath = this.getMainFilePath();
                    const splitMarkdownPath = this.getSplitMarkdownPath();
                    if (splitOriginalPath && splitMarkdownPath) {
                        await showFileDiff(splitOriginalPath, splitMarkdownPath);
                    }
                    break;
                }
                case 'proofreadJson': {
                    const jsonPath = this.getSplitJsonPath();
                    if (jsonPath) {
                        // 直接调用校对JSON文件的回调函数
                        if ((this as any).proofreadJsonCallback) {
                            await (this as any).proofreadJsonCallback(jsonPath, context);
                        }
                    }
                    break;
                }
                case 'dictPrepLlmPlan': {
                    const jsonPath = this.getSplitJsonPath();
                    if (!jsonPath) {
                        vscode.window.showWarningMessage('请先完成切分，或未找到 JSON 文件。');
                        break;
                    }
                    if ((this as any).dictPrepLlmPlanCallback) {
                        await (this as any).dictPrepLlmPlanCallback(jsonPath, context);
                    }
                    break;
                }
                case 'dictPrepLocalMerge': {
                    const jsonPath = this.getSplitJsonPath();
                    if (!jsonPath) {
                        vscode.window.showWarningMessage('请先完成切分，或未找到 JSON 文件。');
                        break;
                    }
                    if ((this as any).dictPrepLocalMergeCallback) {
                        await (this as any).dictPrepLocalMergeCallback(jsonPath, context);
                    }
                    break;
                }
                case 'showDictPrepJson': {
                    const p = this.getDictPrepJsonPath();
                    if (p && fs.existsSync(p)) {
                        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(p));
                        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
                    } else {
                        vscode.window.showInformationMessage('尚未生成 .dictprep.json（需先执行「LLM 生成查词计划」）。');
                    }
                    break;
                }
                case 'showDictPrepLog': {
                    const p = this.getDictPrepLogPath();
                    if (p && fs.existsSync(p)) {
                        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(p));
                        const ed = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
                        const lastLine = doc.lineCount - 1;
                        const lastLen = doc.lineAt(lastLine).text.length;
                        const end = new vscode.Position(lastLine, lastLen);
                        ed.selection = new vscode.Selection(end, end);
                        ed.revealRange(new vscode.Range(end, end), vscode.TextEditorRevealType.InCenter);
                    } else {
                        vscode.window.showInformationMessage('尚未生成 .dictprep.log。');
                    }
                    break;
                }
                case 'showProofreadJson': {
                    const proofreadJsonPath = this.getProofreadJsonPath();
                    if (proofreadJsonPath) {
                        const outputUri = vscode.Uri.file(proofreadJsonPath);
                        const proofreadDoc = await vscode.workspace.openTextDocument(outputUri);
                        await vscode.window.showTextDocument(proofreadDoc, { viewColumn: vscode.ViewColumn.Beside });
                    }
                    break;
                }
                case 'showProofreadJsonMd': {
                    const mdPath = this.getProofreadMarkdownPath();
                    if (mdPath) {
                        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(mdPath));
                        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
                    }
                    break;
                }
                case 'showProofreadLog': {
                    const proofreadLogPath = this.getProofreadLogPath();
                    if (proofreadLogPath) {
                        const logUri = vscode.Uri.file(proofreadLogPath);
                        const document = await vscode.workspace.openTextDocument(logUri);
                        const editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside });

                        // 滚动到文件末端
                        const lastLine = document.lineCount - 1;
                        const lastLineLength = document.lineAt(lastLine).text.length;
                        const endPosition = new vscode.Position(lastLine, lastLineLength);
                        editor.selection = new vscode.Selection(endPosition, endPosition);
                        editor.revealRange(new vscode.Range(endPosition, endPosition), vscode.TextEditorRevealType.InCenter);
                    }
                    break;
                }
                case 'showProofreadDiff': {
                    const proofreadOriginalPath = this.getMainFilePath();
                    const proofreadMarkdownPath = this.getProofreadMarkdownPath();
                    if (proofreadOriginalPath && proofreadMarkdownPath) {
                        await showFileDiff(proofreadOriginalPath, proofreadMarkdownPath);
                    }
                    break;
                }
                case 'generateDiff': {
                    const originalJsonPath = this.getSplitJsonPath();
                    const proofreadJsonFilePath = this.getProofreadJsonPath();

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
                case 'generateAlignment': {
                    const alignmentOriginalPath = this.getMainFilePath();
                    const alignmentMarkdownPath = this.getProofreadMarkdownPath();

                    if (alignmentOriginalPath && alignmentMarkdownPath) {
                        await this.handleSentenceAlignment(alignmentOriginalPath, alignmentMarkdownPath, context);
                    } else {
                        vscode.window.showErrorMessage('无法找到原始文件或校对后的Markdown文件！');
                    }
                    break;
                }
                case 'convertMarkdownToDocx': {
                    // 头部按钮：使用当前编辑窗口文件
                    await vscode.commands.executeCommand('ai-proofread.convertMarkdownToDocx');
                    break;
                }
                case 'convertQuotes': {
                    // 头部按钮：使用当前编辑窗口文件
                    await vscode.commands.executeCommand('ai-proofread.convertQuotes');
                    break;
                }
                case 'citationOpenView':
                    await vscode.commands.executeCommand('ai-proofread.citation.openView');
                    break;
                case 'checkWords': {
                    // 头部按钮：使用当前编辑窗口文件
                    await vscode.commands.executeCommand('ai-proofread.checkWords');
                    break;
                }
                case 'splitIntoSentences':
                case 'segmentFile':
                case 'diffItWithAnotherFile':
                case 'queryLocalDictSelection':
                case 'searchSelectionInPDF':
                case 'searchSelectionInShidianguji':
                case 'searchSelectionInAncientbooks':
                case 'searchSelectionInReferences':
                case 'duplicateScanDocument':
                case 'numberingCheck': {
                    // 头部按钮：使用当前编辑窗口文件
                    const cmdMap: Record<string, string> = {
                        splitIntoSentences: 'ai-proofread.splitIntoSentences',
                        segmentFile: 'ai-proofread.segmentFile',
                        diffItWithAnotherFile: 'ai-proofread.diffItWithAnotherFile',
                        queryLocalDictSelection: 'ai-proofread.queryLocalDictSelection',
                        searchSelectionInPDF: 'ai-proofread.searchSelectionInPDF',
                        searchSelectionInShidianguji: 'ai-proofread.searchSelectionInShidianguji',
                        searchSelectionInAncientbooks: 'ai-proofread.searchSelectionInAncientbooks',
                        searchSelectionInReferences: 'ai-proofread.searchSelectionInReferences',
                        duplicateScanDocument: 'ai-proofread.duplicate.scanDocument',
                        numberingCheck: 'ai-proofread.numbering.check'
                    };
                    await vscode.commands.executeCommand(cmdMap[command]);
                    break;
                }
                case 'editProofreadingExamples':
                    await vscode.commands.executeCommand('ai-proofread.editProofreadingExamples');
                    break;
                case 'continuousProofread':
                    await vscode.commands.executeCommand('ai-proofread.continuousProofread');
                    break;
                case 'citationRebuildIndex':
                    await vscode.commands.executeCommand('ai-proofread.citation.rebuildIndex');
                    break;
                case 'manageCustomTables':
                    await vscode.commands.executeCommand('ai-proofread.manageCustomTables');
                    break;
                case 'showProofreadItemsTree': {
                    const proofreadJsonPath = this.getProofreadJsonPath();
                    const itemPath = proofreadJsonPath?.replace(/\.proofread\.json$/i, '.proofread-item.json');
                    if (itemPath && fs.existsSync(itemPath)) {
                        const itemUri = vscode.Uri.file(itemPath);
                        const doc = await vscode.workspace.openTextDocument(itemUri);
                        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
                    }
                    await vscode.commands.executeCommand('setContext', 'aiProofread.showProofreadItemsView', true);
                    await new Promise((r) => setTimeout(r, 50));
                    await vscode.commands.executeCommand('ai-proofread.proofreadItems.focus');
                    break;
                }
            }
        } catch (error) {
            ErrorUtils.showError(error, `执行操作时出错：`);
        }
    }

    /**
     * 设置校对JSON文件的回调函数
     */
    public setProofreadJsonCallback(callback: (jsonFilePath: string, context: vscode.ExtensionContext) => Promise<void>): void {
        (this as any).proofreadJsonCallback = callback;
    }

    /** 设置切分文档的回调（按主文件路径切分） */
    public setSplitCallback(callback: (mainFilePath: string, context: vscode.ExtensionContext) => Promise<void>): void {
        (this as any).splitCallback = callback;
    }

    /** 设置合并 JSON的回调（按 JSON 路径） */
    public setMergeCallback(callback: (jsonFilePath: string, context: vscode.ExtensionContext) => Promise<void>): void {
        (this as any).mergeCallback = callback;
    }

    public setDictPrepLlmPlanCallback(
        callback: (jsonFilePath: string, context: vscode.ExtensionContext) => Promise<void>
    ): void {
        (this as any).dictPrepLlmPlanCallback = callback;
    }

    public setDictPrepLocalMergeCallback(
        callback: (jsonFilePath: string, context: vscode.ExtensionContext) => Promise<void>
    ): void {
        (this as any).dictPrepLocalMergeCallback = callback;
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
     * 生成完整 HTML（根据状态：空/主文件/完整结果）
     * 完整结果时：主文件、切分结果、校对结果 三板块固定顺序展示
     */
    private generateFullHtml(result: ProcessResult, context?: vscode.ExtensionContext): string {
        if (result.splitResult || result.proofreadResult || result.progressTracker) {
            const mainSectionHtml = this.generateMainSectionForFullResult(result);
            const splitHtml = result.splitResult ? this.generateSplitResultHtml(result.splitResult) : '';
            const proofreadSectionHtml = this.generateProofreadSectionHtml(result);
            return this.generateWebviewHtml(result, mainSectionHtml, splitHtml, proofreadSectionHtml);
        }
        if (result.mainFilePath || result.companionFiles) {
            return this.generateMainFileStateHtml(result);
        }
        return this.generateEmptyStateHtml();
    }

    /** 空状态 HTML */
    private generateEmptyStateHtml(): string {
        return this.getBaseHtml(`
            <div class="header">
                <div class="message">选择要校对的主文件，或等待切分/校对完成后查看结果。</div>
            </div>
            <div class="process-section">
                <h3>📄 选择主文件</h3>
                <p class="hint">选择要校对的 Markdown 文档，然后进行切分和校对。</p>
                <div class="section-actions">
                    <button class="action-button" onclick="handleAction('selectMainFile')">选择主文件</button>
                </div>
            </div>
            <div class="panel-footer-commands">
                ${this.getHeaderQuickActionsHtml()}
            </div>
        `);
    }

    /** 主文件已选、配套文档检测后的 HTML */
    private generateMainFileStateHtml(result: ProcessResult): string {
        const mainPath = result.mainFilePath!;
        const comp = result.companionFiles || {};
        const hasJson = !!comp.json;
        const hasProofread = !!comp.proofreadJson;

        const jsonLen = comp.json ? getJsonArrayLength(comp.json) : undefined;
        const proofreadLen = comp.proofreadJson ? getJsonArrayLength(comp.proofreadJson) : undefined;
        const lengthMismatch = (jsonLen !== undefined && proofreadLen !== undefined && jsonLen !== proofreadLen);

        let mainSection = `
            <div class="process-section">
                <h3>📄 主文件</h3>
                <div class="file-paths-compact">
                    <div class="file-path-row">
                        <span class="file-label">主文件:</span>
                        <span class="file-path">${this.getRelativePath(mainPath)}</span>
                    </div>
                </div>
                ${lengthMismatch ? `
                <div class="warning-box">
                    ⚠️ JSON 与 proofread.json 条目数不一致（${jsonLen} vs ${proofreadLen}），请检查或删除 proofread.json 后重新校对。
                </div>
                ` : ''}
                <div class="section-actions">
                    <button class="action-button" onclick="handleAction('selectMainFile')">更换主文件</button>
                    <button class="action-button" onclick="handleAction('formatParagraphsUseMainFile')" title="AI Proofreader: format paragraphs">整理段落</button>
                    <button class="action-button" onclick="handleAction('markTitlesFromTocUseMainFile')" title="AI Proofreader: mark titles from table of contents">根据目录标记标题</button>
                    <button class="action-button" onclick="handleAction('splitDocument')" title="AI Proofreader: split file">${hasJson ? '重新切分' : '切分文档'}</button>
                </div>
            </div>
        `;

        let splitSection = '';
        if (hasJson && comp.json && comp.jsonMd && comp.log) {
            const stats = this.tryReadSplitStats(comp.log);
            const dictPrepJsonPath = FilePathUtils.getFilePath(comp.json, '.dictprep', '.json');
            const dictPrepLogPath = FilePathUtils.getFilePath(comp.json, '.dictprep', '.log');
            splitSection = `
            <div class="process-section">
                <h3>✂️ 切分结果</h3>
                ${stats ? `<div class="stats-section"><div class="stats-inline">
                    <span class="stat-item">切分片段数: <span class="stat-value">${stats.segmentCount}</span></span>
                </div></div>` : ''}
                <div class="file-paths-compact">
                    ${this.filePathRowWithOpenButtonIfExists('JSON:', comp.json, 'showSplitJson')}
                    ${this.filePathRowWithOpenButtonIfExists('JSON.md:', comp.jsonMd, 'showSplitJsonMd')}
                    ${this.filePathRowWithOpenButtonIfExists('切分日志:', comp.log, 'showSplitLog')}
                    ${this.filePathRowWithOpenButtonIfExists('查词过程:', dictPrepJsonPath, 'showDictPrepJson')}
                    ${this.filePathRowWithOpenButtonIfExists('查词日志:', dictPrepLogPath, 'showDictPrepLog')}
                </div>
                <div class="section-actions">
                    <button class="action-button" onclick="handleAction('showSplitDiff')">比较前后差异</button>
                    <button class="action-button" onclick="handleAction('mergeContext')">合并 JSON</button>
                    <button class="action-button" onclick="handleAction('dictPrepLlmPlan')" title="第一段：LLM 确定查询候选">LLM 生成查词计划</button>
                    <button class="action-button" onclick="handleAction('dictPrepLocalMerge')" title="第二段：查询本地词典并写入 reference">查词并入 reference</button>
                    <button class="action-button" onclick="handleAction('proofreadJson')">LLM 校对 JSON</button>
                </div>
            </div>
            `;
        }

        let proofreadSection = '';
        if (hasProofread && comp.proofreadJson && comp.proofreadJsonMd && comp.proofreadLog) {
            const nullCount = getProofreadNullCount(comp.proofreadJson);
            const hasUnfinished = (nullCount ?? 0) > 0;
            proofreadSection = `
            <div class="process-section">
                <h3>✏️ 校对结果</h3>
                ${hasUnfinished ? `
                <div class="warning-box">
                    ⚠️ 有 <strong>${nullCount}</strong> 条未完成校对（.proofread.json 中为 null）。重新校对时将只处理未完成的条目。
                </div>
                ` : ''}
                <div class="file-paths-compact">
                    ${this.filePathRowWithOpenButton('JSON:', comp.proofreadJson, 'showProofreadJson')}
                    ${this.filePathRowWithOpenButton('JSON.md:', comp.proofreadJsonMd, 'showProofreadJsonMd')}
                    ${this.filePathRowWithOpenButton('校对日志:', comp.proofreadLog, 'showProofreadLog')}
                </div>
                <div class="section-actions">
                    <button class="action-button" onclick="handleAction('showProofreadDiff')">比较前后差异</button>
                    <button class="action-button" onclick="handleAction('showProofreadItemsTree')">查看校对条目</button>
                    <button class="action-button" onclick="handleAction('generateDiff')">生成差异文件</button>
                    <button class="action-button" onclick="handleAction('generateAlignment')">生成勘误表</button>
                </div>
            </div>
            `;
        }

        return this.getBaseHtml(`
            <div class="header">
                <div class="message">${result.message}</div>
            </div>
            ${mainSection}
            ${splitSection}
            ${proofreadSection}
            <div class="panel-footer-commands">
                ${this.getHeaderQuickActionsHtml()}
            </div>
        `, true);
    }

    /** 常用命令快捷按钮栏（组内 `|`，组间 `||`，操作对象为当前编辑窗口文件） */
    private getHeaderQuickActionsHtml(): string {
        const sep = '<span class="cmd-sep" aria-hidden="true">|</span>';
        const groupSep = '<span class="cmd-sep cmd-sep--between-groups" aria-hidden="true">||</span>';
        return `
            <p class="header-commands-hint">常用命令（Ctrl+Shift+P 查找全部命令）</p>
            <div class="header-actions">
                <button type="button" class="link-button" onclick="handleAction('convertDocxToMarkdown')" title="AI Proofreader: convert docx to markdown">docx → Markdown</button>
                ${sep}
                <button type="button" class="link-button" onclick="handleAction('convertPdfToMarkdown')" title="AI Proofreader: convert PDF to markdown">PDF → Markdown</button>
                ${sep}
                <button type="button" class="link-button" onclick="handleAction('convertMarkdownToDocx')" title="AI Proofreader: convert markdown to docx">Markdown → docx</button>
                ${groupSep}
                <button type="button" class="link-button" onclick="handleAction('formatParagraphs')" title="AI Proofreader: format paragraphs">整理段落</button>
                ${sep}
                <button type="button" class="link-button" onclick="handleAction('markTitlesFromToc')" title="AI Proofreader: mark titles from table of contents">根据目录标记标题</button>
                ${sep}
                <button type="button" class="link-button" onclick="handleAction('convertQuotes')" title="AI Proofreader: convert quotes to Chinese">半角引号转全角</button>
                ${sep}
                <button type="button" class="link-button" onclick="handleAction('splitIntoSentences')" title="AI Proofreader: split into sentences">切分为句子</button>
                ${sep}
                <button type="button" class="link-button" onclick="handleAction('segmentFile')" title="AI Proofreader: segment file（分词、词频与字频统计）">分词与统计</button>
                ${groupSep}
                <button type="button" class="link-button" onclick="handleAction('proofreadSelection')" title="AI Proofreader: proofread selection">校对选中文本</button>
                ${sep}
                <button type="button" class="link-button" onclick="handleAction('proofreadSelectionWithExamples')" title="AI Proofreader: proofread selection with examples">使用样例校对选中</button>
                ${sep}
                <button type="button" class="link-button" onclick="handleAction('continuousProofread')" title="AI Proofreader: continuous proofread">持续校对</button>
                ${sep}
                <button type="button" class="link-button" onclick="handleAction('editProofreadingExamples')" title="AI Proofreader: edit Proofreading examples">编辑校对样例</button>
                ${groupSep}
                <button type="button" class="link-button" onclick="handleAction('citationOpenView')" title="AI Proofreader: verify citations">核对全文引文</button>
                ${sep}
                <button type="button" class="link-button" onclick="handleAction('citationRebuildIndex')" title="AI Proofreader: build citation reference index">建立引文索引</button>
                ${groupSep}
                <button type="button" class="link-button" onclick="handleAction('checkWords')" title="AI Proofreader: check words">字词检查</button>
                ${sep}
                <button type="button" class="link-button" onclick="handleAction('manageCustomTables')" title="AI Proofreader: manage custom tables">管理自定义替换表</button>
                ${sep}
                <button type="button" class="link-button" onclick="handleAction('numberingCheck')" title="AI Proofreader: check numbering hierarchy">标题序号检查</button>
                ${sep}
                <button type="button" class="link-button" onclick="handleAction('duplicateScanDocument')" title="AI Proofreader: scan duplicate sentences in document">重复句扫描</button>
                ${groupSep}
                <button type="button" class="link-button" onclick="handleAction('diffItWithAnotherFile')" title="AI Proofreader: diff it with another file">diff 与另一文件</button>
                ${sep}
                <button type="button" class="link-button" onclick="handleAction('queryLocalDictSelection')" title="AI Proofreader: query local dictionary for selection">在词典中查询选中</button>
                ${sep}
                <button type="button" class="link-button" onclick="handleAction('searchSelectionInPDF')" title="AI Proofreader: search selection in PDF">在 PDF 中搜索选中文本</button>
                ${sep}
                <button type="button" class="link-button" onclick="handleAction('searchSelectionInShidianguji')" title="AI Proofreader: search selection in Shidianguji">在识典古籍中搜索选中文本</button>
                ${sep}
                <button type="button" class="link-button" onclick="handleAction('searchSelectionInAncientbooks')" title="AI Proofreader: search selection in Ancientbooks (jingdian)">在中华经典古籍库中搜索选中文本</button>
                ${sep}
                <button type="button" class="link-button" onclick="handleAction('searchSelectionInReferences')" title="AI Proofreader: search selection in References">在 References 中搜索选中文本</button>
                ${groupSep}
                <button type="button" class="link-button" onclick="handleAction('managePrompts')" title="AI Proofreader: manage prompts">管理提示词</button>
                ${sep}
                <button type="button" class="link-button" onclick="handleAction('openSettings')" title="打开设置">打开设置</button>
            </div>
        `;
    }

    private tryReadSplitStats(logPath: string): { segmentCount: number } | null {
        try {
            const text = fs.readFileSync(logPath, 'utf8');
            const m = text.match(/切分片段数[：:]\s*(\d+)/);
            if (m) return { segmentCount: parseInt(m[1], 10) };
        } catch { /* ignore */ }
        return null;
    }

    private getBaseHtml(bodyContent: string, includeExtraStyles = false): string {
        const extraStyles = includeExtraStyles ? `
            .hint { font-size: 12px; color: #6B8E9A; margin: 8px 0; }
            .consistency-hint { font-style: italic; }
            .warning-box { padding: 10px; margin: 10px 0; background: #fff3cd; border: 1px solid #ffc107; border-radius: 4px; font-size: 13px; color: #856404; }
            .file-path-row--with-actions { flex-wrap: wrap; align-items: flex-start; }
            .file-path-row--with-actions .file-path { flex: 1 1 180px; min-width: 0; }
            .file-row-actions { flex: 0 0 auto; margin-left: 8px; }
            .action-button--compact { padding: 3px 8px; font-size: 11px; }
        ` : '';
        return `
            <!DOCTYPE html>
            <html lang="zh-CN">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Proofreading panel</title>
                <style>
                    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground);
                        background-color: var(--vscode-editor-background); padding: 16px; line-height: 1.4; }
                    .header { margin-bottom: 16px; padding-bottom: 12px; width: 100%; min-width: 0; box-sizing: border-box; }
                    .message { font-size: 15px; margin-bottom: 16px; color: #6B8E9A; font-weight: 500; }
                    .process-section { margin-bottom: 20px; padding: 16px; background-color: var(--vscode-editor-background);
                        border: 1px solid var(--vscode-panel-border); border-radius: 6px; }
                    .process-section h3 { margin-top: 0; margin-bottom: 12px; color: #5A7A85; font-size: 16px;
                        padding-bottom: 6px; }
                    .stats-section { margin-bottom: 12px; padding: 12px; background-color: #F8FAFB; border: 1px solid #E8F0F2; border-radius: 4px; }
                    .stats-inline { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; }
                    .stat-item { display: inline-flex; align-items: center; gap: 4px; font-size: 13px; }
                    .stat-value { color: #4A6B7A; font-weight: 600; }
                    .file-paths-compact { margin-bottom: 16px; padding: 12px; background-color: #F8FAFB; border: 1px solid #E8F0F2; border-radius: 4px; }
                    .file-path-row { margin-bottom: 6px; display: flex; align-items: center; font-size: 12px; }
                    .file-label { font-weight: 500; min-width: 100px; color: #6B8E9A; }
                    .file-path { color: #4A6B7A; font-family: var(--vscode-editor-font-family); font-size: 11px; word-break: break-all; margin-left: 8px; }
                    .section-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; padding-top: 12px;  }
                    .action-button { padding: 6px 12px; background-color: #8BACB8; color: white; border: none; border-radius: 4px;
                        cursor: pointer; font-size: 12px; transition: background-color 0.2s; font-weight: 500; }
                    .action-button:hover { background-color: #7A9BA8; }
                    .action-button:disabled { background-color: #B8C5CA; color: #8A9BA0; cursor: not-allowed; }
                    .panel-footer-commands { margin-top: 20px; padding-top: 14px; border-top: 1px solid var(--vscode-panel-border); width: 100%; min-width: 0; box-sizing: border-box; }
                    .header-commands-hint { font-size: 12px; color: #6B8E9A; margin: 0 0 6px 0; }
                    .header-actions { display: flex; flex-wrap: wrap; align-items: center; align-content: flex-start; gap: 4px 6px; row-gap: 8px; width: 100%; min-width: 0; box-sizing: border-box; margin: 0; padding: 0; font-size: 12px; color: #6B8E9A; }
                    .cmd-sep { color: var(--vscode-panel-border); flex: 0 0 auto; user-select: none; padding: 0 1px; }
                    .cmd-sep--between-groups { padding: 0 5px; letter-spacing: 0.05em; }
                    .link-button { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 12px; line-height: 1.4; padding: 1px 2px; text-decoration: underline; white-space: normal; text-align: left; max-width: 100%; }
                    ${extraStyles}
                    ${ProgressTracker.generateProgressBarCss()}
                </style>
            </head>
            <body>
                ${bodyContent}
                <script>
                    const vscode = acquireVsCodeApi();
                    function handleAction(action) { vscode.postMessage({ command: action }); }
                </script>
            </body>
            </html>
        `;
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

        const dictPrepJsonPath = splitResult.jsonFilePath
            ? FilePathUtils.getFilePath(splitResult.jsonFilePath, '.dictprep', '.json')
            : '';
        const dictPrepLogPath = splitResult.jsonFilePath
            ? FilePathUtils.getFilePath(splitResult.jsonFilePath, '.dictprep', '.log')
            : '';

        return `
            <div class="process-section">
                <h3>✂️ 切分结果</h3>
                ${statsHtml}
                <div class="file-paths-compact">
                    ${this.filePathRowWithOpenButtonIfExists('JSON:', splitResult.jsonFilePath, 'showSplitJson')}
                    ${this.filePathRowWithOpenButtonIfExists('JSON.md:', splitResult.markdownFilePath, 'showSplitJsonMd')}
                    ${this.filePathRowWithOpenButtonIfExists('切分日志:', splitResult.logFilePath, 'showSplitLog')}
                    ${this.filePathRowWithOpenButtonIfExists('查词过程:', dictPrepJsonPath, 'showDictPrepJson')}
                    ${this.filePathRowWithOpenButtonIfExists('查词日志:', dictPrepLogPath, 'showDictPrepLog')}
                </div>
                <div class="section-actions">
                    ${splitResult.originalFilePath && splitResult.markdownFilePath ? '<button class="action-button" onclick="handleAction(\'showSplitDiff\')">比较前后差异</button>' : ''}
                    ${splitResult.jsonFilePath ? '<button class="action-button" onclick="handleAction(\'mergeContext\')">合并 JSON</button>' : ''}
                    ${splitResult.jsonFilePath ? '<button class="action-button" onclick="handleAction(\'dictPrepLlmPlan\')" title="第一段：LLM 确定查询候选">LLM 生成查词计划</button>' : ''}
                    ${splitResult.jsonFilePath ? '<button class="action-button" onclick="handleAction(\'dictPrepLocalMerge\')" title="第二段：查询本地词典并写入 reference">查词并入 reference</button>' : ''}
                    ${splitResult.jsonFilePath ? '<button class="action-button" onclick="handleAction(\'proofreadJson\')">LLM 校对 JSON</button>' : ''}
                </div>
            </div>
        `;
    }

    /**
     * 生成校对结果板块 HTML（进度条嵌入其中，校对进行中即显示）
     */
    private generateProofreadSectionHtml(result: ProcessResult): string {
        if (!result.progressTracker && !result.proofreadResult) {
            return '';
        }
        const progressHtml = result.progressTracker ? result.progressTracker.generateProgressBarHtml() : '';
        const proofreadContent = result.proofreadResult ? this.generateProofreadResultContent(result.proofreadResult) : '';
        return `
            <div class="process-section">
                <h3>✏️ 校对结果</h3>
                ${progressHtml}
                ${proofreadContent}
            </div>
        `;
    }

    /**
     * 生成校对结果内容（文件列表与按钮，不含外框）
     */
    private generateProofreadResultContent(proofreadResult: ProofreadResult): string {
        const nullCount = getProofreadNullCount(proofreadResult.outputFilePath);
        const hasUnfinished = (nullCount ?? 0) > 0;
        return `
                ${hasUnfinished ? `
                <div class="warning-box">
                    ⚠️ 有 <strong>${nullCount}</strong> 条未完成校对（.proofread.json 中为 null）。重新校对时将只处理未完成的条目。
                </div>
                ` : ''}
                <div class="file-paths-compact">
                    ${proofreadResult.outputFilePath ? this.filePathRowWithOpenButton('JSON:', proofreadResult.outputFilePath, 'showProofreadJson') : ''}
                    ${proofreadResult.markdownFilePath ? this.filePathRowWithOpenButton('JSON.md:', proofreadResult.markdownFilePath, 'showProofreadJsonMd') : ''}
                    ${proofreadResult.logFilePath ? this.filePathRowWithOpenButton('校对日志:', proofreadResult.logFilePath, 'showProofreadLog') : ''}
                </div>
                <div class="section-actions">
                    ${proofreadResult.outputFilePath ? '<button class="action-button" onclick="handleAction(\'showProofreadItemsTree\')">查看校对条目</button>' : ''}
                    ${proofreadResult.originalFilePath && proofreadResult.markdownFilePath ? '<button class="action-button" onclick="handleAction(\'showProofreadDiff\')">比较前后差异</button>' : ''}
                    ${proofreadResult.outputFilePath ? '<button class="action-button" onclick="handleAction(\'generateDiff\')">生成差异文件</button>' : ''}
                    ${proofreadResult.originalFilePath && proofreadResult.markdownFilePath ? '<button class="action-button" onclick="handleAction(\'generateAlignment\')">生成勘误表</button>' : ''}
                </div>
        `;
    }

    /**
     * 生成主文件板块（用于完整结果时的固定布局）
     */
    private generateMainSectionForFullResult(result: ProcessResult): string {
        const mainPath =
            result.mainFilePath ??
            result.splitResult?.originalFilePath ??
            result.proofreadResult?.originalFilePath;
        if (!mainPath) return '';
        const comp = result.companionFiles || {};
        const hasJson = !!result.splitResult || !!comp.json;
        const jsonLen = comp.json ? getJsonArrayLength(comp.json) : undefined;
        const proofreadLen = comp.proofreadJson ? getJsonArrayLength(comp.proofreadJson) : undefined;
        const lengthMismatch = (jsonLen !== undefined && proofreadLen !== undefined && jsonLen !== proofreadLen);
        return `
            <div class="process-section">
                <h3>📄 主文件</h3>
                <div class="file-paths-compact">
                    <div class="file-path-row">
                        <span class="file-label">主文件:</span>
                        <span class="file-path">${this.getRelativePath(mainPath)}</span>
                    </div>
                </div>
                ${lengthMismatch ? `
                <div class="warning-box">
                    ⚠️ JSON 与 proofread.json 条目数不一致（${jsonLen} vs ${proofreadLen}），请检查或删除 proofread.json 后重新校对。
                </div>
                ` : ''}
                <div class="section-actions">
                    <button class="action-button" onclick="handleAction('selectMainFile')">更换主文件</button>
                    <button class="action-button" onclick="handleAction('formatParagraphsUseMainFile')" title="AI Proofreader: format paragraphs">整理段落</button>
                    <button class="action-button" onclick="handleAction('markTitlesFromTocUseMainFile')" title="AI Proofreader: mark titles from table of contents">根据目录标记标题</button>
                    <button class="action-button" onclick="handleAction('splitDocument')" title="AI Proofreader: split file">${hasJson ? '重新切分' : '切分文档'}</button>
                </div>
            </div>
        `;
    }

    /**
     * 生成完整的 Webview HTML（主文件、切分结果、校对结果 固定顺序）
     */
    private generateWebviewHtml(result: ProcessResult, mainSectionHtml: string, splitHtml: string, proofreadSectionHtml: string): string {
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
                        width: 100%;
                        min-width: 0;
                        box-sizing: border-box;
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
                    .file-path-row--with-actions { flex-wrap: wrap; align-items: flex-start; }
                    .file-path-row--with-actions .file-path { flex: 1 1 180px; min-width: 0; }
                    .file-row-actions { flex: 0 0 auto; margin-left: 8px; }
                    .action-button--compact { padding: 3px 8px; font-size: 11px; }
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
                    }
                    .actions {
                        display: flex;
                        flex-wrap: wrap;
                        gap: 8px;
                    }
                    .action-button {
                        padding: 6px 12px;
                        background-color: #8BACB8;
                        color: white;
                        border: none;
                        border-radius: 4px;
                        cursor: pointer;
                        font-size: 12px;
                        transition: background-color 0.2s;
                        font-weight: 500;
                    }
                    .action-button:hover {
                        background-color: #7A9BA8;
                    }
                    .action-button:disabled {
                        background-color: #B8C5CA;
                        color: #8A9BA0;
                        cursor: not-allowed;
                    }
                    .warning-box {
                        padding: 10px;
                        margin: 10px 0;
                        background: #fff3cd;
                        border: 1px solid #ffc107;
                        border-radius: 4px;
                        font-size: 13px;
                        color: #856404;
                    }
                    .panel-footer-commands { margin-top: 20px; padding-top: 14px; border-top: 1px solid var(--vscode-panel-border); width: 100%; min-width: 0; box-sizing: border-box; }
                    .header-commands-hint { font-size: 12px; color: #6B8E9A; margin: 0 0 6px 0; }
                    .header-actions { display: flex; flex-wrap: wrap; align-items: center; align-content: flex-start; gap: 4px 6px; row-gap: 8px; width: 100%; min-width: 0; box-sizing: border-box; margin: 0; padding: 0; font-size: 12px; color: #6B8E9A; }
                    .cmd-sep { color: var(--vscode-panel-border); flex: 0 0 auto; user-select: none; padding: 0 1px; }
                    .cmd-sep--between-groups { padding: 0 5px; letter-spacing: 0.05em; }
                    .link-button { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 12px; line-height: 1.4; padding: 1px 2px; text-decoration: underline; white-space: normal; text-align: left; max-width: 100%; }

                    ${ProgressTracker.generateProgressBarCss()}
                </style>
            </head>
            <body>
                <div class="header">
                    <div class="message">${result.message}</div>
                </div>

                ${mainSectionHtml}
                ${splitHtml}
                ${proofreadSectionHtml}

                <div class="panel-footer-commands">
                    ${this.getHeaderQuickActionsHtml()}
                </div>

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

    /**
     * 处理句子对齐（生成勘误表）
     */
    private async handleSentenceAlignment(fileA: string, fileB: string, context: vscode.ExtensionContext): Promise<void> {
        try {
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

            // 让用户选择相似度计算时是否忽略句中空白字符
            const removeInnerWhitespaceChoice = await vscode.window.showQuickPick(
                [
                    { label: '是（默认）', description: '忽略句中空白，仅用字面比较', value: true },
                    { label: '否', description: '保留句中空白参与比较', value: false }
                ],
                {
                    placeHolder: '相似度计算时是否忽略句中空白字符？',
                    title: '句中空白',
                    ignoreFocusOut: true
                }
            );
            const removeInnerWhitespace = removeInnerWhitespaceChoice?.value ?? true;

            const collectWordErrorsChoice = await vscode.window.showQuickPick(
                [
                    { label: '否', description: '仅生成勘误表（默认）', value: false },
                    { label: '是', description: '同时收集常用词语错误', value: true }
                ],
                {
                    placeHolder: '是否同时收集常用词语错误？',
                    title: '常用词语错误',
                    ignoreFocusOut: true
                }
            );
            const shouldCollectWordErrors = collectWordErrorsChoice?.value ?? false;

            const citationConfig = vscode.workspace.getConfiguration('ai-proofread.citation');
            const ngramGranularity = config.get<'word' | 'char'>('ngramGranularity', 'word');
            let jieba: import('../jiebaLoader').JiebaWasmModule | undefined;
            if (ngramGranularity === 'word' || shouldCollectWordErrors) {
                try {
                    const customDictPath = vscode.workspace.getConfiguration('ai-proofread.jieba').get<string>('customDictPath', '');
                    jieba = getJiebaWasm(path.join(context.extensionPath, 'dist'), customDictPath || undefined);
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    vscode.window.showErrorMessage(`jieba 加载失败，${shouldCollectWordErrors ? '词语错误收集需要 jieba；' : ''}${ngramGranularity === 'word' ? '当前配置为词级相似度，需要 jieba；' : ''}已中止：${msg}`);
                    return;
                }
            }
            const options: AlignmentOptions = {
                windowSize: config.get<number>('windowSize', 10),
                similarityThreshold: similarityThreshold,
                ngramSize: config.get<number>('ngramSize', 1),
                ngramGranularity: jieba ? 'word' : 'char',
                cutMode: vscode.workspace.getConfiguration('ai-proofread.jieba').get<'default' | 'search'>('cutMode', 'default'),
                jieba,
                offset: config.get<number>('offset', 1),
                maxWindowExpansion: config.get<number>('maxWindowExpansion', 3),
                consecutiveFailThreshold: config.get<number>('consecutiveFailThreshold', 3),
                removeInnerWhitespace,
                removePunctuation: citationConfig.get<boolean>('normalizeIgnorePunctuation', false),
                removeDigits: config.get<boolean>('normalizeIgnoreDigits', false),
                removeLatin: config.get<boolean>('normalizeIgnoreLatin', false)
            };

            // 显示进度
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: '正在生成勘误表...',
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

                let wordErrorsMessage = '';
                if (shouldCollectWordErrors && jieba) {
                    progress.report({ increment: 95, message: '收集词语错误...' });
                    const weConfig = vscode.workspace.getConfiguration('ai-proofread.wordErrorCollector');
                    const delimitersStr = weConfig.get<string>('delimiters', '，；。？！');
                    const delimiters = parseDelimitersFromConfig(delimitersStr);
                    const clauseThreshold = weConfig.get<number>('clauseSimilarityThreshold', 0.4);
                    const cutMode = vscode.workspace.getConfiguration('ai-proofread.jieba').get<'default' | 'search'>('cutMode', 'default');
                    const entries = collectWordErrors(alignment, {
                        jieba,
                        cutMode,
                        delimiters,
                        clauseSimilarityThreshold: clauseThreshold
                    });
                    const wordErrorsPath = FilePathUtils.getFilePath(fileA, '.word-errors', '.csv');
                    fs.writeFileSync(wordErrorsPath, formatWordErrors(entries), 'utf8');
                    wordErrorsMessage = `\n词语错误已保存至: ${path.basename(wordErrorsPath)}（${entries.length} 条）`;
                }

                progress.report({ increment: 100, message: '完成' });

                // 显示统计信息
                const statsMessage = `勘误表生成完成！\n` +
                    `总计: ${stats.total}\n` +
                    `匹配: ${stats.match}\n` +
                    `删除: ${stats.delete}\n` +
                    `新增: ${stats.insert}\n` +
                    `移出: ${stats.moveout}\n` +
                    `移入: ${stats.movein}`;

                vscode.window.showInformationMessage(statsMessage + `\n报告已保存至: ${path.basename(outputFile)}` + wordErrorsMessage);
            });

        } catch (error) {
            ErrorUtils.showError(error, '生成勘误表时出错：');
        }
    }
}
