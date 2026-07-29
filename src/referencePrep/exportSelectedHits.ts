/**
 * 将参考资料命中导出为供 LLM 阅读的精简 Markdown / JSON。
 *
 * 排序：按相关度（score）降序。RAG/校对注入惯例是最相关材料在前，
 * 便于模型优先利用，且上下文截断时保留高分证据。
 */

import type { CorpusHit } from './schema';

/** 去掉 ai-proofread 机器标记注释，保留正文供模型阅读 */
export function cleanBlockForLlm(block: string): string {
    return String(block ?? '')
        .replace(/<!--\s*ai-proofread:[^>]*-->\s*/gi, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function hitScore(h: CorpusHit): number {
    return h.finalScore ?? h.aggregatedValue ?? h.baseValue ?? 0;
}

/**
 * 导出前排序：score 降序；同分时按来源稳定次序，再按 hitId。
 * 来源次序偏「可核验出处」优先于纯导航类（导航已过滤）。
 */
export function sortHitsForLlm(hits: CorpusHit[]): CorpusHit[] {
    const sourceRank: Record<string, number> = {
        dict: 0,
        grep_md: 1,
        bm25: 2,
        vector: 3,
        wikipedia: 4,
        web: 5,
    };
    return [...hits].sort((a, b) => {
        const ds = hitScore(b) - hitScore(a);
        if (Math.abs(ds) > 1e-9) return ds;
        const ra = sourceRank[a.source] ?? 9;
        const rb = sourceRank[b.source] ?? 9;
        if (ra !== rb) return ra - rb;
        return (a.hitId || '').localeCompare(b.hitId || '');
    });
}

function usableHits(hits: CorpusHit[]): CorpusHit[] {
    return sortHitsForLlm(
        hits.filter((h) => h.kind !== 'navigation_hint' && h.status !== 'pruned')
    );
}

/** Markdown：按相关度降序拼接洗净后的 reference 块 */
export function formatSelectedHitsAsMarkdown(hits: CorpusHit[]): string {
    return usableHits(hits)
        .map((h) => cleanBlockForLlm(h.referenceBlock || h.snippet || ''))
        .filter(Boolean)
        .join('\n\n');
}

/** 写入 JSON.reference / 校对注入：同 Markdown 正文 */
export function formatSelectedHitsAsReferenceField(hits: CorpusHit[]): string {
    return formatSelectedHitsAsMarkdown(hits);
}

/** JSON：仅保留合并后的 reference 正文（供校对注入） */
export function formatSelectedHitsAsJsonDocument(hits: CorpusHit[]): {
    reference: string;
} {
    return { reference: formatSelectedHitsAsMarkdown(hits) };
}
