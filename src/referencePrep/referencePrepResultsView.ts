import * as vscode from 'vscode';
import * as path from 'path';
import type { CorpusHit, ReferencePrepProcessFileV020, ReferencePrepRound } from './schema';
import { loadProcessFile, saveProcessFile } from './processFile';
import { buildMergedReference } from './retrieval/executor';
import {
    canOpenHitInEditor,
    canOpenHitInBrowser,
    formatReferencePrepIntent,
    getAllQueryIds,
    getHitsForRoundQuery,
    getRoundHitCount,
    queryNodeContextValue,
    referencePrepHitContextValue,
    roundHasVisiblePlan,
} from './referencePrepResultsTree';

export type ReferencePrepRecordNode = {
    kind: 'record';
    process: ReferencePrepProcessFileV020;
    recordIndex: number;
};
export type ReferencePrepRoundNode = {
    kind: 'round';
    round: ReferencePrepRound;
    roundIndex: number;
    process: ReferencePrepProcessFileV020;
};
export type ReferencePrepQueryNode = {
    kind: 'query';
    roundIndex: number;
    queryId: string;
    intent: string;
    process: ReferencePrepProcessFileV020;
};
export type ReferencePrepHitNode = {
    kind: 'hit';
    hit: CorpusHit;
    roundIndex: number;
    process: ReferencePrepProcessFileV020;
};
export type ReferencePrepTreeNode =
    | ReferencePrepRecordNode
    | ReferencePrepRoundNode
    | ReferencePrepQueryNode
    | ReferencePrepHitNode;

