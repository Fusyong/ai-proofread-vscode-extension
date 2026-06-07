import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { resolveReferencesPath } from '../../citation/referenceStore';
import { digestSha1, formatGrepReferenceBlock } from '../../localDict/dictLookupShared';
import { buildRgCommand, runGrepInReferences } from '../grep/grepRunner';
import { mergeGrepLineHits } from '../grep/hitMerger';
import { expandRetrievalUnit } from '../grep/unitExpander';
import { getStrengthPreset } from '../config';
import type { CorpusHit, ReferencePrepGrepQuery, ReferencePrepStrength, RetrievalUnit } from '../schema';
import type { ResourceScope } from '../schema';
import { isFileInScope } from '../scope/resourceScope';

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
    unit?: RetrievalUnit;
    scopePaths?: string[];
}

export function retrieveGrepHits(params: {
    queries: GrepRetrievalQueryInput[];
    strength: ReferencePrepStrength;
    existingReference?: string;
    scope?: ResourceScope;
    referencesRoot?: string;
    roundId?: string;
}): CorpusHit[] {
    const config = vscode.workspace.getConfiguration('ai-proofread');
    const refPathRaw = config.get<string>('citation.referencesPath', '${workspaceFolder}/references');
    const refRoot = params.referencesRoot ?? resolveReferencesPath(refPathRaw);
    const preset = getStrengthPreset(params.strength);
    const existingReference = params.existingReference ?? '';
    const scopePaths = params.scope?.filePaths?.length
        ? params.scope.filePaths
        : params.queries[0]?.scopePaths;

    const hits: CorpusHit[] = [];

    for (const q of params.queries) {
        const patterns = q.patterns.map((p) => p.trim()).filter(Boolean);
        if (patterns.length === 0) continue;

        const unit = q.unit ?? 'line_context';
        const raw = runGrepInReferences({
            referencesRoot: refRoot,
            patterns,
            patternValue: q.priority,
            contextLines: q.contextLines ?? 2,
            scopePaths: q.scopePaths ?? scopePaths,
        });

        const merged = mergeGrepLineHits(raw, {
            maxHits: preset.grepMaxHitsPerRound,
            proximityLines: 5,
        });

        let totalChars = 0;
        for (const m of merged) {
            if (params.scope && !isFileInScope(m.file, params.scope)) continue;

            const fullPath = path.join(refRoot, m.file);
            let mtimeMs: number | undefined;
            try {
                mtimeMs = fs.statSync(fullPath).mtimeMs;
            } catch {
                /* ignore */
            }

            const expanded = expandRetrievalUnit({
                filePath: fullPath,
                anchorLine: m.startLine,
                unit,
                contextLines: q.contextLines ?? 2,
            });

            const snippet = expanded?.snippet ?? m.snippet;
            const startLine = expanded?.startLine ?? m.startLine;
            const endLine = expanded?.endLine ?? m.endLine;

            if (totalChars + snippet.length > preset.grepMaxSnippetChars) break;

            const digest = digestSha1(`${m.file}:${startLine}\n${snippet}`);
            const beginTag = `<!-- ai-proofread:grepHit begin sha1=${digest} -->`;
            if (existingReference.includes(beginTag)) continue;
            if (hits.some((h) => h.digest === digest)) continue;

            const kind =
                unit === 'file_outline' || expanded?.isHeadingOnly ? 'navigation_hint' : 'evidence';
            const rgPattern = patterns[0] ?? '';
            const rgCommand = buildRgCommand(fullPath, rgPattern, true);

            const block = formatGrepReferenceBlock({
                file: m.file,
                line: startLine,
                snippet,
                digest,
            });

            const hit: CorpusHit = {
                hitId: nextGrepHitId(),
                source: 'grep_md',
                queryId: q.queryId,
                baseValue: q.priority,
                aggregatedValue: m.aggregatedValue,
                llmPriority: q.priority,
                file: m.file,
                relPath: m.file,
                line: startLine,
                startLine,
                endLine,
                snippet: snippet.slice(0, 500),
                digest,
                referenceBlock: block,
                status: 'active',
                kind,
                unit,
                headingPath: expanded?.headingPath,
                paragraphIndex: expanded?.paragraphIndex,
                grepPatterns: patterns,
                rgCommand,
                fileMtimeMs: mtimeMs,
                roundId: params.roundId,
            };
            if (kind === 'navigation_hint') {
                hit.suggestedScope = { file: m.file, headingPath: expanded?.headingPath };
            }
            hits.push(hit);
            totalChars += snippet.length;
        }
    }

    return hits;
}

export function buildGrepMergedReference(hits: CorpusHit[]): string {
    return hits
        .filter((h) => h.status === 'active' && h.kind !== 'navigation_hint')
        .map((h) => h.referenceBlock)
        .join('\n\n');
}
