/**
 * 校对条目 TreeView：展示 .proofread-item.json 中的条目（根下列出全部修改项），
 * 选中条目时在切分稿 .json.md 中定位（锚点存于条目 JSON，与 splitter 拼接规则一致）。
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parseItemOutput, formatConfidencePercent, type ProofreadItem } from './itemOutputParser';
import { findOriginalSpanInSegment } from './itemReplacer';
import {
    proofreadItemPathToSegmentsJsonPath,
    segmentsJsonPathToSplitMarkdownPath,
    splitMarkdownPathToProofreadItemPath,
    segmentBaseOffsetInJoinedMarkdown,
} from './proofreadSplitLayout';
import { showDiff } from './differ';

export const PROOFREAD_ITEMS_VIEW_ID = 'ai-proofread.proofreadItems';

/** 与 package.json 中 view/item/context 的 viewItem 条件一致 */
export const PROOFREAD_ITEM_TREE_CONTEXT_VALUE = 'proofreadItem';

/** 与磁盘路径是否为同一文件（Windows 大小写不敏感） */
function sameDiskPath(a: string, b: string): boolean {
    const na = path.normalize(a);
    const nb = path.normalize(b);
    if (process.platform === 'win32') {
        return na.toLowerCase() === nb.toLowerCase();
    }
    return na === nb;
}

const WS_KEY_SORT = 'proofreadItems.sortMode';
const WS_KEY_MIN_CONF = 'proofreadItems.minConfidence';
/** 最近一次成功加载的条目 JSON 路径（焦点在侧边栏时 activeEditor 可能为空，用于保持树数据） */
export const WS_KEY_LAST_ITEM_JSON = 'proofreadItems.lastItemJsonPath';

const MSG_ANCHOR_STALE = '无法在切分稿中定位本条（请确认 .json.md 与切分 JSON 一致，或重新运行条目校对）。';

/** 段落内条目排序方式 */
export type ProofreadItemsSortMode = 'segment' | 'confidenceDesc' | 'confidenceAsc';

export interface ItemNode {
    type: 'item';
    segmentIndex: number;
    itemIndex: number;
    item: ProofreadItem;
}

/** 树节点仅为条目叶子（无段落分组层级） */
export type ProofreadItemsNode = ItemNode;

