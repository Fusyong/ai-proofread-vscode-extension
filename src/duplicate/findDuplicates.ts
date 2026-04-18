/**
 * 单文档内重复句检测：完全重复（归一化键相同）与近似重复（长度分桶 + Jaccard）
 * 配置与引文核验一致：getCitationNormalizeOptions、alignment、jieba、openccT2cnBeforeSimilarity
 */

import type { JiebaWasmModule } from '../jiebaLoader';
import { jaccardSimilarity, normalizeForSimilarity } from '../similarity';
import { convertOpencc } from '../opencc';
import { getCitationNormalizeOptions } from '../citation/referenceStore';
import type { NormalizeForSimilarityOptions } from '../similarity';
import { normalizeLineEndings } from '../utils';
import { splitChineseSentencesWithOffsets } from '../splitter';
import type {
    DuplicateExactGroup,
    DuplicateFuzzyGroup,
    DuplicateOccurrence,
    DuplicateScanMode,
    DuplicateScanResult
} from './types';

/** 与 citationMatcher 一致：比较前去掉省略号 */
function normalizedWithoutEllipsis(normalized: string): string {
    return normalized.replace(/\u2026+|\.{2,}/g, '');
}

function normalizeForCitationMatch(
    text: string,
    enableOpenccT2cn: boolean,
    opts: NormalizeForSimilarityOptions
): string {
    const pre = enableOpenccT2cn ? convertOpencc(text, 't', 'cn') : text;
    return normalizeForSimilarity(pre, opts);
}

function lengthBounds(lenNorm: number, deltaRatio: number): { low: number; high: number } {
    const low = Math.max(0, Math.floor(lenNorm * (1 - deltaRatio)));
    const high = Math.ceil(lenNorm * (1 + deltaRatio));
    return { low, high };
}

class UnionFind {
    private parent: number[];
    constructor(n: number) {
        this.parent = Array.from({ length: n }, (_, i) => i);
    }
    find(i: number): number {
        if (this.parent[i] !== i) {
            this.parent[i] = this.find(this.parent[i]);
        }
        return this.parent[i];
    }
    union(i: number, j: number): void {
        const ri = this.find(i);
        const rj = this.find(j);
        if (ri !== rj) {
            this.parent[ri] = rj;
        }
    }
}

export interface FindDuplicatesParams {
    /** 已统一换行的扫描文本（全文或选区） */
    text: string;
    /** 与引文块分句一致：splitChineseSentencesWithLineNumbers(..., true) */
    useSimpleSplitter: boolean;
    minCitationLength: number;
    lenDeltaRatio: number;
    similarityThreshold: number;
    ngramSize: number;
    ngramGranularity: 'word' | 'char';
    cutMode: 'default' | 'search';
    jieba: JiebaWasmModule | undefined;
    openccT2cnBeforeSimilarity: boolean;
    mode: DuplicateScanMode;
    /** 可选：进度与取消（大批量时） */
    cancelToken?: { isCancellationRequested: boolean };
    progress?: (message: string, done: number, total: number) => void;
}

interface InternalSentence {
    sentenceIndex: number;
    text: string;
    startLine: number;
    endLine: number;
    startOffset: number;
    endOffset: number;
    /** 用于长度分桶，与引文句一致：normalizeForSimilarity(trimmed) 的长度 */
    lenNorm: number;
    /** 用于完全重复分组与 fuzzy 跳过 */
    matchKey: string;
}

/**
 * 将扫描文本切分为带归一化键的句列表（过滤过短句）
 */
export function buildInternalSentences(params: {
    text: string;
    useSimpleSplitter: boolean;
    minCitationLength: number;
    openccT2cnBeforeSimilarity: boolean;
    normalizeOpts: NormalizeForSimilarityOptions;
}): InternalSentence[] {
    const raw = normalizeLineEndings(params.text);
    const spans = splitChineseSentencesWithOffsets(raw, params.useSimpleSplitter);
    const out: InternalSentence[] = [];
    let outIdx = 0;
    for (const sp of spans) {
        const trimmed = sp.sentence.trim();
        if (!trimmed || trimmed.length < params.minCitationLength) {
            continue;
        }
        const normPlain = normalizeForSimilarity(trimmed, params.normalizeOpts);
        const lenNorm = normPlain.length;
        const matchKey = normalizedWithoutEllipsis(
            normalizeForCitationMatch(trimmed, params.openccT2cnBeforeSimilarity, params.normalizeOpts)
        );
        out.push({
            sentenceIndex: outIdx,
            text: trimmed,
            startLine: sp.startLine,
            endLine: sp.endLine,
            startOffset: sp.startOffset,
            endOffset: sp.endOffset,
            lenNorm,
            matchKey
        });
        outIdx++;
    }
    return out;
}

