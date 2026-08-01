import * as fs from 'fs';
import * as vscode from 'vscode';
import { ErrorUtils } from '../utils';
import type { ReferencePrepProcessFileV020, ReferencePrepStrength, ReferenceSourceId } from '../referencePrep/schema';
import { getDefaultEnabledSources, runReferencePrepForJsonFile, runReferencePrepForTarget } from '../referencePrep/referencePrepRunner';
import type { ReferencePrepResultsProvider } from '../referencePrep/referencePrepResultsView';
import { setReferenceHitVisible } from '../ui/sidebarViewVisibility';
import { loadReferencePrepLastRun, saveReferencePrepLastRun } from '../referencePrep/runPreferences';
import { pickReferencePrepContinuation } from '../referencePrep/continuation';
import { listProcessRecords } from '../referencePrep/processFile';
import {
    REFERENCE_PREP_STRENGTH_OPTIONS,
    REFERENCE_SOURCE_OPTIONS,
} from '../referencePrep/referencePrepSession';
import type { PrepEventListener } from '../referencePrep/prepEvents';
import { WebviewManager } from '../ui/webviewManager';

export interface PrepForSelectionParams {
    target: string;
    anchorPath: string;
    context: vscode.ExtensionContext;
    enabledSources: ReferenceSourceId[];
    strength: ReferencePrepStrength;
    freshProcess?: boolean;
    continuation?: boolean;
    maxRoundsOverride?: number;
    recordId?: string;
    onProgress?: (msg: string) => void;
    onEvent?: PrepEventListener;
    token?: vscode.CancellationToken;
    /** 是否打开 mergedReference 未保存预览（默认否；结果见侧栏/检索面板） */
    openMergedPreview?: boolean;
    showInformationMessage?: boolean;
}

export class ReferencePrepCommandHandler {
    constructor(
        _webviewManager: WebviewManager,
        private resultsProvider?: ReferencePrepResultsProvider
    ) {}

    private async showResultsTree(anchorPath: string, process: ReferencePrepProcessFileV020): Promise<void> {
        if (!this.resultsProvider) return;
        await setReferenceHitVisible(true);
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
                title: '检索强度',
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

    /**
     * 选段准备参考资料（与 prepareReferencesJson 对称）。
     * 检索面板、命令面板共用。
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
            prepOrigin: 'selection',
            freshProcess: params.freshProcess ?? true,
            continuation: params.continuation,
            maxRoundsOverride: params.maxRoundsOverride,
            recordId: params.recordId,
            onProgress: params.onProgress,
            onEvent: params.onEvent,
            token: params.token,
            onProcessUpdated: (proc) => this.resultsProvider?.refresh(proc, params.anchorPath),
        });
        await this.showResultsTree(params.anchorPath, process);

        if (params.openMergedPreview === true && mergedReference) {
            const doc = await vscode.workspace.openTextDocument({
                content: mergedReference,
                language: 'markdown',
            });
            await vscode.window.showTextDocument(doc, { preview: true });
        }
        if (params.showInformationMessage !== false) {
            vscode.window.showInformationMessage(
                mergedReference
                    ? '参考资料已准备完成（见侧栏「资料检索」；可在检索面板勾选导出）。'
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
        if (editor.document.languageId === 'json') {
            vscode.window.showErrorMessage(
                'JSON 文件请使用「当前 JSON 文件」模式或「准备参考资料（JSON）」；选段模式仅用于 Markdown 等文稿。'
            );
            return;
        }
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
                        recordId: cont.recordId,
                        onProgress: (m) => _p.report({ message: m }),
                        onEvent: options?.onEvent,
                        token,
                    })
            );
        } catch (e) {
            ErrorUtils.showError(e, '准备参考资料失败：');
        }
    }

    /**
     * JSON：准备参考资料（只写过程文件，不自动写入源 JSON 的 reference）。
     * 校对请另用校对面板；命中勾选导出/合并请在检索面板完成。
     */
    async handlePrepareReferencesJson(
        jsonFilePath: string,
        context: vscode.ExtensionContext,
        options?: {
            onEvent?: PrepEventListener;
            skipPicks?: boolean;
            enabledSources?: ReferenceSourceId[];
            strength?: ReferencePrepStrength;
            token?: vscode.CancellationToken;
            skipExistingReference?: boolean;
        }
    ): Promise<void> {
        let enabledSources = options?.enabledSources;
        let strength = options?.strength;

        if (!options?.skipPicks || !enabledSources || !strength) {
            const prep = await this.pickPrepSourcesAndStrength(context);
            if (!prep) return;
            enabledSources = prep.enabledSources;
            strength = prep.strength;
        }

        try {
            const content = fs.readFileSync(jsonFilePath, 'utf8');
            const parsed = JSON.parse(content);
            if (!Array.isArray(parsed)) {
                throw new Error('JSON 格式不正确');
            }

            let lastProcess: ReferencePrepProcessFileV020 | undefined;
            const stats = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: options?.skipExistingReference
                        ? '继续准备参考资料（跳过已有过程）'
                        : '批量准备参考资料',
                    cancellable: true,
                },
                async (_p, progressToken) => {
                    const linked = new vscode.CancellationTokenSource();
                    const disposables = [
                        progressToken.onCancellationRequested(() => linked.cancel()),
                    ];
                    if (options?.token) {
                        if (options.token.isCancellationRequested) {
                            linked.cancel();
                        } else {
                            disposables.push(
                                options.token.onCancellationRequested(() => linked.cancel())
                            );
                        }
                    }
                    try {
                        return await runReferencePrepForJsonFile({
                            jsonFilePath,
                            context,
                            enabledSources: enabledSources!,
                            strength: strength!,
                            skipExistingReference: options?.skipExistingReference,
                            onProgress: (m) => _p.report({ message: m }),
                            onEvent: options?.onEvent,
                            token: linked.token,
                            onAfterJsonItem: () => {},
                            onProcessUpdated: (proc) => {
                                lastProcess = proc;
                                this.resultsProvider?.refresh(proc, jsonFilePath);
                            },
                        });
                    } finally {
                        for (const d of disposables) {
                            d.dispose();
                        }
                        linked.dispose();
                    }
                }
            );

            if (lastProcess) {
                const all = listProcessRecords(jsonFilePath, { origin: 'json_item' }).filter(
                    (r) => r.corpus.length > 0 || r.rounds.length > 0
                );
                if (all.length > 1) {
                    await setReferenceHitVisible(true);
                    this.resultsProvider?.refreshRecords(all, jsonFilePath);
                } else {
                    await this.showResultsTree(jsonFilePath, lastProcess);
                }
            }

            const skipPart =
                stats.skipped > 0 ? `，跳过 ${stats.skipped} 条` : '';
            if (stats.cancelled) {
                vscode.window.showInformationMessage(
                    `参考资料准备已中断：完成 ${stats.processed}/${stats.total} 条${skipPart}。可在检索面板点「继续未完成部分」接着跑。`
                );
            } else {
                vscode.window.showInformationMessage(
                    `参考资料准备完成：${stats.processed}/${stats.total} 条${skipPart}（见侧栏「资料检索」；需写入条目时请在检索面板勾选后合并到源 JSON）。`
                );
            }
        } catch (e) {
            ErrorUtils.showError(e, '准备参考资料失败：');
        }
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
