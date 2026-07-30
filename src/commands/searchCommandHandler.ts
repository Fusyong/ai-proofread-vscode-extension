import * as vscode from 'vscode';
import { ErrorUtils } from '../utils';
import {
    pickReferencePrepStrength,
    presentReferencePrepSessionResult,
    resolveEditorAnchorPath,
    runReferencePrepSession,
    summarizeSessionPatterns,
} from '../referencePrep/referencePrepSession';
import { pickReferencePrepContinuation } from '../referencePrep/continuation';
import type { ReferencePrepResultsProvider } from '../referencePrep/referencePrepResultsView';
import type { ReferenceSourceId } from '../referencePrep/schema';
import type { ReferencePrepTargetKind } from '../referencePrep/referencePrepPrompt';
import type { PrepEventListener } from '../referencePrep/prepEvents';
import { isWebSearchConfigured } from '../referencePrep/retrieval/webAdapter';

export interface SingleSourceSearchOptions {
    sources: ReferenceSourceId[];
    title: string;
    targetKind?: ReferencePrepTargetKind;
    /** 若为 true，无选区时用 InputBox；否则要求选区 */
    allowInputBox?: boolean;
    inputPrompt?: string;
    inputPlaceholder?: string;
    /** @deprecated 不再打开未保存合并预览 */
    openMergedBeside?: boolean;
    onEvent?: PrepEventListener;
    /** 跳过强度 QuickPick，使用固定强度 */
    strength?: import('../referencePrep/schema').ReferencePrepStrength;
    /** 跳过续跑对话框时使用 */
    skipContinuation?: boolean;
}

/**
 * 单源 / 固定来源检索统一壳：解析目标 → 强度 → 续跑 → referencePrepSession → 呈现结果。
 */
export async function runSingleSourceSearch(
    editor: vscode.TextEditor | undefined,
    context: vscode.ExtensionContext,
    resultsProvider: ReferencePrepResultsProvider | undefined,
    options: SingleSourceSearchOptions
): Promise<void> {
    if (options.sources.includes('web') && !isWebSearchConfigured()) {
        vscode.window.showWarningMessage(
            'Web 搜索尚未配置适配器。请在设置中等待后续版本，或改用词典 / 参考文献 / 维基百科。'
        );
        return;
    }

    const selection = editor ? editor.document.getText(editor.selection).trim() : '';
    let target = selection;

    if (!target) {
        if (!options.allowInputBox) {
            vscode.window.showErrorMessage('请先选择要检索的文本。');
            return;
        }
        const description = await vscode.window.showInputBox({
            title: options.title,
            prompt: options.inputPrompt ?? '描述检索意图或输入关键词',
            placeHolder: options.inputPlaceholder ?? '例如：李白 籍贯',
            ignoreFocusOut: true,
            validateInput: (v) => (v.trim() ? null : '请输入检索内容'),
        });
        if (!description?.trim()) return;
        target = description.trim();
    } else if (options.allowInputBox) {
        const description = await vscode.window.showInputBox({
            title: options.title,
            prompt: options.inputPrompt ?? '可修改检索描述（默认使用选区）',
            placeHolder: options.inputPlaceholder,
            value: selection,
            ignoreFocusOut: true,
            validateInput: (v) => (v.trim() ? null : '请输入检索内容'),
        });
        if (!description?.trim()) return;
        target = description.trim();
    }

    const strength =
        options.strength ?? (await pickReferencePrepStrength(options.title));
    if (!strength) return;

    const anchorPath = resolveEditorAnchorPath(editor, 'search-session.md');
    let runTarget = target;
    let runAnchor = anchorPath;
    let freshProcess = true;
    let continuation = false;
    let maxRoundsOverride: number | undefined;

    if (!options.skipContinuation) {
        const cont = await pickReferencePrepContinuation({
            context,
            anchorPath,
            target,
            title: options.title,
        });
        if (!cont) return;
        runAnchor = cont.anchorPath;
        freshProcess = cont.freshProcess;
        continuation = cont.continuation;
        maxRoundsOverride = cont.maxRoundsOverride;
        if (cont.targetOverride) runTarget = cont.targetOverride;
    }

    try {
        const { mergedReference, hits, process } = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: continuation ? `${options.title}（续跑）` : options.title,
                cancellable: true,
            },
            async (progress, token) =>
                runReferencePrepSession({
                    target: runTarget,
                    targetKind: options.targetKind ?? 'search_intent',
                    strength,
                    context,
                    anchorPath: runAnchor,
                    enabledSources: options.sources,
                    freshProcess,
                    continuation,
                    maxRoundsOverride,
                    onProgress: (m) => progress.report({ message: m }),
                    onEvent: options.onEvent,
                    token,
                    onProcessUpdated: (proc) => resultsProvider?.refresh(proc, runAnchor),
                })
        );

        const patternSummary = summarizeSessionPatterns(process);
        const roundCount = process.rounds.length;
        await presentReferencePrepSessionResult({
            resultsProvider,
            anchorPath: runAnchor,
            process,
            mergedReference,
            openMergedBeside: options.openMergedBeside ?? false,
            informationMessage: mergedReference
                ? `检索完成：${hits.length} 条命中，${roundCount} 轮（关键词：${patternSummary}）`
                : `检索完成，未命中（${roundCount} 轮；关键词：${patternSummary}）`,
        });
    } catch (e) {
        ErrorUtils.showError(e, `${options.title}失败：`);
    }
}

