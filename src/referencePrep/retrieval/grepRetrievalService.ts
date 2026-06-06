import * as vscode from 'vscode';
import { resolveReferencesPath } from '../../citation/referenceStore';
import { digestSha1, formatGrepReferenceBlock } from '../../localDict/dictLookupShared';
import { runGrepInReferences } from '../grep/grepRunner';
import { mergeGrepLineHits } from '../grep/hitMerger';
import { getStrengthPreset } from '../config';
import type { CorpusHit, ReferencePrepGrepQuery, ReferencePrepStrength } from '../schema';

let grepHitCounter = 0;

export function resetGrepHitCounter(): void {
    grepHitCounter = 0;
}

function nextGrepHitId(): string {
    grepHitCounter += 1;
    return `h-grep-${grepHitCounter}`;
}

export interface GrepRetrievalQueryInput {
    queryId: string;
    patterns: string[];
    priority: number;
    contextLines?: number;
}

export function retrieveGrepHits(params: {
    queries: GrepRetrievalQueryInput[];
    strength: ReferencePrepStrength;
    existingReference?: string;
}): CorpusHit[] {
    const config = vscode.workspace.getConfiguration('ai-proofread');
    const refPathRaw = config.get<string>('citation.referencesPath', '${workspaceFolder}/references');
    const refRoot = resolveReferencesPath(refPathRaw);
    const preset = getStrengthPreset(params.strength);
    const existingReference = params.existingReference ?? '';

    const hits: CorpusHit[] = [];

    for (const q of params.queries) {
        const patterns = q.patterns.map((p) => p.trim()).filter(Boolean);
        if (patterns.length === 0) continue;

        const grepBlock: ReferencePrepGrepQuery = {
            patterns,
            contextLines: q.contextLines ?? 2,
        };

        const raw = runGrepInReferences({
            referencesRoot: refRoot,
            patterns: grepBlock.patterns,
            patternValue: q.priority,
            contextLines: grepBlock.contextLines ?? 2,
        });

        const merged = mergeGrepLineHits(raw, {
            maxHits: preset.grepMaxHitsPerRound,
            proximityLines: 5,
        });

        let totalChars = 0;
        for (const m of merged) {
            const snippet = m.snippet;
            if (totalChars + snippet.length > preset.grepMaxSnippetChars) break;
            const digest = digestSha1(`${m.file}:${m.startLine}\n${snippet}`);
            const beginTag = `<!-- ai-proofread:grepHit begin sha1=${digest} -->`;
            if (existingReference.includes(beginTag)) continue;
            const seen = hits.some((h) => h.digest === digest);
            if (seen) continue;

            const block = formatGrepReferenceBlock({
                file: m.file,
                line: m.startLine,
                snippet,
                digest,
            });
            hits.push({
                hitId: nextGrepHitId(),
                source: 'grep_md',
                queryId: q.queryId,
                baseValue: q.priority,
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
    }

    return hits;
}

export function buildGrepMergedReference(hits: CorpusHit[]): string {
    return hits
        .filter((h) => h.status === 'active')
        .map((h) => h.referenceBlock)
        .join('\n\n');
}
