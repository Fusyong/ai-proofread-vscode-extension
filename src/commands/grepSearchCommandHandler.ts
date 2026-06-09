import * as vscode from 'vscode';
import { ErrorUtils } from '../utils';
import {
    pickReferencePrepStrength,
    presentReferencePrepSessionResult,
    summarizeSessionPatterns,
} from '../referencePrep/referencePrepSession';
import { resolveGrepSearchAnchorPath, runLlmGrepSearch } from '../referencePrep/grep/grepSearchRunner';
import type { ReferencePrepResultsProvider } from '../referencePrep/referencePrepResultsView';
import { pickReferencePrepContinuation } from '../referencePrep/continuation';

export class GrepSearchCommandHandler {
    constructor(private resultsProvider?: ReferencePrepResultsProvider) {}

    async handleLlmGrepSearchCommand(
        editor: vscode.TextEditor | undefined,
        context: vscode.ExtensionContext
    ): Promise<void> {
        const defaultDescription = editor
            ? editor.document.getText(editor.selection).trim()
            : '';

        const description = await vscode.window.showInputBox({
            title: 'LLM 增强参考文献检索',
            prompt: '描述你想在词典与参考文献中检索的内容（可含专名、主题、史实要点等）',
            placeHolder: '例如：查找关于李白生卒年与籍贯的记述',
            value: defaultDescription || undefined,
            ignoreFocusOut: true,
            validateInput: (v) => (v.trim() ? null : '请输入检索描述'),
        });
        if (!description?.trim()) return;

        const strength = await pickReferencePrepStrength('LLM 增强参考文献检索');
        if (!strength) return;

        try {
            const anchorPath = resolveGrepSearchAnchorPath(editor);
            const cont = await pickReferencePrepContinuation({
                context,
                anchorPath,
                target: description.trim(),
                title: 'LLM 增强参考文献检索',
            });
            if (!cont) return;

            const runDescription = cont.targetOverride ?? description.trim();
            const runAnchor = cont.anchorPath;

            const { mergedReference, hits, process } = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: cont.continuation ? '参考资料准备（续跑）' : '参考资料准备',
                    cancellable: true,
                },
                async (progress, token) =>
                    runLlmGrepSearch({
                        description: runDescription,
                        strength,
                        context,
                        anchorPath: runAnchor,
                        freshProcess: cont.freshProcess,
                        continuation: cont.continuation,
                        maxRoundsOverride: cont.maxRoundsOverride,
                        onProgress: (m) => progress.report({ message: m }),
                        token,
                    })
            );

            const patternSummary = summarizeSessionPatterns(process);
            const roundCount = process.rounds.length;
            await presentReferencePrepSessionResult({
                resultsProvider: this.resultsProvider,
                anchorPath: runAnchor,
                process,
                mergedReference,
                openMergedBeside: true,
                informationMessage: mergedReference
                    ? `检索完成：${hits.length} 条命中，${roundCount} 轮（关键词：${patternSummary}）`
                    : `检索完成，未命中（${roundCount} 轮；关键词：${patternSummary}）`,
            });
        } catch (e) {
            ErrorUtils.showError(e, '参考文献检索失败：');
        }
    }
}
