import type { CorpusHit } from '../schema';

/** 从正文抽取可消歧信号：年份、现代史关键词、古典文学关键词 */
export function extractSenseSignals(text: string): {
    years: number[];
    modern: number;
    classical: number;
} {
    const t = String(text ?? '');
    const years = [...t.matchAll(/\b(1[5-9]\d{2}|20\d{2})\b/g)].map((m) => Number(m[1]));
    const modernKeys = [
        '情报',
        '特工',
        '烈士',
        '电台',
        '电波',
        '地下党',
        '共产党',
        '国民党',
        '红军',
        '延安',
        '牺牲',
        '刑讯',
        '裘慧英',
        '永不消逝',
        '密战',
        '毛人凤',
        '潘汉年',
    ];
    const classicalKeys = [
        '唐诗',
        '诗人',
        '太白',
        '青莲',
        '蜀道',
        '盛唐',
        '乐府',
        '诗仙',
        '杜甫',
        '天宝',
        '开元',
        '长安',
        '词句注释',
        '作品原文',
        '创作背景',
    ];
    let modern = 0;
    let classical = 0;
    for (const k of modernKeys) if (t.includes(k)) modern++;
    for (const k of classicalKeys) if (t.includes(k)) classical++;
    return { years, modern, classical };
}

/**
 * 命中相对 target 的义项契合度 0~1。
 * 用于同名多义（如李白诗人 vs 特工）降权不匹配义项。
 */
export function senseFitScore(target: string, hitText: string): number {
    const tgt = extractSenseSignals(target);
    const hit = extractSenseSignals(hitText);
    if (tgt.modern === 0 && tgt.classical === 0 && tgt.years.length === 0) {
        return 0.55; // 语境不明，中性
    }

    let score = 0.5;

    // 年代：target 偏现代史则压低唐代年份义项，反之亦然
    const tgtModernYear = tgt.years.some((y) => y >= 1900);
    const tgtTangYear = tgt.years.some((y) => y >= 600 && y <= 900);
    const hitModernYear = hit.years.some((y) => y >= 1900);
    const hitTangYear = hit.years.some((y) => y >= 600 && y <= 900);

    if (tgt.modern > tgt.classical || tgtModernYear) {
        if (hitModernYear || hit.modern > 0) score += 0.35;
        if (hitTangYear && hit.modern === 0) score -= 0.45;
        if (hit.classical > hit.modern && hit.modern === 0) score -= 0.25;
    } else if (tgt.classical > tgt.modern || tgtTangYear) {
        if (hitTangYear || hit.classical > 0) score += 0.35;
        if (hitModernYear && hit.classical === 0) score -= 0.45;
        if (hit.modern > hit.classical && hit.classical === 0) score -= 0.25;
    }

    // 关键词共现微调
    const bothModern = Math.min(tgt.modern, hit.modern);
    const bothClassical = Math.min(tgt.classical, hit.classical);
    score += Math.min(0.15, bothModern * 0.05 + bothClassical * 0.05);

    return Math.max(0, Math.min(1, score));
}

export function hitSenseText(h: CorpusHit): string {
    return [h.matchedKey, h.pageTitle, h.snippet, h.referenceBlock?.slice(0, 800)]
        .filter(Boolean)
        .join('\n');
}

/** 对低契合义项压低 finalScore / rerankScore，供软勾选使用 */
export function applySenseFitPenalty(hits: CorpusHit[], target: string): void {
    for (const h of hits) {
        if (h.status !== 'active' || h.kind === 'navigation_hint') continue;
        const fit = senseFitScore(target, hitSenseText(h));
        h.channelScores = { ...(h.channelScores ?? {}), dict: fit };
        if (fit < 0.35) {
            const base = h.rerankScore ?? h.finalScore ?? h.aggregatedValue;
            const penalized = Math.min(base, 0.2) * fit;
            h.finalScore = penalized;
            h.aggregatedValue = penalized;
            if (h.rerankScore != null) h.rerankScore = Math.min(h.rerankScore, penalized);
            if (!h.rerankReason) h.rerankReason = '义项与正文语境不符';
            h.suggestedForExport = false;
        } else if (fit >= 0.7) {
            // 略抬契合义项，便于 entity 核查时压过长鉴赏文
            const base = h.rerankScore ?? h.finalScore ?? h.aggregatedValue;
            const boosted = Math.min(1, base + 0.08);
            h.finalScore = boosted;
            h.aggregatedValue = boosted;
        }
    }
}
