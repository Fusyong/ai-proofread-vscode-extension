import * as path from 'path';
import * as vscode from 'vscode';
import { FilePathUtils } from '../utils';
import { runReferencePrepForTarget } from './referencePrepRunner';
import type { ReferencePrepResultsProvider } from './referencePrepResultsView';
import type {
    CorpusHit,
    ReferencePrepProcessFileV020,
    ReferencePrepStrength,
    ReferenceSourceId,
} from './schema';
import type { ReferencePrepTargetKind } from './referencePrepPrompt';

/** LLM 增强检索 / 核对选中引文 / 知识核查「仅准备」等共用的默认资料来源 */
export const DEFAULT_REFERENCE_PREP_SOURCES: ReferenceSourceId[] = [
    'dict',
    'grep_md',
    'bm25',
    'vector',
];

export const REFERENCE_PREP_STRENGTH_OPTIONS: Array<{
    label: string;
    description: string;
    value: ReferencePrepStrength;
}> = [
    { label: '轻量', description: '1 轮，较少查询', value: 'light' },
    { label: '标准', description: '3 轮', value: 'standard' },
    { label: '深入', description: '5 轮，更多查询', value: 'thorough' },
];

export interface ReferencePrepSessionParams {
    target: string;
    targetKind: ReferencePrepTargetKind;
    strength: ReferencePrepStrength;
    context: vscode.ExtensionContext;
    anchorPath: string;
    enabledSources?: ReferenceSourceId[];
    intents?: import('./schema').ReferencePrepIntent[];
    onProgress?: (msg: string) => void;
    token?: vscode.CancellationToken;
    freshProcess?: boolean;
    continuation?: boolean;
    maxRoundsOverride?: number;
}

export interface ReferencePrepSessionResult {
    mergedReference: string;
    process: ReferencePrepProcessFileV020;
    hits: CorpusHit[];
}

/**
 * 统一的参考资料准备会话：资源预筛 → 多轮规划 → 检索 → LLM 精排。
 * 知识核查（仅准备）、LLM 增强检索、核对选中引文均经此入口，差异在 targetKind / 提示词 / 是否校对。
 */
export async function runReferencePrepSession(
    params: ReferencePrepSessionParams
): Promise<ReferencePrepSessionResult> {
    const { mergedReference, process } = await runReferencePrepForTarget({
        target: params.target,
        anchorPath: params.anchorPath,
        context: params.context,
        enabledSources: params.enabledSources ?? DEFAULT_REFERENCE_PREP_SOURCES,
        strength: params.strength,
        targetKind: params.targetKind,
        intents: params.intents,
        freshProcess: params.freshProcess ?? true,
        continuation: params.continuation,
        maxRoundsOverride: params.maxRoundsOverride,
        onProgress: params.onProgress,
        token: params.token,
    });
    const hits = process.corpus.filter((h) => h.status === 'active');
    return { mergedReference, process, hits };
}

export function resolveEditorAnchorPath(
    editor: vscode.TextEditor | undefined,
    workspaceFallbackBasename: string
): string {
    if (editor) {
        const { uri } = editor.document;
        if (uri.scheme !== 'untitled' && uri.fsPath) {
            return uri.fsPath;
        }
    }
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (ws) {
        const anchorPath = path.join(ws, '.proofread', workspaceFallbackBasename);
        FilePathUtils.ensureDirExists(path.dirname(anchorPath));
        return anchorPath;
    }
    throw new Error('请先打开工作区，或在编辑器中打开/保存一个文件。');
}

export async function pickReferencePrepStrength(
    title: string,
    defaultStrength: ReferencePrepStrength = 'standard'
): Promise<ReferencePrepStrength | undefined> {
    const picked = await vscode.window.showQuickPick(
        REFERENCE_PREP_STRENGTH_OPTIONS.map((o) => ({
            ...o,
            picked: o.value === defaultStrength,
        })),
        {
            title,
            placeHolder: '控制轮次、查询数与命中预算（与知识核查相同）',
            ignoreFocusOut: true,
        }
    );
    return picked?.value;
}

export async function presentReferencePrepSessionResult(params: {
    resultsProvider?: ReferencePrepResultsProvider;
    anchorPath: string;
    process: ReferencePrepProcessFileV020;
    mergedReference: string;
    informationMessage: string;
    openMergedBeside?: boolean;
}): Promise<void> {
    if (params.resultsProvider) {
        await vscode.commands.executeCommand('setContext', 'aiProofread.showReferencePrepResultsView', true);
        params.resultsProvider.refresh(params.process, params.anchorPath);
    }
    if (params.mergedReference.trim()) {
        const doc = await vscode.workspace.openTextDocument({
            content: params.mergedReference,
            language: 'markdown',
        });
        await vscode.window.showTextDocument(doc, {
            preview: true,
            viewColumn: params.openMergedBeside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active,
        });
    }
    vscode.window.showInformationMessage(params.informationMessage);
}

export function summarizeSessionPatterns(process: ReferencePrepProcessFileV020): string {
    const patterns = process.rounds.flatMap((r) =>
        r.plan.queries.flatMap((q) => q.grep?.patterns ?? [])
    );
    const unique = [...new Set(patterns)];
    return unique.length > 0 ? unique.join(' / ') : '(无)';
}
