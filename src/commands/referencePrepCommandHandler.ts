import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConfigManager, ErrorUtils, FilePathUtils } from '../utils';
import { resolveModelRoute } from '../modelRoutes/modelRouteResolver';
import { proofreadSelection } from '../proofreader';
import { getPromptDisplayName } from '../promptManager';
import { showSelectionProofreadDiffWithApply } from '../differ';
import { runEditorialMemoryAfterAccept } from '../editorialMemory/service';
import {
    pickProofreadPromptForKnowledgeVerify,
    withTemporaryProofreadPrompt,
} from '../proofreadPromptPick';
import type { ReferencePrepProcessFileV020, ReferencePrepStrength, ReferenceSourceId } from '../referencePrep/schema';
import { getDefaultEnabledSources, runReferencePrepForJsonFile, runReferencePrepForTarget } from '../referencePrep/referencePrepRunner';
import type { ReferencePrepResultsProvider } from '../referencePrep/referencePrepResultsView';
import { loadReferencePrepLastRun, saveReferencePrepLastRun } from '../referencePrep/runPreferences';
import {
    pickExistingReferenceForProofread,
    pickReferencePrepContinuation,
} from '../referencePrep/continuation';
import {
    REFERENCE_PREP_STRENGTH_OPTIONS,
    REFERENCE_SOURCE_OPTIONS,
} from '../referencePrep/referencePrepSession';
import type { PrepEventListener } from '../referencePrep/prepEvents';
import { WebviewManager } from '../ui/webviewManager';
import type { ProofreadCommandHandler } from './proofreadCommandHandler';

type KnowledgeVerifyMode = 'prep_and_proofread' | 'prep_only' | 'proofread_existing';

const KNOWLEDGE_VERIFY_MODE_OPTIONS: Array<{
    label: string;
    description: string;
    value: KnowledgeVerifyMode;
}> = [
    {
        label: '准备参考资料并验证',
        description: '检索词典与文献后，用知识核查提示词校对选段',
        value: 'prep_and_proofread',
    },
    {
        label: '仅准备参考资料',
        description: '只运行 referencePrep，生成 mergedReference，不校对',
        value: 'prep_only',
    },
    {
        label: '用已有参考资料验证',
        description: '使用当前文档或最近会话中已准备的 reference 直接校对',
        value: 'proofread_existing',
    },
];

export interface PrepForSelectionParams {
    target: string;
    anchorPath: string;
    context: vscode.ExtensionContext;
    enabledSources: ReferenceSourceId[];
    strength: ReferencePrepStrength;
    freshProcess?: boolean;
    continuation?: boolean;
    maxRoundsOverride?: number;
    onProgress?: (msg: string) => void;
    onEvent?: PrepEventListener;
    token?: vscode.CancellationToken;
    /** 是否打开 mergedReference 预览 */
    openMergedPreview?: boolean;
    showInformationMessage?: boolean;
}

export class ReferencePrepCommandHandler {
    private configManager = ConfigManager.getInstance();

    constructor(
        private webviewManager: WebviewManager,
        private proofreadHandler?: ProofreadCommandHandler,
        private resultsProvider?: ReferencePrepResultsProvider
    ) {}

    private async showResultsTree(anchorPath: string, process: ReferencePrepProcessFileV020): Promise<void> {
        if (!this.resultsProvider) return;
        await vscode.commands.executeCommand('setContext', 'aiProofread.showReferencePrepResultsView', true);
        this.resultsProvider.refresh(process, anchorPath);
    }

    async maybeShowWikipediaNotice(
        context: vscode.ExtensionContext,
        enabledSources: ReferenceSourceId[]
    ): Promise<void> {
        if (!enabledSources.includes('wikipedia')) return;
        const noticeKey = 'ai-proofread.wikipedia.complianceNoticeShown';
        if (!context.globalState.get<boolean>(noticeKey)) {
            await context.globalState.update(noticeKey, true);
            await vscode.window.showInformationMessage(
                '已启用维基百科检索：扩展将以只读方式访问 Wikimedia API（串行限速、本地缓存）。请勿高频批量请求；详见 README「维基百科资料来源」。',
                { modal: false }
            );
        }
    }

