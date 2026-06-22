import type { CorpusHit, CorpusHitSource } from '../schema';
import { unitKey } from '../grep/unitExpander';
import { capHitsPerFile, dedupeHitsByOverlap, scoreAndSortHits } from './scoring';

export function fuseChannelHits(hits: CorpusHit[], target: string): CorpusHit[] {
    const byUnit = new Map<string, CorpusHit>();
    for (const h of hits) {
        const key =
            h.source === 'wikipedia'
                ? `wiki:${h.pageUrl ?? h.digest}`
                : unitKey(
                      h.relPath ?? h.file ?? '',
                      h.startLine ?? h.line ?? 0,
                      h.endLine ?? h.line ?? 0
                  );
        const prev = byUnit.get(key);
        if (!prev) {
            byUnit.set(key, {
                ...h,
                channelScores: { [h.source]: h.bm25Score ?? h.vectorScore ?? h.baseValue },
            });
            continue;
        }
        const scores = { ...prev.channelScores, [h.source]: h.bm25Score ?? h.vectorScore ?? h.baseValue };
        const merged: CorpusHit = {
            ...prev,
            channelScores: scores,
            baseValue: Math.max(prev.baseValue, h.baseValue),
            grepPatterns: [...new Set([...(prev.grepPatterns ?? []), ...(h.grepPatterns ?? [])])],
            bm25Score: Math.max(prev.bm25Score ?? 0, h.bm25Score ?? 0) || undefined,
            vectorScore: Math.max(prev.vectorScore ?? 0, h.vectorScore ?? 0) || undefined,
        };
        if ((h.finalScore ?? 0) > (prev.finalScore ?? 0)) {
            merged.snippet = h.snippet;
            merged.referenceBlock = h.referenceBlock;
        }
        byUnit.set(key, merged);
    }
    let result = [...byUnit.values()];
    result = scoreAndSortHits(result, target);
    result = dedupeHitsByOverlap(result);
    result = capHitsPerFile(result);
    return result;
}

export function mergeHitsIntoCorpus(corpus: CorpusHit[], incoming: CorpusHit[]): void {
    const seen = new Set(corpus.filter((h) => h.status === 'active').map((h) => h.digest));
    for (const h of incoming) {
        if (seen.has(h.digest)) continue;
        seen.add(h.digest);
        corpus.push(h);
    }
}

export function assignRefTags(hits: CorpusHit[], startIndex = 1): void {
    let n = startIndex;
    for (const h of hits) {
        if (!h.refTag) {
            h.refTag = `R${String(n).padStart(3, '0')}`;
            n++;
        }
    }
}

export function getActiveHitsSorted(corpus: CorpusHit[]): CorpusHit[] {
    return corpus
        .filter((h) => h.status === 'active' && h.kind !== 'navigation_hint')
        .sort((a, b) => (b.finalScore ?? b.aggregatedValue) - (a.finalScore ?? a.aggregatedValue));
}