export class ProofreadItemsTreeDataProvider implements vscode.TreeDataProvider<ProofreadItemsNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private segmentsRaw: { raw: string | null; items: ProofreadItem[] }[] = [];
    /** 与 item 文件同批的切分段 target，与 .json.md 拼接顺序一致 */
    private segmentTargets: string[] = [];
    private sourcePath: string | null = null;
    private treeView?: vscode.TreeView<ProofreadItemsNode>;

    private sortMode: ProofreadItemsSortMode;
    private minConfidence: number | undefined;

    constructor(private readonly extContext: vscode.ExtensionContext) {
        this.sortMode = extContext.workspaceState.get<ProofreadItemsSortMode>(WS_KEY_SORT) ?? 'segment';
        const mc = extContext.workspaceState.get<number>(WS_KEY_MIN_CONF);
        this.minConfidence = typeof mc === 'number' && Number.isFinite(mc) ? mc : undefined;
    }

    bindTreeView(treeView: vscode.TreeView<ProofreadItemsNode>): void {
        this.treeView = treeView;
        this.updateViewMessage();
    }

    private updateViewMessage(): void {
        if (!this.treeView) {
            return;
        }
        const parts: string[] = [];
        if (this.sortMode !== 'segment') {
            parts.push(this.sortMode === 'confidenceDesc' ? '排序：置信度↓' : '排序：置信度↑');
        }
        if (this.minConfidence !== undefined) {
            parts.push(`筛选：≥ ${Math.round(this.minConfidence * 100)}%`);
        }
        this.treeView.message = parts.length > 0 ? parts.join(' · ') : undefined;
    }

    private passesConfidenceFilter(item: ProofreadItem): boolean {
        if (this.minConfidence === undefined) {
            return true;
        }
        if (item.confidence === undefined) {
            return true;
        }
        return item.confidence >= this.minConfidence;
    }

    /** 筛选后、按当前排序规则排序，用于树展示（不改变磁盘上的原始 JSON） */
    private projectItemsForDisplay(items: ProofreadItem[]): ProofreadItem[] {
        const filtered = items.filter((i) => this.passesConfidenceFilter(i));
        if (this.sortMode === 'segment') {
            return filtered;
        }
        const withC = filtered.filter((i) => i.confidence !== undefined);
        const withoutC = filtered.filter((i) => i.confidence === undefined);
        withC.sort((a, b) => {
            const ca = a.confidence!;
            const cb = b.confidence!;
            return this.sortMode === 'confidenceDesc' ? cb - ca : ca - cb;
        });
        return [...withC, ...withoutC];
    }

    async commandPickSort(): Promise<void> {
        const picked = await vscode.window.showQuickPick(
            [
                {
                    label: '段落内原始顺序',
                    description: '与模型输出顺序一致',
                    value: 'segment' as const,
                },
                {
                    label: '置信度从高到低',
                    value: 'confidenceDesc' as const,
                },
                {
                    label: '置信度从低到高',
                    value: 'confidenceAsc' as const,
                },
            ],
            { placeHolder: '校对条目排序方式', ignoreFocusOut: true }
        );
        if (!picked) {
            return;
        }
        this.sortMode = picked.value;
        await this.extContext.workspaceState.update(WS_KEY_SORT, this.sortMode);
        this.updateViewMessage();
        this._onDidChangeTreeData.fire();
    }

    async commandPickConfidenceFilter(): Promise<void> {
        type ConfRow =
            | { label: string; kind: 'clear' }
            | { label: string; kind: 'preset'; min: number }
            | { label: string; kind: 'custom' };
        const picked = await vscode.window.showQuickPick<ConfRow>(
            [
                { label: '清除筛选（显示全部）', kind: 'clear' },
                { label: '≥ 50%', kind: 'preset', min: 0.5 },
                { label: '≥ 70%', kind: 'preset', min: 0.7 },
                { label: '≥ 90%', kind: 'preset', min: 0.9 },
                { label: '自定义最低置信度…', kind: 'custom' },
            ],
            { placeHolder: '仅保留置信度不低于阈值的条目（无 confidence 字段的条目仍显示）', ignoreFocusOut: true }
        );
        if (!picked) {
            return;
        }
        if (picked.kind === 'custom') {
            const raw = await vscode.window.showInputBox({
                prompt: '最低置信度：可填 0–1 之间的小数，或 50–100 表示百分数',
                placeHolder: '例如 0.75 或 75',
                validateInput: (s) => {
                    const t = s.trim();
                    if (t === '') {
                        return '请输入数字';
                    }
                    const n = Number(t.endsWith('%') ? t.slice(0, -1).trim() : t);
                    if (!Number.isFinite(n)) {
                        return '请输入有效数字';
                    }
                    const v = t.endsWith('%') ? n / 100 : n > 1 ? n / 100 : n;
                    if (v < 0 || v > 1) {
                        return '折合后须在 0–1 之间';
                    }
                    return undefined;
                },
            });
            if (raw === undefined) {
                return;
            }
            const t = raw.trim();
            const n = Number(t.endsWith('%') ? t.slice(0, -1).trim() : t);
            const v = t.endsWith('%') ? n / 100 : n > 1 ? n / 100 : n;
            this.minConfidence = Math.min(1, Math.max(0, v));
        } else if (picked.kind === 'clear') {
            this.minConfidence = undefined;
        } else {
            this.minConfidence = picked.min;
        }
        await this.extContext.workspaceState.update(WS_KEY_MIN_CONF, this.minConfidence);
        this.updateViewMessage();
        this._onDidChangeTreeData.fire();
    }

    /** 校验已存锚点仍指向 original；否则按文本重新匹配 */
    private resolveSpanInSegment(segmentTarget: string, item: ProofreadItem): { start: number; end: number } | undefined {
        const a = item.anchor;
        if (a !== undefined && a.start >= 0 && a.end <= segmentTarget.length && a.start <= a.end) {
            if (segmentTarget.slice(a.start, a.end) === item.original) {
                return { start: a.start, end: a.end };
            }
        }
        return findOriginalSpanInSegment(segmentTarget, item.original);
    }

    /** 在切分 .json.md 中揭示本条（供 TreeView 选中调用） */
    async revealItemNode(node: ItemNode): Promise<void> {
        if (!this.sourcePath) {
            return;
        }
        const segIdx = node.segmentIndex;
        if (segIdx < 0 || segIdx >= this.segmentTargets.length) {
            vscode.window.showWarningMessage(MSG_ANCHOR_STALE);
            return;
        }
        const segmentTarget = this.segmentTargets[segIdx];
        const span = this.resolveSpanInSegment(segmentTarget, node.item);
        if (!span) {
            vscode.window.showWarningMessage(MSG_ANCHOR_STALE);
            return;
        }
        const segmentsJsonPath = proofreadItemPathToSegmentsJsonPath(this.sourcePath);
        const jsonMdPath = segmentsJsonPathToSplitMarkdownPath(segmentsJsonPath);
        if (!fs.existsSync(jsonMdPath)) {
            vscode.window.showWarningMessage('未找到切分 Markdown（.json.md），无法定位原文。');
            return;
        }
        const base = segmentBaseOffsetInJoinedMarkdown(this.segmentTargets, segIdx);
        const absStart = base + span.start;
        const absEnd = base + span.end;
        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(jsonMdPath));
            const start = doc.positionAt(absStart);
            const end = doc.positionAt(absEnd);
            const range = new vscode.Range(start, end);
            const selection = new vscode.Selection(range.start, range.end);

            const pickExistingEditor = (): vscode.TextEditor | undefined => {
                const active = vscode.window.activeTextEditor;
                if (
                    active &&
                    active.document.uri.scheme === 'file' &&
                    sameDiskPath(active.document.uri.fsPath, jsonMdPath)
                ) {
                    return active;
                }
                return vscode.window.visibleTextEditors.find(
                    (ed) => ed.document.uri.scheme === 'file' && sameDiskPath(ed.document.uri.fsPath, jsonMdPath)
                );
            };

            const existing = pickExistingEditor();
            if (existing) {
                existing.selection = selection;
                existing.revealRange(range, vscode.TextEditorRevealType.InCenter);
                return;
            }

            // 不复用 ViewColumn.Beside：焦点在侧栏时反复 Beside 会叠出多个编辑组
            const editor = await vscode.window.showTextDocument(doc, {
                preview: false,
                preserveFocus: true,
                selection: range,
            });
            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        } catch {
            vscode.window.showWarningMessage(MSG_ANCHOR_STALE);
        }
    }

    /** 临时文件对照：本条「原文」与「改后」 */
    async diffItemOriginalVsCorrected(node: ItemNode): Promise<void> {
        const { original, corrected } = node.item;
        const after = corrected ?? '';
        await showDiff(
            this.extContext,
            original,
            after,
            '.txt',
            false,
            `条目（段${node.segmentIndex + 1}）：原文 ↔ 改后`
        );
    }

    refresh(uri?: vscode.Uri): void {
        const active = vscode.window.activeTextEditor?.document;
        const focusPath = uri?.fsPath ?? active?.uri.fsPath;

        const loadItemJsonPath = (itemPath: string): void => {
            this.sourcePath = itemPath;
            this.segmentTargets = [];
            try {
                const openDoc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === itemPath);
                const content = openDoc?.getText() ?? fs.readFileSync(itemPath, 'utf8');
                const arr = JSON.parse(content) as (string | null)[];
                if (!Array.isArray(arr)) {
                    this.segmentsRaw = [];
                    return;
                }
                this.segmentsRaw = arr.map((raw) => ({
                    raw,
                    items: raw ? parseItemOutput(raw) : [],
                }));
                const segJson = proofreadItemPathToSegmentsJsonPath(itemPath);
                if (fs.existsSync(segJson)) {
                    try {
                        const rows = JSON.parse(fs.readFileSync(segJson, 'utf8')) as unknown;
                        if (Array.isArray(rows)) {
                            this.segmentTargets = rows.map((row) =>
                                row != null &&
                                typeof row === 'object' &&
                                typeof (row as { target?: unknown }).target === 'string'
                                    ? String((row as { target: string }).target)
                                    : ''
                            );
                        }
                    } catch {
                        this.segmentTargets = [];
                    }
                }
                void this.extContext.workspaceState.update(WS_KEY_LAST_ITEM_JSON, itemPath);
            } catch {
                this.segmentsRaw = [];
                this.segmentTargets = [];
            }
        };

        const tryReloadFromStoredItemPath = (): boolean => {
            const candidates = [this.sourcePath, this.extContext.workspaceState.get<string>(WS_KEY_LAST_ITEM_JSON)];
            const seen = new Set<string>();
            for (const p of candidates) {
                if (typeof p !== 'string' || p.length === 0 || seen.has(p)) {
                    continue;
                }
                seen.add(p);
                if (
                    fs.existsSync(p) &&
                    (p.endsWith('.proofread-item.json') || p.endsWith('proofread-item.json'))
                ) {
                    loadItemJsonPath(p);
                    return true;
                }
            }
            return false;
        };

        if (!focusPath) {
            // 焦点在侧边栏等场景下无 activeTextEditor：保留已加载的条目文件视图
            if (!tryReloadFromStoredItemPath()) {
                this.sourcePath = null;
                this.segmentsRaw = [];
                this.segmentTargets = [];
            }
        } else if (focusPath.endsWith('.proofread-item.json') || focusPath.endsWith('proofread-item.json')) {
            loadItemJsonPath(focusPath);
        } else if (/\.json\.md$/i.test(focusPath) && !/\.proofread\.json\.md$/i.test(focusPath)) {
            const itemPath = splitMarkdownPathToProofreadItemPath(focusPath);
            if (fs.existsSync(itemPath)) {
                loadItemJsonPath(itemPath);
            } else {
                this.sourcePath = null;
                this.segmentsRaw = [];
                this.segmentTargets = [];
            }
        } else if (focusPath.endsWith('.proofread.json')) {
            const itemPath = focusPath.replace(/\.proofread\.json$/i, '.proofread-item.json');
            if (fs.existsSync(itemPath)) {
                loadItemJsonPath(itemPath);
            } else {
                this.sourcePath = itemPath;
                this.segmentsRaw = [];
                this.segmentTargets = [];
            }
        } else {
            this.sourcePath = null;
            this.segmentsRaw = [];
            this.segmentTargets = [];
        }
        this.updateViewMessage();
        this._onDidChangeTreeData.fire();
    }

    getChildren(element?: ProofreadItemsNode): ProofreadItemsNode[] {
        if (element) {
            return [];
        }
        const out: ItemNode[] = [];
        for (let segmentIndex = 0; segmentIndex < this.segmentsRaw.length; segmentIndex++) {
            const visible = this.projectItemsForDisplay(this.segmentsRaw[segmentIndex].items);
            for (let itemIndex = 0; itemIndex < visible.length; itemIndex++) {
                out.push({
                    type: 'item',
                    segmentIndex,
                    itemIndex,
                    item: visible[itemIndex],
                });
            }
        }
        return out;
    }

    getTreeItem(element: ProofreadItemsNode): vscode.TreeItem {
        const { original, corrected, explanation, confidence } = element.item;
        const shortOriginal = original.length > 30 ? original.slice(0, 30) + '…' : original;
        const correctedLabel = corrected != null ? (corrected.length > 30 ? corrected.slice(0, 30) + '…' : corrected) : '(无)';
        const treeItem = new vscode.TreeItem(
            `${shortOriginal} → ${correctedLabel}`,
            vscode.TreeItemCollapsibleState.None
        );
        treeItem.id = `item:${element.segmentIndex}:${element.itemIndex}`;
        const confStr = formatConfidencePercent(confidence);
        const segBit = `段${element.segmentIndex + 1}`;
        treeItem.description = confStr !== undefined ? `${segBit} · ${confStr}` : `${segBit} · —`;
        const lines = [`段落: 段${element.segmentIndex + 1}`, `原文: ${original}`, `改后: ${corrected ?? '(无)'}`];
        if (confStr !== undefined) {
            lines.push(`置信度: ${confStr}`);
        } else {
            lines.push('置信度: （未标注）');
        }
        if (explanation) {
            lines.push(`说明: ${explanation}`);
        }
        treeItem.tooltip = lines.join('\n');
        treeItem.iconPath = new vscode.ThemeIcon('edit');
        treeItem.contextValue = PROOFREAD_ITEM_TREE_CONTEXT_VALUE;
        return treeItem;
    }
}

