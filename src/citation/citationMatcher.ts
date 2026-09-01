/**
 * 引文与文献整体匹配：
 * A. 锚点 + 邻句合并对齐（1:1 / n:1 / 1:n）
 * B. 块级去标点滑窗（A 失败时 fallback）
 * 仅匹配时内部分句，对用户展示整块引文与整段文献
 */

import * as vscode from 'vscode';
import type { JiebaWasmModule } from '../jiebaLoader';
import {
    jaccardSimilarity,
    normalizeForSimilarity,
    type JaccardSimilarityOptions,
    type NormalizeForSimilarityOptions
} from '../similarity';
import { convertOpencc } from '../opencc';
import { ReferenceStore } from './referenceStore';
import type { RefSentenceRow } from './referenceStore';
import type { CitationBlockWithSentences, CitationSentence } from './citationCollector';
import { getCitationNormalizeOptions } from './referenceStore';

/** 整块引文的一条匹配结果（文献片段） */
export interface BlockMatchCandidate {
    /** 匹配到的文献句列表（按顺序） */
    refFragment: RefSentenceRow[];
    /** 整体平均相似度 */
    score: number;
    /** 文献文件路径（相对参考资料根） */
    file_path: string;
    /** 匹配策略 */
    strategy?: 'neighbor-merge' | 'block-window';
}

/** 块级匹配结果（只展示整块，不展示分句） */
export interface BlockMatchResult {
    block: CitationBlockWithSentences;
    /** 整体平均相似度（取最佳匹配的分数），未匹配时为 0 */
    overallScore: number;
    /** 达到阈值的文献匹配列表，按相似度降序，最多 matchesPerCitation 条 */
    matches: BlockMatchCandidate[];
}

const DEFAULT_LEN_DELTA_RATIO = 0.2;
const DEFAULT_NGRAM_SIZE = 1;
const DEFAULT_MAX_MERGE = 3;
/** 锚点初筛时略低于正式阈值，避免漏掉可合并对齐的候选 */
const ANCHOR_SCORE_FLOOR_RATIO = 0.5;
const MAX_ANCHOR_HITS_PER_BLOCK = 8;

export interface CitationMatchCoreOptions {
    lenDeltaRatio?: number;
    similarityThreshold?: number;
    maxMerge?: number;
    /** A 失败后是否启用块级滑窗 B，默认 true */
    enableBlockWindowFallback?: boolean;
    normalizeOpts: NormalizeForSimilarityOptions;
    simOpts: JaccardSimilarityOptions;
}

/** 比较时去掉省略号（用于相似度）；每次新建正则避免 global 状态 */
function normalizedWithoutEllipsis(normalized: string): string {
    return normalized.replace(/\u2026+|\.{2,}/g, '');
}

/** 句是否含省略号 */
function hasEllipsis(text: string): boolean {
    return /\u2026+|\.{2,}/.test(text);
}

function normalizeForCitationMatch(
    text: string,
    normalizeOpts: NormalizeForSimilarityOptions,
    enableOpenccT2cn: boolean
): string {
    const pre = enableOpenccT2cn ? convertOpencc(text, 't', 'cn') : text;
    return normalizeForSimilarity(pre, normalizeOpts);
}

function joinSlice(parts: string[], start: number, end: number): string {
    return parts.slice(start, end).join('');
}

/**
 * 选锚点句：非首尾、不含省略号、长度取中位数附近；不足时回退到全部可用句
 */
export function pickAnchorIndices(
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
        for (let i = 0; i < n; i++) {
            if (!hasEllipsisFlags[i]) candidates.push(i);
        }
    }
    if (candidates.length === 0) {
        candidates.push(0);
    }
    // 多锚点：按长度接近中位数排序，最多取 3 个，提高 1↔n 场景召回
    const sorted = [...candidates].sort((a, b) => sentences[a].lenNorm - sentences[b].lenNorm);
    const mid = Math.floor(sorted.length / 2);
    const ordered: number[] = [sorted[mid]];
    for (let d = 1; ordered.length < Math.min(3, sorted.length); d++) {
        if (mid - d >= 0) ordered.push(sorted[mid - d]);
        if (ordered.length >= Math.min(3, sorted.length)) break;
        if (mid + d < sorted.length) ordered.push(sorted[mid + d]);
    }
    return ordered;
}

