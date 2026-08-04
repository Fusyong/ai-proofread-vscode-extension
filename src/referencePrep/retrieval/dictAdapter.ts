import * as vscode from 'vscode';
import { pickDefaultDictId, resolveLocalDictConfigs } from '../../localDict/dictConfig';
import { MdictClient, type LookupMode } from '../../localDict/mdictClient';
import { stripHtmlToText } from '../../localDict/htmlToText';
import { cleanDictDefinition } from '../../localDict/dictCleaners';
import {
    buildDedupKeyLegacy,
    buildDictTryList,
    buildLocalDictEntryBeginTag,
    buildOpenccAltTerms,
    digestSha1,
    formatDictReferenceBlock,
    limitCleanText,
    normalizeDictCandidate,
    sanitizeLookupTerm,
} from '../../localDict/dictLookupShared';
import { senseFitScore } from './senseFit';
import type { ReferencePrepDictQuery, ReferencePrepPlanQuery, CorpusHit } from '../schema';
import { getDictPrepConfigKeys } from '../config';
import type { ReferencePrepRunControls } from '../runControls';
import { defaultControlsForStrength } from '../runControls';
import { relevanceToTarget, selectDictEntries, type DictEntryPick } from './dictSelect';

export { selectDictEntries } from './dictSelect';

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
    target?: string;
    controls?: ReferencePrepRunControls;
}): Promise<{ hits: CorpusHit[]; lookupsUsed: number }> {
    const { maxDefinitionChars, cacheEnabled, cacheTtlHours } = getDictPrepConfigKeys();
    const controls = params.controls ?? defaultControlsForStrength('standard');
    const dicts = resolveLocalDictConfigs();
    const defaultDictId = pickDefaultDictId(dicts);
    const mode: LookupMode = 'exact';
    const client = MdictClient.getInstance(params.context);
    const rawCandidates = params.dictBlock.candidates.slice(0, 3);
    const candidates = [
        ...new Set(
            rawCandidates
                .flatMap((c) => {
                    const full = sanitizeLookupTerm(c);
                    const bare = normalizeDictCandidate(c);
                    return bare && bare !== full ? [bare, full] : [bare || full];
                })
                .filter(Boolean)
        ),
    ].slice(0, 4);
    const preferredDictId = params.dictBlock.dictId ?? defaultDictId ?? null;
    const dictTryList = buildDictTryList(dicts, preferredDictId, defaultDictId);
    const target = params.target ?? rawCandidates.join(' ');

    const entries: DictEntryPick[] = [];
    const seenDigest = new Set<string>();

    let lookupsUsed = 0;

    for (const dict of dictTryList) {
        if (params.lookupsBudget.used + lookupsUsed >= params.lookupsBudget.max) break;
        for (const c of candidates) {
            if (params.lookupsBudget.used + lookupsUsed >= params.lookupsBudget.max) break;
            const baseTerm = normalizeDictCandidate(c) || sanitizeLookupTerm(c);
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
                    const stripped = stripHtmlToText(h.definition);
                    const cleanedRaw = cleanDictDefinition({
                        text: stripped,
                        dictId: h.dictId,
                        tags: dict.tags,
                    });
                    const cleaned = limitCleanText(cleanedRaw, maxDefinitionChars);
                    const digest = digestSha1(`${h.matchedKey}\n${cleaned}`);
                    if (seenDigest.has(digest)) continue;
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
                    seenDigest.add(digest);
                    const block = formatDictReferenceBlock({
                        dictName: h.dictName,
                        matchedKey: h.matchedKey,
                        definition: cleaned,
                        digest,
                    });
                    const lit = relevanceToTarget(target, h.matchedKey, cleaned, rawCandidates);
                    const sense = senseFitScore(target, `${h.matchedKey}\n${cleaned}`);
                    entries.push({
                        dictId: h.dictId,
                        dictName: h.dictName,
                        matchedKey: h.matchedKey,
                        cleaned,
                        digest,
                        block,
                        relevance: Math.max(0, Math.min(1, lit * 0.55 + sense * 0.45)),
                    });
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

    const picked = selectDictEntries(entries, preferredDictId, controls);
    const hits: CorpusHit[] = picked.map((one) => ({
        hitId: nextHitId(),
        source: 'dict',
        queryId: params.query.queryId,
        baseValue: params.priority,
        aggregatedValue: params.priority,
        llmPriority: params.priority,
        finalScore: Math.max(params.priority * 0.5, one.relevance),
        snippet: one.cleaned.slice(0, 400),
        digest: one.digest,
        referenceBlock: one.block,
        status: 'active',
        kind: 'evidence' as const,
        matchedKey: one.matchedKey,
        dictId: one.dictId,
    }));

    return { hits, lookupsUsed };
}
