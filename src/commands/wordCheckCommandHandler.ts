/**
 * 检查字词：命令入口（检查字词、上一处、下一处、查看说明、应用替换、管理自定义表）
 * 规划见 docs/xh7-word-check-plan.md、docs/custom-word-check-plan.md
 */

import * as vscode from 'vscode';
import type { WordCheckEntry } from '../xh7/types';
import type { CustomTable } from '../xh7/types';
import type { WordCheckTreeDataProvider } from '../xh7/wordCheckTreeProvider';
import {
    registerWordCheckView,
    focusWordCheckView,
    getLastSelectedEntry,
    getCurrentOccurrenceIndex,
    setCurrentOccurrenceIndex,
} from '../xh7/wordCheckView';
import { initTableLoader, getDict } from '../xh7/tableLoader';
import { scanDocument } from '../xh7/documentScanner';
import { formatFullNotesAsHtml } from '../xh7/notesResolver';
import { CHECK_TYPE_LABELS, type CheckType } from '../xh7/types';
import {
    initCustomTableCache,
    getCustomTables,
    addCustomTableFromFile,
    removeCustomTable,
    setCustomTableEnabled,
} from '../xh7/customTableCache';
import { scanDocumentWithCustomTable } from '../xh7/documentScannerCustom';
import { applyReplaceInDocument } from '../xh7/applyReplace';
import * as path from 'path';

const VIEW_BASE_TITLE = 'checkWords';

const KEY_LAST_SELECTED_TABLE_IDS = 'ai-proofread.wordCheck.lastSelectedTableIds';
const KEY_LAST_ADD_FOLDER = 'ai-proofread.wordCheck.lastAddFolder';
const KEY_LAST_IS_REGEX = 'ai-proofread.wordCheck.lastIsRegex';
const KEY_LAST_MANAGED_TABLE_ID = 'ai-proofread.wordCheck.lastManagedTableId';

export class WordCheckCommandHandler {
    private treeView: vscode.TreeView<WordCheckEntry> | null = null;
    private treeProvider: WordCheckTreeDataProvider | null = null;

    constructor(private context: vscode.ExtensionContext) {
        initTableLoader(context);
        initCustomTableCache(context);
    }

    /** 注册视图并绑定选中回调；返回 provider 与 treeView 供扩展注册命令时使用 */
    registerView(): { provider: WordCheckTreeDataProvider; treeView: vscode.TreeView<WordCheckEntry> } {
        const reg = registerWordCheckView(this.context, (entry, index) => this.revealEntryAt(entry, index, true));
        this.treeProvider = reg.provider;
        this.treeView = reg.treeView;
        return reg;
    }

    private updateViewTitle(entryCount: number, occurrenceCount: number): void {
        if (this.treeView) {
            this.treeView.title = `${VIEW_BASE_TITLE} (${entryCount} 条 / ${occurrenceCount} 处)`;
        }
    }

    /**
     * 在编辑器中揭示并选中某条目的第 index 处。
     * @param preserveFocus true 时仅滚动/选中，焦点留在树（便于用方向键浏览）；false 时激活编辑器。
     */
    private revealEntryAt(entry: WordCheckEntry, index: number, preserveFocus = true): void {
        if (entry.ranges.length === 0) return;
        const docUri = this.treeProvider?.getDocumentUri();
        if (!docUri) return;
        const idx = ((index % entry.ranges.length) + entry.ranges.length) % entry.ranges.length;
        const range = entry.ranges[idx];
        setCurrentOccurrenceIndex(idx);
        vscode.window.showTextDocument(docUri, { selection: range, preserveFocus }).then((editor) => {
            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
            editor.selection = new vscode.Selection(range.start, range.end);
        });
    }

    async handleCheckWordsCommand(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('请先打开要检查的文档。');
            return;
        }

        const branch = await vscode.window.showQuickPick(
            [
                { label: '预置检查', value: 'preset' as const },
                { label: '自定义检查', value: 'custom' as const },
            ],
            { placeHolder: '选择检查方式', title: '检查字词' }
        );
        if (!branch) return;