/**
 * A：在文献窗口内对引文句做邻句合并对齐（仅 1:1 / n:1 / 1:n）
 * @returns 平均段相似度与覆盖的文献下标区间；无法覆盖全部引文句时返回 null
 */
export function alignWithNeighborMerge(
    citNorms: string[],
    refNorms: string[],
    approxRefIdx: number,
    maxMerge: number,
    simOpts: JaccardSimilarityOptions
): { avgScore: number; firstRefIdx: number; lastRefIdx: number } | null {
    const n = citNorms.length;
    const m = refNorms.length;
    if (n === 0 || m === 0) return null;

    const merge = Math.max(1, Math.floor(maxMerge));
    const pad = n * merge + 2;
    const w0 = Math.max(0, approxRefIdx - pad);
    const w1 = Math.min(m, approxRefIdx + pad + 1);
    const W = w1 - w0;
    if (W <= 0) return null;

    const NEG = Number.NEGATIVE_INFINITY;
    const dp: number[][] = Array.from({ length: n + 1 }, () => Array(W + 1).fill(NEG));
    const back: Array<Array<{ pi: number; pj: number } | null>> = Array.from({ length: n + 1 }, () =>
        Array(W + 1).fill(null)
    );

    // 可在窗口内任意位置开始（跳过前导文献句）
    for (let j = 0; j <= W; j++) {
        dp[0][j] = 0;
    }

    for (let i = 0; i <= n; i++) {
        for (let j = 0; j <= W; j++) {
            if (dp[i][j] === NEG) continue;
            for (let c = 1; c <= merge && i + c <= n; c++) {
                for (let r = 1; r <= merge && j + r <= W; r++) {
                    // 只允许一侧合并，避免任意 n:m
                    if (c > 1 && r > 1) continue;
                    const citText = joinSlice(citNorms, i, i + c);
                    const refText = joinSlice(refNorms, w0 + j, w0 + j + r);
                    if (!citText || !refText) continue;
                    const s = jaccardSimilarity(citText, refText, simOpts);
                    const next = dp[i][j] + s;
                    if (next > dp[i + c][j + r]) {
                        dp[i + c][j + r] = next;
                        back[i + c][j + r] = { pi: i, pj: j };
                    }
                }
            }
        }
    }

    let bestJ = -1;
    let bestTotal = NEG;
    for (let j = 1; j <= W; j++) {
        if (dp[n][j] > bestTotal) {
            bestTotal = dp[n][j];
            bestJ = j;
        }
    }
    if (bestJ < 0 || bestTotal === NEG) return null;

    let segments = 0;
    let startRel = bestJ;
    let i = n;
    let j = bestJ;
    while (i > 0) {
        const b = back[i][j];
        if (!b) return null;
        segments++;
        startRel = b.pj;
        i = b.pi;
        j = b.pj;
    }
    if (segments <= 0) return null;

    return {
        avgScore: bestTotal / segments,
        firstRefIdx: w0 + startRel,
        lastRefIdx: w0 + bestJ - 1
    };
}

/**
 * B：块级去标点滑窗——连续文献句拼接后与整块引文比相似度
 */
export function matchBlockBySlidingWindow(
    citNormNoPunct: string,
    refOrdered: RefSentenceRow[],
    refNormsNoPunct: string[],
    lenDeltaRatio: number,
    threshold: number,
    simOpts: JaccardSimilarityOptions
): { score: number; firstRefIdx: number; lastRefIdx: number } | null {
    if (!citNormNoPunct || refOrdered.length === 0) return null;
    const targetLen = citNormNoPunct.length;
    const low = targetLen * (1 - lenDeltaRatio);
    const high = targetLen * (1 + lenDeltaRatio);

    const pref: number[] = [0];
    for (const t of refNormsNoPunct) {
        pref.push(pref[pref.length - 1] + t.length);
    }

    let bestScore = 0;
    let bestI = -1;
    let bestJ = -1;

    for (let i = 0; i < refNormsNoPunct.length; i++) {
        for (let j = i; j < refNormsNoPunct.length; j++) {
            const len = pref[j + 1] - pref[i];
            if (len < low) continue;
            if (len > high) break;
            const joined = joinSlice(refNormsNoPunct, i, j + 1);
            const score = jaccardSimilarity(citNormNoPunct, joined, simOpts);
            if (score > bestScore) {
                bestScore = score;
                bestI = i;
                bestJ = j;
            }
        }
    }

    if (bestI < 0 || bestScore < threshold) return null;
    return { score: bestScore, firstRefIdx: bestI, lastRefIdx: bestJ };
}