export function registerProofreadItemsView(context: vscode.ExtensionContext): {
    provider: ProofreadItemsTreeDataProvider;
    treeView: vscode.TreeView<ProofreadItemsNode>;
} {
    const provider = new ProofreadItemsTreeDataProvider(context);
    const treeView = vscode.window.createTreeView(PROOFREAD_ITEMS_VIEW_ID, {
        treeDataProvider: provider,
        showCollapseAll: false,
    });
    provider.bindTreeView(treeView);

    let revealDebounce: ReturnType<typeof setTimeout> | undefined;
    context.subscriptions.push(
        treeView,
        treeView.onDidChangeSelection((e) => {
            const node = e.selection[0];
            if (!node) {
                return;
            }
            if (revealDebounce !== undefined) {
                clearTimeout(revealDebounce);
            }
            revealDebounce = setTimeout(() => {
                revealDebounce = undefined;
                void provider.revealItemNode(node);
            }, 80);
        }),
        vscode.commands.registerCommand('ai-proofread.proofreadItems.setSort', () => provider.commandPickSort()),
        vscode.commands.registerCommand('ai-proofread.proofreadItems.setConfidenceFilter', () =>
            provider.commandPickConfidenceFilter()
        ),
        vscode.commands.registerCommand('ai-proofread.proofreadItems.diffItem', async () => {
            const node = treeView.selection[0];
            if (!node) {
                return;
            }
            await provider.diffItemOriginalVsCorrected(node);
        })
    );

    const refreshWhenActiveEditor = () => provider.refresh();
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(refreshWhenActiveEditor));
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((e) => {
            const fp = e.document.uri.fsPath;
            if (fp.endsWith('.proofread-item.json') || fp.endsWith('proofread-item.json')) {
                provider.refresh(e.document.uri);
            } else if (/\.proofread\.json$/i.test(fp)) {
                refreshWhenActiveEditor();
            } else if (/\.json\.md$/i.test(fp) && !/\.proofread\.json\.md$/i.test(fp)) {
                provider.refresh(e.document.uri);
            }
        })
    );
    refreshWhenActiveEditor();

    return { provider, treeView };
}