export class SearchCommandHandler {
    constructor(private resultsProvider?: ReferencePrepResultsProvider) {}

    handleDictPrep(
        editor: vscode.TextEditor | undefined,
        context: vscode.ExtensionContext
    ): Promise<void> {
        return runSingleSourceSearch(editor, context, this.resultsProvider, {
            sources: ['dict'],
            title: '词典规划检索',
            allowInputBox: true,
            inputPrompt: '描述要用词典查证的内容（默认可用选区）',
            targetKind: 'search_intent',
        });
    }

    handleRefsGrep(
        editor: vscode.TextEditor | undefined,
        context: vscode.ExtensionContext
    ): Promise<void> {
        return runSingleSourceSearch(editor, context, this.resultsProvider, {
            sources: ['grep_md'],
            title: '参考文献 grep 检索',
            allowInputBox: true,
            targetKind: 'search_intent',
        });
    }

    handleRefsBm25(
        editor: vscode.TextEditor | undefined,
        context: vscode.ExtensionContext
    ): Promise<void> {
        return runSingleSourceSearch(editor, context, this.resultsProvider, {
            sources: ['bm25'],
            title: '参考文献 BM25 检索',
            allowInputBox: true,
            targetKind: 'search_intent',
        });
    }

    handleRefsVector(
        editor: vscode.TextEditor | undefined,
        context: vscode.ExtensionContext
    ): Promise<void> {
        return runSingleSourceSearch(editor, context, this.resultsProvider, {
            sources: ['vector'],
            title: '参考文献向量检索',
            allowInputBox: true,
            targetKind: 'search_intent',
        });
    }

    handleWikipedia(
        editor: vscode.TextEditor | undefined,
        context: vscode.ExtensionContext
    ): Promise<void> {
        return runSingleSourceSearch(editor, context, this.resultsProvider, {
            sources: ['wikipedia'],
            title: '维基百科检索',
            allowInputBox: true,
            inputPrompt: '输入要查询的专名或主题',
            targetKind: 'search_intent',
        });
    }

    handleWeb(
        editor: vscode.TextEditor | undefined,
        context: vscode.ExtensionContext
    ): Promise<void> {
        return runSingleSourceSearch(editor, context, this.resultsProvider, {
            sources: ['web'],
            title: 'Web 搜索',
            allowInputBox: true,
            targetKind: 'search_intent',
        });
    }
}
