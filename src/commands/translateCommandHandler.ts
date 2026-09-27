/**
 * 翻译相关命令：选段带翻译记忆、JSON 顺序批译、清理过程输出、批准 candidate、清空记忆。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { PromptManager, SYSTEM_PROMPT_NAME_BOOK_TRANSLATE_FULL, SYSTEM_PROMPT_NAME_TERM_CHECK_FULL, getPromptDisplayName } from '../promptManager';
import { assertPromptMatchesEntry } from '../promptTask';
import { parseTranslateProcessOutput, cleanTranslateDelivery } from '../translationMemory/bitextCodec';
import {
    approveAllCandidates,
    buildTranslationMemoryXml,
    clearTranslationMemory,
    mergeTranslationMemoryFromParsed,
} from '../translationMemory/service';
import { processTranslateJsonSequential } from '../translationMemory/sequentialRunner';
import {
    guardTranslateFileCommand,
    segmentsJsonDirAndBaseFromPath,
    inspectTranslateRounds,
    translateProcessJsonPath,
    readJsonStringArray,
} from '../translationMemory/translateRoundLayout';
import { FilePathUtils, ConfigManager, ErrorUtils } from '../utils';
import { showSelectionProofreadDiffWithApply } from '../differ';
import { assembleProofreadSelectionInput, proofreadSelection } from '../proofreader';
import { loadTranslateSelectionWithMemoryConfig } from '../translateSelectionWithMemoryConfig';
import { ProgressTracker } from '../progressTracker';
import { WebviewManager, ProcessResult } from '../ui/webviewManager';
import { asOverlaySourceItems, resolveSegmentsJsonPath } from '../proofreadRoundLayout';
import { readTranslateInjectConfig } from '../translationMemory/injectConfig';
import { loadTranslationMemory } from '../translationMemory/persist';
import { buildTermAuditReport, formatTermAuditMarkdown } from '../translationMemory/termAudit';
import { loadTranslateReviewFromEditorOrPath } from '../translationMemory/translationReviewView';

function loadStyleSampleText(anchorUri: vscode.Uri): { text: string; configuredPath: string } {
    try {
        const root = FilePathUtils.getProofreadWorkspaceRoot(anchorUri);
        const configPath = path.join(root, '.proofread', 'translate-selection-with-memory.json');
        if (!fs.existsSync(configPath)) {
            return { text: '', configuredPath: '' };
        }
        const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { styleSamplePath?: string };
        const stylePath = String(parsed.styleSamplePath ?? '').trim();
        if (!stylePath) {
            return { text: '', configuredPath: '' };
        }
        const folder = vscode.workspace.getWorkspaceFolder(anchorUri);
        const abs = path.isAbsolute(stylePath)
            ? stylePath
            : path.join(folder?.uri.fsPath ?? root, stylePath);
        if (fs.existsSync(abs)) {
            return { text: fs.readFileSync(abs, 'utf8'), configuredPath: stylePath };
        }
        vscode.window.showWarningMessage(`试译样张未找到：${stylePath}（将继续翻译）`);
        return { text: '', configuredPath: stylePath };
    } catch {
        /* ignore */
    }
    return { text: '', configuredPath: '' };
}

/** 未配置样张时警告；返回 false 表示用户取消 */
async function confirmStyleSampleOrContinue(hasStyleSample: boolean): Promise<boolean> {
    const inj = readTranslateInjectConfig();
    if (hasStyleSample || !inj.warnIfNoStyleSample) {
        return true;
    }
    const pick = await vscode.window.showWarningMessage(
        '未配置试译样张（.proofread/translate-selection-with-memory.json 的 styleSamplePath）。建议先填写样张以稳住文风。',
        { modal: true },
        '仍继续',
        '取消'
    );
    return pick === '仍继续';
}

function resolveTranslateTemperature(fallback: number): number {
    const inj = readTranslateInjectConfig();
    return inj.temperature ?? fallback;
}

export class TranslateCommandHandler {
    private webviewManager?: WebviewManager;
    private configManager: ConfigManager;

    constructor(webviewManager?: WebviewManager) {
        this.webviewManager = webviewManager;
        this.configManager = ConfigManager.getInstance();
    }

