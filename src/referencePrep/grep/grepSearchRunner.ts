import {
    resolveEditorAnchorPath,
    runReferencePrepSession,
    type ReferencePrepSessionParams,
    type ReferencePrepSessionResult,
} from '../referencePrepSession';

export type GrepSearchRunParams = Omit<ReferencePrepSessionParams, 'targetKind'> & {
    description: string;
};

export type GrepSearchRunResult = ReferencePrepSessionResult;

/**
 * LLM 增强参考文献检索：共用 referencePrep 全流程，规划提示词为 search_intent。
 */
export async function runLlmGrepSearch(params: GrepSearchRunParams): Promise<GrepSearchRunResult> {
    return runReferencePrepSession({
        ...params,
        target: params.description,
        targetKind: 'search_intent',
    });
}

export function resolveGrepSearchAnchorPath(editor?: import('vscode').TextEditor): string {
    return resolveEditorAnchorPath(editor, 'llm-grep-search.md');
}

export { summarizeSessionPatterns as summarizeGrepPatterns } from '../referencePrepSession';
export type { ReferencePrepProcessFileV020 } from '../schema';
