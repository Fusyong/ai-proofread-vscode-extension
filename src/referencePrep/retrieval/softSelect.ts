import type { CorpusHit } from '../schema';
import type { ReferencePrepRunControls } from '../runControls';

/**
 * 精排后按 query 软筛选：标记 suggestedForExport，不删除 hit。
 */
export function applySoftSelectToHits(
    hits: CorpusHit[],
    controls: Pick<
        ReferencePrepRunControls,
        'minSelectScore' | 'maxSelectedPerQuery' | 'maxSelectedCharsPerQuery'
    >
): CorpusHit[] {
    const byQuery = new Map<string, CorpusHit[]>();
    for (const h of hits) {
        const list = byQuery.get(h.queryId) ?? [];
        list.push(h);
        byQuery.set(h.queryId, list);
    }

    for (const list of byQuery.values()) {
        for (const h of list) {
            h.suggestedForExport = false;
        }
        const ranked = [...list]
            .filter((h) => h.status === 'active' && h.kind !== 'navigation_hint')
            .sort(
                (a, b) =>
                    (b.rerankScore ?? b.finalScore ?? b.aggregatedValue) -
                    (a.rerankScore ?? a.finalScore ?? a.aggregatedValue)
            );

        let selected = 0;
        let chars = 0;
        for (const h of ranked) {
            const score = h.rerankScore ?? h.finalScore ?? h.aggregatedValue;
            if (score < controls.minSelectScore) continue;
            const blockLen = (h.referenceBlock || h.snippet || '').length;
            if (selected >= controls.maxSelectedPerQuery) continue;
            if (selected > 0 && chars + blockLen > controls.maxSelectedCharsPerQuery) continue;
            h.suggestedForExport = true;
            selected++;
            chars += blockLen;
        }
    }
    return hits;
}

/** 按 query 截断候选池（L2），保留高分 */
export function capCandidateHitsPerQuery(
    hits: CorpusHit[],
    maxPerQuery: number
): CorpusHit[] {
    if (maxPerQuery <= 0) return hits;
    const byQuery = new Map<string, CorpusHit[]>();
    for (const h of hits) {
        const list = byQuery.get(h.queryId) ?? [];
        list.push(h);
        byQuery.set(h.queryId, list);
    }
    const out: CorpusHit[] = [];
    for (const list of byQuery.values()) {
        const ranked = [...list].sort(
            (a, b) =>
                (b.finalScore ?? b.aggregatedValue) - (a.finalScore ?? a.aggregatedValue)
        );
        out.push(...ranked.slice(0, maxPerQuery));
    }
    return out;
}