        if (branch.value === 'preset') {
            await this.runPresetCheck(editor);
            return;
        }
        await this.runCustomCheck(editor);
    }

    private async runPresetCheck(editor: vscode.TextEditor): Promise<void> {
        const typeChoices = await vscode.window.showQuickPick(
            (Object.entries(CHECK_TYPE_LABELS) as [CheckType, string][]).map(([value, label]) => ({
                label,
                value,
                picked: value === 'variant_to_standard',
            })),
            { placeHolder: '勾选要检查的类型（可多选）', title: '预置检查', canPickMany: true }
        );
        if (!typeChoices?.length) return;

        const checkTypes = typeChoices.map((c) => c.value as CheckType);
        const scanRange = editor.selection.isEmpty ? undefined : new vscode.Range(editor.selection.start, editor.selection.end);

        try {
            const entries = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: scanRange ? '字词检查（选中范围）' : '字词检查',
                    cancellable: true,
                },
                async (progress, cancelToken) => {
                    const merged = new Map<string, WordCheckEntry>();
                    for (let i = 0; i < checkTypes.length; i++) {
                        if (cancelToken.isCancellationRequested) break;
                        const type = checkTypes[i];
                        progress.report({ message: `加载字词表 (${i + 1}/${checkTypes.length})…` });
                        const dict = getDict(type);
                        if (Object.keys(dict).length === 0) continue;
                        progress.report({ message: scanRange ? '扫描选中文本…' : '扫描文档…' });
                        const list = scanDocument(editor.document, dict, cancelToken, scanRange);
                        for (const e of list) {
                            const key = `${e.variant}|${e.preferred}`;
                            const existing = merged.get(key);
                            if (existing) {
                                existing.ranges.push(...e.ranges);
                            } else {
                                merged.set(key, { ...e, ranges: [...e.ranges] });
                            }
                        }
                    }
                    return Array.from(merged.values());
                }
            );

            if (!this.treeProvider) return;
            this.treeProvider.refresh(entries, editor.document.uri);
            const totalOccurrences = entries.reduce((s, e) => s + e.ranges.length, 0);
            this.updateViewTitle(entries.length, totalOccurrences);
            await focusWordCheckView();
            if (entries.length === 0) {
                vscode.window.showInformationMessage('当前文档中未发现需要提示的字词。');
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(`字词检查失败：${msg}`);
            if (this.treeProvider) {
                this.treeProvider.refresh([], null);
                this.updateViewTitle(0, 0);
            }
        }
    }

    private async runCustomCheck(editor: vscode.TextEditor): Promise<void> {
        const scanRange = editor.selection.isEmpty ? undefined : new vscode.Range(editor.selection.start, editor.selection.end);
        let selectedTables: CustomTable[] = [];

        const lastSelectedIds = this.context.workspaceState.get<string[]>(KEY_LAST_SELECTED_TABLE_IDS) ?? [];

        for (;;) {
            const tables = getCustomTables();
            const tableItems = tables.map((t) => ({
                label: t.name,
                description: t.isRegex ? `正则 · ${t.rules.length} 条` : `字面 · ${t.rules.length} 条`,
                table: t,
                picked: lastSelectedIds.includes(t.id),
            }));
            type TablePickItem = { label: string; description?: string; table: CustomTable | null; picked?: boolean };
            const pick = await vscode.window.showQuickPick<TablePickItem>(
                [
                    ...tableItems.map((t) => ({
                        label: t.label,
                        description: t.description,
                        table: t.table,
                        picked: t.picked,
                    })),
                    { label: '$(file-add) 加载新表…', table: null },
                    { label: '$(settings-gear) 管理自定义表…', table: null },
                ],
                {
                    placeHolder: '勾选要参与检查的表（可多选）',
                    title: '自定义检查',
                    canPickMany: true,
                }
            );
            if (!pick?.length) return;

            const loadNew = pick.some((p) => p.label === '$(file-add) 加载新表…');
            const manage = pick.some((p) => p.label === '$(settings-gear) 管理自定义表…');
            selectedTables = pick.filter((p): p is TablePickItem & { table: CustomTable } => p.table != null).map((p) => p.table);

            if (loadNew) {
                const lastFolder = this.context.workspaceState.get<string>(KEY_LAST_ADD_FOLDER);
                const defaultUri = lastFolder ? vscode.Uri.file(lastFolder) : undefined;
                const uris = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    filters: { '替换表': ['txt', 'json'] },
                    defaultUri,
                });
                if (uris?.length) {
                    const parentFolder = path.dirname(uris[0].fsPath);
                    await this.context.workspaceState.update(KEY_LAST_ADD_FOLDER, parentFolder);

                    const lastIsRegex = this.context.workspaceState.get<boolean>(KEY_LAST_IS_REGEX);
                    const isRegex = await vscode.window.showQuickPick(
                        [
                            { label: '正则替换表', value: true, picked: lastIsRegex === true },
                            { label: '非正则替换表', value: false, picked: lastIsRegex === false },
                        ],
                        { placeHolder: '选择表类型' }
                    );
                    if (isRegex != null) {
                        await this.context.workspaceState.update(KEY_LAST_IS_REGEX, isRegex.value);
                        const { table, errors } = addCustomTableFromFile(uris[0].fsPath, isRegex.value);
                        if (table) {
                            vscode.window.showInformationMessage(`已加载「${table.name}」`);
                            if (errors.length) {
                                vscode.window.showWarningMessage(`部分规则编译失败：${errors.join('；')}`);
                            }
                        } else {
                            vscode.window.showErrorMessage(errors[0] ?? '加载失败');
                        }
                    }
                }
                continue;
            }
            if (manage) {
                await this.handleManageCustomTablesCommand();
                continue;
            }
            if (selectedTables.length === 0) {
                vscode.window.showWarningMessage('请至少勾选一张表。');
                continue;
            }
            await this.context.workspaceState.update(
                KEY_LAST_SELECTED_TABLE_IDS,
                selectedTables.map((t) => t.id)
            );
            break;
        }

        const applyMode = await vscode.window.showQuickPick(
            [
                { label: '应用为提示', value: 'hint' as const },
                { label: '应用为替换', value: 'replace' as const },
            ],
            { placeHolder: '选择应用方式', title: '自定义检查' }
        );
        if (!applyMode) return;

        let prefix = '';
        let suffix = '';
        if (applyMode.value === 'replace') {
            const pre = await vscode.window.showInputBox({
                title: '替换结果前标记',
                placeHolder: '可为空，如 【',
                value: '',
            });
            if (pre === undefined) return;
            const suf = await vscode.window.showInputBox({
                title: '替换结果后标记',
                placeHolder: '可为空，如 】',
                value: '',
            });
            if (suf === undefined) return;
            prefix = pre ?? '';
            suffix = suf ?? '';
        }

        try {
            const entries = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: scanRange ? '字词检查（选中范围）' : '字词检查',
                    cancellable: true,
                },
                async (progress, cancelToken) => {
                    const merged = new Map<string, WordCheckEntry>();
                    for (let i = 0; i < selectedTables.length; i++) {
                        if (cancelToken.isCancellationRequested) break;
                        const table = selectedTables[i];
                        progress.report({ message: `扫描表 (${i + 1}/${selectedTables.length}) ${table.name}…` });
                        const list = scanDocumentWithCustomTable(editor.document, table, cancelToken, scanRange);
                        for (const e of list) {
                            const key = `${e.variant}|${e.preferred}`;
                            const existing = merged.get(key);
                            if (existing) {
                                existing.ranges.push(...e.ranges);
                            } else {
                                merged.set(key, { ...e, ranges: [...e.ranges] });
                            }
                        }
                    }
                    return Array.from(merged.values());
                }
            );

            if (!this.treeProvider) return;
            this.treeProvider.refresh(entries, editor.document.uri);
            const totalOccurrences = entries.reduce((s, e) => s + e.ranges.length, 0);
            this.updateViewTitle(entries.length, totalOccurrences);
            await focusWordCheckView();

            if (applyMode.value === 'replace' && entries.length > 0) {
                const ok = await applyReplaceInDocument(editor, entries, prefix, suffix);
                if (ok) {
                    vscode.window.showInformationMessage(`已替换 ${totalOccurrences} 处。`);
                    this.treeProvider.refresh([], null);
                    this.updateViewTitle(0, 0);
                } else {
                    vscode.window.showErrorMessage('替换失败');
                }
            } else if (entries.length === 0) {
                vscode.window.showInformationMessage('当前文档中未发现需要提示的字词。');
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(`字词检查失败：${msg}`);
            if (this.treeProvider) {
                this.treeProvider.refresh([], null);
                this.updateViewTitle(0, 0);
            }
        }
    }

    async handleManageCustomTablesCommand(): Promise<void> {
        const tables = getCustomTables();
        if (tables.length === 0) {
            vscode.window.showInformationMessage('暂无自定义表，请先在「检查字词 → 自定义检查」中加载新表。');
            return;
        }
        const lastManagedId = this.context.workspaceState.get<string>(KEY_LAST_MANAGED_TABLE_ID);
        const sorted = [...tables].sort((a, b) => {
            if (a.id === lastManagedId) return -1;
            if (b.id === lastManagedId) return 1;
            return 0;
        });
        const choice = await vscode.window.showQuickPick(
            sorted.map((t) => ({
                label: t.name,
                description: `${t.isRegex ? '正则' : '字面'} · ${t.enabled ? '已启用' : '未启用'}`,
                table: t,
            })),
            { placeHolder: '选择要管理的表', title: '管理自定义表' }
        );
        if (!choice) return;
        await this.context.workspaceState.update(KEY_LAST_MANAGED_TABLE_ID, choice.table.id);
        const action = await vscode.window.showQuickPick(
            [
                { label: '删除', value: 'delete' as const },
                { label: choice.table.enabled ? '禁用' : '启用', value: 'toggle' as const },
            ],
            { placeHolder: '选择操作' }
        );
        if (!action) return;
        if (action.value === 'delete') {
            removeCustomTable(choice.table.id);
            vscode.window.showInformationMessage(`已删除「${choice.table.name}」。`);
        } else {
            setCustomTableEnabled(choice.table.id, !choice.table.enabled);
            vscode.window.showInformationMessage(
                choice.table.enabled ? `已禁用「${choice.table.name}」。` : `已启用「${choice.table.name}」。`
            );
        }
    }

    /** 上一处：在当前选中条目的多处之间循环（激活编辑器） */
    async handlePrevOccurrenceCommand(): Promise<void> {
        const entry = this.getSelectedEntry();
        if (!entry || entry.ranges.length === 0) {
            vscode.window.showWarningMessage('请先在字词检查视图中选中一条条目。');
            return;
        }
        let idx = getCurrentOccurrenceIndex();
        idx = (idx - 1 + entry.ranges.length) % entry.ranges.length;
        setCurrentOccurrenceIndex(idx);
        this.revealEntryAt(entry, idx, false);
    }

    /** 下一处（上下文菜单用：先前进再定位，激活编辑器） */
    async handleNextOccurrenceCommand(): Promise<void> {
        const entry = this.getSelectedEntry();
        if (!entry || entry.ranges.length === 0) {
            vscode.window.showWarningMessage('请先在字词检查视图中选中一条条目。');
            return;
        }
        let idx = getCurrentOccurrenceIndex();
        idx = (idx + 1) % entry.ranges.length;
        setCurrentOccurrenceIndex(idx);
        this.revealEntryAt(entry, idx, false);
    }

    /** 揭示当前处并前进（TreeItem 单击/Enter/双击时都会触发，保持焦点在树以便键盘浏览；需激活编辑器时用上下文菜单「上一处/下一处」） */
    async handleRevealCurrentAndAdvanceCommand(): Promise<void> {
        const entry = this.getSelectedEntry();
        if (!entry || entry.ranges.length === 0) return;
        const idx = getCurrentOccurrenceIndex();
        this.revealEntryAt(entry, idx, true);
        setCurrentOccurrenceIndex((idx + 1) % entry.ranges.length);
    }

    /** 查看说明：用 Webview 展示当前条目的完整注释 */
    async handleShowNotesCommand(): Promise<void> {
        const entry = this.getSelectedEntry();
        if (!entry) {
            vscode.window.showWarningMessage('请先在字词检查视图中选中一条条目。');
            return;
        }
        const html = formatFullNotesAsHtml(entry.preferred, entry.variant, entry.rawComment);
        const panel = vscode.window.createWebviewPanel(
            'wordCheckNotes',
            `说明：${entry.variant} → ${entry.preferred}`,
            vscode.ViewColumn.Beside,
            { enableScripts: false }
        );
        panel.webview.html = getNotesWebviewHtml(html);
    }

    /** 对当前选中条目应用替换（使用配置的前后标记） */
    async handleApplyReplaceForEntryCommand(): Promise<void> {
        const entry = this.getSelectedEntry();
        if (!entry || entry.ranges.length === 0) {
            vscode.window.showWarningMessage('请先在字词检查视图中选中一条条目。');
            return;
        }
        const docUri = this.treeProvider?.getDocumentUri();
        if (!docUri) {
            vscode.window.showWarningMessage('无法获取文档。');
            return;
        }
        const config = vscode.workspace.getConfiguration('ai-proofread.wordCheck');
        const prefix = config.get<string>('replacePrefix') ?? '';
        const suffix = config.get<string>('replaceSuffix') ?? '';
        const editor = await vscode.window.showTextDocument(docUri);
        const ok = await applyReplaceInDocument(editor, [entry], prefix, suffix);
        if (ok) {
            vscode.window.showInformationMessage(`已替换 ${entry.ranges.length} 处。`);
            const entries = this.treeProvider?.getEntries() ?? [];
            const remaining = entries.filter((e) => e !== entry);
            this.treeProvider?.refresh(remaining, docUri);
            const totalOccurrences = remaining.reduce((s, e) => s + e.ranges.length, 0);
            this.updateViewTitle(remaining.length, totalOccurrences);
        } else {
            vscode.window.showErrorMessage('替换失败');
        }
    }

    private getSelectedEntry(): WordCheckEntry | null {
        if (this.treeView?.selection?.[0]) return this.treeView.selection[0];
        return getLastSelectedEntry();
    }
}

function getNotesWebviewHtml(bodyHtml: string): string {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); padding: 1em; line-height: 1.6; }
h4 { margin-top: 1em; margin-bottom: 0.4em; }
.notes { margin-bottom: 0.8em; }
sup, small { font-size: 0.85em; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}
