import * as vscode from 'vscode';
import { resolveReferencesPath } from '../../citation/referenceStore';
import { digestSha1, formatGrepReferenceBlock } from '../../localDict/dictLookupShared';
import { runGrepInReferences } from '../grep/grepRunner';
import { mergeGrepLineHits } from '../grep/hitMerger';
import type { CorpusHit, ReferencePrepGrepQuery, ReferencePrepPlanQuery } from '../schema';
import { getStrengthPreset } from '../config';
import type { ReferencePrepStrength } from '../schema';

let grepHitCounter = 0;
export function resetGrepHitCounter(): void {
    grepHitCounter = 0;
}

function nextGrepHitId(): string {
    grepHitCounter += 1;
    return `h-grep-${grepHitCounter}`;
}

export function executeGrepQuery(params: {
    query: ReferencePrepPlanQuery;
    grepBlock: ReferencePrepGrepQuery;
    priority: number;
    strength: ReferencePrepStrength;
    existingReference: string;
}): CorpusHit[] {
    const config = vscode.workspace.getConfiguration('ai-proofread');
    const refPathRaw = config.get<string>('citation.referencesPath', '${workspaceFolder}/references');
    const refRoot = resolveReferencesPath(refPathRaw);
    const preset = getStrengthPreset(params.strength);

    const raw = runGrepInReferences({
        referencesRoot: refRoot,
        patterns: params.grepBlock.patterns,
        patternValue: params.priority,
        contextLines: params.grepBlock.contextLines ?? 2,
    });

    const merged = mergeGrepLineHits(raw, {
        maxHits: preset.grepMaxHitsPerRound,
        proximityLines: 5,
    });

    const hits: CorpusHit[] = [];
    let totalChars = 0;
    for (const m of merged) {
        const snippet = m.snippet;
        if (totalChars + snippet.length > preset.grepMaxSnippetChars) break;
        const digest = digestSha1(`${m.file}:${m.startLine}\n${snippet}`);
        const beginTag = `<!-- ai-proofread:grepHit begin sha1=${digest} -->`;
        if (params.existingReference.includes(beginTag)) continue;
        const block = formatGrepReferenceBlock({
            file: m.file,
            line: m.startLine,
            snippet,
            digest,
        });
        hits.push({
            hitId: nextGrepHitId(),
            source: 'grep_md',
            queryId: params.query.queryId,
            baseValue: params.priority,
            aggregatedValue: m.aggregatedValue,
            file: m.file,
            line: m.startLine,
            snippet: snippet.slice(0, 500),
            digest,
            referenceBlock: block,
            status: 'active',
        });
        totalChars += snippet.length;
    }
    return hits;
}
