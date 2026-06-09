import * as vscode from 'vscode';
import { pickDefaultDictId, resolveLocalDictConfigs, type ResolvedLocalDictConfigItem } from '../../localDict/dictConfig';
import { MdictClient, type LookupMode } from '../../localDict/mdictClient';
import { stripHtmlToText } from '../../localDict/htmlToText';
import {
    buildDedupKeyLegacy,
    buildDictTryList,
    buildLocalDictEntryBeginTag,
    buildOpenccAltTerms,
    digestSha1,
    formatDictReferenceBlock,
    limitCleanText,
    sanitizeLookupTerm,
} from '../../localDict/dictLookupShared';
import type { ReferencePrepDictQuery, ReferencePrepPlanQuery, CorpusHit } from '../schema';
import { getDictPrepConfigKeys } from '../config';

let hitCounter = 0;
function nextHitId(): string {
    hitCounter += 1;
    return `h-dict-${hitCounter}`;
}

export function resetDictHitCounter(): void {
    hitCounter = 0;
}

export async function executeDictQuery(params: {
    query: ReferencePrepPlanQuery;
    dictBlock: ReferencePrepDictQuery;
    context: vscode.ExtensionContext;
    existingReference: string;
    priority: number;
    lookupsBudget: { used: number; max: number };
}): Promise<{ hits: CorpusHit[]; lookupsUsed: number }> {
    const { maxDefinitionChars, cacheEnabled, cacheTtlHours } = getDictPrepConfigKeys();
    const dicts = resolveLocalDictConfigs();
    const defaultDictId = pickDefaultDictId(dicts);
    const mode: LookupMode = 'exact';
    const client = MdictClient.getInstance(params.context);
    const candidates = params.dictBlock.candidates.slice(0, 3);
    const preferredDictId = params.dictBlock.dictId;
    const dictTryList = buildDictTryList(dicts, preferredDictId, defaultDictId);

    const groups = new Map<
        string,
        {
            dictName: string;
            matchedKey: string;
            entries: Map<string, { cleaned: string; digest: string; block: string }>;
            groupLen: number;
        }
    >();

    let lookupsUsed = 0;
    const MAX_ENTRIES_PER_GROUP = 6;

    for (const dict of dictTryList) {
        if (params.lookupsBudget.used + lookupsUsed >= params.lookupsBudget.max) break;
        for (const c of candidates) {
            if (params.lookupsBudget.used + lookupsUsed >= params.lookupsBudget.max) break;
            const baseTerm = sanitizeLookupTerm(c);
            if (!baseTerm) continue;

            const execLookup = async (term: string): Promise<number> => {
                if (params.lookupsBudget.used + lookupsUsed >= params.lookupsBudget.max) return 0;
                lookupsUsed++;
                let rawHits: Awaited<ReturnType<typeof client.lookupMany>> = [];
                try {
                    rawHits = await client.lookupMany(dict, term, mode, {
                        prefixMaxCandidates: 0,
                        minPrefixLength: 999,
                        maxDefinitionChars,
                        cacheEnabled,
                        cacheTtlHours,
                    });
                } catch {
                    return 0;
                }
                if (rawHits.length === 0) return 0;

                for (const h of rawHits) {
                    const cleaned = limitCleanText(stripHtmlToText(h.definition), maxDefinitionChars);
                    const digest = digestSha1(`${h.matchedKey}\n${cleaned}`);
                    const beginTag = buildLocalDictEntryBeginTag(digest);
                    const legacyKey = buildDedupKeyLegacy(dict.id, term, mode);
                    const header = `【本地词典】${h.dictName}｜${h.matchedKey}`;
                    const fingerprint = `${header}\n\n${cleaned}`;
                    if (
                        params.existingReference.includes(beginTag) ||
                        params.existingReference.includes(fingerprint) ||
                        params.existingReference.includes(legacyKey)
                    ) {
                        continue;
                    }
                    const groupKey = `${h.dictId}::${h.matchedKey}`;
                    let g = groups.get(groupKey);
                    if (!g) {
                        g = {
                            dictName: h.dictName,
                            matchedKey: h.matchedKey,
                            entries: new Map(),
                            groupLen: 0,
                        };
                        groups.set(groupKey, g);
                    }
                    g.groupLen = Math.max(g.groupLen, cleaned.length);
                    const block = formatDictReferenceBlock({
                        dictName: h.dictName,
                        matchedKey: h.matchedKey,
                        definition: cleaned,
                        digest,
                    });
                    const prev = g.entries.get(digest);
                    if (!prev || cleaned.length > prev.cleaned.length) {
                        g.entries.set(digest, { cleaned, digest, block });
                    }
                }
                return rawHits.length;
            };

            const n = await execLookup(baseTerm);
            if (n > 0) continue;
            for (const alt of buildOpenccAltTerms(baseTerm)) {
                if (params.lookupsBudget.used + lookupsUsed >= params.lookupsBudget.max) break;
                await execLookup(alt);
            }
        }
    }

    const bestGroup = [...groups.values()].sort((a, b) => b.groupLen - a.groupLen)[0];
    if (!bestGroup) return { hits: [], lookupsUsed };

    const picked = [...bestGroup.entries.values()]
        .sort((a, b) => b.cleaned.length - a.cleaned.length)
        .slice(0, MAX_ENTRIES_PER_GROUP);

    const hits: CorpusHit[] = picked.map((one) => ({
        hitId: nextHitId(),
        source: 'dict',
        queryId: params.query.queryId,
        baseValue: params.priority,
        aggregatedValue: params.priority,
        llmPriority: params.priority,
        finalScore: params.priority,
        snippet: one.cleaned.slice(0, 400),
        digest: one.digest,
        referenceBlock: one.block,
        status: 'active',
        kind: 'evidence' as const,
        matchedKey: bestGroup.matchedKey,
        dictId: params.dictBlock.dictId ?? undefined,
    }));

    return { hits, lookupsUsed };
}
