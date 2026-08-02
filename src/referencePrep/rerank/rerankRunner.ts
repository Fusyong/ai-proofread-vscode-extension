import type { CorpusHit } from '../schema';
import { getRerankConfig, getReferencePrepRerankLlmConfig } from '../config';
import { referencePrepLlmGenerateJson } from '../referencePrepLlm';
import {
    buildRerankSystemPrompt,
    buildRerankUserPrompt,
    parseRerankResult,
} from './rerankPrompt';
import { assignRefTags } from '../retrieval/fusion';

/**
 * LLM 精排：写 score/reason；drop 仅压低分并记原因，不从结果剔除（供软勾选）。
 * mergeGroups 中的重复项仍标记 pruned（去重）。
 */
export async function runLlmRerank(params: {
    target: string;
    hits: CorpusHit[];
}): Promise<CorpusHit[]> {
    const cfg = getRerankConfig();
    if (!cfg.enabled || params.hits.length === 0) return params.hits;

    const candidates = params.hits.slice(0, cfg.maxCandidates);
    assignRefTags(candidates);

    const { platform, model, disableThinking } = getReferencePrepRerankLlmConfig();
    const raw = await referencePrepLlmGenerateJson({
        platform,
        model,
        systemPrompt: buildRerankSystemPrompt(cfg.includeReason),
        userPrompt: buildRerankUserPrompt(params.target, candidates),
        disableThinking,
        logTag: 'referencePrepRerank',
    });

    const result = parseRerankResult(raw);
    const dropTags = new Set(
        result.decisions.filter((d) => d.action === 'drop').map((d) => d.refTag)
    );
    const scoreByTag = new Map(
        result.decisions.map((d) => [d.refTag, { score: d.score, reason: d.reason }])
    );
    const mergeDrop = new Set<string>();
    for (const g of result.mergeGroups) {
        for (const d of g.drop) mergeDrop.add(d);
    }

    const tagToHit = new Map(candidates.map((h) => [h.refTag ?? h.hitId, h]));

    for (const h of candidates) {
        const tag = h.refTag ?? h.hitId;
        const dec = scoreByTag.get(tag);
        if (dec?.score != null) {
            h.rerankScore = dec.score;
            h.finalScore = dec.score;
            h.aggregatedValue = dec.score;
        }
        if (dec?.reason && cfg.includeReason) {
            h.rerankReason = dec.reason;
        }
        if (mergeDrop.has(tag)) {
            h.status = 'pruned';
            h.pruneReason = dec?.reason ?? '精排合并去重';
            h.suggestedForExport = false;
        } else if (dropTags.has(tag)) {
            // 软丢弃：保留 active，压低分，不默认勾选
            h.status = 'active';
            if (h.rerankScore == null) {
                h.rerankScore = 0;
                h.finalScore = 0;
                h.aggregatedValue = 0;
            } else {
                h.rerankScore = Math.min(h.rerankScore, 0.15);
                h.finalScore = h.rerankScore;
                h.aggregatedValue = h.rerankScore;
            }
            h.suggestedForExport = false;
            if (!h.rerankReason) h.rerankReason = dec?.reason ?? '精排建议丢弃';
        }
    }

    for (const g of result.mergeGroups) {
        const keep = tagToHit.get(g.keep);
        if (!keep || keep.status === 'pruned') continue;
        for (const dTag of g.drop) {
            const dropHit = tagToHit.get(dTag);
            if (dropHit) {
                dropHit.status = 'pruned';
                dropHit.pruneReason = g.reason ?? '精排合并去重';
                dropHit.suggestedForExport = false;
            }
        }
    }

    // 全部返回（含低分 active），由 softSelect 决定默认勾选
    return params.hits;
}
