/**
 * 将参考资料命中导出为供 LLM 阅读的精简 Markdown / JSON。
 *
 * 排序：按相关度（score）降序。RAG/校对注入惯例是最相关材料在前，
 * 便于模型优先利用，且上下文截断时保留高分证据。
 */

import type { CorpusHit } from './schema';

export interface HitExportGroup {
    /** 选区 / JSON 条目 target 文本 */
    target: string;
    hits: CorpusHit[];
}

/** 去掉 ai-proofread 机器标记注释，保留正文供模型阅读 */
export function cleanBlockForLlm(block: string): string {
    return String(block ?? '')
        .replace(/<!--\s*ai-proofread:[^>]*-->\s*/gi, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** 选区原文（核对引文时即引文；意图检索时为查询文本） */
export function citationTextForDiff(process: {
    userInput?: string;
    targetPreview?: string;
}): string {
    return (process.userInput || process.targetPreview || '').trim();
}

/**
 * 命中侧供 diff 的正文：去掉机器注释与【文献摘录】等来源头，避免与引文比对时掺入元数据。
 */
export function literatureTextForDiff(hit: CorpusHit): string {
    const cleaned = cleanBlockForLlm(hit.referenceBlock || '');
    if (cleaned) {
        const lines = cleaned.split('\n');
        let i = 0;
        while (i < lines.length) {
            const t = lines[i].trim();
            if (!t) {
                i++;
                continue;
            }
            if (/^【(?:文献摘录|本地词典|维基百科)/.test(t)) {
                i++;
                continue;
            }
            if (/^URL:/i.test(t) || /^Wikidata:/i.test(t)) {
                i++;
                continue;
            }
            break;
        }
        let rest = lines.slice(i).join('\n').trim();
        rest = rest.replace(/^摘录：/, '').trim();
        if (rest) return rest;
    }
    return (hit.snippet || '').trim();
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

/**
 * 多选区导出 Markdown：各组加 ## target 标题；仅一组时不加标题（与旧行为一致）。
 */
export function formatGroupedHitsAsMarkdown(groups: HitExportGroup[]): string {
    const nonempty = groups
        .map((g) => ({
            target: (g.target ?? '').replace(/\s+/g, ' ').trim(),
            body: formatSelectedHitsAsMarkdown(g.hits),
        }))
        .filter((g) => g.body);
    if (nonempty.length === 0) return '';
    if (nonempty.length === 1) return nonempty[0].body;
    return nonempty
        .map((g, i) => {
            const title = (g.target || `选区 ${i + 1}`).slice(0, 80);
            return `## ${title}\n\n${g.body}`;
        })
        .join('\n\n');
}

/**
 * 多选区导出 JSON：多组时为 `[{ target, reference }, …]`；单组仍为 `{ reference }`。
 */
export function formatGroupedHitsAsJsonDocument(
    groups: HitExportGroup[]
): { reference: string } | Array<{ target: string; reference: string }> {
    const nonempty = groups
        .map((g) => ({
            target: (g.target ?? '').replace(/\s+/g, ' ').trim(),
            reference: formatSelectedHitsAsReferenceField(g.hits),
        }))
        .filter((g) => g.reference.trim());
    if (nonempty.length <= 1) {
        return { reference: nonempty[0]?.reference ?? '' };
    }
    return nonempty.map((g, i) => ({
        target: g.target || `选区 ${i + 1}`,
        reference: g.reference,
    }));
}
