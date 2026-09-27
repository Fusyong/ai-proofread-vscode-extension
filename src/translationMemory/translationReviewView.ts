/**
 * 翻译审核 TreeView：段级过程对照（源单元 ↔ 过程/交付译文）。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseTranslateProcessOutput, cleanTranslateDelivery } from './bitextCodec';
import {
    inspectTranslateRounds,
    translateProcessJsonPath,
    readJsonStringArray,
} from './translateRoundLayout';
import { asOverlaySourceItems, resolveSegmentsJsonPath } from '../proofreadRoundLayout';
import { setTranslateReviewVisible } from '../ui/sidebarViewVisibility';

export const TRANSLATE_REVIEW_VIEW_ID = 'ai-proofread.translateReview';
export const TRANSLATE_REVIEW_ITEM = 'translateReviewUnit';
export const WS_KEY_LAST_TRANSLATE_REVIEW = 'translateReview.lastPaths';

export type TranslateReviewUnit = {
    index: number;
    source: string;
    delivery: string | null;
    processRaw: string | null;
    warnings: string[];
    ok: boolean;
};

type ReviewPaths = {
    segmentsJson: string;
    deliveryJson: string;
    processJson: string;
};

type TreeNode = { kind: 'unit'; unit: TranslateReviewUnit };

export class TranslateReviewTreeProvider implements vscode.TreeDataProvider<TreeNode> {
    private _onDidChange = new vscode.EventEmitter<TreeNode | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChange.event;
    private units: TranslateReviewUnit[] = [];
    private paths: ReviewPaths | undefined;

    constructor(private readonly context: vscode.ExtensionContext) {
        const last = context.workspaceState.get<ReviewPaths>(WS_KEY_LAST_TRANSLATE_REVIEW);
        if (last?.segmentsJson && fs.existsSync(last.segmentsJson)) {
            this.loadFromPaths(last);
        }
    }

    refresh(): void {
        this._onDidChange.fire();
    }

    getPaths(): ReviewPaths | undefined {
        return this.paths;
    }

    getUnits(): TranslateReviewUnit[] {
        return this.units;
    }

    loadFromPaths(paths: ReviewPaths): boolean {
        try {
            const raw = JSON.parse(fs.readFileSync(paths.segmentsJson, 'utf8'));
            const sources = asOverlaySourceItems(raw);
            if (!sources) {
                return false;
            }
            const n = sources.length;
            const deliveries = readJsonStringArray(paths.deliveryJson, n) ?? new Array(n).fill(null);
            const processes = readJsonStringArray(paths.processJson, n) ?? new Array(n).fill(null);
            this.units = sources.map((item, index) => {
                const source = String(item.target ?? '');
                const processRaw = processes[index];
                const delivery = deliveries[index];
                let warnings: string[] = [];
                let ok = true;
                if (typeof processRaw === 'string' && processRaw.trim()) {
                    const parsed = parseTranslateProcessOutput(processRaw, source);
                    warnings = parsed.warnings;
                    ok = parsed.ok && parsed.sourceMatchesInput !== false;
                } else if (delivery == null) {
                    ok = false;
                    warnings = ['尚未翻译'];
                }
                return {
                    index,
                    source,
                    delivery: delivery == null ? null : String(delivery),
                    processRaw: processRaw == null ? null : String(processRaw),
                    warnings,
                    ok,
                };
            });
            this.paths = paths;
            void this.context.workspaceState.update(WS_KEY_LAST_TRANSLATE_REVIEW, paths);
            this.refresh();
            return true;
        } catch {
            return false;
        }
    }

    getTreeItem(element: TreeNode): vscode.TreeItem {
        const u = element.unit;
        const preview = (u.delivery ?? u.source).replace(/\s+/g, ' ').slice(0, 48);
        const mark = u.ok ? (u.warnings.length ? '⚠' : '✓') : '○';
        const item = new vscode.TreeItem(
            `${mark} #${u.index + 1} ${preview}${preview.length >= 48 ? '…' : ''}`,
            vscode.TreeItemCollapsibleState.None
        );
        item.contextValue = TRANSLATE_REVIEW_ITEM;
        item.description = u.warnings[0]?.slice(0, 40);
        item.tooltip = [
            `单元 ${u.index + 1}`,
            u.warnings.length ? `警告：${u.warnings.join('；')}` : '校验通过',
            `源：${u.source.slice(0, 200)}`,
            `译：${(u.delivery ?? '（空）').slice(0, 200)}`,
        ].join('\n');
        item.command = {
            command: 'ai-proofread.translateReview.openUnit',
            title: '打开单元对照',
            arguments: [u.index],
        };
        return item;
    }

    getChildren(): TreeNode[] {
        return this.units.map((unit) => ({ kind: 'unit' as const, unit }));
    }
}

let provider: TranslateReviewTreeProvider | undefined;

export function getTranslateReviewProvider(): TranslateReviewTreeProvider | undefined {
    return provider;
}

export function registerTranslateReviewView(context: vscode.ExtensionContext): {
    provider: TranslateReviewTreeProvider;
} {
    provider = new TranslateReviewTreeProvider(context);
    const tree = vscode.window.createTreeView(TRANSLATE_REVIEW_VIEW_ID, {
        treeDataProvider: provider,
        showCollapseAll: false,
    });
    context.subscriptions.push(tree);
    return { provider };
}

/** 从切分 JSON 或翻译结果 JSON 解析路径并加载审核树 */
export async function loadTranslateReviewFromEditorOrPath(
    context: vscode.ExtensionContext,
    filePath?: string
): Promise<boolean> {
    const p =
        filePath ??
        vscode.window.activeTextEditor?.document.uri.fsPath ??
        context.workspaceState.get<ReviewPaths>(WS_KEY_LAST_TRANSLATE_REVIEW)?.segmentsJson;
    if (!p) {
        vscode.window.showWarningMessage('请先打开切分 JSON 或翻译结果 JSON。');
        return false;
    }
    const segments = resolveSegmentsJsonPath(p);
    if (!segments || !fs.existsSync(segments)) {
        vscode.window.showErrorMessage('无法解析切分 JSON 路径。');
        return false;
    }
    const dir = path.dirname(segments);
    const base = path.basename(segments, '.json');
    const inspected = inspectTranslateRounds(dir, base);
    if (inspected.maxRound < 1 || !inspected.latestJsonPath) {
        vscode.window.showWarningMessage('尚未找到 .translate.N.json，请先顺序翻译。');
        return false;
    }
    const deliveryJson = inspected.latestJsonPath;
    const processJson = translateProcessJsonPath(dir, base, inspected.maxRound);
    const ok = provider?.loadFromPaths({ segmentsJson: segments, deliveryJson, processJson });
    if (!ok) {
        vscode.window.showErrorMessage('加载翻译审核数据失败。');
        return false;
    }
    await setTranslateReviewVisible(true);
    await vscode.commands.executeCommand(`${TRANSLATE_REVIEW_VIEW_ID}.focus`);
    return true;
}

export async function openTranslateReviewUnit(index: number): Promise<void> {
    const u = provider?.getUnits()[index];
    if (!u) {
        return;
    }
    let body: string;
    if (u.processRaw?.trim()) {
        const parsed = parseTranslateProcessOutput(u.processRaw, u.source);
        const delivery = u.delivery ?? cleanTranslateDelivery(parsed);
        body = [
            `# 翻译审核 · 单元 ${u.index + 1}`,
            '',
            parsed.warnings.length ? `> 警告：${parsed.warnings.join('；')}` : '> 校验通过',
            '',
            '## 原文 `<s>`',
            '',
            parsed.sourcePlain || u.source,
            '',
            '## 译文 `<t>`（交付）',
            '',
            delivery,
            '',
            '## 过程原文',
            '',
            '```html',
            u.processRaw.trim(),
            '```',
            '',
        ].join('\n');
    } else {
        body = [
            `# 翻译审核 · 单元 ${u.index + 1}`,
            '',
            '## 原文',
            '',
            u.source,
            '',
            '## 译文',
            '',
            u.delivery ?? '（尚未翻译）',
            '',
        ].join('\n');
    }
    const doc = await vscode.workspace.openTextDocument({
        content: body,
        language: 'markdown',
    });
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
}