function toCandidate(
    refOrdered: RefSentenceRow[],
    firstRefIdx: number,
    lastRefIdx: number,
    score: number,
    strategy: 'neighbor-merge' | 'block-window'
): BlockMatchCandidate | null {
    if (firstRefIdx < 0 || lastRefIdx < firstRefIdx || lastRefIdx >= refOrdered.length) return null;
    const fragment = refOrdered.slice(firstRefIdx, lastRefIdx + 1);
    if (fragment.length === 0) return null;
    return {
        refFragment: fragment,
        score,
        file_path: fragment[0].file_path,
        strategy
    };
}

function isDuplicate(a: BlockMatchCandidate, b: BlockMatchCandidate): boolean {
    return (
        a.file_path === b.file_path &&
        a.refFragment[0]?.id === b.refFragment[0]?.id &&
        a.refFragment[a.refFragment.length - 1]?.id === b.refFragment[b.refFragment.length - 1]?.id
    );
}

function pushUnique(collected: BlockMatchCandidate[], candidate: BlockMatchCandidate): void {
    if (collected.some((c) => isDuplicate(c, candidate))) return;
    collected.push(candidate);
}

/**
 * 对单个引文块、单个文献文件尝试 A（邻句合并）
 * @param refNormsPre 可选：与 refOrdered 对齐的预归一化文本（含 OpenCC 等）
 */
export function tryNeighborMergeOnFile(
    citTexts: string[],
    citNorms: string[],
    refOrdered: RefSentenceRow[],
    approxRefIdx: number,
    options: CitationMatchCoreOptions,
    refNormsPre?: string[]
): BlockMatchCandidate | null {
    const maxMerge = options.maxMerge ?? DEFAULT_MAX_MERGE;
    const threshold = options.similarityThreshold ?? 0.4;
    const refNorms =
        refNormsPre && refNormsPre.length === refOrdered.length
            ? refNormsPre
            : refOrdered.map((r) =>
                  normalizedWithoutEllipsis(
                      normalizeForSimilarity(r.content, options.normalizeOpts)
                  )
              );
    const norms =
        citNorms.length === citTexts.length
            ? citNorms
            : citTexts.map((t) =>
                  normalizedWithoutEllipsis(normalizeForSimilarity(t, options.normalizeOpts))
              );

    const aligned = alignWithNeighborMerge(
        norms,
        refNorms,
        approxRefIdx,
        maxMerge,
        options.simOpts
    );
    if (!aligned || aligned.avgScore < threshold) return null;
    return toCandidate(
        refOrdered,
        aligned.firstRefIdx,
        aligned.lastRefIdx,
        aligned.avgScore,
        'neighbor-merge'
    );
}

/**
 * 对单个引文块、单个文献文件尝试 B（块级滑窗）
 */
export function tryBlockWindowOnFile(
    citTexts: string[],
    refOrdered: RefSentenceRow[],
    options: CitationMatchCoreOptions
): BlockMatchCandidate | null {
    const lenDeltaRatio = options.lenDeltaRatio ?? DEFAULT_LEN_DELTA_RATIO;
    const threshold = options.similarityThreshold ?? 0.4;
    const noPunctOpts: NormalizeForSimilarityOptions = {
        ...options.normalizeOpts,
        removePunctuation: true
    };
    const citNormNoPunct = normalizedWithoutEllipsis(
        normalizeForSimilarity(citTexts.join(''), noPunctOpts)
    );
    const refNormsNoPunct = refOrdered.map((r) =>
        normalizedWithoutEllipsis(normalizeForSimilarity(r.content, noPunctOpts))
    );
    const hit = matchBlockBySlidingWindow(
        citNormNoPunct,
        refOrdered,
        refNormsNoPunct,
        lenDeltaRatio,
        threshold,
        options.simOpts
    );
    if (!hit) return null;
    return toCandidate(refOrdered, hit.firstRefIdx, hit.lastRefIdx, hit.score, 'block-window');
}

