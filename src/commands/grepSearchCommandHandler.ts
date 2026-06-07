import * as vscode from 'vscode';
import { ErrorUtils } from '../utils';
import type { ReferencePrepStrength } from '../referencePrep/schema';
import {
    resolveGrepSearchAnchorPath,
    runLlmGrepSearch,
    summarizeGrepPatterns,
} from '../referencePrep/grep/grepSearchRunner';
import type { ReferencePrepResultsProvider } from '../referencePrep/referencePrepResultsView';
import { pickReferencePrepContinuation } from '../referencePrep/continuation';

const STRENGTH_OPTIONS: Array<{ label: string; description: string; value: ReferencePrepStrength }> = [
    { label: '轻量', description: '1 轮，较少命中', value: 'light' },
    { label: '标准', description: '3 轮', value: 'standard' },
    { label: '深入', description: '5 轮，更多命中', value: 'thorough' },
];

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
            prompt: '描述你想在参考文献中检索的内容（可含专名、主题、史实要点等）',
            placeHolder: '例如：查找关于李白生卒年与籍贯的记述',
            value: defaultDescription || undefined,
            ignoreFocusOut: true,
            validateInput: (v) => (v.trim() ? null : '请输入检索描述'),
        });
        if (!description?.trim()) return;

        const strengthPick = await vscode.window.showQuickPick(
            STRENGTH_OPTIONS.map((o) => ({ ...o, picked: o.value === 'standard' })),
            {
                title: '检索强度',
                placeHolder: '与 knowledge verify 相同：控制轮次、查询数与命中预算',
                ignoreFocusOut: true,
            }
        );
        if (!strengthPick) return;

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
                    title: cont.continuation ? '参考文献 LLM 检索（续跑）' : '参考文献 LLM 检索',
                    cancellable: true,
                },
                async (progress, token) =>
                    runLlmGrepSearch({
                        description: runDescription,
                        strength: strengthPick.value,
                        context,
                        anchorPath: runAnchor,
                        freshProcess: cont.freshProcess,
                        continuation: cont.continuation,
                        maxRoundsOverride: cont.maxRoundsOverride,
                        onProgress: (m) => progress.report({ message: m }),
                        token,
                    })
            );

            if (this.resultsProvider) {
                await vscode.commands.executeCommand('setContext', 'aiProofread.showReferencePrepResultsView', true);
                this.resultsProvider.refresh(process, runAnchor);
            }

            if (mergedReference) {
                const doc = await vscode.workspace.openTextDocument({
                    content: mergedReference,
                    language: 'markdown',
                });
                await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
            }

            const patternSummary = summarizeGrepPatterns(process);
            const roundCount = process.rounds.length;
            vscode.window.showInformationMessage(
                mergedReference
                    ? `检索完成：${hits.length} 条命中，${roundCount} 轮（关键词：${patternSummary}）`
                    : `检索完成，未命中（${roundCount} 轮；关键词：${patternSummary}）`
            );
        } catch (e) {
            ErrorUtils.showError(e, '参考文献检索失败：');
        }
    }
}