    async pickPrepSourcesAndStrength(context: vscode.ExtensionContext): Promise<
        | {
              enabledSources: ReferenceSourceId[];
              strength: ReferencePrepStrength;
          }
        | undefined
    > {
        const last = loadReferencePrepLastRun(context);
        const configDefaults = getDefaultEnabledSources();
        const defaultSourceIds = last.enabledSources.length > 0 ? last.enabledSources : configDefaults;

        const pickedSources = await vscode.window.showQuickPick(
            REFERENCE_SOURCE_OPTIONS.filter((o) => !o.stub).map((o) => ({
                label: o.label,
                description: o.description,
                id: o.id,
                picked: defaultSourceIds.includes(o.id),
            })),
            {
                title: '选择资料来源（可多选）',
                placeHolder: '已记住上次选择，可直接回车确认',
                canPickMany: true,
                ignoreFocusOut: true,
            }
        );
        if (!pickedSources?.length) return undefined;
        const enabledSources = pickedSources.map((p) => p.id);

        await this.maybeShowWikipediaNotice(context, enabledSources);

        const strengthPick = await vscode.window.showQuickPick(
            REFERENCE_PREP_STRENGTH_OPTIONS.map((o) => ({
                ...o,
                picked: o.value === last.strength,
            })),
            {
                title: '核查强度',
                placeHolder: `上次：${REFERENCE_PREP_STRENGTH_OPTIONS.find((s) => s.value === last.strength)?.label ?? '标准'}`,
                ignoreFocusOut: true,
            }
        );
        if (!strengthPick) return undefined;

        await saveReferencePrepLastRun(context, {
            enabledSources,
            strength: strengthPick.value,
        });

        return { enabledSources, strength: strengthPick.value };
    }

    /** JSON 批量准备等：资料来源 + 强度 + 是否接着校对 */
    async pickRunOptions(context: vscode.ExtensionContext): Promise<
        | {
              enabledSources: ReferenceSourceId[];
              strength: ReferencePrepStrength;
              runProofread: boolean;
              proofreadPromptName?: string;
          }
        | undefined
    > {
        const prep = await this.pickPrepSourcesAndStrength(context);
        if (!prep) return undefined;

        const actionPick = await vscode.window.showQuickPick(
            [
                { label: '准备参考资料并校对', value: 'prep_and_proofread' as const },
                { label: '仅准备参考资料', value: 'prep' as const },
            ],
            { title: '下一步', ignoreFocusOut: true }
        );
        if (!actionPick) return undefined;

        const runProofread = actionPick.value === 'prep_and_proofread';
        let proofreadPromptName: string | undefined;
        if (runProofread) {
            proofreadPromptName = await pickProofreadPromptForKnowledgeVerify(context);
            if (!proofreadPromptName) return undefined;
        }

        return {
            enabledSources: prep.enabledSources,
            strength: prep.strength,
            runProofread,
            proofreadPromptName,
        };
    }

    /**
     * 选段准备参考资料（与 prepareReferencesJson 对称）。
     * 知识核查、Webview、命令面板共用。
     */
    async runPrepForSelection(
        params: PrepForSelectionParams
    ): Promise<{ mergedReference: string; process: ReferencePrepProcessFileV020 }> {
        const { mergedReference, process } = await runReferencePrepForTarget({
            target: params.target,
            anchorPath: params.anchorPath,
            context: params.context,
            enabledSources: params.enabledSources,
            strength: params.strength,
            targetKind: 'manuscript',
            freshProcess: params.freshProcess ?? true,
            continuation: params.continuation,
            maxRoundsOverride: params.maxRoundsOverride,
            onProgress: params.onProgress,
            onEvent: params.onEvent,
            token: params.token,
            onProcessUpdated: (proc) => this.resultsProvider?.refresh(proc, params.anchorPath),
        });
        await this.showResultsTree(params.anchorPath, process);

        if (params.openMergedPreview !== false && mergedReference) {
            const doc = await vscode.workspace.openTextDocument({
                content: mergedReference,
                language: 'markdown',
            });
            await vscode.window.showTextDocument(doc, { preview: true });
        }
        if (params.showInformationMessage !== false) {
            vscode.window.showInformationMessage(
                mergedReference
                    ? '参考资料已准备完成（已打开预览）。'
                    : '参考资料准备完成，未检索到命中。'
            );
        }
        return { mergedReference, process };
    }

