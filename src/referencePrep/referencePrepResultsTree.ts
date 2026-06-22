import type { CorpusHit, ReferencePrepProcessFileV020, ReferencePrepRound } from './schema';

/** 词典命中无文献路径，不宜「打开命中位置」 */
export function canOpenHitInEditor(hit: CorpusHit): boolean {
    if (hit.source === 'dict' || hit.source === 'wikipedia') return false;
    const rel = (hit.relPath ?? hit.file)?.trim();
    return Boolean(rel);
}

export function canOpenHitInBrowser(hit: CorpusHit): boolean {
    return hit.source === 'wikipedia' && Boolean(hit.pageUrl?.trim());
}

export function referencePrepHitContextValue(hit: CorpusHit): string {
    if (hit.source === 'wikipedia') {
        return hit.status === 'pruned' ? 'referencePrepHitPrunedWeb' : 'referencePrepHitActiveWeb';
    }
    const openable = canOpenHitInEditor(hit);
    if (hit.status === 'pruned') {
        return openable ? 'referencePrepHitPruned' : 'referencePrepHitPrunedDict';
    }
    return openable ? 'referencePrepHitActive' : 'referencePrepHitActiveDict';
}

/** 某轮某 query 在 corpus 中的命中（严格按 roundId，兼容无 roundId 的旧数据） */
export function getHitsForRoundQuery(
    process: ReferencePrepProcessFileV020,
    roundIndex: number,
    queryId: string
): CorpusHit[] {
    const round = process.rounds[roundIndex];
    if (!round) return [];
    const roundId = round.roundId;
    return process.corpus.filter((h) => {
        if (h.queryId !== queryId) return false;
        if (!roundId) return true;
        if (h.roundId) return h.roundId === roundId;
        const firstRoundWithQuery = process.rounds.findIndex((r) =>
            r.plan.queries.some((q) => q.queryId === queryId)
        );
        return roundIndex === firstRoundWithQuery;
    });
}

export function getRoundHitCount(process: ReferencePrepProcessFileV020, roundIndex: number): number {
    const round = process.rounds[roundIndex];
    if (!round) return 0;
    const qIds = [...new Set(round.plan.queries.map((q) => q.queryId))];
    return qIds.reduce((n, qid) => n + getHitsForRoundQuery(process, roundIndex, qid).length, 0);
}

/** 该轮下至少有 1 条命中的 queryId（保持 plan 顺序） */
export function getQueryIdsWithHits(process: ReferencePrepProcessFileV020, round: ReferencePrepRound, roundIndex: number): string[] {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const q of round.plan.queries) {
        if (seen.has(q.queryId)) continue;
        seen.add(q.queryId);
        if (getHitsForRoundQuery(process, roundIndex, q.queryId).length > 0) {
            ordered.push(q.queryId);
        }
    }
    return ordered;
}

export function roundHasVisibleHits(process: ReferencePrepProcessFileV020, roundIndex: number): boolean {
    return getRoundHitCount(process, roundIndex) > 0;
}
