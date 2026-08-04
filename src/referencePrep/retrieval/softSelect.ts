import type { CorpusHit, ReferencePrepIntent } from '../schema';
import type { ReferencePrepRunControls } from '../runControls';
import { sanitizeCorpusChannelHit } from './grepNoise';
import { applySenseFitPenalty } from './senseFit';

function intentSourceBoost(intent: ReferencePrepIntent | undefined, source: CorpusHit['source']): number {
    if (!intent) return 0;
    if (intent === 'entity_name' || intent === 'term_norm') {
        if (source === 'dict') return 0.18;
        if (source === 'wikipedia') return 0.08;
        if (source === 'grep_md' || source === 'bm25' || source === 'vector') return -0.06;
    }
    if (intent === 'citation' || intent === 'word_usage') {
        if (source === 'grep_md' || source === 'bm25') return 0.08;
    }
    return 0;
}

function effectiveScore(h: CorpusHit, intentByQuery: Map<string, ReferencePrepIntent>): number {
    const base = h.rerankScore ?? h.finalScore ?? h.aggregatedValue;
    const intent = intentByQuery.get(h.queryId);
    return Math.max(0, Math.min(1, base + intentSourceBoost(intent, h.source)));
}

/**
 * 精排后按 query 软筛选：标记 suggestedForExport，不删除 hit。
 */
export function applySoftSelectToHits(
    hits: CorpusHit[],
    controls: Pick<
        ReferencePrepRunControls,
        'minSelectScore' | 'maxSelectedPerQuery' | 'maxSelectedCharsPerQuery'
    >,
    opts?: { target?: string; intentByQuery?: Map<string, ReferencePrepIntent> }
): CorpusHit[] {
    if (opts?.target) {
        applySenseFitPenalty(hits, opts.target);
    }
    const intentByQuery = opts?.intentByQuery ?? new Map();

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
            .filter((h) => {
                if (h.status !== 'active' || h.kind === 'navigation_hint') return false;
                return sanitizeCorpusChannelHit(h);
            })
            .sort((a, b) => effectiveScore(b, intentByQuery) - effectiveScore(a, intentByQuery));

        let selected = 0;
        let chars = 0;
        for (const h of ranked) {
            const score = effectiveScore(h, intentByQuery);
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
