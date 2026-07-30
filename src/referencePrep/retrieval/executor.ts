import * as vscode from 'vscode';
import { resolveReferencesPath } from '../../citation/referenceStore';
import type {
    CorpusHit,
    ReferencePrepPlan,
    ReferenceSourceId,
    ReferencePrepStrength,
} from '../schema';
import type { ResourceScope } from '../schema';
import { resolveSourcesForQuery } from './intentMap';
import { executeDictQuery } from './dictAdapter';
import { executeGrepQuery } from './grepAdapter';
import { executeBm25Query } from './bm25Adapter';
import { executeVectorQuery } from './vectorAdapter';
import { executeWikipediaQuery } from './wikipediaAdapter';
import { executeWebQuery, isWebSearchConfigured } from './webAdapter';
import { extractFallbackGrepPatterns, extractFallbackSearchPhrases } from '../referencePrepPrompt';
import { fuseChannelHits } from './fusion';
import { filterDictsByScope } from '../scope/resourceScope';
import { resolveLocalDictConfigs } from '../../localDict/dictConfig';
import { buildScopeCacheKey, withRetrievalCache } from './retrievalCache';

export async function executeReferencePrepPlan(params: {
    plan: ReferencePrepPlan;
    target: string;
    enabledSources: ReferenceSourceId[];
    strength: ReferencePrepStrength;
    context: vscode.ExtensionContext;
    existingReference: string;
    lookupsBudget: { used: number; max: number };
    wikiRequestsBudget?: { used: number; max: number };
    scope?: ResourceScope;
    roundId?: string;
    catalogSnapshotId?: string;
}): Promise<CorpusHit[]> {
    const config = vscode.workspace.getConfiguration('ai-proofread');
    const refPathRaw = config.get<string>('citation.referencesPath', '${workspaceFolder}/references');
    const refRoot = resolveReferencesPath(refPathRaw);

    const scopeKey = params.scope
        ? buildScopeCacheKey({
              catalogSnapshotId: params.catalogSnapshotId,
              dictIds: params.scope.dictIds,
              filePaths: params.scope.filePaths,
          })
        : undefined;

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
            const dictBlock = q.dict;
            const { hits } = await withRetrievalCache({
                source: 'dict',
                keyParts: {
                    intent: q.intent,
                    dictId: dictBlock.dictId,
                    candidates: dictBlock.candidates,
                    strength: params.strength,
                },
                scopeKey,
                catalogSnapshotId: params.catalogSnapshotId,
                roundId: params.roundId,
                priority: q.priority,
                existingReference: reference,
                produce: async () => {
                    const { hits: produced, lookupsUsed } = await executeDictQuery({
                        query: q,
                        dictBlock,
                        context: params.context,
                        // 不在此按 existingReference 过滤，避免把「已有资料导致的空结果」写入缓存
                        existingReference: '',
                        priority: q.priority,
                        lookupsBudget: params.lookupsBudget,
                    });
                    params.lookupsBudget.used += lookupsUsed;
                    for (const h of produced) {
                        h.llmPriority = q.priority;
                        h.roundId = params.roundId;
                        if (dictBlock.dictId) h.dictId = dictBlock.dictId;
                    }
                    return produced;
                },
            });
            queryHits.push(...hits);
        }

        if (
            params.enabledSources.includes('wikipedia') &&
            q.wikipedia &&
            params.wikiRequestsBudget
        ) {
            const wikiBlock = q.wikipedia;
            const { hits } = await withRetrievalCache({
                source: 'wikipedia',
                keyParts: {
                    intent: q.intent,
                    searchTerms: wikiBlock.searchTerms,
                    titles: wikiBlock.titles,
                    lang: wikiBlock.lang,
                    includeWikidata: wikiBlock.includeWikidata,
                    strength: params.strength,
                },
                scopeKey,
                catalogSnapshotId: params.catalogSnapshotId,
                roundId: params.roundId,
                priority: q.priority,
                existingReference: reference,
                produce: async () => {
                    const { hits: produced } = await executeWikipediaQuery({
                        query: q,
                        wikiBlock,
                        existingReference: '',
                        priority: q.priority,
                        strength: params.strength,
                        roundId: params.roundId,
                        requestsBudget: params.wikiRequestsBudget!,
                    });
                    return produced;
                },
            });
            queryHits.push(...hits);
        }

        if (params.enabledSources.includes('web') && isWebSearchConfigured()) {
            const webBlock =
                q.web ??
                (q.wikipedia?.searchTerms
                    ? { searchTerms: q.wikipedia.searchTerms, why: q.wikipedia.why }
                    : q.grep?.patterns
                      ? { searchTerms: q.grep.patterns.slice(0, 3) }
                      : undefined);
            if (webBlock?.searchTerms?.length) {
                const { hits } = await withRetrievalCache({
                    source: 'web',
                    keyParts: { intent: q.intent, searchTerms: webBlock.searchTerms },
                    scopeKey,
                    catalogSnapshotId: params.catalogSnapshotId,
                    roundId: params.roundId,
                    priority: q.priority,
                    existingReference: reference,
                    produce: async () => {
                        const webBudget = { used: 0, max: 10 };
                        const { hits: produced } = await executeWebQuery({
                            query: q,
                            webBlock,
                            priority: q.priority,
                            existingReference: '',
                            roundId: params.roundId,
                            requestsBudget: webBudget,
                        });
                        return produced;
                    },
                });
                queryHits.push(...hits);
            }
        }

        const wantsCorpusSearch =
            sources.includes('grep_md') || sources.includes('bm25') || sources.includes('vector');

        let grepBlock = q.grep;
        if (!grepBlock && wantsCorpusSearch) {
            const fromQuotes = extractFallbackGrepPatterns(params.target);
            const fromDict = q.dict?.candidates?.map((c) => c.trim()).filter(Boolean) ?? [];
            const phrases =
                fromQuotes.length > 0
                    ? fromQuotes
                    : fromDict.length > 0
                      ? fromDict
                      : extractFallbackSearchPhrases(params.target);
            if (phrases.length > 0) {
                grepBlock = {
                    patterns: phrases.slice(0, 4),
                    searchPhrases: phrases.slice(0, 6),
                    contextLines: 2,
                    unit: 'sentence',
                };
            }
        }

        if (grepBlock && (grepBlock.patterns.length > 0 || (grepBlock.searchPhrases?.length ?? 0) > 0)) {
            if (!grepBlock.patterns.length && grepBlock.searchPhrases?.length) {
                grepBlock = { ...grepBlock, patterns: grepBlock.searchPhrases.slice(0, 4) };
            }
            const grepKeyParts = {
                intent: q.intent,
                patterns: grepBlock.patterns,
                searchPhrases: grepBlock.searchPhrases,
                contextLines: grepBlock.contextLines,
                unit: grepBlock.unit,
                scopePaths: grepBlock.scopePaths,
                strength: params.strength,
            };

            if (params.enabledSources.includes('grep_md')) {
                const { hits } = await withRetrievalCache({
                    source: 'grep_md',
                    keyParts: grepKeyParts,
                    scopeKey,
                    catalogSnapshotId: params.catalogSnapshotId,
                    roundId: params.roundId,
                    priority: q.priority,
                    existingReference: reference,
                    produce: () =>
                        executeGrepQuery({
                            query: q,
                            grepBlock,
                            priority: q.priority,
                            strength: params.strength,
                            existingReference: '',
                            scope: params.scope,
                            referencesRoot: refRoot,
                            roundId: params.roundId,
                        }),
                });
                queryHits.push(...hits);
            }

            if (params.enabledSources.includes('bm25')) {
                const { hits } = await withRetrievalCache({
                    source: 'bm25',
                    keyParts: grepKeyParts,
                    scopeKey,
                    catalogSnapshotId: params.catalogSnapshotId,
                    roundId: params.roundId,
                    priority: q.priority,
                    existingReference: reference,
                    produce: () =>
                        executeBm25Query({
                            query: q,
                            grepBlock,
                            priority: q.priority,
                            existingReference: '',
                            context: params.context,
                            referencesRoot: refRoot,
                            scope: params.scope,
                            roundId: params.roundId,
                        }),
                });
                queryHits.push(...hits);
            }

            if (params.enabledSources.includes('vector')) {
                const { hits } = await withRetrievalCache({
                    source: 'vector',
                    keyParts: grepKeyParts,
                    scopeKey,
                    catalogSnapshotId: params.catalogSnapshotId,
                    roundId: params.roundId,
                    priority: q.priority,
                    existingReference: reference,
                    produce: () =>
                        executeVectorQuery({
                            query: q,
                            grepBlock,
                            priority: q.priority,
                            existingReference: '',
                            context: params.context,
                            referencesRoot: refRoot,
                            scope: params.scope,
                            roundId: params.roundId,
                        }),
                });
                queryHits.push(...hits);
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