    /**
     * 翻译选区（带翻译记忆）：激活 translate 提示词，注入 TM，解析过程输出后写回译文。
     */
    public async handleTranslateSelectionWithMemory(
        editor: vscode.TextEditor,
        context: vscode.ExtensionContext
    ): Promise<void> {
        const promptManager = PromptManager.getInstance(context);
        await promptManager.activatePromptForTask('translate');
        const ok = await assertPromptMatchesEntry(context, 'translate', { hard: true });
        if (!ok) {
            return;
        }

        if (editor.selection.isEmpty) {
            vscode.window.showWarningMessage('请先选择要翻译的文本（建议整段）。');
            return;
        }

        const cfg = await loadTranslateSelectionWithMemoryConfig(context);
        if (!cfg) {
            return;
        }

        const range = new vscode.Range(editor.selection.start, editor.selection.end);
        const sel = new vscode.Selection(range.start, range.end);
        const originalText = editor.document.getText(range);
        const fileExt = path.extname(editor.document.fileName) || '.md';

        const stylePath = cfg.styleSamplePath?.trim();
        let styleRef = '';
        if (stylePath) {
            const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
            const abs = path.isAbsolute(stylePath)
                ? stylePath
                : path.join(folder?.uri.fsPath ?? path.dirname(editor.document.uri.fsPath), stylePath);
            if (fs.existsSync(abs)) {
                styleRef = fs.readFileSync(abs, 'utf8');
            } else {
                vscode.window.showWarningMessage(`试译样张未找到：${stylePath}（将继续翻译）`);
            }
        }
        if (!(await confirmStyleSampleOrContinue(!!styleRef))) {
            return;
        }

        const temperature = resolveTranslateTemperature(cfg.temperature);

        const tmXml = buildTranslationMemoryXml(editor.document.uri, originalText);
        const assembled = await assembleProofreadSelectionInput({
            editor,
            selection: sel,
            contextLevel: cfg.contextLevel,
            beforeMinLength: cfg.beforeMinLength,
            afterMinLength: cfg.afterMinLength,
            includeTargetInContext: cfg.includeTargetInContext,
            referenceFile: undefined,
            inlineReferenceText: styleRef || undefined,
            editorialMemoryForceEnabled: false,
        });
        if (tmXml) {
            assembled.preText = `${assembled.preText || ''}${tmXml}`;
        }

        const configManager = ConfigManager.getInstance();
        const platform = configManager.getPlatform();
        const model = configManager.getModel(platform);

        const result = await proofreadSelection(
            editor,
            sel,
            platform,
            model,
            cfg.contextLevel,
            undefined,
            temperature,
            context,
            cfg.beforeMinLength,
            cfg.afterMinLength,
            cfg.includeTargetInContext,
            cfg.repetitionMode,
            cfg.sourceTextHintBody,
            cfg.sourceTextHintTitle,
            undefined,
            undefined,
            false,
            styleRef || undefined,
            assembled
        );

        if (!result) {
            vscode.window.showErrorMessage('翻译失败，请重试。');
            return;
        }

        const parsed = parseTranslateProcessOutput(result, originalText);
        if (parsed.warnings.length) {
            vscode.window.showWarningMessage(`过程输出提示：${parsed.warnings.slice(0, 2).join('；')}`);
        }
        const delivery = cleanTranslateDelivery(parsed);

        const logFilePath = FilePathUtils.getFilePath(editor.document.uri.fsPath, '.translate', '.log');
        const promptName = getPromptDisplayName(
            context.globalState.get<string>('currentPrompt', SYSTEM_PROMPT_NAME_BOOK_TRANSLATE_FULL) ??
                SYSTEM_PROMPT_NAME_BOOK_TRANSLATE_FULL
        );
        fs.appendFileSync(
            logFilePath,
            `\n${'='.repeat(50)}\nPrompt: ${promptName}\nRaw:\n${result}\n\nDelivery:\n${delivery}\n${'='.repeat(50)}\n\n`,
            'utf8'
        );

        const diffRes = await showSelectionProofreadDiffWithApply(
            context,
            editor.document,
            range,
            originalText,
            delivery,
            fileExt
        );

        if (diffRes.applied) {
            try {
                mergeTranslationMemoryFromParsed({
                    documentUri: editor.document.uri,
                    finalTranslation: diffRes.finalText,
                    parsed,
                    approve: true,
                    sourceUnit: originalText,
                });
                vscode.window.showInformationMessage('翻译已写回，翻译记忆已更新。');
            } catch {
                vscode.window.showInformationMessage('翻译已写回；翻译记忆更新失败（可忽略）。');
            }
        }
    }