/**
 * 对当前文档的引文块做整体匹配：先 A（邻句合并）再 B（块级滑窗）
 */
export async function matchCitationsToReferences(
    blocks: CitationBlockWithSentences[],
    refStore: ReferenceStore,
    options: {
        lenDeltaRatio?: number;
        similarityThreshold?: number;
        matchesPerCitation?: number;
        ngramSize?: number;
        ngramGranularity?: 'word' | 'char';
        cutMode?: 'default' | 'search';
        maxMerge?: number;
        enableBlockWindowFallback?: boolean;
        jieba?: JiebaWasmModule;
        cancelToken?: vscode.CancellationToken;
        progress?: (message: string, current: number, total: number) => void;
    } = {}
): Promise<BlockMatchResult[]> {
    const openccConfig = vscode.workspace.getConfiguration('ai-proofread.citation');
    const enableOpenccT2cn = openccConfig.get<boolean>('openccT2cnBeforeSimilarity', false);
    const lenDeltaRatio = options.lenDeltaRatio ?? DEFAULT_LEN_DELTA_RATIO;
    const threshold = options.similarityThreshold ?? 0.4;
    const maxMatches = Math.max(1, Math.floor(options.matchesPerCitation ?? 2));
    const ngramSize = Math.max(1, Math.floor(options.ngramSize ?? DEFAULT_NGRAM_SIZE));
    const granularity = options.ngramGranularity ?? 'char';
    const cutMode = options.cutMode ?? 'default';
    const maxMerge = Math.max(1, Math.floor(options.maxMerge ?? openccConfig.get<number>('maxMerge', DEFAULT_MAX_MERGE)));
    const enableBlockWindowFallback =
        options.enableBlockWindowFallback ??
        openccConfig.get<boolean>('enableBlockWindowFallback', true);
    const jieba = options.jieba;
    const simOpts: JaccardSimilarityOptions = {
        n: ngramSize,
        granularity: granularity === 'word' && jieba ? 'word' : 'char',
        jieba: granularity === 'word' && jieba ? jieba : undefined,
        cutMode
    };
    const normalizeOpts = getCitationNormalizeOptions();
    const coreOpts: CitationMatchCoreOptions = {
        lenDeltaRatio,
        similarityThreshold: threshold,
        maxMerge,
        enableBlockWindowFallback,
        normalizeOpts,
        simOpts
    };
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

        const citTexts = sents.map((s) => s.text);
        const citNorms = citTexts.map((t) =>
            normalizedWithoutEllipsis(normalizeForCitationMatch(t, normalizeOpts, enableOpenccT2cn))
        );
        const ellipsisFlags = sents.map((s) => hasEllipsis(s.text));
        const anchorIndices = pickAnchorIndices(sents, ellipsisFlags);
        const collected: BlockMatchCandidate[] = [];
        const fileCache = new Map<string, RefSentenceRow[]>();

        const getOrdered = async (filePath: string): Promise<RefSentenceRow[]> => {
            let rows = fileCache.get(filePath);
            if (!rows) {
                rows = await refStore.getSentencesByFileOrdered(filePath);
                fileCache.set(filePath, rows);
            }
            return rows;
        };

        // —— A：锚点（含邻句合并查询）+ 邻句合并对齐 ——
        type AnchorHit = {
            score: number;
            file_path: string;
            refId: number;
            citStart: number;
            citEnd: number;
        };
        const anchorHits: AnchorHit[] = [];

        for (const anchorIdx of anchorIndices) {
            for (let c = 1; c <= maxMerge && anchorIdx + c <= sents.length; c++) {
                // 合并段内若含省略号句，跳过（省略号句不宜作锚）
                let hasEll = false;
                for (let k = anchorIdx; k < anchorIdx + c; k++) {
                    if (ellipsisFlags[k]) {
                        hasEll = true;
                        break;
                    }
                }
                if (hasEll) continue;

                const mergedNorm = joinSlice(citNorms, anchorIdx, anchorIdx + c);
                const lenNorm = mergedNorm.length;
                if (lenNorm <= 0) continue;
                const candidates = await refStore.getCandidatesByLength(lenNorm, lenDeltaRatio);
                const floor = threshold * ANCHOR_SCORE_FLOOR_RATIO;
                for (const ref of candidates) {
                    const refNorm = normalizedWithoutEllipsis(
                        normalizeForCitationMatch(ref.content, normalizeOpts, enableOpenccT2cn)
                    );
                    const score = jaccardSimilarity(mergedNorm, refNorm, simOpts);
                    if (score >= floor) {
                        anchorHits.push({
                            score,
                            file_path: ref.file_path,
                            refId: ref.id,
                            citStart: anchorIdx,
                            citEnd: anchorIdx + c
                        });
                    }
                }
            }
        }

        anchorHits.sort((a, b) => b.score - a.score);
        const seenAnchorKeys = new Set<string>();
        let usedHits = 0;
        for (const hit of anchorHits) {
            if (usedHits >= MAX_ANCHOR_HITS_PER_BLOCK) break;
            const key = `${hit.file_path}#${hit.refId}#${hit.citStart}#${hit.citEnd}`;
            if (seenAnchorKeys.has(key)) continue;
            seenAnchorKeys.add(key);
            usedHits++;

            const refOrdered = await getOrdered(hit.file_path);
            const refIdx = refOrdered.findIndex((r) => r.id === hit.refId);
            if (refIdx < 0) continue;

            const refNorms = refOrdered.map((r) =>
                normalizedWithoutEllipsis(
                    normalizeForCitationMatch(r.content, normalizeOpts, enableOpenccT2cn)
                )
            );
            const candidate = tryNeighborMergeOnFile(
                citTexts,
                citNorms,
                refOrdered,
                refIdx,
                coreOpts,
                refNorms
            );
            if (candidate) pushUnique(collected, candidate);
            if (collected.length >= maxMatches) break;
        }

        // —— B：A 未命中时，块级去标点滑窗 ——
        if (collected.length === 0 && enableBlockWindowFallback) {
            const candidateFiles = new Set<string>();
            for (let i = 0; i < sents.length; i++) {
                const candidates = await refStore.getCandidatesByLength(sents[i].lenNorm, lenDeltaRatio);
                for (const ref of candidates.slice(0, 20)) {
                    candidateFiles.add(ref.file_path);
                }
            }
            // 合并相邻两句再探文件，覆盖「半句对长句」长度过滤落空
            for (let i = 0; i + 1 < sents.length; i++) {
                const mergedLen = (citNorms[i] + citNorms[i + 1]).length;
                const candidates = await refStore.getCandidatesByLength(mergedLen, lenDeltaRatio);
                for (const ref of candidates.slice(0, 10)) {
                    candidateFiles.add(ref.file_path);
                }
            }

            const citTextsForB = enableOpenccT2cn
                ? citTexts.map((t) => convertOpencc(t, 't', 'cn'))
                : citTexts;

            for (const filePath of candidateFiles) {
                if (cancelToken?.isCancellationRequested) break;
                const refOrdered = await getOrdered(filePath);
                const refsForB = enableOpenccT2cn
                    ? refOrdered.map((r) => ({
                          ...r,
                          content: convertOpencc(r.content, 't', 'cn')
                      }))
                    : refOrdered;
                const candidate = tryBlockWindowOnFile(citTextsForB, refsForB, coreOpts);
                if (!candidate || candidate.refFragment.length === 0) continue;
                const first = refOrdered.findIndex((r) => r.id === candidate.refFragment[0].id);
                const last = refOrdered.findIndex(
                    (r) => r.id === candidate.refFragment[candidate.refFragment.length - 1].id
                );
                const mapped = toCandidate(refOrdered, first, last, candidate.score, 'block-window');
                if (mapped) pushUnique(collected, mapped);
            }
        }

        collected.sort((a, b) => b.score - a.score);
        const matches = collected.slice(0, maxMatches);
        const overallScore = matches[0]?.score ?? 0;
        results.push({ block, overallScore, matches });
    }
    return results;
}