export class ReferencePrepResultsProvider implements vscode.TreeDataProvider<ReferencePrepTreeNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private _onDidChangeCorpus = new vscode.EventEmitter<{
        anchorPath: string;
        records: ReferencePrepProcessFileV020[];
    }>();
    /** prune/restore 写盘后通知面板同步 */
    readonly onDidChangeCorpus = this._onDidChangeCorpus.event;

    /** 当前展示的全部选区记录（单条时 length=1） */
    private records: ReferencePrepProcessFileV020[] = [];
    private anchorPath: string = '';

    refresh(process: ReferencePrepProcessFileV020 | null, anchorPath?: string): void {
        this.records = process ? [process] : [];
        if (anchorPath) this.anchorPath = anchorPath;
        this._onDidChangeTreeData.fire();
    }

    /** 多选区 / JSON 多 target 时按记录分组展示 */
    refreshRecords(records: ReferencePrepProcessFileV020[], anchorPath?: string): void {
        this.records = records.slice();
        if (anchorPath) this.anchorPath = anchorPath;
        this._onDidChangeTreeData.fire();
    }

    loadFromAnchor(anchorPath: string): void {
        this.anchorPath = anchorPath;
        const active = loadProcessFile(anchorPath);
        this.records = active ? [active] : [];
        this._onDidChangeTreeData.fire();
    }

    getProcess(): ReferencePrepProcessFileV020 | null {
        return this.records.length ? this.records[this.records.length - 1] : null;
    }

    getRecords(): ReferencePrepProcessFileV020[] {
        return this.records.slice();
    }

    getAnchorPath(): string {
        return this.anchorPath;
    }

    private multiMode(): boolean {
        return this.records.length > 1;
    }

    private targetLabel(proc: ReferencePrepProcessFileV020, index: number): string {
        const preview = (proc.targetPreview ?? proc.userInput ?? '').replace(/\s+/g, ' ').trim();
        const prefix = proc.prepOrigin === 'json_item' ? '条目' : '选区';
        if (preview) {
            return `${prefix} · ${preview.length > 32 ? preview.slice(0, 32) + '…' : preview}`;
        }
        return `${prefix} ${index + 1}`;
    }

    getTreeItem(element: ReferencePrepTreeNode): vscode.TreeItem {
        if (element.kind === 'record') {
            const active = element.process.corpus.filter((h) => h.status === 'active').length;
            const item = new vscode.TreeItem(
                this.targetLabel(element.process, element.recordIndex),
                vscode.TreeItemCollapsibleState.Expanded
            );
            item.id = `rp-record:${element.process.id ?? element.recordIndex}`;
            item.description = `${active} 命中 · ${element.process.rounds.length} 轮`;
            item.tooltip = element.process.userInput ?? element.process.targetPreview ?? item.label;
            item.iconPath = new vscode.ThemeIcon('symbol-string');
            return item;
        }
        if (element.kind === 'round') {
            const r = element.round;
            const hitCount = getRoundHitCount(element.process, element.roundIndex);
            const planCount = getAllQueryIds(r).length;
            const item = new vscode.TreeItem(
                `轮次 ${element.roundIndex + 1}`,
                planCount > 0
                    ? vscode.TreeItemCollapsibleState.Expanded
                    : vscode.TreeItemCollapsibleState.None
            );
            const rid = element.process.id ?? 'x';
            item.id = `rp-round:${rid}:${element.roundIndex}`;
            item.description = `${hitCount} 命中 · ${planCount} 规划`;
            item.tooltip = [
                r.startedAt + (r.finishedAt ? ` → ${r.finishedAt}` : ''),
                `规划 ${planCount} 个查询，corpus ${hitCount} 条`,
            ].join('\n');
            return item;
        }
        if (element.kind === 'query') {
            const hits = getHitsForRoundQuery(element.process, element.roundIndex, element.queryId);
            const item = new vscode.TreeItem(
                element.queryId,
                hits.length > 0
                    ? vscode.TreeItemCollapsibleState.Collapsed
                    : vscode.TreeItemCollapsibleState.None
            );
            const rid = element.process.id ?? 'x';
            item.id = `rp-query:${rid}:${element.roundIndex}:${element.queryId}`;
            item.description = `${formatReferencePrepIntent(element.intent)} · ${hits.length} 条`;
            item.tooltip =
                hits.length > 0
                    ? `intent: ${element.intent}`
                    : `intent: ${element.intent}\n（规划了但无命中）`;
            item.contextValue = queryNodeContextValue(hits.length);
            item.iconPath =
                hits.length > 0
                    ? new vscode.ThemeIcon('search')
                    : new vscode.ThemeIcon('warning');
            return item;
        }
        const h = element.hit;
        const label = h.snippet.slice(0, 40).replace(/\s+/g, ' ') + (h.snippet.length > 40 ? '…' : '');
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        const rid = element.process.id ?? 'x';
        item.id = `rp-hit:${rid}:${element.roundIndex}:${h.queryId}:${h.hitId}`;
        const score = (h.rerankScore ?? h.finalScore ?? h.aggregatedValue).toFixed(2);
        item.description = `${h.source} · ${score} · ${h.status}`;
        const tips = [
            `hitId: ${h.hitId}`,
            h.refTag ? `refTag: ${h.refTag}` : '',
            `source: ${h.source}`,
            h.relPath ? `file: ${h.relPath}` : '',
            h.startLine ? `lines: ${h.startLine}-${h.endLine ?? h.startLine}` : '',
            h.headingPath ? `heading: ${h.headingPath}` : '',
            h.rgCommand ? `rg: ${h.rgCommand}` : '',
            h.rerankReason ? `rerank: ${h.rerankReason}` : '',
            h.pruneReason ? `prune: ${h.pruneReason}` : '',
        ].filter(Boolean);
        item.tooltip = tips.join('\n');
        item.contextValue = referencePrepHitContextValue(h);
        item.iconPath =
            h.status === 'pruned'
                ? new vscode.ThemeIcon('circle-slash')
                : h.source === 'wikipedia' || h.source === 'web'
                  ? new vscode.ThemeIcon('globe')
                  : h.source === 'dict'
                    ? new vscode.ThemeIcon('book')
                    : new vscode.ThemeIcon('file');
        if (canOpenHitInEditor(h) || canOpenHitInBrowser(h)) {
            item.command = {
                command: 'ai-proofread.referencePrep.openHit',
                title:
                    h.source === 'wikipedia' || h.source === 'web'
                        ? '在浏览器打开'
                        : '打开命中位置',
                arguments: [h],
            };
        }
        return item;
    }

    private roundsFor(process: ReferencePrepProcessFileV020): ReferencePrepRoundNode[] {
        return process.rounds
            .map((round, roundIndex) => ({
                kind: 'round' as const,
                round,
                roundIndex,
                process,
            }))
            .filter(({ roundIndex }) => roundHasVisiblePlan(process, roundIndex));
    }

    getChildren(element?: ReferencePrepTreeNode): ReferencePrepTreeNode[] {
        if (!this.records.length) return [];
        if (!element) {
            if (this.multiMode()) {
                return this.records.map((process, recordIndex) => ({
                    kind: 'record' as const,
                    process,
                    recordIndex,
                }));
            }
            return this.roundsFor(this.records[0]);
        }
        if (element.kind === 'record') {
            return this.roundsFor(element.process);
        }
        if (element.kind === 'round') {
            const queryIds = getAllQueryIds(element.round);
            return queryIds.map((queryId) => {
                const q = element.round.plan.queries.find((x) => x.queryId === queryId)!;
                return {
                    kind: 'query' as const,
                    roundIndex: element.roundIndex,
                    queryId,
                    intent: q.intent,
                    process: element.process,
                };
            });
        }
        if (element.kind === 'query') {
            return getHitsForRoundQuery(element.process, element.roundIndex, element.queryId).map(
                (hit) => ({
                    kind: 'hit' as const,
                    hit,
                    roundIndex: element.roundIndex,
                    process: element.process,
                })
            );
        }
        return [];
    }

    private replaceRecord(updated: ReferencePrepProcessFileV020): void {
        const idx = this.records.findIndex((r) => r.id && r.id === updated.id);
        if (idx >= 0) {
            this.records[idx] = updated;
        } else if (this.records.length === 1) {
            this.records[0] = updated;
        } else {
            this.records.push(updated);
        }
    }

    pruneHit(hit: CorpusHit, process?: ReferencePrepProcessFileV020): void {
        if (!this.anchorPath) return;
        const proc = process ?? this.getProcess();
        if (!proc) return;
        const h = proc.corpus.find((x) => x.digest === hit.digest);
        if (!h) return;
        h.status = 'pruned';
        h.pruneReason = '手动 prune';
        proc.mergedReference = buildMergedReference(proc.corpus);
        saveProcessFile(this.anchorPath, proc);
        this.replaceRecord(proc);
        this._onDidChangeTreeData.fire();
        this._onDidChangeCorpus.fire({ anchorPath: this.anchorPath, records: this.getRecords() });
    }

    restoreHit(hit: CorpusHit, process?: ReferencePrepProcessFileV020): void {
        if (!this.anchorPath) return;
        const proc = process ?? this.getProcess();
        if (!proc) return;
        const h = proc.corpus.find((x) => x.digest === hit.digest);
        if (!h) return;
        h.status = 'active';
        h.pruneReason = undefined;
        proc.mergedReference = buildMergedReference(proc.corpus);
        saveProcessFile(this.anchorPath, proc);
        this.replaceRecord(proc);
        this._onDidChangeTreeData.fire();
        this._onDidChangeCorpus.fire({ anchorPath: this.anchorPath, records: this.getRecords() });
    }
}

