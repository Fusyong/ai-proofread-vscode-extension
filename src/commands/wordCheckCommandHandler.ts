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
import { initTableLoader, getDict, getCustomPresetDict, getCustomPresetLabel, CUSTOM_PRESET_IDS, type CustomPresetId } from '../xh7/tableLoader';
import {
    registerCustomTablesView,
    CUSTOM_TABLES_VIEW_ID,
    KEY_TABLE_ORDER,
    type CustomTableTreeItem,
} from '../xh7/customTablesView';
import {
    registerDictCheckTypesView,
    registerTgsccCheckTypesView,
    DICT_CHECK_TYPES_VIEW_ID,
    TGSCC_CHECK_TYPES_VIEW_ID,
    type CheckTypeTreeItem,
    type DictCheckTypesTreeDataProvider,
    type TgsccCheckTypesTreeDataProvider,
} from '../xh7/checkTypesView';
import { scanDocument, scanDocumentWithSegmentation } from '../xh7/documentScanner';
import { scanDocumentTgsccSpecial, isTgsccSpecialType } from '../xh7/documentScannerTgscc';
import { getJiebaWasm } from '../jiebaLoader';
import { formatFullNotesAsHtml } from '../xh7/notesResolver';
import { CHECK_TYPE_LABELS, DICT_CHECK_TYPES, TGSCC_CHECK_TYPES, isDictWordTableType, type CheckType } from '../xh7/types';
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

export class WordCheckCommandHandler {
    private treeView: vscode.TreeView<WordCheckEntry> | null = null;
    private treeProvider: WordCheckTreeDataProvider | null = null;
    private customTablesProvider: import('../xh7/customTablesView').CustomTablesTreeDataProvider | null = null;
    private customTablesTreeView: vscode.TreeView<CustomTableTreeItem> | null = null;
    private dictCheckTypesProvider: DictCheckTypesTreeDataProvider | null = null;
    private tgsccCheckTypesProvider: TgsccCheckTypesTreeDataProvider | null = null;

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

    /** 注册替换表 TreeView，供「管理自定义替换表」聚焦及删除/上移/下移使用 */
    registerCustomTablesView(): void {
        const reg = registerCustomTablesView(this.context);
        this.customTablesProvider = reg.provider;
        this.customTablesTreeView = reg.treeView;
    }

    /** 注册词典/通规检查类型 TreeView，供「管理检查类型」聚焦及上移/下移使用 */
    registerCheckTypesViews(): void {
        const dictReg = registerDictCheckTypesView(this.context);
        this.dictCheckTypesProvider = dictReg.provider as DictCheckTypesTreeDataProvider;
        const tgsccReg = registerTgsccCheckTypesView(this.context);
        this.tgsccCheckTypesProvider = tgsccReg.provider as TgsccCheckTypesTreeDataProvider;
    }

