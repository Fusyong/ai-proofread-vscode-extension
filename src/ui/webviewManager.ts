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
import { proofreadJsonPathToSegmentsJsonPath, segmentsJsonPathToSplitMarkdownPath } from '../proofreadSplitLayout';
import { focusWorkingTextEditor } from './lastActiveTextEditor';
import { setProofreadItemsVisible } from './sidebarViewVisibility';
import { commandHoverTitle } from './commandHover';

// 接口定义
/** 配套文档检测结果 */
export interface CompanionFiles {
    json: string;
    jsonMd: string;
    log: string;
    /** 由切分 JSON 派生：basename.dictprep.json（旧版） */
    dictPrepJson: string;
    dictPrepLog: string;
    referencePrepJson: string;
    referencePrepLog: string;
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
        'referencePrepJson',
        'referencePrepLog',
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
        referencePrepJson: path.join(dir, `${base}.referenceprep.json`),
        referencePrepLog: path.join(dir, `${base}.referenceprep.log`),
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
                : '整理当前文档，或选择主文件后切分、校对。',
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

    private getReferencePrepJsonPath(): string | undefined {
        const j = this.getSplitJsonPath();
        return j ? FilePathUtils.getFilePath(j, '.referenceprep', '.json') : undefined;
    }

    private getReferencePrepLogPath(): string | undefined {
        const j = this.getSplitJsonPath();
        return j ? FilePathUtils.getFilePath(j, '.referenceprep', '.log') : undefined;
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

        /** 依赖当前编辑器/选区的命令：先把最近活动编辑器重新激活，避免 Webview 获焦后 activeTextEditor 为空 */
        const runWithWorkingEditor = async (cmd: string): Promise<void> => {
            const ed = await focusWorkingTextEditor();
            if (!ed) {
                vscode.window.showWarningMessage('请先打开目标文档，再使用此按钮（焦点可留在校对面板上）。');
                return;
            }
            await vscode.commands.executeCommand(cmd);
        };

        try {
            switch (command) {
                case 'showMainFile': {
                    const mainPath = this.mainFilePath ?? this.getMainFilePath();
                    if (!mainPath) {
                        vscode.window.showWarningMessage('请先选择主文件');
                        break;
                    }
                    const doc = await vscode.workspace.openTextDocument(mainPath);
                    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
                    break;
                }
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
                case 'markTitlesFromToc':
                case 'alignHeadings': {
                    const cmd =
                        command === 'formatParagraphs'
                            ? 'ai-proofread.formatParagraphs'
                            : command === 'markTitlesFromToc'
                              ? 'ai-proofread.markTitlesFromToc'
                              : 'ai-proofread.alignHeadings';
                    await runWithWorkingEditor(cmd);
                    break;
                }
                case 'formatParagraphsUseMainFile':
                case 'markTitlesFromTocUseMainFile':
                case 'alignHeadingsUseMainFile': {
                    // 主文件板块：使用主文件
                    const mainPath = this.mainFilePath ?? this.getMainFilePath();
                    if (!mainPath) {
                        vscode.window.showWarningMessage('请先选择主文件');
                        break;
                    }
                    const doc = await vscode.workspace.openTextDocument(mainPath);
                    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
                    await vscode.commands.executeCommand(
                        command === 'formatParagraphsUseMainFile'
                            ? 'ai-proofread.formatParagraphs'
                            : command === 'markTitlesFromTocUseMainFile'
                              ? 'ai-proofread.markTitlesFromToc'
                              : 'ai-proofread.alignHeadings'
                    );
                    break;
                }
                case 'proofreadSelection':
                    await runWithWorkingEditor('ai-proofread.proofreadSelection');
                    break;
                case 'proofreadSelectionWithMemory':
                    await runWithWorkingEditor('ai-proofread.proofreadSelectionWithMemory');
                    break;
                case 'convertDocxToMarkdown':
                    await vscode.commands.executeCommand('ai-proofread.convertDocxToMarkdown');
                    break;
                case 'convertPdfToMarkdown':
                    await vscode.commands.executeCommand('ai-proofread.convertPdfToMarkdown');
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
                case 'referencePrepJson': {
                    const jsonPath = this.getSplitJsonPath();
                    if (!jsonPath) {
                        vscode.window.showWarningMessage('请先完成切分，或未找到 JSON 文件。');
                        break;
                    }
                    const outputUri = vscode.Uri.file(jsonPath);
                    const splitDoc = await vscode.workspace.openTextDocument(outputUri);
                    await vscode.window.showTextDocument(splitDoc, { viewColumn: vscode.ViewColumn.Beside });
                    await vscode.commands.executeCommand('ai-proofread.referencePrep.openConsole');
                    break;
                }
                case 'showReferencePrepJson': {
                    const p = this.getReferencePrepJsonPath();
                    if (p && fs.existsSync(p)) {
                        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(p));
                        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
                    } else {
                        vscode.window.showInformationMessage('尚未生成 .referenceprep.json（需先执行「准备参考资料」）。');
                    }
                    break;
                }
                case 'showReferencePrepLog': {
                    const p = this.getReferencePrepLogPath();
                    if (p && fs.existsSync(p)) {
                        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(p));
                        const ed = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
                        const lastLine = doc.lineCount - 1;
                        const lastLen = doc.lineAt(lastLine).text.length;
                        const end = new vscode.Position(lastLine, lastLen);
                        ed.selection = new vscode.Selection(end, end);
                        ed.revealRange(new vscode.Range(end, end), vscode.TextEditorRevealType.InCenter);
                    } else {
                        vscode.window.showInformationMessage('尚未生成 .referenceprep.log。');
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
                    await runWithWorkingEditor('ai-proofread.convertMarkdownToDocx');
                    break;
                }
                case 'convertQuotes': {
                    await runWithWorkingEditor('ai-proofread.convertQuotes');
                    break;
                }
                case 'halfToFullPunctuation': {
                    await runWithWorkingEditor('ai-proofread.halfToFullPunctuation');
                    break;
                }
                case 'fullToHalfPunctuation': {
                    await runWithWorkingEditor('ai-proofread.fullToHalfPunctuation');
                    break;
                }
                case 'deleteInlineWhitespace': {
                    await runWithWorkingEditor('ai-proofread.deleteInlineWhitespace');
                    break;
                }
                case 'opencc': {
                    await runWithWorkingEditor('ai-proofread.opencc');
                    break;
                }
                case 'replaceFounderCircledNumbers': {
                    await runWithWorkingEditor('ai-proofread.replaceFounderCircledNumbers');
                    break;
                }
                case 'citationOpenView':
                    await vscode.commands.executeCommand('ai-proofread.citation.openView');
                    break;
                case 'citationVerifySelection':
                    await runWithWorkingEditor('ai-proofread.citation.verifySelection');
                    break;
                case 'checkWords': {
                    await runWithWorkingEditor('ai-proofread.checkWords');
                    break;
                }
                case 'splitIntoSentences':
                case 'segmentFile':
                case 'diffItWithAnotherFile':
                case 'duplicateScanDocument':
                case 'duplicateScanSelection':
                case 'numberingCheck':
                case 'numberingCheckTitles':
                case 'numberingCheckSegments': {
                    const cmdMap: Record<string, string> = {
                        splitIntoSentences: 'ai-proofread.splitIntoSentences',
                        segmentFile: 'ai-proofread.segmentFile',
                        diffItWithAnotherFile: 'ai-proofread.diffItWithAnotherFile',
                        duplicateScanDocument: 'ai-proofread.duplicate.scanDocument',
                        duplicateScanSelection: 'ai-proofread.duplicate.scanSelection',
                        numberingCheck: 'ai-proofread.numbering.check',
                        numberingCheckTitles: 'ai-proofread.numbering.checkTitles',
                        numberingCheckSegments: 'ai-proofread.numbering.checkSegments'
                    };
                    await runWithWorkingEditor(cmdMap[command]);
                    break;
                }
                case 'citationRebuildIndex':
                    await vscode.commands.executeCommand('ai-proofread.citation.rebuildIndex');
                    break;
                case 'manageCustomTables':
                    await vscode.commands.executeCommand('ai-proofread.manageCustomTables');
                    break;
                case 'showProofreadItemsTree': {
                    const proofreadJsonPath = this.getProofreadJsonPath();
                    const segJson = proofreadJsonPath ? proofreadJsonPathToSegmentsJsonPath(proofreadJsonPath) : undefined;
                    const splitMdPath = segJson ? segmentsJsonPathToSplitMarkdownPath(segJson) : undefined;
                    if (splitMdPath && fs.existsSync(splitMdPath)) {
                        const mdUri = vscode.Uri.file(splitMdPath);
                        const doc = await vscode.workspace.openTextDocument(mdUri);
                        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
                    }
                    await setProofreadItemsVisible(true);
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
     * 生成完整 HTML：文档整理 → 切分与合并（含主文件）→ 校对结果 → 专项检查
     */
    private generateFullHtml(result: ProcessResult, context?: vscode.ExtensionContext): string {
        return this.getBaseHtml(`
            <div class="header">
                <div class="message">${result.message}</div>
            </div>
            ${this.generateDocumentPrepHtml()}
            ${this.generateSplitSectionHtml(result)}
            ${this.generateProofreadSectionHtml(result)}
            ${this.generateSpecialChecksHtml()}
            <div class="panel-footer-commands">
                ${this.generatePanelFooterHtml()}
            </div>
        `, true);
    }

    private readonly buttonGroupSep = '<span class="cmd-sep cmd-sep--between-groups" aria-hidden="true">||</span>';

    /** 文档整理：作用于当前编辑窗口 */
    private generateDocumentPrepHtml(): string {
        const sep = this.buttonGroupSep;
        return `
            <div class="process-section">
                <h3>📄 文档整理</h3>
                <p class="hint">作用于当前编辑窗口中的文档。请先打开稿件，再点下方按钮（焦点可留在本面板）。</p>
                <div class="section-actions">
                    <button class="action-button" onclick="handleAction('convertDocxToMarkdown')" title="${commandHoverTitle('将 Word 转为 Markdown', 'ai-proofread.convertDocxToMarkdown')}">docx → Markdown</button>
                    <button class="action-button" onclick="handleAction('convertPdfToMarkdown')" title="${commandHoverTitle('将 PDF 转为 Markdown', 'ai-proofread.convertPdfToMarkdown')}">PDF → Markdown</button>
                    <button class="action-button" onclick="handleAction('convertMarkdownToDocx')" title="${commandHoverTitle('将 Markdown 转为 Word', 'ai-proofread.convertMarkdownToDocx')}">Markdown → docx</button>
                    ${sep}
                    <button class="action-button" onclick="handleAction('formatParagraphs')" title="${commandHoverTitle('整理段落', 'ai-proofread.formatParagraphs')}">整理段落</button>
                    <button class="action-button" onclick="handleAction('deleteInlineWhitespace')" title="${commandHoverTitle('删除行中空白', 'ai-proofread.deleteInlineWhitespace')}">删除行中空白</button>
                    ${sep}
                    <button class="action-button" onclick="handleAction('convertQuotes')" title="${commandHoverTitle('半角引号转全角', 'ai-proofread.convertQuotes')}">半角引号转全角</button>
                    <button class="action-button" onclick="handleAction('halfToFullPunctuation')" title="${commandHoverTitle('半角 ,;:!? 转为 ，；：！？', 'ai-proofread.halfToFullPunctuation')}">半角标点转全角</button>
                    <button class="action-button" onclick="handleAction('fullToHalfPunctuation')" title="${commandHoverTitle('全角 ，；：！？ 转为 ,;:!?', 'ai-proofread.fullToHalfPunctuation')}">全角标点转半角</button>
                    <button class="action-button" onclick="handleAction('opencc')" title="${commandHoverTitle('繁简 / 地区用字转换', 'ai-proofread.opencc')}">繁简转换</button>
                    <button class="action-button" onclick="handleAction('replaceFounderCircledNumbers')" title="${commandHoverTitle('方正书版带圈序号转为 Unicode 或 [n]', 'ai-proofread.replaceFounderCircledNumbers')}">方正带圈序号</button>
                    ${sep}
                    <button class="action-button" onclick="handleAction('markTitlesFromToc')" title="${commandHoverTitle('根据目录标记标题', 'ai-proofread.markTitlesFromToc')}">根据目录标记标题</button>
                    <button class="action-button" onclick="handleAction('alignHeadings')" title="${commandHoverTitle('请先并排打开两个文件，再检查标题是否一致', 'ai-proofread.alignHeadings')}">对齐标题</button>
                    ${sep}
                    <button class="action-button" onclick="handleAction('splitIntoSentences')" title="${commandHoverTitle('切分为句子', 'ai-proofread.splitIntoSentences')}">切分为句子</button>
                    <button class="action-button" onclick="handleAction('segmentFile')" title="${commandHoverTitle('分词、词频与字频统计', 'ai-proofread.segmentFile')}">分词与统计</button>
                    <button class="action-button" onclick="handleAction('diffItWithAnotherFile')" title="${commandHoverTitle('与另一文件比较差异', 'ai-proofread.diffItWithAnotherFile')}">与另一文件比较</button>
                </div>
            </div>
        `;
    }

    /** 切分与合并：上部选主文件；有 JSON 后再露出配套文件与合并/检索/校对 */
    private generateSplitSectionHtml(result: ProcessResult): string {
        const mainPath =
            result.mainFilePath ??
            result.splitResult?.originalFilePath ??
            result.proofreadResult?.originalFilePath ??
            this.mainFilePath;
        const comp = this.resolveCompanionFiles(result);
        const split = result.splitResult;
        const hasJson = !!split || !!comp.json;
        const jsonPath = split?.jsonFilePath ?? comp.json;
        const jsonMdPath = split?.markdownFilePath ?? comp.jsonMd;
        const logPath = split?.logFilePath ?? comp.log;
        const jsonLen = jsonPath ? getJsonArrayLength(jsonPath) : undefined;
        const proofreadLen = comp.proofreadJson ? getJsonArrayLength(comp.proofreadJson) : undefined;
        const lengthMismatch = jsonLen !== undefined && proofreadLen !== undefined && jsonLen !== proofreadLen;
        const stats = split?.stats
            ? split.stats
            : logPath
                ? this.tryReadSplitStats(logPath)
                : null;
        const referencePrepJsonPath = jsonPath
            ? FilePathUtils.getFilePath(jsonPath, '.referenceprep', '.json')
            : '';
        const referencePrepLogPath = jsonPath
            ? FilePathUtils.getFilePath(jsonPath, '.referenceprep', '.log')
            : '';

        const mainFileBlock = mainPath
            ? `<div class="file-paths-compact">
                    ${this.filePathRowWithOpenButton('主文件:', mainPath, 'showMainFile')}
                </div>`
            : `<p class="hint">尚未选择主文件。切分、合并 JSON、校对 JSON 需要先选定主稿。</p>`;

        const companionBlock = hasJson && jsonPath
            ? `
                ${stats ? `<div class="stats-section"><div class="stats-inline">
                    <span class="stat-item">切分片段数: <span class="stat-value">${'segmentCount' in stats ? stats.segmentCount : ''}</span></span>
                    ${'maxSegmentLength' in stats && stats.maxSegmentLength != null ? `<span class="stat-item">最长: <span class="stat-value">${stats.maxSegmentLength}</span></span>` : ''}
                    ${'minSegmentLength' in stats && stats.minSegmentLength != null ? `<span class="stat-item">最短: <span class="stat-value">${stats.minSegmentLength}</span></span>` : ''}
                </div></div>` : ''}
                <div class="file-paths-compact">
                    ${this.filePathRowWithOpenButtonIfExists('JSON:', jsonPath, 'showSplitJson')}
                    ${jsonMdPath ? this.filePathRowWithOpenButtonIfExists('JSON.md:', jsonMdPath, 'showSplitJsonMd') : ''}
                    ${logPath ? this.filePathRowWithOpenButtonIfExists('切分日志:', logPath, 'showSplitLog') : ''}
                    ${this.filePathRowWithOpenButtonIfExists('参考资料过程:', referencePrepJsonPath, 'showReferencePrepJson')}
                    ${this.filePathRowWithOpenButtonIfExists('参考资料日志:', referencePrepLogPath, 'showReferencePrepLog')}
                </div>
                <div class="section-actions">
                    ${mainPath && jsonMdPath ? '<button class="action-button" onclick="handleAction(\'showSplitDiff\')">比较前后差异</button>' : ''}
                    <button class="action-button" onclick="handleAction('mergeContext')" title="${commandHoverTitle('合并 JSON', 'ai-proofread.mergeTwoFiles')}">合并 JSON</button>
                    <button class="action-button" onclick="handleAction('referencePrepJson')" title="${commandHoverTitle('打开切分 JSON 并打开检索面板', 'ai-proofread.prepareReferencesJson')}">准备参考资料</button>
                    <button class="action-button" onclick="handleAction('proofreadJson')" title="${commandHoverTitle('LLM 校对 JSON', 'ai-proofread.proofreadFile')}">LLM 校对 JSON</button>
                </div>`
            : '';

        return `
            <div class="process-section">
                <h3>✂️ 切分与合并</h3>
                ${mainFileBlock}
                ${lengthMismatch ? `
                <div class="warning-box">
                    ⚠️ JSON 与 proofread.json 条目数不一致（${jsonLen} vs ${proofreadLen}），请检查或删除 proofread.json 后重新校对。
                </div>
                ` : ''}
                <div class="section-actions section-actions--between">
                    <button class="action-button" onclick="handleAction('selectMainFile')">${mainPath ? '更换主文件' : '选择主文件'}</button>
                    <button class="action-button" onclick="handleAction('selectMainFileFromWorkspace')">从工作区选择</button>
                    <button class="action-button" onclick="handleAction('splitDocument')" title="${commandHoverTitle('切分文档', 'ai-proofread.splitFile')}"${mainPath ? '' : ' disabled'}>${hasJson ? '重新切分' : '切分文档'}</button>
                </div>
                ${companionBlock}
            </div>
        `;
    }

    /** 专项检查：结果进入左侧对应列表 */
    private generateSpecialChecksHtml(): string {
        const sep = this.buttonGroupSep;
        return `
            <div class="process-section">
                <h3>🔍 专项检查</h3>
                <p class="hint">作用于当前编辑窗口。某些结果列表会出现在左侧栏。</p>
                <div class="section-actions">
                    <button class="action-button" onclick="handleAction('checkWords')" title="${commandHoverTitle('字词检查', 'ai-proofread.checkWords')}">字词检查</button>
                    <button class="action-button" onclick="handleAction('manageCustomTables')" title="${commandHoverTitle('管理自定义替换表', 'ai-proofread.manageCustomTables')}">管理替换表</button>
                    ${sep}
                    <button class="action-button" onclick="handleAction('numberingCheckTitles')" title="${commandHoverTitle('检查标题树', 'ai-proofread.numbering.checkTitles')}">检查标题树</button>
                    <button class="action-button" onclick="handleAction('numberingCheckSegments')" title="${commandHoverTitle('检查段内序号', 'ai-proofread.numbering.checkSegments')}">检查段内序号</button>
                    ${sep}
                    <button class="action-button" onclick="handleAction('alignHeadings')" title="${commandHoverTitle('请先并排打开两个文件，再检查标题是否一致', 'ai-proofread.alignHeadings')}">对齐标题</button>
                    ${sep}
                    <button class="action-button" onclick="handleAction('duplicateScanDocument')" title="${commandHoverTitle('扫描全文重复句', 'ai-proofread.duplicate.scanDocument')}">重复句扫描</button>
                    <button class="action-button" onclick="handleAction('duplicateScanSelection')" title="${commandHoverTitle('扫描选区重复句', 'ai-proofread.duplicate.scanSelection')}">重复句扫描（选区）</button>
                    ${sep}
                    <button class="action-button" onclick="handleAction('citationOpenView')" title="${commandHoverTitle('核对全文引文', 'ai-proofread.citation.openView')}">核对全文引文</button>
                    <button class="action-button" onclick="handleAction('citationVerifySelection')" title="${commandHoverTitle('对选中文本做与全文相同的相似度核对（去掉行首 >）', 'ai-proofread.citation.verifySelection')}">核对选中引文</button>
                </div>
            </div>
        `;
    }

    /** 底部仅保留选段校对 */
    private generatePanelFooterHtml(): string {
        const sep = '<span class="cmd-sep" aria-hidden="true">|</span>';
        return `
            <p class="header-commands-hint">选段校对</p>
            <div class="header-actions">
                <button type="button" class="link-button" onclick="handleAction('proofreadSelection')" title="${commandHoverTitle('校对选中文本', 'ai-proofread.proofreadSelection')}">校对选中文本</button>
                ${sep}
                <button type="button" class="link-button" onclick="handleAction('proofreadSelectionWithMemory')" title="${commandHoverTitle('校对选中（带编辑记忆）', 'ai-proofread.proofreadSelectionWithMemory')}">校对选中（带编辑记忆）</button>
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
            .hint { font-size: 12px; color: #6B8E9A; margin: 2px 0 4px; line-height: 1.3; }
            .consistency-hint { font-style: italic; }
            .warning-box { padding: 6px 8px; margin: 6px 0; background: #fff3cd; border: 1px solid #ffc107; border-radius: 4px; font-size: 12px; color: #856404; line-height: 1.3; }
            .file-path-row--with-actions { flex-wrap: wrap; align-items: center; }
            .file-path-row--with-actions .file-path { flex: 1 1 180px; min-width: 0; }
            .file-row-actions { flex: 0 0 auto; margin-left: 8px; }
            .action-button--compact { padding: 3px 7px; font-size: 11px; line-height: 1; }
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
                        background-color: var(--vscode-editor-background); padding: 10px 12px; line-height: 1.3; }
                    .header { margin-bottom: 8px; padding-bottom: 0; width: 100%; min-width: 0; box-sizing: border-box; }
                    .message { font-size: 14px; margin: 0; color: #6B8E9A; font-weight: 500; line-height: 1.3; }
                    .process-section { margin-bottom: 8px; padding: 8px 10px; background-color: var(--vscode-editor-background);
                        border: 1px solid var(--vscode-panel-border); border-radius: 5px; }
                    .process-section:last-of-type { margin-bottom: 0; }
                    .process-section h3 { margin: 0 0 4px; color: #5A7A85; font-size: 14px; line-height: 1.3;
                        padding-bottom: 0; }
                    .stats-section { display: flex; margin-bottom: 6px; padding: 6px 8px; background-color: #F8FAFB; border: 1px solid #E8F0F2; border-radius: 4px; }
                    .stats-inline { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; }
                    .stat-item { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; }
                    .stat-value { color: #4A6B7A; font-weight: 600; }
                    .file-paths-compact { display: flex; flex-direction: column; gap: 2px; margin-bottom: 6px; padding: 6px 8px; background-color: #F8FAFB; border: 1px solid #E8F0F2; border-radius: 4px; }
                    .file-path-row { display: flex; align-items: center; font-size: 12px; line-height: 1.3; }
                    .file-label { font-weight: 500; min-width: 100px; color: #6B8E9A; }
                    .file-path { color: #4A6B7A; font-family: var(--vscode-editor-font-family); font-size: 11px; word-break: break-all; margin-left: 8px; }
                    .section-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; padding-top: 0; align-items: center; }
                    .section-actions--between { margin-top: 4px; margin-bottom: 6px; padding-top: 0; padding-bottom: 0; }
                    .action-button { display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box;
                        margin: 0; padding: 4px 10px; background-color: #8BACB8; color: white; border: none; border-radius: 4px;
                        cursor: pointer; font-family: inherit; font-size: 12px; line-height: 1; font-weight: 500;
                        transition: background-color 0.2s; }
                    .action-button:hover { background-color: #7A9BA8; }
                    .action-button:disabled { background-color: #B8C5CA; color: #8A9BA0; cursor: not-allowed; }
                    .panel-footer-commands { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--vscode-panel-border); width: 100%; min-width: 0; box-sizing: border-box; }
                    .header-commands-hint { font-size: 12px; color: #6B8E9A; margin: 0 0 4px 0; line-height: 1.3; }
                    .header-actions { display: flex; flex-wrap: wrap; align-items: center; align-content: flex-start; gap: 2px 6px; row-gap: 4px; width: 100%; min-width: 0; box-sizing: border-box; margin: 0; padding: 0; font-size: 12px; color: #6B8E9A; }
                    .cmd-sep { color: var(--vscode-panel-border); flex: 0 0 auto; user-select: none; padding: 0 1px; }
                    .cmd-sep--between-groups { padding: 0 2px; letter-spacing: 0.08em; color: #6B8E9A; }
                    .link-button { display: inline-flex; align-items: center; background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; font-family: inherit; font-size: 12px; line-height: 1; padding: 2px; text-decoration: underline; white-space: normal; text-align: left; max-width: 100%; }
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
     * 按主文件扫描磁盘上的配套文档（切分 JSON、校对结果等）
     */
    private resolveCompanionFiles(result: ProcessResult): Partial<CompanionFiles> {
        const main =
            result.mainFilePath ??
            result.splitResult?.originalFilePath ??
            result.proofreadResult?.originalFilePath ??
            this.mainFilePath;
        const detected = main ? detectCompanionFiles(main) : {};
        return { ...result.companionFiles, ...detected };
    }

    /** 当前应展示的校对结果：内存中的本次校对，或磁盘上已有的配套文件 */
    private resolveProofreadResult(result: ProcessResult): ProofreadResult | undefined {
        if (result.proofreadResult) {
            return result.proofreadResult;
        }
        const comp = this.resolveCompanionFiles(result);
        if (!comp.proofreadJson) {
            return undefined;
        }
        const main =
            result.mainFilePath ??
            result.splitResult?.originalFilePath ??
            this.mainFilePath ??
            '';
        return {
            outputFilePath: comp.proofreadJson,
            markdownFilePath: comp.proofreadJsonMd ?? '',
            logFilePath: comp.proofreadLog ?? '',
            originalFilePath: main,
            stats: { totalCount: 0, processedCount: 0, processedLength: 0, totalLength: 0 },
        };
    }

    /**
     * 生成校对结果板块 HTML（进度条嵌入其中，校对进行中即显示）
     */
    private generateProofreadSectionHtml(result: ProcessResult): string {
        const proofreadResult = this.resolveProofreadResult(result);
        if (!result.progressTracker && !proofreadResult) {
            return '';
        }
        const progressHtml = result.progressTracker ? result.progressTracker.generateProgressBarHtml() : '';
        const proofreadContent = proofreadResult ? this.generateProofreadResultContent(proofreadResult) : '';
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
        const nullCount = proofreadResult.outputFilePath
            ? getProofreadNullCount(proofreadResult.outputFilePath)
            : undefined;
        const hasUnfinished = (nullCount ?? 0) > 0;
        const hasMd = !!proofreadResult.markdownFilePath;
        const hasMain = !!proofreadResult.originalFilePath;
        return `
                ${hasUnfinished ? `
                <div class="warning-box">
                    ⚠️ 有 <strong>${nullCount}</strong> 条未完成校对（.proofread.json 中为 null）。重新校对时将只处理未完成的条目。
                </div>
                ` : ''}
                <div class="file-paths-compact">
                    ${this.filePathRowWithOpenButtonIfExists('JSON:', proofreadResult.outputFilePath, 'showProofreadJson')}
                    ${this.filePathRowWithOpenButtonIfExists('JSON.md:', proofreadResult.markdownFilePath, 'showProofreadJsonMd')}
                    ${this.filePathRowWithOpenButtonIfExists('校对日志:', proofreadResult.logFilePath, 'showProofreadLog')}
                </div>
                <div class="section-actions">
                    ${proofreadResult.outputFilePath ? `<button class="action-button" onclick="handleAction('showProofreadItemsTree')" title="${commandHoverTitle('查看校对条目', 'ai-proofread.showProofreadItemsTree')}">查看校对条目</button>` : ''}
                    ${hasMain && hasMd ? '<button class="action-button" onclick="handleAction(\'showProofreadDiff\')">比较前后差异</button>' : ''}
                    ${proofreadResult.outputFilePath ? '<button class="action-button" onclick="handleAction(\'generateDiff\')">生成差异文件</button>' : ''}
                    ${hasMain && hasMd ? '<button class="action-button" onclick="handleAction(\'generateAlignment\')">生成勘误表</button>' : ''}
                </div>
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
