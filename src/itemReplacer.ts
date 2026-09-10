/**
 * 将条目式校对结果应用到原文（单段内替换）
 */

import * as vscode from 'vscode';
import { normalizeForSimilarity, jaccardSimilarity } from './similarity';
import type { ProofreadItem } from './itemOutputParser';

export interface ApplyReplacementsOptions {
    /** 相似度匹配阈值（0–1），默认从配置读取 */
    similarityThreshold?: number;
}

/** 与 similarity.normalizeForSimilarity 去掉标点时所用类别一致；不含 g，避免 lastIndex 干扰逐字检测 */
const PUNCT_CHAR_RE = /\p{P}/u;
const HORIZONTAL_WS_RE = /[ \t\u3000]/u;

function getSimilarityThreshold(): number {
    const config = vscode.workspace.getConfiguration('ai-proofread');
    return config.get<number>('proofread.itemReplaceSimilarityThreshold', 0.85);
}

function isPunctChar(ch: string): boolean {
    return PUNCT_CHAR_RE.test(ch);
}

function isContentChar(ch: string): boolean {
    return ch !== '' && !/\s/u.test(ch) && !isPunctChar(ch);
}

function leadingPunct(s: string): string {
    let i = 0;
    while (i < s.length && isPunctChar(s[i]!)) {
        i++;
    }
    return s.slice(0, i);
}

function trailingPunct(s: string): string {
    let i = s.length;
    while (i > 0 && isPunctChar(s[i - 1]!)) {
        i--;
    }
    return s.slice(i);
}

function longestAffixOverlap(suffix: string, prefix: string): number {
    const max = Math.min(suffix.length, prefix.length);
    for (let n = max; n > 0; n--) {
        if (suffix.slice(suffix.length - n) === prefix.slice(0, n)) {
            return n;
        }
    }
    return 0;
}

/**
 * 去掉替换结果与上下文接缝处重复的标点。
 * 例如原文「……源远流长”。」而 corrected 已含「”。」时，避免得到「……源远流长”。”。」。
 */
function spliceReplacement(text: string, start: number, end: number, replacement: string): string {
    let left = text.slice(0, start);
    let right = text.slice(end);

    const replTrail = trailingPunct(replacement);
    const rightLead = leadingPunct(right);
    if (replTrail && rightLead) {
        right = right.slice(longestAffixOverlap(replTrail, rightLead));
        const trailSet = new Set(replTrail);
        let i = 0;
        while (i < right.length && isPunctChar(right[i]!) && trailSet.has(right[i]!)) {
            i++;
        }
        right = right.slice(i);
    }

    const leftTrail = trailingPunct(left);
    const replLead = leadingPunct(replacement);
    if (leftTrail && replLead) {
        left = left.slice(0, left.length - longestAffixOverlap(leftTrail, replLead));
        const leadSet = new Set(replLead);
        let i = left.length;
        while (i > 0 && isPunctChar(left[i - 1]!) && leadSet.has(left[i - 1]!)) {
            i--;
        }
        left = left.slice(0, i);
    }

    return left + replacement + right;
}

function countLeadingPunct(s: string): number {
    return leadingPunct(s).length;
}

function countTrailingPunct(s: string): number {
    return trailingPunct(s).length;
}

/** 按 original 自身的首尾标点数量，把匹配区间向外扩到相邻标点（不跨过换行） */
function expandSpanByOriginalPunct(
    text: string,
    start: number,
    end: number,
    original: string
): { start: number; end: number } {
    let s = start;
    let leadLeft = countLeadingPunct(original);
    while (s > 0 && leadLeft > 0) {
        const ch = text[s - 1]!;
        if (HORIZONTAL_WS_RE.test(ch)) {
            s--;
            continue;
        }
        if (isPunctChar(ch)) {
            s--;
            leadLeft--;
            continue;
        }
        break;
    }

    let e = end;
    let trailLeft = countTrailingPunct(original);
    while (e < text.length && trailLeft > 0) {
        const ch = text[e]!;
        if (HORIZONTAL_WS_RE.test(ch)) {
            e++;
            continue;
        }
        if (isPunctChar(ch)) {
            e++;
            trailLeft--;
            continue;
        }
        break;
    }
    return { start: s, end: e };
}