    /** 获取当前参与检查的表 id 列表（按 tableOrder 顺序） */
    getOrderedSelectedTableIds(): { presetIds: CustomPresetId[]; customIds: string[] } {
        const lastSelectedIds = this.context.workspaceState.get<string[]>(KEY_LAST_SELECTED_TABLE_IDS) ?? [];
        const order = this.context.workspaceState.get<string[]>(KEY_TABLE_ORDER) ?? [
            ...CUSTOM_PRESET_IDS,
            ...getCustomTables().map((t) => t.id),
        ];
        const selectedSet = new Set(lastSelectedIds);
        const presetIds: CustomPresetId[] = [];
        const customIds: string[] = [];
        for (const id of order) {
            if (!selectedSet.has(id)) continue;
            if (CUSTOM_PRESET_IDS.includes(id as CustomPresetId)) {
                presetIds.push(id as CustomPresetId);
            } else {
                customIds.push(id);
            }
        }
        return { presetIds, customIds };
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
                { label: '对照词典检查', value: 'dict' as const },
                { label: '对照通用规范汉字表检查', value: 'tgscc' as const },
                { label: '自定义替换表检查', value: 'custom' as const },
            ],
            { placeHolder: '选择检查方式', title: '字词检查' }
        );
        if (!branch) return;

        if (branch.value === 'dict') {
            await this.runDictCheck(editor);
            return;
        }
        if (branch.value === 'tgscc') {
            await this.runTgsccCheck(editor);
            return;
        }
        await this.runCustomCheck(editor);
    }

    private async runDictCheck(editor: vscode.TextEditor): Promise<void> {
        const action = await vscode.window.showQuickPick(
            [
                { label: '$(play) 开始检查', value: 'run' as const },
                { label: '$(settings-gear) 管理检查类型', value: 'manage' as const },
            ],
            { placeHolder: '选择操作', title: '对照词典检查' }
        );
        if (!action) return;
        if (action.value === 'manage') {
            await vscode.commands.executeCommand(`${DICT_CHECK_TYPES_VIEW_ID}.focus`);
            return;
        }
        const types = this.dictCheckTypesProvider?.getOrderedSelectedTypes() ?? [];
        if (types.length === 0) {
            vscode.window.showWarningMessage('请在侧栏「词典检查类型」视图中勾选至少一项参与检查。');
            await vscode.commands.executeCommand(`${DICT_CHECK_TYPES_VIEW_ID}.focus`);
            return;
        }
        await this.runPresetStyleCheck(editor, types);
    }

    private async runTgsccCheck(editor: vscode.TextEditor): Promise<void> {
        const action = await vscode.window.showQuickPick(
            [
                { label: '$(play) 开始检查', value: 'run' as const },
                { label: '$(settings-gear) 管理检查类型', value: 'manage' as const },
            ],
            { placeHolder: '选择操作', title: '对照通用规范汉字表检查' }
        );
        if (!action) return;
        if (action.value === 'manage') {
            await vscode.commands.executeCommand(`${TGSCC_CHECK_TYPES_VIEW_ID}.focus`);
            return;
        }
        const types = this.tgsccCheckTypesProvider?.getOrderedSelectedTypes() ?? [];
        if (types.length === 0) {
            vscode.window.showWarningMessage('请在侧栏「通规检查类型」视图中勾选至少一项参与检查。');
            await vscode.commands.executeCommand(`${TGSCC_CHECK_TYPES_VIEW_ID}.focus`);
            return;
        }
        await this.runPresetStyleCheck(editor, types);
    }

    private async runPresetStyleCheck(editor: vscode.TextEditor, checkTypes: CheckType[]): Promise<void> {
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
                    const typeLabel = (t: CheckType) => CHECK_TYPE_LABELS[t];
                    for (let i = 0; i < checkTypes.length; i++) {
                        if (cancelToken.isCancellationRequested) break;
                        const type = checkTypes[i];
                        progress.report({ message: `加载字词表 (${i + 1}/${checkTypes.length})…` });
                        let list: WordCheckEntry[];
                        if (isTgsccSpecialType(type)) {
                            progress.report({ message: scanRange ? '扫描选中文本…' : '扫描文档…' });
                            list = scanDocumentTgsccSpecial(editor.document, type, cancelToken, scanRange);
                        } else {
                            const dict = getDict(type);
                            if (Object.keys(dict).length === 0) continue;
                            progress.report({ message: scanRange ? '扫描选中文本…' : '扫描文档…' });
                            if (isDictWordTableType(type)) {
                                try {
                                    const customDictPath = vscode.workspace.getConfiguration('ai-proofread.jieba').get<string>('customDictPath', '');
                                    const jieba = getJiebaWasm(path.join(this.context.extensionPath, 'dist'), customDictPath || undefined);
                                    list = scanDocumentWithSegmentation(editor.document, dict, jieba, cancelToken, scanRange);
                                } catch {
                                    list = scanDocument(editor.document, dict, cancelToken, scanRange);
                                }
                            } else {
                                list = scanDocument(editor.document, dict, cancelToken, scanRange);
                            }
                        }
                        const label = typeLabel(type);
                        for (const e of list) {
                            const key = `${e.variant}|${e.preferred}`;
                            const existing = merged.get(key);
                            if (existing) {
                                existing.ranges.push(...e.ranges);
                            } else {
                                merged.set(key, { ...e, ranges: [...e.ranges], checkTypeLabel: label });
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

        const action = await vscode.window.showQuickPick(
            [
                { label: '$(play) 开始检查', value: 'run' as const },
                { label: '$(file-add) 加载新表…', value: 'add' as const },
                { label: '$(settings-gear) 管理替换表', value: 'manage' as const },
            ],
            { placeHolder: '选择操作', title: '自定义替换表检查' }
        );
        if (!action) return;
        if (action.value === 'manage') {
            await this.handleManageCustomTablesCommand();
            return;
        }
        if (action.value === 'add') {
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
                        this.customTablesProvider?.refresh();
                        if (errors.length) {
                            vscode.window.showWarningMessage(`部分规则编译失败：${errors.join('；')}`);
                        }
                    } else {
                        vscode.window.showErrorMessage(errors[0] ?? '加载失败');
                    }
                }
            }
            return;
        }

        const { presetIds, customIds } = this.getOrderedSelectedTableIds();
        const tablesById = new Map(getCustomTables().map((t) => [t.id, t]));
        const selectedPresets = presetIds.map((id) => ({ presetId: id, label: getCustomPresetLabel(id) }));
        const selectedTables = customIds.map((id) => tablesById.get(id)).filter((t): t is CustomTable => t != null);
        if (selectedPresets.length === 0 && selectedTables.length === 0) {
            vscode.window.showWarningMessage('请在侧栏「替换表」视图中勾选至少一项参与检查。');
            await this.handleManageCustomTablesCommand();
            return;
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
                    const total = selectedPresets.length + selectedTables.length;
                    let idx = 0;
                    for (const { presetId, label } of selectedPresets) {
                        if (cancelToken.isCancellationRequested) break;
                        idx++;
                        progress.report({ message: `扫描 (${idx}/${total}) ${label}…` });
                        const dict = getCustomPresetDict(presetId);
                        if (Object.keys(dict).length === 0) continue;
                        const list = scanDocument(editor.document, dict, cancelToken, scanRange);
                        for (const e of list) {
                            const key = `${e.variant}|${e.preferred}`;
                            const existing = merged.get(key);
                            if (existing) {
                                existing.ranges.push(...e.ranges);
                            } else {
                                merged.set(key, { ...e, ranges: [...e.ranges], checkTypeLabel: label });
                            }
                        }
                    }
                    for (const table of selectedTables) {
                        if (cancelToken.isCancellationRequested) break;
                        idx++;
                        progress.report({ message: `扫描表 (${idx}/${total}) ${table.name}…` });
                        const list = scanDocumentWithCustomTable(editor.document, table, cancelToken, scanRange);
                        const tableLabel = table.name;
                        for (const e of list) {
                            const key = `${e.variant}|${e.preferred}`;
                            const existing = merged.get(key);
                            if (existing) {
                                existing.ranges.push(...e.ranges);
                            } else {
                                merged.set(key, { ...e, ranges: [...e.ranges], checkTypeLabel: tableLabel });
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
        await vscode.commands.executeCommand(`${CUSTOM_TABLES_VIEW_ID}.focus`);
    }

    /** 加载替换表：文件选择 → 正则/字面 → 加入列表并刷新视图 */
    async handleLoadCustomTableCommand(): Promise<void> {
        const lastFolder = this.context.workspaceState.get<string>(KEY_LAST_ADD_FOLDER);
        const defaultUri = lastFolder ? vscode.Uri.file(lastFolder) : undefined;
        const uris = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { '替换表': ['txt', 'json'] },
            defaultUri,
        });
        if (!uris?.length) return;
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
        if (isRegex == null) return;
        await this.context.workspaceState.update(KEY_LAST_IS_REGEX, isRegex.value);
        const { table, errors } = addCustomTableFromFile(uris[0].fsPath, isRegex.value);
        if (table) {
            vscode.window.showInformationMessage(`已加载「${table.name}」`);
            this.customTablesProvider?.refresh();
            if (errors.length) {
                vscode.window.showWarningMessage(`部分规则编译失败：${errors.join('；')}`);
            }
        } else {
            vscode.window.showErrorMessage(errors[0] ?? '加载失败');
        }
    }

    async handleCustomTableDelete(element: CustomTableTreeItem): Promise<void> {
        if (element.isPreset) return;
        removeCustomTable(element.id);
        this.customTablesProvider?.removeFromOrder(element.id);
        vscode.window.showInformationMessage(`已删除「${element.label}」。`);
    }

    async handleCustomTableMoveUp(element: CustomTableTreeItem): Promise<void> {
        this.customTablesProvider?.moveInOrder(element.id, -1);
    }

    async handleCustomTableMoveDown(element: CustomTableTreeItem): Promise<void> {
        this.customTablesProvider?.moveInOrder(element.id, 1);
    }

    async handleDictCheckTypeMoveUp(element: CheckTypeTreeItem): Promise<void> {
        this.dictCheckTypesProvider?.moveInOrder(element.id, -1);
    }

    async handleDictCheckTypeMoveDown(element: CheckTypeTreeItem): Promise<void> {
        this.dictCheckTypesProvider?.moveInOrder(element.id, 1);
    }

    async handleTgsccCheckTypeMoveUp(element: CheckTypeTreeItem): Promise<void> {
        this.tgsccCheckTypesProvider?.moveInOrder(element.id, -1);
    }

    async handleTgsccCheckTypeMoveDown(element: CheckTypeTreeItem): Promise<void> {
        this.tgsccCheckTypesProvider?.moveInOrder(element.id, 1);
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
