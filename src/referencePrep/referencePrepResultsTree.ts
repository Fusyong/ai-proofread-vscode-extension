import type { CorpusHit, ReferencePrepIntent, ReferencePrepProcessFileV020, ReferencePrepRound } from './schema';

/** 查询意图英文枚举 → 侧栏展示用中文（entity_name 等是合法 intent，不是实体名） */
export function formatReferencePrepIntent(intent: string): string {
    const map: Record<ReferencePrepIntent, string> = {
        entity_name: '专名',
        term_norm: '术语',
        citation: '引文',
        general_fact: '通识',
        word_usage: '用法',
    };
    return map[intent as ReferencePrepIntent] ?? intent;
}

/** 词典命中无文献路径，不宜「打开命中位置」 */
export function canOpenHitInEditor(hit: CorpusHit): boolean {
    if (hit.source === 'dict' || hit.source === 'wikipedia' || hit.source === 'web') return false;
    const rel = (hit.relPath ?? hit.file)?.trim();
    return Boolean(rel);
}

export function canOpenHitInBrowser(hit: CorpusHit): boolean {
    return (
        (hit.source === 'wikipedia' || hit.source === 'web') && Boolean(hit.pageUrl?.trim())
    );
}

/**
 * 选区/引文 vs 文献摘录的 diff 只适用于平行正文（grep / BM25 / 向量）。
 * 词典、百科、网页是释义或转述，与书稿做字面 diff 没有核对意义。
 */
export function canDiffHit(hit: CorpusHit): boolean {
    if (hit.kind === 'navigation_hint') return false;
    return hit.source === 'grep_md' || hit.source === 'bm25' || hit.source === 'vector';
}

export function referencePrepHitContextValue(hit: CorpusHit): string {
    let base: string;
    if (hit.source === 'wikipedia' || hit.source === 'web') {
        base = hit.status === 'pruned' ? 'referencePrepHitPrunedWeb' : 'referencePrepHitActiveWeb';
    } else {
        const openable = canOpenHitInEditor(hit);
        if (hit.status === 'pruned') {
            base = openable ? 'referencePrepHitPruned' : 'referencePrepHitPrunedDict';
        } else {
            base = openable ? 'referencePrepHitActive' : 'referencePrepHitActiveDict';
        }
    }
    return canDiffHit(hit) ? `${base},hitDiff` : base;
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

/** 该轮 plan 中全部 queryId（保持顺序，含 0 命中） */
export function getAllQueryIds(round: ReferencePrepRound): string[] {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const q of round.plan.queries) {
        if (seen.has(q.queryId)) continue;
        seen.add(q.queryId);
        ordered.push(q.queryId);
    }
    return ordered;
}

/** 该轮下至少有 1 条命中的 queryId（保持 plan 顺序） */
export function getQueryIdsWithHits(process: ReferencePrepProcessFileV020, round: ReferencePrepRound, roundIndex: number): string[] {
    return getAllQueryIds(round).filter(
        (queryId) => getHitsForRoundQuery(process, roundIndex, queryId).length > 0
    );
}

export function roundHasVisibleHits(process: ReferencePrepProcessFileV020, roundIndex: number): boolean {
    return getRoundHitCount(process, roundIndex) > 0;
}

/** 该轮有规划 query（即使 0 命中也在侧栏展示） */
export function roundHasVisiblePlan(process: ReferencePrepProcessFileV020, roundIndex: number): boolean {
    const round = process.rounds[roundIndex];
    return Boolean(round && getAllQueryIds(round).length > 0);
}

export function queryNodeContextValue(hitCount: number): string {
    return hitCount > 0 ? 'referencePrepQueryWithHits' : 'referencePrepQueryEmpty';
}
