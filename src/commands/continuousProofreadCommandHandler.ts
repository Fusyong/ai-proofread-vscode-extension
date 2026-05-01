/**
 * 持续发现与监督校对命令处理器
 * 从当前位置取段 → 校对 → diff 复核 → 接受写回 → 更新 editorial-memory → 继续
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { proofreadSelection } from '../proofreader';
import { isUsingSystemDefaultPrompt, pickSourceTextCharacteristicsInjection } from '../sourceTextCharacteristicsPicker';
import { TempFileManager, FilePathUtils, ErrorUtils, ConfigManager } from '../utils';
import type { ProofreadItem } from '../itemOutputParser';
import { getSegmentFromPositionWithMode } from '../splitter';
import { runEditorialMemoryAfterAccept } from '../editorialMemory/service';

interface ContinuousProofreadConfig {
    platform: string;
    model: string;
    temperature: number;
    contextLevel: string;
    beforeParagraphs: number;
    afterParagraphs: number;
    repetitionMode: 'none' | 'target' | 'all';
    /** 系统默认提示词时注入的源文本特性提示词正文；空字符串表示不注入 */
    sourceTextCharacteristics?: string;
    /** 注入项在通知/日志中的标题（预设名或「本次临时输入」等） */
    sourceTextCharacteristicsTitle?: string;
    splitMode: 'length' | 'title';
    splitCutBy: number;
    splitLevels: number[];
}

export class ContinuousProofreadCommandHandler {
    private configManager = ConfigManager.getInstance();
    private statusBarItem: vscode.StatusBarItem;
    private extensionContext: vscode.ExtensionContext | undefined; // 用于终止时清除配置
    constructor() {
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
    }
    private session: {
        config: ContinuousProofreadConfig;
        documentUri: vscode.Uri;
        startOffset: number;
        segmentIndex: number;
        proofreadUri: vscode.Uri | undefined;
        currentSegmentEndOffset: number | undefined;
        diffCloseListener: vscode.Disposable | undefined;
        currentSegmentItems: ProofreadItem[] | undefined;
        /** 本段模型输出原文（未含用户在 diff 右侧手改） */
        lastProofreadModelText: string | undefined;
    } | null = null;

    dispose(): void {
        this.statusBarItem.dispose();
    }

    private updateStatusBar(text: string, clickToStop: boolean = false): void {
        this.statusBarItem.text = text;
        this.statusBarItem.tooltip = clickToStop ? '点击停止 | Alt+Enter 接受 | 关闭 diff 可提示选择' : undefined;
        this.statusBarItem.command = clickToStop ? 'ai-proofread.continuousProofread.stop' : undefined;
        this.statusBarItem.show();
    }

    private hideStatusBar(): void {
        this.statusBarItem.command = undefined;
        this.statusBarItem.tooltip = undefined;
        this.statusBarItem.hide();
    }

    private setContextActive(active: boolean): void {
        vscode.commands.executeCommand('setContext', 'aiProofreadContinuousProofreadActive', active);
    }

