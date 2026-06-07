import type { CorpusHit } from '../schema';
import { getRerankConfig, getReferencePrepRerankLlmConfig } from '../config';
import { referencePrepLlmGenerateJson } from '../referencePrepLlm';
import {
    buildRerankSystemPrompt,
    buildRerankUserPrompt,
    parseRerankResult,
} from './rerankPrompt';
import { assignRefTags } from '../retrieval/fusion';

export async function runLlmRerank(params: {
    target: string;
    hits: CorpusHit[];
}): Promise<CorpusHit[]> {
    const cfg = getRerankConfig();
    if (!cfg.enabled || params.hits.length === 0) return params.hits;

    const candidates = params.hits.slice(0, cfg.maxCandidates);
    assignRefTags(candidates);

    const { platform, model } = getReferencePrepRerankLlmConfig();
    const raw = await referencePrepLlmGenerateJson({
        platform,
        model,
        systemPrompt: buildRerankSystemPrompt(cfg.includeReason),
        userPrompt: buildRerankUserPrompt(params.target, candidates),
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
        if (dropTags.has(tag) || mergeDrop.has(tag)) {
            h.status = 'pruned';
            h.pruneReason = dec?.reason ?? '精排丢弃';
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
            }
        }
    }

    const prunedTags = new Set(candidates.filter((h) => h.status === 'pruned').map((h) => h.refTag ?? h.hitId));
    const kept = params.hits.filter((h) => {
        const tag = h.refTag ?? h.hitId;
        if (candidates.includes(h)) return !prunedTags.has(tag);
        return h.status === 'active';
    });
    return kept;
}