/**
 * 忽略空白与标点后，按原文内容字符定位区间；再按 original 的首尾标点数量向外扩展。
 * 避免旧实现从最短窗口扫起，只吃到「源远流长」而把「”。」留给正文。
 */
function findNormalizedContentSpan(
    text: string,
    original: string
): { start: number; end: number } | undefined {
    const normalizedOriginal = normalizeForSimilarity(original, {
        removeInnerWhitespace: true,
        removePunctuation: true,
    });
    if (!normalizedOriginal) {
        return undefined;
    }

    let content = '';
    const indices: number[] = [];
    for (let i = 0; i < text.length; i++) {
        const ch = text[i]!;
        if (isContentChar(ch)) {
            content += ch;
            indices.push(i);
        }
    }
    const pos = content.indexOf(normalizedOriginal);
    if (pos === -1) {
        return undefined;
    }
    const last = pos + normalizedOriginal.length - 1;
    return expandSpanByOriginalPunct(text, indices[pos]!, indices[last]! + 1, original);
}

function findSimilaritySpan(
    text: string,
    original: string,
    threshold: number
): { start: number; end: number } | undefined {
    const len = original.length;
    const minLen = Math.max(1, Math.floor(len * 0.7));
    const maxLen = Math.min(text.length, Math.ceil(len * 1.5));
    let bestSim = threshold;
    let bestStart = -1;
    let bestLen = 0;
    for (let L = minLen; L <= maxLen; L++) {
        for (let start = 0; start <= text.length - L; start++) {
            const candidate = text.slice(start, start + L);
            const sim = jaccardSimilarity(original, candidate, { n: 2, granularity: 'char' });
            if (
                sim > bestSim ||
                (sim === bestSim && bestStart >= 0 && Math.abs(L - len) < Math.abs(bestLen - len))
            ) {
                bestSim = sim;
                bestStart = start;
                bestLen = L;
            }
        }
    }
    if (bestStart >= 0 && bestLen > 0) {
        return { start: bestStart, end: bestStart + bestLen };
    }
    return undefined;
}

/**
 * 在单段 target 内定位 `original` 的 UTF-16 区间（与 applyItemReplacements 单步策略一致，不改变文本）。
 */
export function findOriginalSpanInSegment(
    segmentText: string,
    original: string,
    options: ApplyReplacementsOptions = {}
): { start: number; end: number } | undefined {
    if (!original) {
        return undefined;
    }
    const threshold = options.similarityThreshold ?? getSimilarityThreshold();

    const exactIndex = segmentText.indexOf(original);
    if (exactIndex !== -1) {
        return { start: exactIndex, end: exactIndex + original.length };
    }

    const normalized = findNormalizedContentSpan(segmentText, original);
    if (normalized) {
        return normalized;
    }

    return findSimilaritySpan(segmentText, original, threshold);
}

/** 为条目写入 .proofread-item.json 前填充锚点（段落内 UTF-16 偏移） */
export function attachAnchorsToProofreadItems(items: ProofreadItem[], segmentTarget: string): ProofreadItem[] {
    return items.map((item) => {
        const span = findOriginalSpanInSegment(segmentTarget, item.original);
        if (!span) {
            return item;
        }
        return { ...item, anchor: { start: span.start, end: span.end } };
    });
}

/**
 * 在单段文本内按顺序应用每条替换；每处只替换一次，不跨段。
 * 匹配策略：1）全文查找 2）忽略空格、标点后按内容定位并扩展首尾标点 3）相似度最高且＞阈值的片段
 * 写入时去掉与上下文接缝处重复的标点。
 */
export function applyItemReplacements(
    originalText: string,
    items: ProofreadItem[],
    options: ApplyReplacementsOptions = {}
): string {
    if (!items.length) {
        return originalText;
    }
    let result = originalText;

    for (const item of items) {
        const { original, corrected } = item;
        if (!original || corrected === undefined || corrected === null) {
            continue;
        }

        const span = findOriginalSpanInSegment(result, original, options);
        if (!span) {
            continue;
        }
        result = spliceReplacement(result, span.start, span.end, corrected);
    }

    return result;
}