export function registerReferencePrepResultsView(context: vscode.ExtensionContext): {
    provider: ReferencePrepResultsProvider;
    treeView: vscode.TreeView<ReferencePrepTreeNode>;
} {
    const provider = new ReferencePrepResultsProvider();
    const treeView = vscode.window.createTreeView('ai-proofread.referencePrepResults', {
        treeDataProvider: provider,
        showCollapseAll: true,
    });
    context.subscriptions.push(treeView);
    return { provider, treeView };
}

export async function openCorpusHitInEditor(
    hit: CorpusHit,
    referencesRoot: string
): Promise<void> {
    const rel = hit.relPath ?? hit.file;
    if (!rel) {
        const doc = await vscode.workspace.openTextDocument({
            content: hit.referenceBlock,
            language: 'markdown',
        });
        await vscode.window.showTextDocument(doc, { preview: true });
        return;
    }
    const full = path.isAbsolute(rel) ? rel : path.join(referencesRoot, rel);
    try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(full));
        const editor = await vscode.window.showTextDocument(doc, { preview: true });
        const line = Math.max(0, (hit.startLine ?? hit.line ?? 1) - 1);
        const pos = new vscode.Position(line, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    } catch {
        vscode.window.showErrorMessage(`无法打开文件：${rel}`);
    }
}
