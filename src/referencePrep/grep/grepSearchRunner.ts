import * as path from 'path';
import * as vscode from 'vscode';
import { FilePathUtils } from '../../utils';
import { runReferencePrepForTarget } from '../referencePrepRunner';
import type { CorpusHit, ReferencePrepProcessFileV020, ReferencePrepStrength } from '../schema';

export interface GrepSearchRunParams {
    description: string;
    strength: ReferencePrepStrength;
    context: vscode.ExtensionContext;
    anchorPath: string;
    onProgress?: (msg: string) => void;
    token?: vscode.CancellationToken;
    freshProcess?: boolean;
    continuation?: boolean;
    maxRoundsOverride?: number;
}

export interface GrepSearchRunResult {
    mergedReference: string;
    process: ReferencePrepProcessFileV020;
    hits: CorpusHit[];
}

/**
 * 复用 knowledge verify 的 referencePrep 多轮 grep 流程（sufficient / prune / executeReferencePrepPlan），
 * 仅启用 grep_md，输入为检索意图描述。
 */
export async function runLlmGrepSearch(params: GrepSearchRunParams): Promise<GrepSearchRunResult> {
    const { mergedReference, process } = await runReferencePrepForTarget({
        target: params.description,
        anchorPath: params.anchorPath,
        context: params.context,
        enabledSources: ['grep_md', 'bm25', 'vector'],
        strength: params.strength,
        targetKind: 'search_intent',
        freshProcess: params.freshProcess ?? true,
        continuation: params.continuation,
        maxRoundsOverride: params.maxRoundsOverride,
        onProgress: params.onProgress,
        token: params.token,
    });

    const hits = process.corpus.filter((h) => h.status === 'active');
    return { mergedReference, process, hits };
}

export function resolveGrepSearchAnchorPath(editor?: vscode.TextEditor): string {
    if (editor) {
        const { uri } = editor.document;
        if (uri.scheme !== 'untitled' && uri.fsPath) {
            return uri.fsPath;
        }
    }
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (ws) {
        const anchorPath = path.join(ws, '.proofread', 'llm-grep-search.md');
        FilePathUtils.ensureDirExists(path.dirname(anchorPath));
        return anchorPath;
    }
    throw new Error('请先打开工作区，或在编辑器中打开/保存一个文件。');
}

export function summarizeGrepPatterns(process: ReferencePrepProcessFileV020): string {
    const patterns = process.rounds.flatMap((r) =>
        r.plan.queries.flatMap((q) => q.grep?.patterns ?? [])
    );
    const unique = [...new Set(patterns)];
    return unique.length > 0 ? unique.join(' / ') : '(无)';
}
