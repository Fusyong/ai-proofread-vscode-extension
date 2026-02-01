/**
 * 引文与文献句相似度匹配：长度过滤、Jaccard、Top-K、非阻塞
 * 计划见 docs/citation-verification-plan.md 阶段 3
 */

import * as vscode from 'vscode';
import { jaccardSimilarity } from '../similarity';
import { ReferenceStore } from './referenceStore';
import type { RefSentenceRow } from './referenceStore';
import type { CitationBlockWithSentences, CitationSentence } from './citationCollector';

/** 单条匹配候选 */
export interface MatchCandidate {
    refSentence: RefSentenceRow;
    score: number;
}

/** 单句的匹配结果 */
export interface SentenceMatchResult {
    sentence: CitationSentence;
    matches: MatchCandidate[];
}

/** 块级匹配结果 */
export interface BlockMatchResult {
    block: CitationBlockWithSentences;
    sentenceResults: SentenceMatchResult[];
}

const DEFAULT_TOP_K = 5;
const DEFAULT_LEN_DELTA = 10;
const NGRAM_SIZE = 2;

/**
 * 对当前文档的引文块做匹配：先长度过滤，再 Jaccard 相似度，取 Top-K
 */
export async function matchCitationsToReferences(
    blocks: CitationBlockWithSentences[],
    refStore: ReferenceStore,
    options: {
        topK?: number;
        lenDelta?: number;
        cancelToken?: vscode.CancellationToken;
        progress?: (message: string, current: number, total: number) => void;
    } = {}
): Promise<BlockMatchResult[]> {
    const topK = options.topK ?? DEFAULT_TOP_K;
    const lenDelta = options.lenDelta ?? DEFAULT_LEN_DELTA;
    const cancelToken = options.cancelToken;
    const progress = options.progress;

    const results: BlockMatchResult[] = [];
    let totalSentences = 0;
    for (const b of blocks) totalSentences += b.sentences.length;
    let done = 0;

    for (const block of blocks) {
        if (cancelToken?.isCancellationRequested) break;
        const sentenceResults: SentenceMatchResult[] = [];
        for (const sent of block.sentences) {
            if (cancelToken?.isCancellationRequested) break;
            progress?.(`匹配引文句 ${done + 1}/${totalSentences}`, done, totalSentences);
            const candidates = await refStore.getCandidatesByLength(sent.lenNorm, lenDelta);
            const scored: MatchCandidate[] = [];
            for (const ref of candidates) {
                const score = jaccardSimilarity(sent.normalized, ref.normalized, NGRAM_SIZE);
                scored.push({ refSentence: ref, score });
            }
            scored.sort((a, b) => b.score - a.score);
            sentenceResults.push({
                sentence: sent,
                matches: scored.slice(0, topK)
            });
            done++;
        }
        results.push({ block, sentenceResults });
    }
    return results;
}
