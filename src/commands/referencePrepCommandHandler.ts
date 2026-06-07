import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConfigManager, ErrorUtils, FilePathUtils } from '../utils';
import { proofreadSelection } from '../proofreader';
import { getPromptDisplayName } from '../promptManager';
import { showSelectionProofreadDiffWithApply } from '../differ';
import { runEditorialMemoryAfterAccept } from '../editorialMemory/service';
import {
    pickProofreadPromptForKnowledgeVerify,
    withTemporaryProofreadPrompt,
} from '../proofreadPromptPick';
import type { ReferencePrepStrength, ReferenceSourceId } from '../referencePrep/schema';
import { getDefaultEnabledSources, runReferencePrepForJsonFile, runReferencePrepForTarget } from '../referencePrep/referencePrepRunner';
import type { ReferencePrepResultsProvider } from '../referencePrep/referencePrepResultsView';
import { loadReferencePrepLastRun, saveReferencePrepLastRun } from '../referencePrep/runPreferences';
import { WebviewManager } from '../ui/webviewManager';
import type { ProofreadCommandHandler } from './proofreadCommandHandler';

const SOURCE_OPTIONS: Array<{ id: ReferenceSourceId; label: string; description: string }> = [
    { id: 'dict', label: '本地词典', description: 'MDict 本地词典查词' },
    { id: 'grep_md', label: '参考文献 grep', description: '在 references 目录 md/txt 中字面检索' },
    { id: 'bm25', label: 'BM25/FTS', description: '需先建立引文索引；语义关键词检索' },
    { id: 'vector', label: '轻量向量', description: '字符 n-gram 相似度；懒构建向量索引' },
];

const STRENGTH_OPTIONS: Array<{ label: string; description: string; value: ReferencePrepStrength }> = [
    { label: '轻量', description: '1 轮，较少查询', value: 'light' },
    { label: '标准', description: '3 轮', value: 'standard' },
    { label: '深入', description: '5 轮，更多查询', value: 'thorough' },
];

export class ReferencePrepCommandHandler {
    private configManager = ConfigManager.getInstance();

    constructor(
        private webviewManager: WebviewManager,
        private proofreadHandler?: ProofreadCommandHandler,
        private resultsProvider?: ReferencePrepResultsProvider
    ) {}

    private async showResultsTree(anchorPath: string, process: import('../referencePrep/schema').ReferencePrepProcessFileV020): Promise<void> {
        if (!this.resultsProvider) return;
        await vscode.commands.executeCommand('setContext', 'aiProofread.showReferencePrepResultsView', true);
        this.resultsProvider.refresh(process, anchorPath);
    }

    async pickRunOptions(context: vscode.ExtensionContext): Promise<
        | {
              enabledSources: ReferenceSourceId[];
              strength: ReferencePrepStrength;
              runProofread: boolean;
              proofreadPromptName?: string;
          }
        | undefined
    > {
        const last = loadReferencePrepLastRun(context);
        const configDefaults = getDefaultEnabledSources();
        const defaultSourceIds = last.enabledSources.length > 0 ? last.enabledSources : configDefaults;

        const pickedSources = await vscode.window.showQuickPick(
            SOURCE_OPTIONS.map((o) => ({
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

        const strengthPick = await vscode.window.showQuickPick(
            STRENGTH_OPTIONS.map((o) => ({
                ...o,
                picked: o.value === last.strength,
            })),
            {
                title: '核查强度',
                placeHolder: `上次：${STRENGTH_OPTIONS.find((s) => s.value === last.strength)?.label ?? '标准'}`,
                ignoreFocusOut: true,
            }
        );
        if (!strengthPick) return undefined;

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

        await saveReferencePrepLastRun(context, {
            enabledSources,
            strength: strengthPick.value,
        });

        return {
            enabledSources,
            strength: strengthPick.value,
            runProofread,
            proofreadPromptName,
        };
    }

    /** 选段：准备参考资料，可选接着校对 */
    async handleKnowledgeVerifySelection(
        editor: vscode.TextEditor,
        context: vscode.ExtensionContext
    ): Promise<void> {
        const opts = await this.pickRunOptions(context);
        if (!opts) return;

        const selectedText = editor.document.getText(editor.selection);
        if (!selectedText.trim()) {
            vscode.window.showErrorMessage('请先选择要核查的文本。');
            return;
        }

        const anchorPath = editor.document.uri.fsPath;

        try {
            const { mergedReference, process } = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: '参考资料准备',
                    cancellable: true,
                },
                async (_p, token) =>
                    runReferencePrepForTarget({
                        target: selectedText,
                        anchorPath,
                        context,
                        enabledSources: opts.enabledSources,
                        strength: opts.strength,
                        freshProcess: true,
                        onProgress: (m) => _p.report({ message: m }),
                        token,
                        onProcessUpdated: (proc) => this.resultsProvider?.refresh(proc, anchorPath),
                    })
            );
            await this.showResultsTree(anchorPath, process);

            if (!opts.runProofread) {
                if (mergedReference) {
                    const doc = await vscode.workspace.openTextDocument({
                        content: mergedReference,
                        language: 'markdown',
                    });
                    await vscode.window.showTextDocument(doc, { preview: true });
                }
                vscode.window.showInformationMessage(
                    mergedReference
                        ? '参考资料已准备完成（已打开预览）。'
                        : '参考资料准备完成，未检索到命中。'
                );
                return;
            }

            const promptStorageName = opts.proofreadPromptName!;
            await withTemporaryProofreadPrompt(context, promptStorageName, () =>
                this.runProofreadSelectionWithInlineReference(
                    editor,
                    context,
                    mergedReference,
                    getPromptDisplayName(promptStorageName)
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

        const platform = this.configManager.getPlatform();
        const model = this.configManager.getModel(platform);
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
    async handlePrepareReferencesJson(jsonFilePath: string, context: vscode.ExtensionContext): Promise<void> {
        const opts = await this.pickRunOptions(context);
        if (!opts) return;

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
                        enabledSources: opts.enabledSources,
                        strength: opts.strength,
                        onProgress: (m) => _p.report({ message: m }),
                        token,
                        onAfterJsonItem: () => {},
                    })
            );
            vscode.window.showInformationMessage(
                `参考资料准备完成：${stats.processed}/${stats.total} 条`
            );

            if (opts.runProofread) {
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
