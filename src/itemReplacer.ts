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

function getSimilarityThreshold(): number {
    const config = vscode.workspace.getConfiguration('ai-proofread');
    return config.get<number>('proofread.itemReplaceSimilarityThreshold', 0.85);
}

/**
 * 在单段文本内按顺序应用每条替换；每处只替换一次，不跨段。
 * 匹配策略：1）全文查找 2）忽略空格、标点后查找 3）相似度最高且≥阈值的片段
 */
export function applyItemReplacements(
    originalText: string,
    items: ProofreadItem[],
    options: ApplyReplacementsOptions = {}
): string {
    if (!items.length) return originalText;
    const threshold = options.similarityThreshold ?? getSimilarityThreshold();
    let result = originalText;

    for (const item of items) {
        const { original, corrected } = item;
        if (!original || corrected === undefined || corrected === null) continue;

        // 1) 全文查找
        const exactIndex = result.indexOf(original);
        if (exactIndex !== -1) {
            result = result.slice(0, exactIndex) + corrected + result.slice(exactIndex + original.length);
            continue;
        }

        // 2) 归一化后查找（忽略句中空白、标点）
        const normalizedOriginal = normalizeForSimilarity(original, {
            removeInnerWhitespace: true,
            removePunctuation: true,
        });
        if (!normalizedOriginal) continue;
        const len = original.length;
        const minLen = Math.max(1, Math.floor(len * 0.7));
        const maxLen = Math.min(result.length, Math.ceil(len * 1.5));
        let found = false;
        for (let L = minLen; L <= maxLen && !found; L++) {
            for (let start = 0; start <= result.length - L; start++) {
                const span = result.slice(start, start + L);
                const normSpan = normalizeForSimilarity(span, {
                    removeInnerWhitespace: true,
                    removePunctuation: true,
                });
                if (normSpan === normalizedOriginal) {
                    result = result.slice(0, start) + corrected + result.slice(start + L);
                    found = true;
                    break;
                }
            }
        }
        if (found) continue;

        // 3) 相似度匹配：在候选区间内选相似度最高且 ≥ 阈值的片段
        let bestSim = threshold;
        let bestStart = -1;
        let bestLen = 0;
        for (let L = minLen; L <= maxLen; L++) {
            for (let start = 0; start <= result.length - L; start++) {
                const candidate = result.slice(start, start + L);
                const sim = jaccardSimilarity(original, candidate, { n: 2, granularity: 'char' });
                if (sim > bestSim) {
                    bestSim = sim;
                    bestStart = start;
                    bestLen = L;
                }
            }
        }
        if (bestStart >= 0 && bestLen > 0) {
            result = result.slice(0, bestStart) + corrected + result.slice(bestStart + bestLen);
        }
    }

    return result;
}