    /**
     * 首次配置（切分方式、平台、模型、温度、上下文）
     * 配置仅在本流程有效，终止后删除
     */
    private async getOrAskConfig(context: vscode.ExtensionContext): Promise<ContinuousProofreadConfig | null> {
        this.extensionContext = context;
        const cached = context.workspaceState.get<ContinuousProofreadConfig>('aiProofread.continuousProofreadConfig');
        if (cached) return cached;

        const workspaceConfig = vscode.workspace.getConfiguration('ai-proofread');

        // 1. 切分方式（首次选择后固定）
        const splitModePick = await vscode.window.showQuickPick([
            { label: '按长度切分', value: 'length' as const, description: '在空行处按字符数切分' },
            { label: '按标题切分', value: 'title' as const, description: '以标题为界取整段' }
        ], { placeHolder: '选择切分方式（首次选择后固定）', ignoreFocusOut: true });
        if (splitModePick === undefined) return null;

        const splitMode = splitModePick.value;
        let splitCutBy = workspaceConfig.get<number>('defaultSplitLength', 600);
        let splitLevels = workspaceConfig.get<number[]>('defaultTitleLevels', [2]);

        if (splitMode === 'length') {
            const cutByInput = await vscode.window.showInputBox({
                prompt: '切分长度（字符数）',
                value: splitCutBy.toString(),
                validateInput: v => (parseInt(v, 10) >= 50 ? null : '至少 50')
            });
            if (cutByInput === undefined) return null;
            splitCutBy = parseInt(cutByInput || '600', 10);
        } else {
            const levelsInput = await vscode.window.showInputBox({
                prompt: '标题级别（如 1,2 表示 # 和 ##）',
                value: splitLevels.join(','),
                validateInput: v => (v.split(/[,，]/).every(x => !isNaN(parseInt(x.trim(), 10))) ? null : '请输入数字，逗号分隔')
            });
            if (levelsInput === undefined) return null;
            splitLevels = (levelsInput || '2').split(/[,，]/).map(x => parseInt(x.trim(), 10)).filter(n => n >= 1 && n <= 6);
            if (splitLevels.length === 0) splitLevels = [2];
        }

        const platform = this.configManager.getPlatform();
        const model = this.configManager.getModel(platform);
        const temperature = this.configManager.getTemperature();
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
            return null;
        }

        const contextBuildMethod = await vscode.window.showQuickPick(
            ['不使用上下文', '前后增加段落', '使用所在标题范围'],
            { placeHolder: '选择上下文构建方式（首次选择后固定）', ignoreFocusOut: true }
        );
        if (contextBuildMethod === undefined) return null;

        let contextLevel = contextBuildMethod;
        let beforeParagraphs = 1;
        let afterParagraphs = 1;

        if (contextBuildMethod === '前后增加段落') {
            const before = await vscode.window.showInputBox({
                prompt: '前文段落数',
                value: '1',
                validateInput: v => (parseInt(v, 10) >= 0 && parseInt(v, 10) <= 10 ? null : '0-10')
            });
            if (before === undefined) return null;
            beforeParagraphs = parseInt(before || '1', 10);

            const after = await vscode.window.showInputBox({
                prompt: '后文段落数',
                value: '1',
                validateInput: v => (parseInt(v, 10) >= 0 && parseInt(v, 10) <= 10 ? null : '0-10')
            });
            if (after === undefined) return null;
            afterParagraphs = parseInt(after || '1', 10);
        } else if (contextBuildMethod === '使用所在标题范围') {
            const level = await vscode.window.showQuickPick(
                ['1 级标题', '2 级标题', '3 级标题', '4 级标题', '5 级标题', '6 级标题'],
                { placeHolder: '选择上下文范围', ignoreFocusOut: true }
            );
            if (level === undefined) return null;
            contextLevel = level;
        }

        const tempInput = await vscode.window.showInputBox({
            prompt: '温度',
            value: temperature.toString(),
            validateInput: v => (parseFloat(v) >= 0 && parseFloat(v) < 2 ? null : '[0,2)')
        });
        if (tempInput === undefined) return null;

        const repMode = await vscode.window.showQuickPick([
            { label: '不重复', value: 'none' as const },
            { label: '仅重复目标', value: 'target' as const },
            { label: '重复完整流程', value: 'all' as const }
        ], { placeHolder: '提示词重复模式', ignoreFocusOut: true });
        if (repMode === undefined) return null;

        let sourceTextCharacteristics = '';
        let sourceTextCharacteristicsTitle: string | undefined;
        if (isUsingSystemDefaultPrompt(context)) {
            const picked = await pickSourceTextCharacteristicsInjection(context);
            if (picked === undefined) {
                return null;
            }
            sourceTextCharacteristics = picked.injectText;
            sourceTextCharacteristicsTitle = picked.displayTitle;
        }