    /**
     * 从编辑器打开的 JSON 启动顺序批译。
     */
    public async handleTranslateFileCommand(
        editor: vscode.TextEditor,
        context: vscode.ExtensionContext
    ): Promise<void> {
        const jsonFilePath = this.resolveTranslateSourceJsonPath(editor);
        if (!jsonFilePath) {
            return;
        }
        await this.handleTranslateJsonFile(jsonFilePath, context);
    }

    /**
     * JSON 顺序翻译（面板 / 命令共用）。
     */
    public async handleTranslateJsonFile(
        jsonFilePath: string,
        context: vscode.ExtensionContext
    ): Promise<void> {
        try {
            if (!fs.existsSync(jsonFilePath)) {
                vscode.window.showErrorMessage('JSON 文件不存在！');
                return;
            }

            const promptManager = PromptManager.getInstance(context);
            await promptManager.activatePromptForTask('translate');
            const ok = await assertPromptMatchesEntry(context, 'translate', { hard: true });
            if (!ok) {
                return;
            }

            let jsonContent: unknown;
            try {
                jsonContent = JSON.parse(fs.readFileSync(jsonFilePath, 'utf8'));
            } catch (error) {
                ErrorUtils.showError(error, '解析 JSON 文件时出错：');
                return;
            }
            const items = asOverlaySourceItems(jsonContent);
            if (!items) {
                vscode.window.showErrorMessage('JSON 文件格式不正确！需要包含 target 字段的对象数组。');
                return;
            }

            const { dir, base } = segmentsJsonDirAndBaseFromPath(jsonFilePath);
            const guard = guardTranslateFileCommand(dir, base);
            const outputFilePath = guard.outputJsonPath;
            const processOutPath = guard.processJsonPath;
            const logFilePath = FilePathUtils.getFilePath(jsonFilePath, '.translate', '.log');
            const originalMarkdownFilePath = FilePathUtils.getFilePath(jsonFilePath, '', '.md');
            const translateMarkdownFilePath = `${outputFilePath}.md`;

            const platform = this.configManager.getPlatform();
            const model = this.configManager.getModel(platform);
            const rpm = this.configManager.getRpm();
            const temperature = resolveTranslateTemperature(this.configManager.getTemperature());

            const apiKey = this.configManager.getApiKey(platform);
            if (!apiKey && platform !== 'ollama') {
                const result = await vscode.window.showErrorMessage(
                    `未配置 ${platform} 平台的 API 密钥，是否现在配置？`,
                    '是',
                    '否'
                );
                if (result === '是') {
                    await vscode.commands.executeCommand('workbench.action.openSettings', 'ai-proofread.apiKeys');
                }
                return;
            }

            const styleLoaded = loadStyleSampleText(vscode.Uri.file(jsonFilePath));
            const styleSampleText = styleLoaded.text;
            if (!(await confirmStyleSampleOrContinue(!!styleSampleText))) {
                return;
            }
            const inj = readTranslateInjectConfig();
            const currentPromptName = getPromptDisplayName(
                context.globalState.get<string>('currentPrompt', SYSTEM_PROMPT_NAME_BOOK_TRANSLATE_FULL) ??
                    SYSTEM_PROMPT_NAME_BOOK_TRANSLATE_FULL
            );

            const confirm = await vscode.window.showInformationMessage(
                [
                    `顺序翻译 JSON（${guard.resume ? '续跑' : '第 1 轮'}）`,
                    `输入：${path.basename(jsonFilePath)}（${items.length} 项）`,
                    `输出：${path.basename(outputFilePath)}`,
                    `过程：${path.basename(processOutPath)}`,
                    `模型：${platform} / ${model}，T=${temperature}，RPM=${rpm}`,
                    `译向：${inj.sourceLang || '（未设）'} → ${inj.targetLang || '（未设）'}`,
                    `提示词：${currentPromptName}`,
                    styleSampleText
                        ? `已加载试译样张（${styleLoaded.configuredPath}）`
                        : '无试译样张（可在 translate-selection-with-memory.json 配置 styleSamplePath）',
                    '将逐项翻译、写入候选翻译记忆，并更新句对侧车。是否开始？',
                ].join('\n'),
                { modal: true },
                '开始'
            );
            if (confirm !== '开始') {
                return;
            }

            const startTime = new Date().toLocaleString();
            let logMessage = `\n${'='.repeat(50)}\n`;
            logMessage += `Start: ${startTime}\n`;
            logMessage += `Mode: sequential translate\n`;
            logMessage += `Round: ${guard.round}${guard.resume ? ' (resume)' : ''}\n`;
            logMessage += `Output: ${outputFilePath}\n`;
            logMessage += `Process: ${processOutPath}\n`;
            logMessage += `Prompt: ${currentPromptName}\n`;
            logMessage += `Model: ${platform}, ${model}, T. ${temperature}\n`;
            logMessage += `RPM: ${rpm}\n`;
            logMessage += `${'='.repeat(50)}\n`;
            fs.appendFileSync(logFilePath, logMessage, 'utf8');

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: '正在顺序翻译…',
                    cancellable: true,
                },
                async (progress, token) => {
                    const stats = await processTranslateJsonSequential(
                        jsonFilePath,
                        outputFilePath,
                        processOutPath,
                        {
                            platform,
                            model,
                            rpm,
                            temperature,
                            styleSampleText,
                            memoryAnchorUri: vscode.Uri.file(jsonFilePath),
                            includePrevTranslatedUnit: true,
                            token,
                            context,
                            onProgress: (info: string) => {
                                fs.appendFileSync(logFilePath, info + '\n', 'utf8');
                                progress.report({ message: info.split('\n')[0] });
                            },
                            onProgressUpdate: (progressTracker: ProgressTracker) => {
                                this.updateTranslateProgressPanel(
                                    context,
                                    jsonFilePath,
                                    originalMarkdownFilePath,
                                    outputFilePath,
                                    translateMarkdownFilePath,
                                    logFilePath,
                                    progressTracker
                                );
                            },
                        }
                    );

                    stats.progressTracker?.complete();

                    const endTime = new Date().toLocaleString();
                    let endLog = `\n${'='.repeat(50)}\n`;
                    endLog += `翻译结束时间: ${endTime}\n`;
                    endLog += `总段落数: ${stats.totalCount}\n`;
                    endLog += `已处理: ${stats.processedCount}/${stats.totalCount} (${((stats.processedCount / stats.totalCount) * 100).toFixed(2)}%), `;
                    endLog += `${stats.processedLength}/${stats.totalLength}\n`;
                    if (stats.unprocessedParagraphs.length > 0) {
                        endLog += '\n未处理的段落:\n';
                        for (const p of stats.unprocessedParagraphs) {
                            endLog += `No.${p.index} \n ${p.preview}...\n\n`;
                        }
                    }
                    endLog += `${'='.repeat(50)}\n\n`;
                    fs.appendFileSync(logFilePath, endLog, 'utf8');

                    this.showTranslateResultPanel(
                        context,
                        jsonFilePath,
                        originalMarkdownFilePath,
                        outputFilePath,
                        translateMarkdownFilePath,
                        logFilePath,
                        stats
                    );

                    const doneMsg =
                        stats.processedCount === stats.totalCount
                            ? `顺序翻译完成：${stats.processedCount}/${stats.totalCount}`
                            : `顺序翻译部分完成：${stats.processedCount}/${stats.totalCount}（可续跑）`;
                    vscode.window.showInformationMessage(doneMsg);
                }
            );
        } catch (error) {
            ErrorUtils.showError(error, '翻译 JSON 文件时出错：');
        }
    }

    private resolveTranslateSourceJsonPath(editor: vscode.TextEditor): string | undefined {
        const document = editor.document;
        if (document.languageId !== 'json') {
            vscode.window.showErrorMessage('请选择 JSON 文件进行翻译！');
            return undefined;
        }
        const jsonFilePath = resolveSegmentsJsonPath(document.uri.fsPath);
        if (!jsonFilePath) {
            vscode.window.showErrorMessage('请选择切分得到的 JSON（含 target），或对应的翻译结果 JSON。');
            return undefined;
        }
        if (!fs.existsSync(jsonFilePath)) {
            vscode.window.showErrorMessage(`未找到切分 JSON：${jsonFilePath}`);
            return undefined;
        }
        return jsonFilePath;
    }

    private updateTranslateProgressPanel(
        context: vscode.ExtensionContext,
        jsonFilePath: string,
        originalMarkdownFilePath: string,
        outputFilePath: string,
        translateMarkdownFilePath: string,
        logFilePath: string,
        progressTracker: ProgressTracker
    ): void {
        const wm = this.webviewManager;
        if (!wm) {
            return;
        }
        const dir = path.dirname(jsonFilePath);
        const base = path.basename(jsonFilePath, '.json');
        const processResult: ProcessResult = {
            title: '工作面板',
            message: '正在顺序翻译…',
            splitResult: {
                jsonFilePath,
                markdownFilePath: path.join(dir, `${base}.json.md`),
                logFilePath: path.join(dir, `${base}.log`),
                originalFilePath: originalMarkdownFilePath,
            },
            proofreadResult: {
                outputFilePath,
                logFilePath,
                originalFilePath: originalMarkdownFilePath,
                markdownFilePath: translateMarkdownFilePath,
                round: 1,
                stats: {
                    totalCount: progressTracker.getStats().totalItems,
                    processedCount: progressTracker.getStats().completedItems,
                    processedLength: progressTracker.getStats().completedChars,
                    totalLength: progressTracker.getStats().totalChars,
                },
            },
            progressTracker,
            actions: { showJson: false, showLog: false, showDiff: false },
        };
        if (wm.getCurrentPanel()) {
            wm.updatePanelContent(processResult);
        } else {
            const panel = wm.createWebviewPanel(processResult, context);
            panel.webview.onDidReceiveMessage(
                (message) => wm.handleWebviewMessage(message, panel, context),
                undefined,
                context.subscriptions
            );
            panel.reveal();
        }
    }

    private showTranslateResultPanel(
        context: vscode.ExtensionContext,
        jsonFilePath: string,
        originalMarkdownFilePath: string,
        outputFilePath: string,
        translateMarkdownFilePath: string,
        logFilePath: string,
        stats: {
            totalCount: number;
            processedCount: number;
            processedLength: number;
            totalLength: number;
            progressTracker?: ProgressTracker;
        }
    ): void {
        const wm = this.webviewManager;
        if (!wm) {
            return;
        }
        const dir = path.dirname(jsonFilePath);
        const base = path.basename(jsonFilePath, '.json');
        const relPath =
            vscode.workspace.workspaceFolders?.[0] &&
            originalMarkdownFilePath.startsWith(vscode.workspace.workspaceFolders[0].uri.fsPath)
                ? path.relative(vscode.workspace.workspaceFolders[0].uri.fsPath, originalMarkdownFilePath)
                : originalMarkdownFilePath;
        const processResult: ProcessResult = {
            title: '工作面板',
            message: `翻译项目：${relPath}`,
            splitResult: {
                jsonFilePath,
                markdownFilePath: path.join(dir, `${base}.json.md`),
                logFilePath: path.join(dir, `${base}.log`),
                originalFilePath: originalMarkdownFilePath,
            },
            proofreadResult: {
                outputFilePath,
                logFilePath,
                originalFilePath: originalMarkdownFilePath,
                markdownFilePath: translateMarkdownFilePath,
                round: 1,
                stats: {
                    totalCount: stats.totalCount,
                    processedCount: stats.processedCount,
                    processedLength: stats.processedLength,
                    totalLength: stats.totalLength,
                },
            },
            progressTracker: stats.progressTracker,
            actions: { showJson: true, showLog: true, showDiff: true },
        };
        if (wm.getCurrentPanel()) {
            wm.updatePanelContent(processResult);
            wm.getCurrentPanel()?.reveal();
        } else {
            const panel = wm.createWebviewPanel(processResult, context);
            panel.webview.onDidReceiveMessage(
                (message) => wm.handleWebviewMessage(message, panel, context),
                undefined,
                context.subscriptions
            );
            panel.reveal();
        }
    }

    public async handleCleanTranslationProcessOutput(editor: vscode.TextEditor): Promise<void> {
        const doc = editor.document;
        const raw = editor.selection.isEmpty ? doc.getText() : doc.getText(editor.selection);
        const delivery = cleanTranslateDelivery(raw);
        const parsed = parseTranslateProcessOutput(raw);
        const target = editor.selection.isEmpty
            ? new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length))
            : editor.selection;

        const edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, target, delivery);
        await vscode.workspace.applyEdit(edit);

        const base = doc.uri.fsPath;
        const outPath = FilePathUtils.getFilePath(base, '.translate.cleaned', path.extname(base) || '.md');
        fs.writeFileSync(outPath, delivery, 'utf8');

        let termsNote = '';
        if (parsed.terms.length) {
            const termsPath = FilePathUtils.getFilePath(base, '.translate.terms', '.md');
            const body = parsed.terms.map((t) => `${t.source}:::${t.target}`).join('\n');
            fs.writeFileSync(termsPath, body + '\n', 'utf8');
            termsNote = `；术语 ${parsed.terms.length} 条 → ${path.basename(termsPath)}`;
        }
        vscode.window.showInformationMessage(`已清理为交付译文 → ${path.basename(outPath)}${termsNote}`);
    }

    public async handleApproveTranslationMemoryCandidates(editor: vscode.TextEditor): Promise<void> {
        const n = approveAllCandidates(editor.document.uri);
        vscode.window.showInformationMessage(n > 0 ? `已批准 ${n} 条 candidate。` : '没有 candidate 条目。');
    }

    public async handleClearTranslationMemory(editor: vscode.TextEditor): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            '将清空工作区 translation-memory.json、archive 与句对侧车 translation-bitext-index.json（可先备份），是否继续？',
            { modal: true },
            '继续'
        );
        if (confirm !== '继续') {
            return;
        }
        clearTranslationMemory(editor.document.uri);
        vscode.window.showInformationMessage('翻译记忆已清空。');
    }

    /** 术语冲突审计报告（记忆 + 可选过程 JSON） */
    public async handleAuditTranslationTerms(editor: vscode.TextEditor): Promise<void> {
        const uri = editor.document.uri;
        const { active, archive } = loadTranslationMemory(uri);
        let processRawItems: (string | null)[] | undefined;
        const resolved = resolveSegmentsJsonPath(uri.fsPath);
        if (resolved && fs.existsSync(resolved)) {
            const { dir, base } = segmentsJsonDirAndBaseFromPath(resolved);
            const inspected = inspectTranslateRounds(dir, base);
            if (inspected.maxRound >= 1) {
                const procPath = translateProcessJsonPath(dir, base, inspected.maxRound);
                const srcLen = asOverlaySourceItems(JSON.parse(fs.readFileSync(resolved, 'utf8')))?.length;
                processRawItems = readJsonStringArray(procPath, srcLen) ?? undefined;
            }
        }
        const report = buildTermAuditReport(active, { archive, processRawItems });
        const md = formatTermAuditMarkdown(report);
        const outPath = path.join(
            FilePathUtils.getProofreadWorkspaceRoot(uri),
            '.proofread',
            `term-audit-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.md`
        );
        FilePathUtils.ensureDirExists(path.dirname(outPath));
        fs.writeFileSync(outPath, md, 'utf8');
        const doc = await vscode.workspace.openTextDocument(outPath);
        await vscode.window.showTextDocument(doc, { preview: false });
        vscode.window.showInformationMessage(
            report.conflictCount > 0
                ? `术语审计：发现 ${report.conflictCount} 处冲突 → ${path.basename(outPath)}`
                : `术语审计：未发现冲突 → ${path.basename(outPath)}`
        );
    }

    public async handleOpenTranslateReview(
        context: vscode.ExtensionContext,
        filePath?: string
    ): Promise<void> {
        await loadTranslateReviewFromEditorOrPath(context, filePath);
    }

    /** 激活「译名一致核对」提示词，便于选段/JSON 专项核对 */
    public async handleActivateTermCheckPrompt(context: vscode.ExtensionContext): Promise<void> {
        const pm = PromptManager.getInstance(context);
        await pm.setCurrentPrompt(SYSTEM_PROMPT_NAME_TERM_CHECK_FULL);
        vscode.window.showInformationMessage(
            '已切换提示词为「译名一致核对」。可对双语文稿选段或 JSON 跑 LLM；程序审计请用「翻译术语审计」。'
        );
    }
}
