import * as vscode from 'vscode';
import type { CorpusHit, ReferencePrepPlan, ReferencePrepPlanQuery, ReferenceSourceId, ReferencePrepStrength } from '../schema';
import { resolveSourcesForQuery } from './intentMap';
import { executeDictQuery, resetDictHitCounter } from './dictAdapter';
import { executeGrepQuery, resetGrepHitCounter } from './grepAdapter';
import { extractFallbackGrepPatterns } from '../referencePrepPrompt';

export async function executeReferencePrepPlan(params: {
    plan: ReferencePrepPlan;
    target: string;
    enabledSources: ReferenceSourceId[];
    strength: ReferencePrepStrength;
    context: vscode.ExtensionContext;
    existingReference: string;
    lookupsBudget: { used: number; max: number };
}): Promise<CorpusHit[]> {
    resetDictHitCounter();
    resetGrepHitCounter();

    const newHits: CorpusHit[] = [];
    let reference = params.existingReference;

    for (const q of params.plan.queries) {
        const sources = resolveSourcesForQuery(q.intent, params.enabledSources);
        if (sources.includes('dict') && q.dict && params.enabledSources.includes('dict')) {
            const { hits, lookupsUsed } = await executeDictQuery({
                query: q,
                dictBlock: q.dict,
                context: params.context,
                existingReference: reference,
                priority: q.priority,
                lookupsBudget: params.lookupsBudget,
            });
            params.lookupsBudget.used += lookupsUsed;
            for (const h of hits) {
                newHits.push(h);
                reference = reference ? `${reference}\n\n${h.referenceBlock}` : h.referenceBlock;
            }
        }
        if (sources.includes('grep_md') && params.enabledSources.includes('grep_md')) {
            const grepBlock = q.grep ?? (sources.includes('grep_md') ? { patterns: extractFallbackGrepPatterns(params.target).slice(0, 2), contextLines: 2 } : undefined);
            if (grepBlock && grepBlock.patterns.length > 0) {
                const hits = executeGrepQuery({
                    query: q,
                    grepBlock,
                    priority: q.priority,
                    strength: params.strength,
                    existingReference: reference,
                });
                for (const h of hits) {
                    newHits.push(h);
                    reference = reference ? `${reference}\n\n${h.referenceBlock}` : h.referenceBlock;
                }
            }
        }
    }
    return newHits;
}

export function applyPruneToCorpus(
    corpus: CorpusHit[],
    plan: ReferencePrepPlan,
    valuePruneThreshold: number
): void {
    const pruneIds = new Set(plan.prune.map((p) => p.hitId));
    for (const h of corpus) {
        if (pruneIds.has(h.hitId) || h.aggregatedValue < valuePruneThreshold) {
            h.status = 'pruned';
        }
    }
}

export function mergeCorpusDedupe(corpus: CorpusHit[], incoming: CorpusHit[]): void {
    const seen = new Set(corpus.filter((h) => h.status === 'active').map((h) => h.digest));
    for (const h of incoming) {
        if (seen.has(h.digest)) continue;
        seen.add(h.digest);
        corpus.push(h);
    }
}

export function buildMergedReference(corpus: CorpusHit[]): string {
    return corpus
        .filter((h) => h.status === 'active')
        .map((h) => h.referenceBlock)
        .join('\n\n');
}