function toOccurrence(s: InternalSentence): DuplicateOccurrence {
    return {
        sentenceIndex: s.sentenceIndex,
        text: s.text,
        startLine: s.startLine,
        endLine: s.endLine,
        startOffset: s.startOffset,
        endOffset: s.endOffset
    };
}

/**
 * 扫描文本内的重复句（完全重复 + 可选近似重复）
 */
export function findDuplicatesInText(params: FindDuplicatesParams): DuplicateScanResult {
    const normalizeOpts = getCitationNormalizeOptions();
    const sentences = buildInternalSentences({
        text: params.text,
        useSimpleSplitter: params.useSimpleSplitter,
        minCitationLength: params.minCitationLength,
        openccT2cnBeforeSimilarity: params.openccT2cnBeforeSimilarity,
        normalizeOpts
    });

    const exactGroups: DuplicateExactGroup[] = [];
    const fuzzyGroups: DuplicateFuzzyGroup[] = [];

    if (sentences.length === 0) {
        return { exactGroups, fuzzyGroups };
    }

    const mode = params.mode;

    if (mode === 'exact' || mode === 'both') {
        const byKey = new Map<string, InternalSentence[]>();
        for (const s of sentences) {
            const list = byKey.get(s.matchKey) ?? [];
            list.push(s);
            byKey.set(s.matchKey, list);
        }
        for (const [key, list] of byKey) {
            if (list.length < 2) continue;
            const preview = key.length > 40 ? key.slice(0, 40) + '…' : key;
            exactGroups.push({
                kind: 'exact',
                preview,
                occurrences: list.map(toOccurrence)
            });
        }
    }

    if (mode === 'fuzzy' || mode === 'both') {
        const n = sentences.length;
        const sortedIdx = sentences.map((_, i) => i).sort((a, b) => sentences[a].lenNorm - sentences[b].lenNorm);

        const uf = new UnionFind(n);
        const simOpts = {
            n: Math.max(1, Math.floor(params.ngramSize)),
            granularity: (params.ngramGranularity === 'word' && params.jieba ? 'word' : 'char') as 'word' | 'char',
            jieba: params.ngramGranularity === 'word' && params.jieba ? params.jieba : undefined,
            cutMode: params.cutMode
        };

        let donePairs = 0;
        const totalPairsEst = (n * (n - 1)) / 2;

        for (let a = 0; a < n; a++) {
            if (params.cancelToken?.isCancellationRequested) break;
            const i = sortedIdx[a];
            const si = sentences[i];
            const { high } = lengthBounds(si.lenNorm, params.lenDeltaRatio);
            for (let b = a + 1; b < n; b++) {
                const j = sortedIdx[b];
                const sj = sentences[j];
                if (sj.lenNorm > high) break;
                const { low } = lengthBounds(si.lenNorm, params.lenDeltaRatio);
                if (sj.lenNorm < low) continue;

                if (si.matchKey === sj.matchKey) continue;

                const normA = normalizedWithoutEllipsis(
                    normalizeForCitationMatch(si.text, params.openccT2cnBeforeSimilarity, normalizeOpts)
                );
                const normB = normalizedWithoutEllipsis(
                    normalizeForCitationMatch(sj.text, params.openccT2cnBeforeSimilarity, normalizeOpts)
                );
                const score = jaccardSimilarity(normA, normB, simOpts);
                donePairs++;
                if (donePairs % 500 === 0) {
                    params.progress?.('近似重复比对…', donePairs, totalPairsEst);
                }
                if (score >= params.similarityThreshold) {
                    uf.union(i, j);
                }
            }
        }

        const byRoot = new Map<number, InternalSentence[]>();
        for (let i = 0; i < n; i++) {
            const root = uf.find(i);
            const list = byRoot.get(root) ?? [];
            list.push(sentences[i]);
            byRoot.set(root, list);
        }

        for (const list of byRoot.values()) {
            if (list.length < 2) continue;
            const distinctKeys = new Set(list.map((s) => s.matchKey));
            if (distinctKeys.size < 2) {
                continue;
            }
            let best = 0;
            for (let p = 0; p < list.length; p++) {
                for (let q = p + 1; q < list.length; q++) {
                    const normA = normalizedWithoutEllipsis(
                        normalizeForCitationMatch(list[p].text, params.openccT2cnBeforeSimilarity, normalizeOpts)
                    );
                    const normB = normalizedWithoutEllipsis(
                        normalizeForCitationMatch(list[q].text, params.openccT2cnBeforeSimilarity, normalizeOpts)
                    );
                    best = Math.max(best, jaccardSimilarity(normA, normB, simOpts));
                }
            }
            fuzzyGroups.push({
                kind: 'fuzzy',
                score: best,
                occurrences: list.map(toOccurrence)
            });
        }

        fuzzyGroups.sort((a, b) => b.score - a.score);
    }

    return { exactGroups, fuzzyGroups };
}
