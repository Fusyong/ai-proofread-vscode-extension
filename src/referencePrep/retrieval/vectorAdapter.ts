import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { digestSha1, formatGrepReferenceBlock } from '../../localDict/dictLookupShared';
import { expandRetrievalUnit } from '../grep/unitExpander';
import type { CorpusHit, ReferencePrepGrepQuery, ReferencePrepPlanQuery } from '../schema';
import { getVectorConfig } from '../config';
import type { ResourceScope } from '../schema';
import { isFileInScope } from '../scope/resourceScope';
import { searchVector } from './vectorIndex';

let hitCounter = 0;
export function resetVectorHitCounter(): void {
    hitCounter = 0;
}
function nextHitId(): string {
    hitCounter += 1;
    return `h-vector-${hitCounter}`;
}

export async function executeVectorQuery(params: {
    query: ReferencePrepPlanQuery;
    grepBlock: ReferencePrepGrepQuery;
    priority: number;
    existingReference: string;
    context: vscode.ExtensionContext;
    referencesRoot: string;
    scope?: ResourceScope;
    roundId?: string;
}): Promise<CorpusHit[]> {
    const vecCfg = getVectorConfig();
    if (!vecCfg.enabled) return [];

    const phrases =
        params.grepBlock.searchPhrases?.length
            ? params.grepBlock.searchPhrases
            : params.grepBlock.patterns;
    const queryText = phrases.join(' ');
    if (!queryText.trim()) return [];

    const scopePaths = params.scope?.filePaths?.length ? params.scope.filePaths : undefined;
    const results = await searchVector(
        params.context,
        queryText,
        vecCfg.topK,
        vecCfg.minScore,
        scopePaths
    );

    const unit = params.grepBlock.unit ?? 'sentence';
    const hits: CorpusHit[] = [];
    const existingReference = params.existingReference;

    for (const { row, score } of results) {
        if (params.scope && !isFileInScope(row.file_path, params.scope)) continue;
        const fullPath = path.join(params.referencesRoot, row.file_path);
        let mtimeMs: number | undefined;
        try {
            mtimeMs = fs.statSync(fullPath).mtimeMs;
        } catch {
            /* ignore */
        }
        const anchorLine = row.start_line ?? 1;
        const expanded = expandRetrievalUnit({
            filePath: fullPath,
            anchorLine,
            unit,
            contextLines: params.grepBlock.contextLines ?? 2,
        });
        const snippet = expanded?.snippet ?? row.content;
        const startLine = expanded?.startLine ?? row.start_line ?? 1;
        const endLine = expanded?.endLine ?? row.end_line ?? startLine;
        const digest = digestSha1(`${row.file_path}:${startLine}\n${snippet}`);
        const beginTag = `<!-- ai-proofread:grepHit begin sha1=${digest} -->`;
        if (existingReference.includes(beginTag)) continue;

        const kind = expanded?.isHeadingOnly ? 'navigation_hint' : 'evidence';
        const block = formatGrepReferenceBlock({
            file: row.file_path,
            line: startLine,
            snippet,
            digest,
        });
        hits.push({
            hitId: nextHitId(),
            source: 'vector',
            queryId: params.query.queryId,
            baseValue: params.priority,
            aggregatedValue: params.priority,
            llmPriority: params.priority,
            vectorScore: score,
            snippet: snippet.slice(0, 500),
            digest,
            referenceBlock: block,
            status: 'active',
            kind,
            unit,
            relPath: row.file_path,
            file: row.file_path,
            line: startLine,
            startLine,
            endLine,
            headingPath: expanded?.headingPath,
            fileMtimeMs: mtimeMs,
            roundId: params.roundId,
            grepPatterns: phrases,
        });
    }
    return hits;
}
