import type { ReferencePrepPlan, ReferencePrepPlanQuery, ReferencePrepRound } from './schema';

function bareTerm(s: string): string {
    return String(s ?? '')
        .replace(/（[^）]*）/g, '')
        .replace(/\([^)]*\)/g, '')
        .replace(/\[[^\]]*\]/g, '')
        .replace(/【[^】]*】/g, '')
        .trim();
}

/** 抽取用于近重复判断的锚点词（去括号、拆短词段） */
export function queryAnchorTerms(q: ReferencePrepPlanQuery): string[] {
    const out = new Set<string>();
    const add = (raw: string) => {
        const t = bareTerm(raw);
        if (!t) return;
        if (t.length >= 2 && t.length <= 12) out.add(t);
        for (const part of t.split(/[\s　/|、，,]+/).filter(Boolean)) {
            if (part.length >= 2 && part.length <= 8) out.add(part);
        }
    };
    for (const c of q.dict?.candidates ?? []) add(c);
    for (const p of [...(q.grep?.patterns ?? []), ...(q.grep?.searchPhrases ?? [])]) add(p);
    for (const t of [...(q.wikipedia?.searchTerms ?? []), ...(q.wikipedia?.titles ?? [])]) add(t);
    for (const t of q.web?.searchTerms ?? []) add(t);
    return [...out];
}

/** 精确签名（完全相同检索块） */
export function querySignature(q: ReferencePrepPlanQuery): string {
    const parts = [
        q.intent,
        q.dict
            ? `d:${(q.dict.candidates ?? []).map((c) => bareTerm(c)).filter(Boolean).sort().join('|')}`
            : '',
        q.grep
            ? `g:${[...(q.grep.patterns ?? []), ...(q.grep.searchPhrases ?? [])]
                  .map((x) => x.trim())
                  .sort()
                  .join('|')}`
            : '',
        q.wikipedia
            ? `w:${[...(q.wikipedia.searchTerms ?? []), ...(q.wikipedia.titles ?? [])]
                  .map((x) => x.trim())
                  .sort()
                  .join('|')}:${q.wikipedia.lang ?? ''}`
            : '',
        q.web ? `web:${(q.web.searchTerms ?? []).map((x) => x.trim()).sort().join('|')}` : '',
    ];
    return parts.filter(Boolean).join(';;');
}

/** 同 intent 且共享锚点词 → 近重复（如「李白/李朴」与「李白/李华初」） */
export function queriesNearDuplicate(a: ReferencePrepPlanQuery, b: ReferencePrepPlanQuery): boolean {
    if (a.intent !== b.intent) return false;
    if (querySignature(a) === querySignature(b)) return true;
    const ta = new Set(queryAnchorTerms(a));
    if (ta.size === 0) return false;
    return queryAnchorTerms(b).some((t) => ta.has(t));
}

/** 去掉与历史轮次高度重复或近重复的 query */
export function filterDuplicatePlanQueries(
    plan: ReferencePrepPlan,
    previousRounds: ReferencePrepRound[]
): { plan: ReferencePrepPlan; removed: number } {
    const prior: ReferencePrepPlanQuery[] = [];
    for (const r of previousRounds) {
        prior.push(...r.plan.queries);
    }
    const kept: ReferencePrepPlanQuery[] = [];
    let removed = 0;
    for (const q of plan.queries) {
        const dupPrior = prior.some((p) => queriesNearDuplicate(p, q));
        const dupRound = kept.some((p) => queriesNearDuplicate(p, q));
        if (dupPrior || dupRound) {
            removed++;
            continue;
        }
        kept.push(q);
    }
    return {
        plan: { ...plan, queries: kept },
        removed,
    };
}
