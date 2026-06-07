import * as vscode from 'vscode';
import * as path from 'path';
import type { CorpusHit, ReferencePrepProcessFileV020, ReferencePrepRound } from './schema';
import { loadProcessFile, saveProcessFile } from './processFile';
import { buildMergedReference } from './retrieval/executor';

export type ReferencePrepRoundNode = { kind: 'round'; round: ReferencePrepRound; roundIndex: number };
export type ReferencePrepQueryNode = {
    kind: 'query';
    roundIndex: number;
    queryId: string;
    intent: string;
};
export type ReferencePrepHitNode = { kind: 'hit'; hit: CorpusHit; roundIndex: number };
export type ReferencePrepTreeNode = ReferencePrepRoundNode | ReferencePrepQueryNode | ReferencePrepHitNode;

export class ReferencePrepResultsProvider implements vscode.TreeDataProvider<ReferencePrepTreeNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private process: ReferencePrepProcessFileV020 | null = null;
    private anchorPath: string = '';

    refresh(process: ReferencePrepProcessFileV020 | null, anchorPath?: string): void {
        this.process = process;
        if (anchorPath) this.anchorPath = anchorPath;
        this._onDidChangeTreeData.fire();
    }

    loadFromAnchor(anchorPath: string): void {
        this.anchorPath = anchorPath;
        this.process = loadProcessFile(anchorPath);
        this._onDidChangeTreeData.fire();
    }

    getProcess(): ReferencePrepProcessFileV020 | null {
        return this.process;
    }

    getAnchorPath(): string {
        return this.anchorPath;
    }

    getTreeItem(element: ReferencePrepTreeNode): vscode.TreeItem {
        if (element.kind === 'round') {
            const r = element.round;
            const item = new vscode.TreeItem(
                `轮次 ${element.roundIndex + 1}`,
                vscode.TreeItemCollapsibleState.Expanded
            );
            item.id = `rp-round:${element.roundIndex}`;
            item.description = `${r.queryCount} 查询`;
            item.tooltip = r.startedAt + (r.finishedAt ? ` → ${r.finishedAt}` : '');
            return item;
        }
        if (element.kind === 'query') {
            const item = new vscode.TreeItem(
                element.queryId,
                vscode.TreeItemCollapsibleState.Collapsed
            );
            item.id = `rp-query:${element.roundIndex}:${element.queryId}`;
            item.description = element.intent;
            return item;
        }
        const h = element.hit;
        const label = h.snippet.slice(0, 40).replace(/\s+/g, ' ') + (h.snippet.length > 40 ? '…' : '');
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.id = `rp-hit:${h.hitId}`;
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
        item.contextValue = h.status === 'active' ? 'referencePrepHitActive' : 'referencePrepHitPruned';
        item.iconPath =
            h.status === 'pruned'
                ? new vscode.ThemeIcon('circle-slash')
                : new vscode.ThemeIcon('book');
        item.command = {
            command: 'ai-proofread.referencePrep.openHit',
            title: '打开命中位置',
            arguments: [h],
        };
        return item;
    }

    getChildren(element?: ReferencePrepTreeNode): ReferencePrepTreeNode[] {
        if (!this.process) return [];
        if (!element) {
            return this.process.rounds.map((round, roundIndex) => ({
                kind: 'round' as const,
                round,
                roundIndex,
            }));
        }
        if (element.kind === 'round') {
            const qIds = element.round.plan.queries.map((q) => q.queryId);
            const unique = [...new Set(qIds)];
            return unique.map((queryId) => {
                const q = element.round.plan.queries.find((x) => x.queryId === queryId)!;
                return {
                    kind: 'query' as const,
                    roundIndex: element.roundIndex,
                    queryId,
                    intent: q.intent,
                };
            });
        }
        if (element.kind === 'query') {
            const roundId = this.process!.rounds[element.roundIndex]?.roundId;
            return this.process!.corpus
                .filter((h) => h.queryId === element.queryId && (!roundId || h.roundId === roundId || !h.roundId))
                .map((hit) => ({
                    kind: 'hit' as const,
                    hit,
                    roundIndex: element.roundIndex,
                }));
        }
        return [];
    }

    pruneHit(hitId: string): void {
        if (!this.process || !this.anchorPath) return;
        const h = this.process.corpus.find((x) => x.hitId === hitId);
        if (!h) return;
        h.status = 'pruned';
        h.pruneReason = '手动 prune';
        this.process.mergedReference = buildMergedReference(this.process.corpus);
        saveProcessFile(this.anchorPath, this.process);
        this._onDidChangeTreeData.fire();
    }

    restoreHit(hitId: string): void {
        if (!this.process || !this.anchorPath) return;
        const h = this.process.corpus.find((x) => x.hitId === hitId);
        if (!h) return;
        h.status = 'active';
        h.pruneReason = undefined;
        this.process.mergedReference = buildMergedReference(this.process.corpus);
        saveProcessFile(this.anchorPath, this.process);
        this._onDidChangeTreeData.fire();
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
    } catch (e) {
        vscode.window.showErrorMessage(`无法打开文件：${rel}`);
    }
}