    /** 命令：prepare references for selection */
    async handlePrepareReferencesSelection(
        editor: vscode.TextEditor,
        context: vscode.ExtensionContext,
        options?: { onEvent?: PrepEventListener; skipPicks?: boolean; enabledSources?: ReferenceSourceId[]; strength?: ReferencePrepStrength }
    ): Promise<void> {
        const selectedText = editor.document.getText(editor.selection);
        if (!selectedText.trim()) {
            vscode.window.showErrorMessage('请先选择要准备参考资料的文本。');
            return;
        }

        let enabledSources = options?.enabledSources;
        let strength = options?.strength;
        if (!options?.skipPicks || !enabledSources || !strength) {
            const prep = await this.pickPrepSourcesAndStrength(context);
            if (!prep) return;
            enabledSources = prep.enabledSources;
            strength = prep.strength;
        }

        const anchorPath = editor.document.uri.fsPath;
        const cont = await pickReferencePrepContinuation({
            context,
            anchorPath,
            target: selectedText,
            title: '准备参考资料（选段）',
        });
        if (!cont) return;

        try {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: cont.continuation ? '参考资料准备（续跑）' : '参考资料准备（选段）',
                    cancellable: true,
                },
                async (_p, token) =>
                    this.runPrepForSelection({
                        target: cont.targetOverride ?? selectedText,
                        anchorPath: cont.anchorPath,
                        context,
                        enabledSources: enabledSources!,
                        strength: strength!,
                        freshProcess: cont.freshProcess,
                        continuation: cont.continuation,
                        maxRoundsOverride: cont.maxRoundsOverride,
                        onProgress: (m) => _p.report({ message: m }),
                        onEvent: options?.onEvent,
                        token,
                    })
            );
        } catch (e) {
            ErrorUtils.showError(e, '准备参考资料失败：');
        }
    }

    private async pickKnowledgeVerifyMode(): Promise<KnowledgeVerifyMode | undefined> {
        const picked = await vscode.window.showQuickPick(
            KNOWLEDGE_VERIFY_MODE_OPTIONS.map((o) => ({
                label: o.label,
                description: o.description,
                value: o.value,
            })),
            {
                title: '知识核查',
                placeHolder: '选择要执行的操作',
                ignoreFocusOut: true,
            }
        );
        return picked?.value;
    }

    /** 选段：知识核查 = 准备 + 可选校对 */
    async handleKnowledgeVerifySelection(
        editor: vscode.TextEditor,
        context: vscode.ExtensionContext
    ): Promise<void> {
        const selectedText = editor.document.getText(editor.selection);
        if (!selectedText.trim()) {
            vscode.window.showErrorMessage('请先选择要核查的文本。');
            return;
        }

        const mode = await this.pickKnowledgeVerifyMode();
        if (!mode) return;

        const anchorPath = editor.document.uri.fsPath;

        if (mode === 'proofread_existing') {
            try {
                const existing = await pickExistingReferenceForProofread({
                    context,
                    anchorPath,
                    selectedText,
                });
                if (!existing) return;

                const promptStorageName = await pickProofreadPromptForKnowledgeVerify(context);
                if (!promptStorageName) return;

                await this.showResultsTree(existing.anchorPath, existing.process);

                await withTemporaryProofreadPrompt(context, promptStorageName, () =>
                    this.runProofreadSelectionWithInlineReference(
                        editor,
                        context,
                        existing.mergedReference,
                        getPromptDisplayName(promptStorageName)
                    )
                );
            } catch (e) {
                ErrorUtils.showError(e, '知识核查失败：');
            }
            return;
        }

        if (mode === 'prep_only') {
            await this.handlePrepareReferencesSelection(editor, context);
            return;
        }

        // prep_and_proofread
        const prep = await this.pickPrepSourcesAndStrength(context);
        if (!prep) return;

        const proofreadPromptName = await pickProofreadPromptForKnowledgeVerify(context);
        if (!proofreadPromptName) return;

        try {
            const { mergedReference } = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: '参考资料准备',
                    cancellable: true,
                },
                async (_p, token) =>
                    this.runPrepForSelection({
                        target: selectedText,
                        anchorPath,
                        context,
                        enabledSources: prep.enabledSources,
                        strength: prep.strength,
                        freshProcess: true,
                        onProgress: (m) => _p.report({ message: m }),
                        token,
                        openMergedPreview: false,
                        showInformationMessage: false,
                    })
            );

            await withTemporaryProofreadPrompt(context, proofreadPromptName, () =>
                this.runProofreadSelectionWithInlineReference(
                    editor,
                    context,
                    mergedReference,
                    getPromptDisplayName(proofreadPromptName)
                )
            );
        } catch (e) {
            ErrorUtils.showError(e, '知识核查失败：');
        }
    }

    private async runProofreadSelectionWithInlineReference(
        editor: vscode.TextEditor,
        context: vscode.ExtensionContext,
        inlineReference: string,
        promptDisplayName: string
    ): Promise<void> {
        const useMemory = vscode.workspace
            .getConfiguration('ai-proofread')
            .get<boolean>('referencePrep.useEditorialMemory', false);

        const { platform, model } = resolveModelRoute('proofread');
        const userTemperature = this.configManager.getTemperature();

        const range = new vscode.Range(editor.selection.start, editor.selection.end);
        const sel = new vscode.Selection(range.start, range.end);

        const originalText = editor.document.getText(range);
        const fileExt = path.extname(editor.document.fileName);
        let itemChanges: Array<{ original: string; corrected: string }> | undefined;

        const result = await proofreadSelection(
            editor,
            sel,
            platform,
            model,
            undefined,
            undefined,
            userTemperature,
            context,
            undefined,
            undefined,
            undefined,
            '',
            undefined,
            (items) => {
                itemChanges = items
                    .filter((i) => i.corrected != null)
                    .map((i) => ({ original: i.original, corrected: i.corrected! }));
            },
            undefined,
            useMemory,
            inlineReference
        );

        if (!result) {
            vscode.window.showErrorMessage('校对失败，请重试。');
            return;
        }

        const logFilePath = FilePathUtils.getFilePath(editor.document.uri.fsPath, '.proofread', '.log');
        fs.appendFileSync(
            logFilePath,
            `\n${'='.repeat(50)}\nKnowledge verify + proofread\nPrompt: ${promptDisplayName}\nReference: inline prepared\nResult:\n\n${result}\n${'='.repeat(50)}\n\n`,
            'utf8'
        );

        const diffRes = await showSelectionProofreadDiffWithApply(
            context,
            editor.document,
            range,
            originalText,
            result,
            fileExt
        );
        if (diffRes.applied && useMemory) {
            try {
                await runEditorialMemoryAfterAccept({
                    documentUri: editor.document.uri,
                    fullText: editor.document.getText(),
                    selectionStartLine: range.start.line,
                    selectionRangeLabel: `L${range.start.line + 1}–L${range.end.line + 1}`,
                    originalSelected: originalText,
                    finalSelected: diffRes.finalText,
                    modelOutput: result,
                    platform,
                    model,
                    items: itemChanges,
                    editorialMemoryForceEnabled: true,
                });
            } catch {
                /* 记忆更新失败不阻断 */
            }
        }
        vscode.window.showInformationMessage(`校对完成 | ${promptDisplayName}`);
    }

    /** JSON：准备参考资料（校对面板） */
    async handlePrepareReferencesJson(
        jsonFilePath: string,
        context: vscode.ExtensionContext,
        options?: {
            onEvent?: PrepEventListener;
            skipPicks?: boolean;
            enabledSources?: ReferenceSourceId[];
            strength?: ReferencePrepStrength;
            runProofread?: boolean;
        }
    ): Promise<void> {
        let enabledSources = options?.enabledSources;
        let strength = options?.strength;
        let runProofread = options?.runProofread ?? false;

        if (!options?.skipPicks || !enabledSources || !strength) {
            const opts = await this.pickRunOptions(context);
            if (!opts) return;
            enabledSources = opts.enabledSources;
            strength = opts.strength;
            runProofread = opts.runProofread;
            if (opts.runProofread && opts.proofreadPromptName) {
                /* prompt already picked in pickRunOptions */
            }
        }

        try {
            const content = fs.readFileSync(jsonFilePath, 'utf8');
            const parsed = JSON.parse(content);
            if (!Array.isArray(parsed)) {
                throw new Error('JSON 格式不正确');
            }

            const stats = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: '批量准备参考资料',
                    cancellable: true,
                },
                async (_p, token) =>
                    runReferencePrepForJsonFile({
                        jsonFilePath,
                        context,
                        enabledSources: enabledSources!,
                        strength: strength!,
                        onProgress: (m) => _p.report({ message: m }),
                        onEvent: options?.onEvent,
                        token,
                        onAfterJsonItem: () => {},
                        onProcessUpdated: (proc) => this.resultsProvider?.refresh(proc, jsonFilePath),
                    })
            );
            vscode.window.showInformationMessage(
                `参考资料准备完成：${stats.processed}/${stats.total} 条`
            );

            if (runProofread) {
                await this.runProofreadJson(jsonFilePath, context);
            }
        } catch (e) {
            ErrorUtils.showError(e, '准备参考资料失败：');
        }
    }

    private async runProofreadJson(jsonFilePath: string, context: vscode.ExtensionContext): Promise<void> {
        if (!this.proofreadHandler) {
            await vscode.commands.executeCommand('ai-proofread.proofreadJson', jsonFilePath, context);
            return;
        }
        await this.proofreadHandler.handleProofreadJsonFile(jsonFilePath, context);
    }

    /** 命令面板：仅对当前 JSON 文件准备参考资料 */
    async handlePrepareReferencesFromEditor(
        editor: vscode.TextEditor,
        context: vscode.ExtensionContext
    ): Promise<void> {
        if (editor.document.languageId !== 'json') {
            vscode.window.showErrorMessage('请在 JSON 切分文件上执行此命令。');
            return;
        }
        await this.handlePrepareReferencesJson(editor.document.uri.fsPath, context);
    }
}