        const fullConfig: ContinuousProofreadConfig = {
            platform,
            model,
            temperature: parseFloat(tempInput || '1'),
            contextLevel,
            beforeParagraphs,
            afterParagraphs,
            repetitionMode: repMode.value,
            sourceTextCharacteristics,
            sourceTextCharacteristicsTitle,
            splitMode,
            splitCutBy,
            splitLevels
        };
        await context.workspaceState.update('aiProofread.continuousProofreadConfig', fullConfig);
        return fullConfig;
    }

    /**
     * 打开 diff 并返回右侧 URI；关闭时提示接受或放弃
     */
    private async openDiffAndGetProofreadUri(
        ctx: vscode.ExtensionContext,
        originalText: string,
        proofreadText: string,
        fileExt: string
    ): Promise<vscode.Uri | undefined> {
        const tempFileManager = TempFileManager.getInstance(ctx);
        const originalUri = await tempFileManager.createTempFile(originalText, fileExt);
        const proofreadUri = await tempFileManager.createTempFile(proofreadText, fileExt);
        await vscode.commands.executeCommand(
            'vscode.diff',
            originalUri,
            proofreadUri,
            '持续校对：原文 ↔ 校对结果（关闭时提示接受或放弃）',
            { preview: false, viewColumn: vscode.ViewColumn.Beside }
        );
        return proofreadUri;
    }

    /**
     * 注册 diff 关闭时的提示（接受或放弃）
     */
    private registerDiffClosePrompt(context: vscode.ExtensionContext, proofreadUri: vscode.Uri): void {
        if (!this.session) return;
        this.session.diffCloseListener?.dispose();
        this.session.diffCloseListener = vscode.workspace.onDidCloseTextDocument(async (doc) => {
            if (!this.session || this.session.proofreadUri?.toString() !== doc.uri.toString()) return;
            this.session.diffCloseListener?.dispose();
            this.session.diffCloseListener = undefined;
            const finalText = doc.getText();
            this.session.proofreadUri = undefined;

            const choice = await vscode.window.showQuickPick(
                [
                    { label: '接受并继续', value: 'accept' as const },
                    { label: '放弃', value: 'skip' as const },
                    { label: '终止校对', value: 'stop' as const }
                ],
                { placeHolder: '关闭 diff 前请选择：接受并写回文档，或放弃当前段', ignoreFocusOut: true }
            );
            if (choice === undefined) {
                await this.handleSkipCommand(context);
                return;
            }
            if (choice.value === 'stop') {
                this.handleStopCommand();
                return;
            }

            if (choice.value === 'accept') {
                const document = await vscode.workspace.openTextDocument(this.session!.documentUri);
                const editor = await vscode.window.showTextDocument(document);
                await this.doAcceptAndContinue(context, editor, finalText);
            } else {
                if (this.session?.currentSegmentEndOffset !== undefined) {
                    this.session.startOffset = this.session.currentSegmentEndOffset;
                    this.session.segmentIndex += 1;
                    this.session.currentSegmentEndOffset = undefined;
                }
                await this.advanceToNextSegment(context);
            }
        });
    }

    /**
     * 从 diff 右侧读取当前内容（含未保存编辑）
     */
    private getProofreadContentFromUri(proofreadUri: vscode.Uri): string | undefined {
        const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === proofreadUri.toString());
        return doc?.getText();
    }

    /**
     * 主入口：启动持续校对
     */
    public async handleContinuousProofreadCommand(context: vscode.ExtensionContext): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('请先打开要校对的文档。');
            return;
        }

        const config = await this.getOrAskConfig(context);
        if (!config) return;

        const examplesPath = FilePathUtils.getExamplesPath(editor.document.uri);
        const referenceFile = (examplesPath && fs.existsSync(examplesPath))
            ? [vscode.Uri.file(examplesPath)]
            : undefined;

        this.session = {
            config,
            documentUri: editor.document.uri,
            startOffset: editor.selection.isEmpty
                ? editor.document.offsetAt(editor.selection.start)
                : editor.document.offsetAt(editor.selection.start),
            segmentIndex: 0,
            proofreadUri: undefined,
            currentSegmentEndOffset: undefined,
            diffCloseListener: undefined,
            currentSegmentItems: undefined,
            lastProofreadModelText: undefined,
        };
        this.setContextActive(true);
        await this.runLoop(context, referenceFile);
    }

    /**
     * 接受并继续
     */
    public async handleAcceptAndContinueCommand(context: vscode.ExtensionContext): Promise<void> {
        if (!this.session) return;

        const proofreadUri = this.session.proofreadUri;
        if (!proofreadUri) {
            vscode.window.showWarningMessage('当前无待接受的校对结果。');
            return;
        }

        const finalText = this.getProofreadContentFromUri(proofreadUri);
        if (finalText === undefined) {
            vscode.window.showWarningMessage('无法读取校对结果，请确保 diff 窗口未关闭。');
            return;
        }

        const editor = vscode.window.activeTextEditor;
        const doc = await vscode.workspace.openTextDocument(this.session.documentUri);
        if (!editor || editor.document.uri.toString() !== this.session.documentUri.toString()) {
            const ed = await vscode.window.showTextDocument(doc);
            await this.doAcceptAndContinue(context, ed, finalText);
        } else {
            await this.doAcceptAndContinue(context, editor, finalText);
        }
    }

    /**
     * 跳过当前段（不保存，直接进入下一段）
     */
    public async handleSkipCommand(context: vscode.ExtensionContext): Promise<void> {
        if (!this.session) return;
        if (this.session.currentSegmentEndOffset !== undefined) {
            this.session.startOffset = this.session.currentSegmentEndOffset;
            this.session.segmentIndex += 1;
            this.session.proofreadUri = undefined;
            this.session.currentSegmentEndOffset = undefined;
        }
        await this.advanceToNextSegment(context);
    }

    /**
     * 停止持续校对
     */
    public handleStopCommand(): void {
        this.session?.diffCloseListener?.dispose();
        this.session = null;
        this.setContextActive(false);
        this.hideStatusBar();
        if (this.extensionContext) {
            this.extensionContext.workspaceState.update('aiProofread.continuousProofreadConfig', undefined);
        }
        vscode.window.showInformationMessage('已停止持续校对。');
    }

    private async doAcceptAndContinue(
        context: vscode.ExtensionContext,
        editor: vscode.TextEditor,
        finalText: string
    ): Promise<void> {
        if (!this.session) return;

        const { config } = this.session;
        const doc = editor.document;
        const startPos = doc.positionAt(this.session.startOffset);
        const segResult = getSegmentFromPositionWithMode(doc, startPos, config.splitMode, {
            cutBy: config.splitCutBy,
            levels: config.splitLevels
        });
        if (!segResult) {
            this.handleStopCommand();
            return;
        }

        const segmentRange = new vscode.Range(
            new vscode.Position(segResult.range.start.line, segResult.range.start.character),
            new vscode.Position(segResult.range.end.line, segResult.range.end.character)
        );

        const ok = await editor.edit(editBuilder => {
            editBuilder.replace(segmentRange, finalText);
        });
        if (!ok) {
            vscode.window.showErrorMessage('写回文档失败。');
            return;
        }

        const originalText = segResult.segment;
        const modelOut = this.session.lastProofreadModelText ?? finalText;
        const items = this.session.currentSegmentItems
            ?.filter((i) => i.corrected != null)
            .map((i) => ({ original: i.original, corrected: i.corrected! }));
        this.session.currentSegmentItems = undefined;
        this.session.lastProofreadModelText = undefined;
        this.session.proofreadUri = undefined;

        try {
            await runEditorialMemoryAfterAccept({
                documentUri: doc.uri,
                fullText: editor.document.getText(),
                selectionStartLine: segmentRange.start.line,
                selectionRangeLabel: `L${segmentRange.start.line + 1}C${segmentRange.start.character}–L${segmentRange.end.line + 1}C${segmentRange.end.character}`,
                originalSelected: originalText,
                finalSelected: finalText,
                modelOutput: modelOut,
                platform: config.platform,
                model: config.model,
                items,
            });
        } catch {
            /* 记忆失败不阻断持续校对 */
        }

        this.session.startOffset = doc.offsetAt(segmentRange.end);
        this.session.currentSegmentEndOffset = undefined;
        this.session.segmentIndex += 1;
        await this.advanceToNextSegment(context);
    }

    private async advanceToNextSegment(context: vscode.ExtensionContext): Promise<void> {
        if (!this.session) return;

        const { config } = this.session;
        const doc = await vscode.workspace.openTextDocument(this.session.documentUri);
        const startPos = doc.positionAt(this.session.startOffset);
        const segResult = getSegmentFromPositionWithMode(doc, startPos, config.splitMode, {
            cutBy: config.splitCutBy,
            levels: config.splitLevels
        });

        if (!segResult) {
            vscode.window.showInformationMessage('已校对完毕，无更多段落。');
            this.handleStopCommand();
            return;
        }

        await this.proofreadOneSegment(context, doc, segResult);
    }

    private async proofreadOneSegment(
        context: vscode.ExtensionContext,
        document: vscode.TextDocument,
        segResult: { segment: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } }
    ): Promise<void> {
        if (!this.session) return;

        const examplesPath = FilePathUtils.getExamplesPath(document.uri);
        const referenceFile = (examplesPath && fs.existsSync(examplesPath))
            ? [vscode.Uri.file(examplesPath)]
            : undefined;

        const segmentRange = new vscode.Range(
            new vscode.Position(segResult.range.start.line, segResult.range.start.character),
            new vscode.Position(segResult.range.end.line, segResult.range.end.character)
        );
        const selection = new vscode.Selection(segmentRange.start, segmentRange.end);

        const editor = await vscode.window.showTextDocument(document);
        // 滚动视口：上部约 2 行前文，下部为即将校对的段落
        const revealStartLine = Math.max(0, segResult.range.start.line - 2);
        const revealRange = new vscode.Range(
            new vscode.Position(revealStartLine, 0),
            new vscode.Position(segResult.range.end.line, segResult.range.end.character)
        );
        editor.revealRange(revealRange, vscode.TextEditorRevealType.AtTop);
        this.updateStatusBar(`持续校对 (第 ${this.session.segmentIndex + 1} 段) | Alt+Enter 接受 Ctrl+Alt+S 跳过 Ctrl+Alt+Q 停止 或关闭 diff 选择`, true);

        let result: string | null;
        try {
            result = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: '正在校对...', cancellable: false },
                async () =>
                    proofreadSelection(
                        editor,
                        selection,
                        this.session!.config.platform,
                        this.session!.config.model,
                        this.session!.config.contextLevel,
                        referenceFile,
                        this.session!.config.temperature,
                        context,
                        this.session!.config.beforeParagraphs,
                        this.session!.config.afterParagraphs,
                        this.session!.config.repetitionMode,
                        this.session!.config.sourceTextCharacteristics ?? '',
                        this.session!.config.sourceTextCharacteristicsTitle,
                        (items) => {
                            if (this.session) this.session.currentSegmentItems = items;
                        }
                    )
            );
        } catch (err) {
            ErrorUtils.showError(err, '校对失败：');
            this.handleStopCommand();
            return;
        }

        if (!result) {
            vscode.window.showErrorMessage('校对失败，请重试。');
            this.handleStopCommand();
            return;
        }

        if (this.session) {
            this.session.lastProofreadModelText = result;
        }

        const fileExt = path.extname(document.fileName) || '.md';
        const proofreadUri = await this.openDiffAndGetProofreadUri(context, segResult.segment, result, fileExt);
        const endOffset = document.offsetAt(new vscode.Position(segResult.range.end.line, segResult.range.end.character));
        this.session.proofreadUri = proofreadUri;
        this.session.currentSegmentEndOffset = endOffset;
        this.registerDiffClosePrompt(context, proofreadUri);
    }

    private async runLoop(
        context: vscode.ExtensionContext,
        referenceFile: vscode.Uri[] | undefined
    ): Promise<void> {
        if (!this.session) return;

        const { config } = this.session;
        const doc = await vscode.workspace.openTextDocument(this.session.documentUri);
        const startPos = doc.positionAt(this.session.startOffset);
        const segResult = getSegmentFromPositionWithMode(doc, startPos, config.splitMode, {
            cutBy: config.splitCutBy,
            levels: config.splitLevels
        });

        if (!segResult) {
            vscode.window.showInformationMessage('从当前位置起无更多段落可校对。');
            this.handleStopCommand();
            return;
        }

        await this.proofreadOneSegment(context, doc, segResult);
    }
}
