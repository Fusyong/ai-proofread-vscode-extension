/**
 * 引文与文献整体匹配：省略号处理、锚点句、平行移动、整体阈值
 * 仅匹配时内部分句，对用户展示整块引文与整段文献
 */

import * as vscode from 'vscode';
import { jaccardSimilarity } from '../similarity';
import { ReferenceStore } from './referenceStore';
import type { RefSentenceRow } from './referenceStore';
import type { CitationBlockWithSentences, CitationSentence } from './citationCollector';

/** 整块引文的一条匹配结果（文献片段） */
export interface BlockMatchCandidate {
    /** 匹配到的文献句列表（按顺序） */
    refFragment: RefSentenceRow[];
    /** 整体平均相似度 */
    score: number;
    /** 文献文件路径（相对参考文献根） */
    file_path: string;
}

/** 块级匹配结果（只展示整块，不展示分句） */
export interface BlockMatchResult {
    block: CitationBlockWithSentences;
    /** 整体平均相似度（取最佳匹配的分数），未匹配时为 0 */
    overallScore: number;
    /** 达到阈值的文献匹配列表，按相似度降序，最多 matchesPerCitation 条 */
    matches: BlockMatchCandidate[];
}

const DEFAULT_LEN_DELTA = 10;
const NGRAM_SIZE = 2;
/** 比较时去掉省略号（用于相似度）；每次新建正则避免 global 状态 */
function normalizedWithoutEllipsis(normalized: string): string {
    return normalized.replace(/\u2026+|\.{2,}/g, '');
}

/** 句是否含省略号 */
function hasEllipsis(text: string): boolean {
    return /\u2026+|\.{2,}/.test(text);
}

/**
 * 选锚点句：非首尾、不含省略号、长度取中位数附近
 */
function pickAnchorIndices(
    sentences: CitationSentence[],
    hasEllipsisFlags: boolean[]
): number[] {
    if (sentences.length <= 0) return [];
    const n = sentences.length;
    const candidates: number[] = [];
    for (let i = 0; i < n; i++) {
        if (i === 0 || i === n - 1) continue;
        if (hasEllipsisFlags[i]) continue;
        candidates.push(i);
    }
    if (candidates.length === 0) {
        for (let i = 1; i < n - 1; i++) candidates.push(i);
    }
    if (candidates.length === 0) {
        candidates.push(0);
    }
    const sorted = [...candidates].sort((a, b) => sentences[a].lenNorm - sentences[b].lenNorm);
    const mid = Math.floor(sorted.length / 2);
    return [sorted[mid]];
}

/**
 * 对当前文档的引文块做整体匹配：锚点句 + 平行移动，平均相似度达阈值则接受
 */
export async function matchCitationsToReferences(
    blocks: CitationBlockWithSentences[],
    refStore: ReferenceStore,
    options: {
        lenDelta?: number;
        similarityThreshold?: number;
        matchesPerCitation?: number;
        cancelToken?: vscode.CancellationToken;
        progress?: (message: string, current: number, total: number) => void;
    } = {}
): Promise<BlockMatchResult[]> {
    const lenDelta = options.lenDelta ?? DEFAULT_LEN_DELTA;
    const threshold = options.similarityThreshold ?? 0.4;
    const maxMatches = Math.max(1, Math.floor(options.matchesPerCitation ?? 2));
    const cancelToken = options.cancelToken;
    const progress = options.progress;

    const results: BlockMatchResult[] = [];
    for (let b = 0; b < blocks.length; b++) {
        if (cancelToken?.isCancellationRequested) break;
        progress?.(`匹配引文块 ${b + 1}/${blocks.length}`, b, blocks.length);

        const block = blocks[b];
        const sents = block.sentences;
        if (sents.length === 0) {
            results.push({ block, overallScore: 0, matches: [] });
            continue;
        }

        const ellipsisFlags = sents.map((s) => hasEllipsis(s.text));
        const anchorIndices = pickAnchorIndices(sents, ellipsisFlags);
        const collected: BlockMatchCandidate[] = [];

        for (const anchorIdx of anchorIndices) {
            const anchor = sents[anchorIdx];
            const candidates = await refStore.getCandidatesByLength(anchor.lenNorm, lenDelta);
            const anchorNorm = normalizedWithoutEllipsis(anchor.normalized);
            let bestRef: RefSentenceRow | undefined;
            let bestScore = 0;
            for (const ref of candidates) {
                const score = jaccardSimilarity(anchorNorm, normalizedWithoutEllipsis(ref.normalized), NGRAM_SIZE);
                if (score > bestScore) {
                    bestScore = score;
                    bestRef = ref;
                }
            }
            if (!bestRef) continue;

            const refOrdered = await refStore.getSentencesByFileOrdered(bestRef.file_path);
            const refIdx = refOrdered.findIndex((r) => r.id === bestRef!.id);
            if (refIdx < 0) continue;

            const n = sents.length;
            const scores: number[] = [];
            let firstRefIdx = refIdx - anchorIdx;
            let lastRefIdx = refIdx + (n - 1 - anchorIdx);
            if (firstRefIdx < 0 || lastRefIdx >= refOrdered.length) continue;

            for (let i = 0; i < n; i++) {
                const rIdx = refIdx - anchorIdx + i;
                const refSent = refOrdered[rIdx];
                const citNorm = normalizedWithoutEllipsis(sents[i].normalized);
                const sim = jaccardSimilarity(citNorm, normalizedWithoutEllipsis(refSent.normalized), NGRAM_SIZE);
                scores.push(sim);
            }
            const avg = scores.reduce((a, x) => a + x, 0) / scores.length;
            if (avg >= threshold) {
                const fragment = refOrdered.slice(firstRefIdx, lastRefIdx + 1);
                const candidate: BlockMatchCandidate = { refFragment: fragment, score: avg, file_path: bestRef.file_path };
                const duplicate = collected.some(
                    (c) => c.file_path === candidate.file_path && c.refFragment[0]?.id === candidate.refFragment[0]?.id
                );
                if (!duplicate) collected.push(candidate);
            }
        }

        collected.sort((a, b) => b.score - a.score);
        const matches = collected.slice(0, maxMatches);
        const overallScore = matches[0]?.score ?? 0;
        results.push({ block, overallScore, matches });
    }
    return results;
}
