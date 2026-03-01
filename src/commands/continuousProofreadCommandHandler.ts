/**
 * 持续发现与监督校对命令处理器
 * 从当前位置取段 → 校对 → diff 复核 → 保存 → 收集样例 → 确认 → 继续
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { proofreadSelection } from '../proofreader';
import { TempFileManager, FilePathUtils, ErrorUtils, ConfigManager } from '../utils';
import type { ProofreadItem } from '../itemOutputParser';
import { getSegmentFromPositionWithMode, splitChineseSentencesSimple } from '../splitter';
import { normalizeLineEndings } from '../utils';
import type { ExamplesCommandHandler } from './examplesCommandHandler';

interface ContinuousProofreadConfig {
    platform: string;
    model: string;
    temperature: number;
    contextLevel: string;
    beforeParagraphs: number;
    afterParagraphs: number;
    repetitionMode: 'none' | 'target' | 'all';
    splitMode: 'length' | 'title';
    splitCutBy: number;
    splitLevels: number[];
}

interface CandidateExample {
    input: string;
    output: string;
}

export class ContinuousProofreadCommandHandler {
    private configManager = ConfigManager.getInstance();
    private statusBarItem: vscode.StatusBarItem;
    private extensionContext: vscode.ExtensionContext | undefined; // 用于终止时清除配置
    constructor(private examplesHandler: ExamplesCommandHandler) {
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
    }
    private session: {
        config: ContinuousProofreadConfig;
        documentUri: vscode.Uri;
        startOffset: number;
        segmentIndex: number;
        proofreadUri: vscode.Uri | undefined;
        currentSegmentEndOffset: number | undefined;
        awaitingExamplesConfirmation: boolean;
        diffCloseListener: vscode.Disposable | undefined;
        currentSegmentItems: ProofreadItem[] | undefined; // 条目式输出时本段解析出的条目，直接用作待选样例
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
     * 按分隔符切分文本（与 examplesCommandHandler 一致）
     */
    private splitBySeparator(text: string, separator: number | string): string[] {
        const normalized = normalizeLineEndings(text);
        const trimmed = normalized.trim();
        if (!trimmed) return [];
        const parts = typeof separator === 'number'
            ? trimmed.split(new RegExp(`\\n{${separator},}`))
            : trimmed.split(separator);
        return parts.map(s => s.trim()).filter(s => s.length > 0);
    }

    /**
     * 从原文和修改后文本提取待选样例
     * 流程：先用 split into sentences 默认设置（splitChineseSentencesSimple）分切，再用 2 个换行符（一个空行）分切，再收集
     */
    private extractCandidateExamples(originalText: string, finalText: string): CandidateExample[] {
        const sentenceSeparator = '\n\n'; // 2 个换行符（一个空行），与 split into sentences 默认一致
        const normalizedA = splitChineseSentencesSimple(originalText).join(sentenceSeparator);
        const normalizedB = splitChineseSentencesSimple(finalText).join(sentenceSeparator);
        const partsA = this.splitBySeparator(normalizedA, 2);
        const partsB = this.splitBySeparator(normalizedB, 2);
        const minLen = Math.min(partsA.length, partsB.length);
        if (minLen === 0) return [];
        return Array.from({ length: minLen }, (_, i) => ({ input: partsA[i], output: partsB[i] }))
            .filter(({ input, output }) => input !== output && input.trim() !== '' && output.trim() !== '');
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

        const fullConfig: ContinuousProofreadConfig = {
            platform,
            model,
            temperature: parseFloat(tempInput || '1'),
            contextLevel,
            beforeParagraphs,
            afterParagraphs,
            repetitionMode: repMode.value,
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
     * 显示样例确认 Webview（jsdiff 展示每条变化）
     */
    private async showExamplesConfirmationWebview(
        context: vscode.ExtensionContext,
        examples: CandidateExample[],
        examplesPath: string
    ): Promise<number[] | 'cancel'> {
        return new Promise((resolve) => {
            let resolved = false;
            const doResolve = (value: number[] | 'cancel') => {
                if (!resolved) {
                    resolved = true;
                    resolve(value);
                }
            };

            const panel = vscode.window.createWebviewPanel(
                'continuousProofreadExamples',
                '选择要保留的校对样例',
                vscode.ViewColumn.Beside,
                { enableScripts: true }
            );

            const diffScriptUri = panel.webview.asWebviewUri(
                vscode.Uri.joinPath(context.extensionUri, 'node_modules', 'diff', 'dist', 'diff.js')
            );

            const examplesJson = JSON.stringify(examples.map(e => ({ input: e.input, output: e.output })));

            panel.webview.html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
body { font-family: var(--vscode-font-family); padding: 1em; }
.example-item { margin: 1em 0; padding: 0.8em; border: 1px solid var(--vscode-panel-border); border-radius: 4px; }
.example-item label { display: flex; align-items: flex-start; gap: 0.5em; cursor: pointer; }
.example-item input[type=checkbox] { margin-top: 4px; flex-shrink: 0; }
.diff-display { white-space: pre-wrap; word-wrap: break-word; font-size: 13px; line-height: 1.5; margin-top: 0.4em; }
.diff-display span.added { color: #0e639c; text-decoration: underline 2px; }
.diff-display span.removed { color: #c72222; text-decoration: dotted underline 2px; }
.buttons { margin-top: 1em; display: flex; gap: 0.5em; }
button { padding: 0.4em 1em; cursor: pointer; }
</style>
<script src="${diffScriptUri}"></script>
</head>
<body>
<h3>勾选要保留为样例的条目（每条展示 input→output 变化）</h3>
<div id="examples"></div>
<div class="buttons">
  <button id="btnConfirm" onclick="confirmSelection()" autofocus>确认选择</button>
  <button onclick="selectAll()">全部保留</button>
  <button onclick="selectNone()">全部抛弃</button>
  <button onclick="cancel()">取消</button>
  <button onclick="stopProofread()">终止校对</button>
</div>
<script>
const examples = ${examplesJson};
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });

function renderDiff(a, b) {
  const diff = Diff.diffWordsWithSpace(a, b, segmenter);
  return diff.map(part => {
    const span = document.createElement('span');
    span.className = part.added ? 'added' : part.removed ? 'removed' : '';
    span.textContent = part.value;
    return span.outerHTML;
  }).join('');
}

const container = document.getElementById('examples');
examples.forEach((ex, i) => {
  const div = document.createElement('div');
  div.className = 'example-item';
  div.innerHTML = '<label><input type="checkbox" data-idx="' + i + '"> <div class="diff-display">' + renderDiff(ex.input, ex.output) + '</div></label>';
  container.appendChild(div);
});

function getSelectedIndices() {
  return Array.from(document.querySelectorAll('input[type=checkbox]:checked')).map(cb => parseInt(cb.dataset.idx, 10));
}

function selectAll() {
  document.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = true; });
}
function selectNone() {
  document.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = false; });
}

function confirmSelection() {
  const vscode = acquireVsCodeApi();
  vscode.postMessage({ type: 'confirm', selectedIndices: getSelectedIndices() });
}
function cancel() {
  const vscode = acquireVsCodeApi();
  vscode.postMessage({ type: 'cancel' });
}
function stopProofread() {
  const vscode = acquireVsCodeApi();
  vscode.postMessage({ type: 'stop' });
}
document.addEventListener('DOMContentLoaded', function() {
  document.getElementById('btnConfirm')?.focus();
});
</script>
</body>
</html>`;

            panel.webview.onDidReceiveMessage((msg: { type: string; selectedIndices?: number[] }) => {
                if (msg.type === 'confirm') {
                    doResolve(msg.selectedIndices ?? []);
                    panel.dispose();
                } else if (msg.type === 'cancel') {
                    doResolve('cancel');
                    panel.dispose();
                } else if (msg.type === 'stop') {
                    this.handleStopCommand();
                    doResolve('cancel');
                    panel.dispose();
                }
            });

            panel.onDidDispose(() => doResolve('cancel'));
        });
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
            awaitingExamplesConfirmation: false,
            diffCloseListener: undefined,
            currentSegmentItems: undefined,
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
        if (this.session.awaitingExamplesConfirmation) {
            vscode.window.showInformationMessage('请先在样例确认面板中点击「确认选择」或「取消」。');
            return;
        }
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
        const examples: CandidateExample[] =
            this.session.currentSegmentItems && this.session.currentSegmentItems.length > 0
                ? this.session.currentSegmentItems.filter((i) => i.corrected != null).map((i) => ({ input: i.original, output: i.corrected! }))
                : this.extractCandidateExamples(originalText, finalText);
        this.session.currentSegmentItems = undefined;
        const examplesPath = FilePathUtils.getExamplesPath(doc.uri);

        if (examples.length > 0 && examplesPath) {
            this.updateStatusBar(`选择要保留的样例 (${examples.length} 条) | Enter 确认 Esc 取消 | Ctrl+Alt+Q 停止`, true);
            this.session.awaitingExamplesConfirmation = true;
            const result = await this.showExamplesConfirmationWebview(context, examples, examplesPath);
            this.session.awaitingExamplesConfirmation = false;
            this.session.proofreadUri = undefined;

            if (result !== 'cancel' && result.length > 0) {
                const examplesToAdd = result
                    .filter(i => i >= 0 && i < examples.length)
                    .map(i => examples[i]);
                if (examplesToAdd.length > 0) {
                    const added = await this.examplesHandler.appendExamplesAndShow(examplesPath, examplesToAdd);
                    if (added > 0) {
                        const skipped = examplesToAdd.length - added;
                        const msg = skipped > 0
                            ? `已添加 ${added} 条样例到 examples.md（${skipped} 条已存在已跳过）`
                            : `已添加 ${added} 条样例到 examples.md`;
                        vscode.window.showInformationMessage(msg);
                    }
                }
            }
        } else {
            this.session.proofreadUri = undefined;
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
