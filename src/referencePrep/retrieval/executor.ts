import * as vscode from 'vscode';
import { resolveReferencesPath } from '../../citation/referenceStore';
import type {
    CorpusHit,
    ReferencePrepPlan,
    ReferencePrepPlanQuery,
    ReferenceSourceId,
    ReferencePrepStrength,
} from '../schema';
import type { ResourceScope } from '../schema';
import { resolveSourcesForQuery } from './intentMap';
import { executeDictQuery, resetDictHitCounter } from './dictAdapter';
import { executeGrepQuery, resetGrepHitCounter } from './grepAdapter';
import { executeBm25Query, resetBm25HitCounter } from './bm25Adapter';
import { executeVectorQuery, resetVectorHitCounter } from './vectorAdapter';
import { extractFallbackGrepPatterns } from '../referencePrepPrompt';
import { fuseChannelHits } from './fusion';
import { filterDictsByScope } from '../scope/resourceScope';
import { resolveLocalDictConfigs } from '../../localDict/dictConfig';

export async function executeReferencePrepPlan(params: {
    plan: ReferencePrepPlan;
    target: string;
    enabledSources: ReferenceSourceId[];
    strength: ReferencePrepStrength;
    context: vscode.ExtensionContext;
    existingReference: string;
    lookupsBudget: { used: number; max: number };
    scope?: ResourceScope;
    roundId?: string;
}): Promise<CorpusHit[]> {
    resetDictHitCounter();
    resetGrepHitCounter();
    resetBm25HitCounter();
    resetVectorHitCounter();

    const config = vscode.workspace.getConfiguration('ai-proofread');
    const refPathRaw = config.get<string>('citation.referencesPath', '${workspaceFolder}/references');
    const refRoot = resolveReferencesPath(refPathRaw);

    const channelHits: CorpusHit[] = [];
    let reference = params.existingReference;

    for (const planQuery of params.plan.queries) {
        let q = planQuery;
        const sources = resolveSourcesForQuery(q.intent, params.enabledSources);
        const queryHits: CorpusHit[] = [];

        if (sources.includes('dict') && q.dict && params.enabledSources.includes('dict')) {
            const scopedDicts = params.scope
                ? filterDictsByScope(resolveLocalDictConfigs(), params.scope)
                : resolveLocalDictConfigs();
            if (q.dict.dictId && params.scope && !params.scope.dictIds.includes(q.dict.dictId)) {
                q = {
                    ...q,
                    dict: { ...q.dict, dictId: scopedDicts[0]?.id ?? q.dict.dictId },
                };
            }
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
                h.llmPriority = q.priority;
                h.roundId = params.roundId;
                if (q.dict?.dictId) h.dictId = q.dict.dictId;
                queryHits.push(h);
            }
        }

        const grepBlock =
            q.grep ??
            (sources.includes('grep_md')
                ? { patterns: extractFallbackGrepPatterns(params.target).slice(0, 2), contextLines: 2, unit: 'line_context' as const }
                : undefined);

        if (grepBlock && grepBlock.patterns.length > 0) {
            if (params.enabledSources.includes('grep_md')) {
                const grepHits = executeGrepQuery({
                    query: q,
                    grepBlock,
                    priority: q.priority,
                    strength: params.strength,
                    existingReference: reference,
                    scope: params.scope,
                    referencesRoot: refRoot,
                    roundId: params.roundId,
                });
                queryHits.push(...grepHits);
            }

            if (params.enabledSources.includes('bm25')) {
                const bm25Hits = await executeBm25Query({
                    query: q,
                    grepBlock,
                    priority: q.priority,
                    existingReference: reference,
                    context: params.context,
                    referencesRoot: refRoot,
                    scope: params.scope,
                    roundId: params.roundId,
                });
                queryHits.push(...bm25Hits);
            }

            if (params.enabledSources.includes('vector')) {
                const vectorHits = await executeVectorQuery({
                    query: q,
                    grepBlock,
                    priority: q.priority,
                    existingReference: reference,
                    context: params.context,
                    referencesRoot: refRoot,
                    scope: params.scope,
                    roundId: params.roundId,
                });
                queryHits.push(...vectorHits);
            }
        }

        const fused = fuseChannelHits(queryHits, params.target);
        for (const h of fused) {
            channelHits.push(h);
            if (h.kind !== 'navigation_hint') {
                reference = reference ? `${reference}\n\n${h.referenceBlock}` : h.referenceBlock;
            }
        }
    }

    return channelHits;
}

export function applyPruneToCorpus(
    corpus: CorpusHit[],
    plan: ReferencePrepPlan,
    valuePruneThreshold: number
): void {
    const pruneIds = new Set(plan.prune.map((p) => p.hitId));
    for (const h of corpus) {
        if (pruneIds.has(h.hitId)) {
            h.status = 'pruned';
            const reason = plan.prune.find((p) => p.hitId === h.hitId)?.reason;
            if (reason) h.pruneReason = reason;
        } else if ((h.finalScore ?? h.aggregatedValue) < valuePruneThreshold) {
            h.status = 'pruned';
            h.pruneReason = h.pruneReason ?? '低于价值阈值';
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
        .filter((h) => h.status === 'active' && h.kind !== 'navigation_hint')
        .sort((a, b) => (b.finalScore ?? b.aggregatedValue) - (a.finalScore ?? a.aggregatedValue))
        .map((h) => h.referenceBlock)
        .join('\n\n');
}
