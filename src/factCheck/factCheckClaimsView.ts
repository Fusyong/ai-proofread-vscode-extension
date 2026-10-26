/**
 * 待核断言侧栏：勾选、批量处理、定位原文、用检索词做人工核查。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { findQueryInReferences } from '../commands/citationCommandHandler';
import {
    segmentBaseOffsetInJoinedMarkdown,
    segmentsJsonPathToSplitMarkdownPath,
} from '../proofreadSplitLayout';
import { setFactCheckVisible, toggleFactCheckVisible } from '../ui/sidebarViewVisibility';
import { loadClaimsFile, readSegmentText, saveClaimsFile } from './claimsFile';
import {
    buildAncientbooksSearchUrl,
    buildShidiangujiSearchUrl,
    buildZhWikiSearchUrl,
    clipManualQuery,
} from './manualSearchUrls';
import { CATEGORY_LABEL, type FactCheckCategory, type FactCheckClaim, type FactCheckClaimsFile } from './schema';
import { runExtractFactClaims, runSearchSelectedClaims } from './service';

export const FACT_CHECK_VIEW_ID = 'ai-proofread.factCheckClaims';

const WS_SORT = 'factCheck.sortMode';

type SortMode = 'segment' | 'urgencyDesc';

type SegmentNode = { kind: 'segment'; segmentIndex: number };
type ClaimNode = { kind: 'claim'; claim: FactCheckClaim };
export type FactCheckTreeNode = SegmentNode | ClaimNode;

function sameDiskPath(a: string, b: string): boolean {
    return path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
}

function formatClaimLine(claim: FactCheckClaim): string {
    const pct = Math.round(claim.urgency * 100);
    return [
        `段${claim.segmentIndex + 1} · ${CATEGORY_LABEL[claim.category]} · 紧迫 ${pct}%`,
        `原文：${claim.span}`,
        claim.urgencyReason ? `为何要核：${claim.urgencyReason}` : '',
        `检索词：${claim.query}`,
    ]
        .filter(Boolean)
        .join('\n');
}

export function formatChecklist(claims: FactCheckClaim[]): string {
    return claims.map(formatClaimLine).join('\n\n');
}

function readTargets(sourceJsonPath: string): string[] {
    try {
        const parsed = JSON.parse(fs.readFileSync(sourceJsonPath, 'utf8'));
        if (!Array.isArray(parsed)) return [];
        return parsed.map((item) => readSegmentText((item as { target?: unknown })?.target));
    } catch {
        return [];
    }
}

export class FactCheckClaimsProvider implements vscode.TreeDataProvider<FactCheckTreeNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private file: FactCheckClaimsFile | undefined;
    private sourceJsonPath = '';
    private targets: string[] = [];
    private sortMode: SortMode;
    private treeView?: vscode.TreeView<FactCheckTreeNode>;

    constructor(private readonly extContext: vscode.ExtensionContext) {
        this.sortMode = extContext.workspaceState.get<SortMode>(WS_SORT) ?? 'segment';
    }

    bindTreeView(treeView: vscode.TreeView<FactCheckTreeNode>): void {
        this.treeView = treeView;
        this.updateMessage();
    }

    getSourcePath(): string {
        return this.sourceJsonPath;
    }

    load(sourceJsonPath: string): void {
        this.sourceJsonPath = sourceJsonPath;
        this.file = loadClaimsFile(sourceJsonPath);
        this.targets = readTargets(sourceJsonPath);
        this.updateMessage();
        this._onDidChangeTreeData.fire();
    }

    private updateMessage(): void {
        if (!this.treeView) return;
        const n = this.file?.claims.length ?? 0;
        const selected = this.file?.claims.filter((c) => c.selected).length ?? 0;
        this.treeView.message = this.file
            ? `共 ${n} 条，勾选 ${selected} 条。检索写入 reference 后，请用「知识核查（item）」校对。`
            : '尚未抽取。请在并行工作台对切分 JSON 执行「抽取待核断言」。';
    }

    private claims(): FactCheckClaim[] {
        return this.file?.claims ?? [];
    }

    getChildren(element?: FactCheckTreeNode): FactCheckTreeNode[] {
        const claims = this.claims();
        if (!element) {
            if (this.sortMode === 'urgencyDesc') {
                return [...claims]
                    .sort((a, b) => b.urgency - a.urgency || a.segmentIndex - b.segmentIndex)
                    .map((claim) => ({ kind: 'claim' as const, claim }));
            }
            const indexes = [...new Set(claims.map((c) => c.segmentIndex))].sort((a, b) => a - b);
            return indexes.map((segmentIndex) => ({ kind: 'segment' as const, segmentIndex }));
        }
        if (element.kind === 'segment') {
            return claims
                .filter((c) => c.segmentIndex === element.segmentIndex)
                .map((claim) => ({ kind: 'claim' as const, claim }));
        }
        return [];
    }

    getTreeItem(element: FactCheckTreeNode): vscode.TreeItem {
        if (element.kind === 'segment') {
            const count = this.claims().filter((c) => c.segmentIndex === element.segmentIndex).length;
            const item = new vscode.TreeItem(`第 ${element.segmentIndex + 1} 段`, vscode.TreeItemCollapsibleState.Expanded);
            item.description = `${count} 条`;
            item.id = `seg-${element.segmentIndex}`;
            return item;
        }
        const claim = element.claim;
        const item = new vscode.TreeItem(claim.span.length > 48 ? claim.span.slice(0, 48) + '…' : claim.span);
        item.id = claim.id;
        item.contextValue = 'factCheckClaim';
        item.description = `${CATEGORY_LABEL[claim.category]} · ${Math.round(claim.urgency * 100)}%${
            claim.status === 'has_reference' ? ' · 已有资料' : claim.status === 'searched' ? ' · 已检索' : ''
        }`;
        item.tooltip = formatClaimLine(claim);
        item.checkboxState = claim.selected
            ? vscode.TreeItemCheckboxState.Checked
            : vscode.TreeItemCheckboxState.Unchecked;
        item.iconPath = new vscode.ThemeIcon(claim.urgency >= 0.6 ? 'warning' : 'search');
        return item;
    }

    private persist(): void {
        if (!this.file || !this.sourceJsonPath) return;
        saveClaimsFile(this.file, this.sourceJsonPath);
        this.updateMessage();
        this._onDidChangeTreeData.fire();
    }

    applyChecks(changes: Array<{ id: string; checked: boolean }>): void {
        for (const change of changes) {
            const claim = this.file?.claims.find((c) => c.id === change.id);
            if (!claim) continue;
            claim.selected = change.checked;
            if (change.checked && claim.status === 'has_reference') {
                claim.status = 'pending';
            }
        }
        this.persist();
    }

    private selectMatching(pred: (claim: FactCheckClaim) => boolean): void {
        for (const claim of this.claims()) {
            if (claim.status === 'searched' || !pred(claim)) continue;
            claim.selected = true;
            if (claim.status === 'has_reference') claim.status = 'pending';
        }
        this.persist();
    }

    selectKeyFacts(): void {
        this.selectMatching((claim) => claim.scope === 'key');
    }

    async selectByCategory(): Promise<void> {
        const picked = await vscode.window.showQuickPick(
            (Object.keys(CATEGORY_LABEL) as FactCheckCategory[]).map((id) => ({
                label: CATEGORY_LABEL[id],
                id,
            })),
            { placeHolder: '勾选这一类（已检索的不改）', ignoreFocusOut: true }
        );
        if (!picked) return;
        this.selectMatching((claim) => claim.category === picked.id);
    }

    async selectByUrgency(): Promise<void> {
        const picked = await vscode.window.showQuickPick(
            [
                { label: '≥ 80%', min: 0.8 },
                { label: '≥ 60%', min: 0.6 },
                { label: '≥ 40%', min: 0.4 },
            ],
            { placeHolder: '勾选紧迫程度达到阈值的断言', ignoreFocusOut: true }
        );
        if (!picked) return;
        this.selectMatching((claim) => claim.urgency >= picked.min);
    }

    clearGeneral(): void {
        for (const claim of this.claims()) {
            if (claim.scope === 'general') claim.selected = false;
        }
        this.persist();
    }

    async copyChecklist(): Promise<void> {
        const selected = this.claims().filter((c) => c.selected);
        const list = selected.length > 0 ? selected : this.claims();
        if (list.length === 0) {
            vscode.window.showInformationMessage('没有可复制的断言。');
            return;
        }
        await vscode.env.clipboard.writeText(formatChecklist(list));
        vscode.window.showInformationMessage(
            selected.length > 0 ? `已复制勾选的 ${list.length} 条。` : `未勾选，已复制全部 ${list.length} 条。`
        );
    }

    async setSort(): Promise<void> {
        const picked = await vscode.window.showQuickPick(
            [
                { label: '按段落', value: 'segment' as const },
                { label: '紧迫程度从高到低', value: 'urgencyDesc' as const },
            ],
            { placeHolder: '待核断言排序', ignoreFocusOut: true }
        );
        if (!picked) return;
        this.sortMode = picked.value;
        await this.extContext.workspaceState.update(WS_SORT, this.sortMode);
        this._onDidChangeTreeData.fire();
    }

    selectedClaim(node?: FactCheckTreeNode): FactCheckClaim | undefined {
        if (node?.kind === 'claim') return node.claim;
        const current = this.treeView?.selection[0];
        return current?.kind === 'claim' ? current.claim : undefined;
    }

    async copyQuery(node?: FactCheckTreeNode): Promise<void> {
        const claim = this.selectedClaim(node);
        if (!claim) return;
        await vscode.env.clipboard.writeText(claim.query);
        vscode.window.showInformationMessage('已复制检索词。');
    }

    async copyClaim(node?: FactCheckTreeNode): Promise<void> {
        const claim = this.selectedClaim(node);
        if (!claim) return;
        await vscode.env.clipboard.writeText(formatClaimLine(claim));
    }

    async openExternal(node: FactCheckTreeNode | undefined, build: (query: string) => string): Promise<void> {
        const claim = this.selectedClaim(node);
        if (!claim) return;
        const { truncated } = clipManualQuery(claim.query);
        if (truncated) {
            vscode.window.showWarningMessage('检索词过长，已截断后再打开。');
        }
        await vscode.env.openExternal(vscode.Uri.parse(build(claim.query)));
    }

    async searchReferences(node?: FactCheckTreeNode): Promise<void> {
        const claim = this.selectedClaim(node);
        if (!claim) return;
        await findQueryInReferences(this.extContext, claim.query);
    }

    async revealClaim(claim: FactCheckClaim): Promise<void> {
        if (!this.sourceJsonPath) return;
        const target = this.targets[claim.segmentIndex] ?? '';
        const mdPath = segmentsJsonPathToSplitMarkdownPath(this.sourceJsonPath);
        if (fs.existsSync(mdPath) && target) {
            const span = locateSpan(target, claim.span);
            if (span) {
                const base = segmentBaseOffsetInJoinedMarkdown(this.targets, claim.segmentIndex);
                await revealRangeInFile(mdPath, base + span.start, base + span.end);
                return;
            }
        }
        await revealSpanInJson(this.sourceJsonPath, this.targets, claim);
    }
}

function locateSpan(target: string, span: string): { start: number; end: number } | undefined {
    const at = target.indexOf(span);
    if (at < 0) return undefined;
    return { start: at, end: at + span.length };
}

async function revealRangeInFile(filePath: string, startOffset: number, endOffset: number): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    const start = doc.positionAt(startOffset);
    const end = doc.positionAt(endOffset);
    const range = new vscode.Range(start, end);
    const existing = vscode.window.visibleTextEditors.find(
        (ed) => ed.document.uri.scheme === 'file' && sameDiskPath(ed.document.uri.fsPath, filePath)
    );
    if (existing) {
        existing.selection = new vscode.Selection(start, end);
        existing.revealRange(range, vscode.TextEditorRevealType.InCenter);
        return;
    }
    const editor = await vscode.window.showTextDocument(doc, {
        preview: false,
        preserveFocus: true,
        selection: range,
    });
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
}

async function revealSpanInJson(jsonPath: string, targets: string[], claim: FactCheckClaim): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(jsonPath));
    const text = doc.getText();
    const target = targets[claim.segmentIndex] ?? '';
    let nth = 0;
    for (let i = 0; i < claim.segmentIndex; i++) {
        if (targets[i] === target) nth += 1;
    }
    let from = 0;
    let at = -1;
    if (target) {
        for (let n = 0; n <= nth; n++) {
            at = text.indexOf(target, from);
            if (at < 0) break;
            from = at + Math.max(target.length, 1);
        }
    }
    const spanAt = at >= 0 ? text.indexOf(claim.span, at) : text.indexOf(claim.span);
    if (spanAt < 0) {
        vscode.window.showWarningMessage('在切分稿里没有定位到这条原文。');
        return;
    }
    await revealRangeInFile(jsonPath, spanAt, spanAt + claim.span.length);
}

export function registerFactCheckClaimsView(context: vscode.ExtensionContext): FactCheckClaimsProvider {
    const provider = new FactCheckClaimsProvider(context);
    const treeView = vscode.window.createTreeView(FACT_CHECK_VIEW_ID, {
        treeDataProvider: provider,
        showCollapseAll: true,
        manageCheckboxStateManually: true,
    });
    provider.bindTreeView(treeView);

    let revealDebounce: ReturnType<typeof setTimeout> | undefined;
    context.subscriptions.push(
        treeView,
        treeView.onDidChangeSelection((e) => {
            const node = e.selection[0];
            if (!node || node.kind !== 'claim') return;
            if (revealDebounce !== undefined) clearTimeout(revealDebounce);
            revealDebounce = setTimeout(() => {
                revealDebounce = undefined;
                void provider.revealClaim(node.claim);
            }, 80);
        }),
        treeView.onDidChangeCheckboxState((e) => {
            provider.applyChecks(
                e.items
                    .filter((entry): entry is [ClaimNode, vscode.TreeItemCheckboxState] => entry[0].kind === 'claim')
                    .map(([element, state]) => ({
                        id: element.claim.id,
                        checked: state === vscode.TreeItemCheckboxState.Checked,
                    }))
            );
        }),
        vscode.commands.registerCommand('ai-proofread.factCheck.extract', async (jsonPath?: string) => {
            const target = jsonPath || vscode.window.activeTextEditor?.document.uri.fsPath;
            if (!target || !target.toLowerCase().endsWith('.json')) {
                vscode.window.showWarningMessage('请先打开切分 JSON，或从并行工作台抽取。');
                return;
            }
            await setFactCheckVisible(true);
            const file = await runExtractFactClaims(target);
            if (file) provider.load(target);
        }),
        vscode.commands.registerCommand('ai-proofread.factCheck.openView', async (jsonPath?: string) => {
            await setFactCheckVisible(true);
            const target = jsonPath || provider.getSourcePath() || vscode.window.activeTextEditor?.document.uri.fsPath;
            if (target && target.toLowerCase().endsWith('.json')) provider.load(target);
        }),
        vscode.commands.registerCommand('ai-proofread.factCheck.toggleView', () => toggleFactCheckVisible()),
        vscode.commands.registerCommand('ai-proofread.factCheck.selectKey', () => provider.selectKeyFacts()),
        vscode.commands.registerCommand('ai-proofread.factCheck.selectCategory', () => provider.selectByCategory()),
        vscode.commands.registerCommand('ai-proofread.factCheck.selectUrgency', () => provider.selectByUrgency()),
        vscode.commands.registerCommand('ai-proofread.factCheck.clearGeneral', () => provider.clearGeneral()),
        vscode.commands.registerCommand('ai-proofread.factCheck.copyChecklist', () => provider.copyChecklist()),
        vscode.commands.registerCommand('ai-proofread.factCheck.setSort', () => provider.setSort()),
        vscode.commands.registerCommand('ai-proofread.factCheck.searchSelected', async () => {
            const source = provider.getSourcePath();
            if (!source) {
                vscode.window.showWarningMessage('没有打开中的待核清单。');
                return;
            }
            const saved = await runSearchSelectedClaims(source);
            if (saved) provider.load(source);
        }),
        vscode.commands.registerCommand('ai-proofread.factCheck.copyQuery', (node?: FactCheckTreeNode) =>
            provider.copyQuery(node)
        ),
        vscode.commands.registerCommand('ai-proofread.factCheck.copyClaim', (node?: FactCheckTreeNode) =>
            provider.copyClaim(node)
        ),
        vscode.commands.registerCommand('ai-proofread.factCheck.openShidianguji', (node?: FactCheckTreeNode) =>
            provider.openExternal(node, buildShidiangujiSearchUrl)
        ),
        vscode.commands.registerCommand('ai-proofread.factCheck.openAncientbooks', (node?: FactCheckTreeNode) =>
            provider.openExternal(node, buildAncientbooksSearchUrl)
        ),
        vscode.commands.registerCommand('ai-proofread.factCheck.openWikipedia', (node?: FactCheckTreeNode) =>
            provider.openExternal(node, buildZhWikiSearchUrl)
        ),
        vscode.commands.registerCommand('ai-proofread.factCheck.searchReferences', (node?: FactCheckTreeNode) =>
            provider.searchReferences(node)
        )
    );
    return provider;
}
