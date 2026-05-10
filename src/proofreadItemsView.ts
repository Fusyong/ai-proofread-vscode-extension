/**
 * 校对条目 TreeView：展示 .proofread-item.json 中的条目（段落 → 每条修改）
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { parseItemOutput, formatConfidencePercent, type ProofreadItem } from './itemOutputParser';

export const PROOFREAD_ITEMS_VIEW_ID = 'ai-proofread.proofreadItems';

const WS_KEY_SORT = 'proofreadItems.sortMode';
const WS_KEY_MIN_CONF = 'proofreadItems.minConfidence';

/** 段落内条目排序方式 */
export type ProofreadItemsSortMode = 'segment' | 'confidenceDesc' | 'confidenceAsc';

export interface SegmentNode {
    type: 'segment';
    index: number;
    raw: string | null;
    allItems: ProofreadItem[];
}

export interface ItemNode {
    type: 'item';
    segmentIndex: number;
    itemIndex: number;
    item: ProofreadItem;
}

export type ProofreadItemsNode = SegmentNode | ItemNode;

export class ProofreadItemsTreeDataProvider implements vscode.TreeDataProvider<ProofreadItemsNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private segmentsRaw: { raw: string | null; items: ProofreadItem[] }[] = [];
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

    refresh(uri?: vscode.Uri): void {
        const active = vscode.window.activeTextEditor?.document;
        const focusPath = uri?.fsPath ?? active?.uri.fsPath;

        const loadItemJsonPath = (itemPath: string): void => {
            this.sourcePath = itemPath;
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
            } catch {
                this.segmentsRaw = [];
            }
        };

        if (!focusPath) {
            this.sourcePath = null;
            this.segmentsRaw = [];
        } else if (focusPath.endsWith('.proofread-item.json') || focusPath.endsWith('proofread-item.json')) {
            loadItemJsonPath(focusPath);
        } else if (focusPath.endsWith('.proofread.json')) {
            const itemPath = focusPath.replace(/\.proofread\.json$/i, '.proofread-item.json');
            if (fs.existsSync(itemPath)) {
                loadItemJsonPath(itemPath);
            } else {
                this.sourcePath = itemPath;
                this.segmentsRaw = [];
            }
        } else {
            this.sourcePath = null;
            this.segmentsRaw = [];
        }
        this.updateViewMessage();
        this._onDidChangeTreeData.fire();
    }

    getChildren(element?: ProofreadItemsNode): ProofreadItemsNode[] {
        if (!element) {
            return this.segmentsRaw.map((seg, index) => ({
                type: 'segment' as const,
                index,
                raw: seg.raw,
                allItems: seg.items,
            }));
        }
        if (element.type === 'segment') {
            const visible = this.projectItemsForDisplay(element.allItems);
            return visible.map((item, itemIndex) => ({
                type: 'item' as const,
                segmentIndex: element.index,
                itemIndex,
                item,
            }));
        }
        return [];
    }

    getTreeItem(element: ProofreadItemsNode): vscode.TreeItem {
        if (element.type === 'segment') {
            const total = element.allItems.length;
            const visible = this.projectItemsForDisplay(element.allItems).length;
            const label = `No.${element.index + 1}`;
            const hasItems = visible > 0;
            const item = new vscode.TreeItem(
                label,
                hasItems ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
            );
            item.id = `seg:${element.index}`;
            item.description = visible === total ? `${total} 条修改` : `${visible}/${total} 条`;
            item.tooltip = this.sourcePath ?? undefined;
            return item;
        }
        const { original, corrected, explanation, confidence } = element.item;
        const shortOriginal = original.length > 30 ? original.slice(0, 30) + '…' : original;
        const correctedLabel = corrected != null ? (corrected.length > 30 ? corrected.slice(0, 30) + '…' : corrected) : '(无)';
        const treeItem = new vscode.TreeItem(
            `${shortOriginal} → ${correctedLabel}`,
            vscode.TreeItemCollapsibleState.None
        );
        treeItem.id = `item:${element.segmentIndex}:${element.itemIndex}`;
        const confStr = formatConfidencePercent(confidence);
        treeItem.description = confStr ?? '—';
        const lines = [`原文: ${original}`, `改后: ${corrected ?? '(无)'}`];
        if (confStr !== undefined) {
            lines.push(`置信度: ${confStr}`);
        } else {
            lines.push('置信度: （未标注）');
        }
        if (explanation) {
            lines.push(`说明: ${explanation}`);
        }
        treeItem.tooltip = lines.join('\n');
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
        showCollapseAll: true,
    });
    provider.bindTreeView(treeView);
    context.subscriptions.push(
        treeView,
        vscode.commands.registerCommand('ai-proofread.proofreadItems.setSort', () => provider.commandPickSort()),
        vscode.commands.registerCommand('ai-proofread.proofreadItems.setConfidenceFilter', () =>
            provider.commandPickConfidenceFilter()
        )
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
            }
        })
    );
    refreshWhenActiveEditor();

    return { provider, treeView };
}
