/**
 * 句子对齐算法模块（基于锚点算法）
 */

/**
 * 对齐结果类型
 */
export type AlignmentType = 'match' | 'delete' | 'insert' | 'movein' | 'moveout';

/**
 * 对齐结果项
 */
export interface AlignmentItem {
    type: AlignmentType;
    a?: string;                    // 原文句子
    b?: string;                    // 校对后句子
    a_index?: number | null;      // 原文句子索引
    b_index?: number | null;      // 校对后句子索引
    a_indices?: number[];          // 原文句子索引列表（合并多个句子时）
    b_indices?: number[];          // 校对后句子索引列表（合并多个句子时）
    similarity?: number;           // 相似度（0-1）
    a_line_number?: number;        // 原文行号
    b_line_number?: number;        // 校对后行号
    a_line_numbers?: number[];     // 原文行号列表
    b_line_numbers?: number[];     // 校对后行号列表
    original_b_index?: number | null;  // 原始b_index（用于moveout项）
    original_a_index?: number | null;  // 原始a_index（用于movein项）
}

/**
 * 对齐参数配置
 */
export interface AlignmentOptions {
    windowSize?: number;                    // 搜索窗口大小（锚点左右各N个句子），默认10
    similarityThreshold?: number;            // 相似度阈值（0-1），默认0.6
    ngramSize?: number;                     // N-gram大小，默认1
    ngramGranularity?: 'word' | 'char';     // 相似度粒度：词级（默认）或字级
    cutMode?: 'default' | 'search';        // 词级粒度时的分词模式：default 或 search
    jieba?: JiebaWasmModule;               // 词级粒度时必填：jieba-wasm 模块
    offset?: number;                        // 锚点偏移量，默认1
    maxWindowExpansion?: number;            // 最大窗口扩展倍数，默认3
    consecutiveFailThreshold?: number;     // 连续失败阈值，默认3
    removeInnerWhitespace?: boolean;        // 相似度计算时是否忽略句中空白/句内分行，默认 true
    removePunctuation?: boolean;           // 归一化时是否去掉标点（与引文核对共用），默认 false
    removeDigits?: boolean;                // 归一化时是否去掉阿拉伯数字（与引文核对共用），默认 false
    removeLatin?: boolean;                 // 归一化时是否去掉拉丁字符（与引文核对共用），默认 false
}

/**
 * 对齐统计信息
 */
export interface AlignmentStatistics {
    total: number;
    match: number;
    delete: number;
    insert: number;
    movein: number;
    moveout: number;
}

import type { JiebaWasmModule } from './jiebaLoader';
import { normalizeForSimilarity, jaccardSimilarity, NormalizeForSimilarityOptions, type JaccardSimilarityOptions } from './similarity';

/** 从 AlignmentOptions 构建归一化选项（供 similarity.normalizeForSimilarity） */
function getNormalizeOptions(options: AlignmentOptions): NormalizeForSimilarityOptions {
    return {
        removeInnerWhitespace: options.removeInnerWhitespace !== false,
        removePunctuation: options.removePunctuation === true,
        removeDigits: options.removeDigits === true,
        removeLatin: options.removeLatin === true
    };
}

/** 从 AlignmentOptions 构建相似度计算选项（供 similarity.jaccardSimilarity） */
function getSimOptions(options: AlignmentOptions): JaccardSimilarityOptions {
    const n = Math.max(1, Math.floor(options.ngramSize ?? 1));
    const granularity = options.ngramGranularity ?? 'char';
    const jieba = options.jieba;
    const cutMode = options.cutMode ?? 'default';
    return {
        n,
        granularity: granularity === 'word' && jieba ? 'word' : 'char',
        jieba: granularity === 'word' && jieba ? jieba : undefined,
        cutMode
    };
}

/**
 * 锚点对齐算法（与Python版本完全一致）
 * @param sentencesA 原文句子列表
 * @param sentencesB 校对后句子列表
 * @param options 对齐参数
 * @returns 对齐结果列表
 */
export function alignSentencesAnchor(
    sentencesA: string[],
    sentencesB: string[],
    options: AlignmentOptions = {}
): AlignmentItem[] {
    const {
        windowSize = 10,
        similarityThreshold = 0.6,
        ngramSize = 1,
        offset = 1,
        maxWindowExpansion = 3,
        consecutiveFailThreshold = 3,
        removeInnerWhitespace = true,
        removePunctuation = false,
        removeDigits = false,
        removeLatin = false
    } = options;
    const normalizeOpts = getNormalizeOptions(options);
    const simOpts = getSimOptions(options);

    const n = sentencesA.length;
    const m = sentencesB.length;

    if (n === 0 && m === 0) {
        return [];
    }

    const result: AlignmentItem[] = [];
    let anchor = 0;  // 当前锚点位置（在B中的索引）
    let aIdx = 0;    // 当前处理的A中句子索引
    const bUsed = new Set<number>();  // 记录B中已匹配的句子索引
    const bToResult: { [key: number]: AlignmentItem } = {};  // 记录B中每个句子对应的结果项

    // 用于跟踪连续失败次数和动态窗口
    let consecutiveFails = 0;
    let currentWindow = windowSize;

    // 按照A文件的顺序处理
    while (aIdx < n) {
        const sentA = normalizeForSimilarity(sentencesA[aIdx], normalizeOpts);

        // 动态调整搜索窗口：如果连续失败，逐步扩大窗口
        if (consecutiveFails >= consecutiveFailThreshold) {
            // 扩大搜索窗口（最多扩大到max_window_expansion倍）
            const expansionFactor = Math.min(
                maxWindowExpansion,
                1 + Math.floor((consecutiveFails - consecutiveFailThreshold) / 2)
            );
            currentWindow = windowSize * expansionFactor;
        } else {
            // 重置窗口大小
            currentWindow = windowSize;
        }

        // 确定搜索窗口
        const windowStart = Math.max(0, anchor - currentWindow);
        const windowEnd = Math.min(m, anchor + currentWindow + 1);

        // 在窗口内搜索最相似的句子
        let bestMatchIdx: number | null = null;
        let bestSimilarity = 0.0;
        let bestBIdxInWindow: number | null = null;  // 窗口内最佳匹配位置（即使相似度不够）

        for (let bIdx = windowStart; bIdx < windowEnd; bIdx++) {
            // 跳过已匹配的句子
            if (bUsed.has(bIdx)) {
                continue;
            }

            const sentB = normalizeForSimilarity(sentencesB[bIdx], normalizeOpts);
            const similarity = jaccardSimilarity(sentA, sentB, simOpts);

            if (similarity > bestSimilarity) {
                bestSimilarity = similarity;
                bestMatchIdx = similarity >= similarityThreshold ? bIdx : null;
                bestBIdxInWindow = bIdx;
            }
        }

        // 如果窗口内没找到匹配，进行全局搜索
        // 触发条件：
        // 1. 连续失败次数达到阈值
        // 2. 或者窗口已经扩大到一定程度（说明可能有大段落变化）
        // 3. 或者窗口内找到的相似度较高（>0.5）但不够阈值（可能是段落重排）
        const shouldGlobalSearch = (
            bestMatchIdx === null && consecutiveFails >= consecutiveFailThreshold
        ) || (
            bestMatchIdx === null && currentWindow >= windowSize * 2
        ) || (
            bestMatchIdx === null && bestSimilarity > 0.5 && consecutiveFails >= 1
        );

        if (shouldGlobalSearch) {
            // 全局搜索：在整个B文本中搜索（跳过已匹配的）
            for (let bIdx = 0; bIdx < m; bIdx++) {
                if (bUsed.has(bIdx)) {
                    continue;
                }

                const sentB = normalizeForSimilarity(sentencesB[bIdx], normalizeOpts);
                const similarity = jaccardSimilarity(sentA, sentB, simOpts);

                if (similarity > bestSimilarity) {
                    bestSimilarity = similarity;
                    if (similarity >= similarityThreshold) {
                        bestMatchIdx = bIdx;
                    }
                    bestBIdxInWindow = bIdx;
                }
            }
        }

        // 判断是否匹配
        if (bestMatchIdx !== null && bestSimilarity >= similarityThreshold) {
            // 匹配成功
            const item: AlignmentItem = {
                type: 'match',
                a: sentencesA[aIdx],
                b: sentencesB[bestMatchIdx],
                similarity: bestSimilarity,
                a_indices: [aIdx],
                b_indices: [bestMatchIdx]
            };
            result.push(item);
            bToResult[bestMatchIdx] = item;

            // 更新锚点和标记
            anchor = bestMatchIdx + offset;
            bUsed.add(bestMatchIdx);
            consecutiveFails = 0;  // 重置连续失败计数
        } else {
            // 未找到匹配，视为删除
            result.push({
                type: 'delete',
                a: sentencesA[aIdx],
                b: undefined,
                similarity: undefined,
                a_index: aIdx,
                b_index: undefined
            });

            // 即使没有匹配，如果找到了相似度较高的句子，也适当更新锚点
            // 这有助于在段落重排时重新定位
            if (bestBIdxInWindow !== null && bestSimilarity > 0.3) {
                // 如果相似度超过0.3，说明可能是同一内容但改动较大
                // 更新锚点到该位置，但保持较小偏移
                anchor = Math.max(anchor, bestBIdxInWindow);
            }

            consecutiveFails++;
        }

        aIdx++;
    }

    // 处理B中剩余的未匹配句子（视为新增）
    // 按照B的原始顺序，紧跟在它上一句（在B中的前一句）的后面

    // 创建B索引到结果位置的映射（包括匹配项和已插入的新增项）
    const bIdxToResultPos: { [key: number]: number } = {};
    for (let pos = 0; pos < result.length; pos++) {
        const item = result[pos];
        if (item.b_indices) {
            // 对于MATCH项，使用b_indices数组
            for (const bIdx of item.b_indices) {
                bIdxToResultPos[bIdx] = pos;
            }
        } else if (item.b_index !== undefined && item.b_index !== null) {
            // 对于INSERT项，使用b_index
            bIdxToResultPos[item.b_index] = pos;
        }
    }

    // 按B的原始顺序处理未匹配的句子
    for (let bIdx = 0; bIdx < m; bIdx++) {
        if (bUsed.has(bIdx)) {
            continue;  // 已匹配，跳过
        }

        // 找到B中b_idx的前一句（b_idx-1）在结果中的位置
        let insertPos = result.length;  // 默认插入到末尾

        if (bIdx > 0) {
            // 查找前一句（b_idx-1）在结果中的位置
            let prevBIdx = bIdx - 1;
            if (prevBIdx in bIdxToResultPos) {
                // 前一句在结果中的位置
                const prevPos = bIdxToResultPos[prevBIdx];
                // 插入到前一句之后
                insertPos = prevPos + 1;
            } else {
                // 前一句也是新增的，继续往前找
                for (let pIdx = prevBIdx; pIdx >= 0; pIdx--) {
                    if (pIdx in bIdxToResultPos) {
                        insertPos = bIdxToResultPos[pIdx] + 1;
                        break;
                    }
                }
            }
        }

        // 创建新增项
        const item: AlignmentItem = {
            type: 'insert',
            a: undefined,
            b: sentencesB[bIdx],
            similarity: undefined,
            a_index: undefined,
            b_index: bIdx
        };

        // 插入到结果中
        result.splice(insertPos, 0, item);

        // 更新映射（因为插入了新项，后面的位置都变了）
        // 重新构建映射
        bIdxToResultPos[bIdx] = insertPos;
        for (let pos = insertPos + 1; pos < result.length; pos++) {
            const item = result[pos];
            if (item.b_indices) {
                for (const idx of item.b_indices) {
                    bIdxToResultPos[idx] = pos;
                }
            } else if (item.b_index !== undefined && item.b_index !== null) {
                bIdxToResultPos[item.b_index] = pos;
            }
        }
    }

    // 结果已经按照A、B文件的原始顺序排列
    // - 匹配和删除按A的顺序
    // - 新增按B的原始顺序插入到合适位置

    // 后处理：在相邻的DELETE和INSERT序列之间尝试重新匹配
    const resultAfterRematch = rematchDeleteInsertSequences(
        result,
        similarityThreshold,
        simOpts,
        normalizeOpts
    );

    // 后处理：在一定的序号上下范围内处理不相邻的DELETE和INSERT
    const resultAfterNonAdjacentRematch = rematchNonAdjacentDeleteInsert(
        resultAfterRematch,
        similarityThreshold,
        simOpts,
        windowSize,  // 使用窗口大小作为索引范围
        normalizeOpts
    );

    // 后处理：将单独的DELETE项合并到相邻的MATCH组中
    const resultAfterMergeDelete = mergeDeleteIntoMatch(
        resultAfterNonAdjacentRematch,
        simOpts,
        normalizeOpts
    );

    // 后处理：将单独的INSERT项合并到相邻的MATCH组中（与 delete 合并对称，处理 b 侧）
    const resultAfterMerge = mergeInsertIntoMatch(
        resultAfterMergeDelete,
        simOpts,
        normalizeOpts
    );

    // 后处理：检测和处理句子移动，创建movein和moveout条目
    const finalResult = detectAndHandleMovements(resultAfterMerge);

    return finalResult;
}

/**
 * 生成合并后的候选句子
 * @param items 句子项列表（DELETE或INSERT）
 * @param textKey 文本键名（'a'或'b'）
 * @param merge 是否生成合并候选（默认true）
 * @returns 候选句子列表
 */
interface Candidate {
    text: string;
    indices: number[];
    matched: boolean;
    originalItem?: AlignmentItem;
    originalItems?: AlignmentItem[];
}

function generateMergedCandidates(
    items: AlignmentItem[],
    textKey: 'a' | 'b',
    merge: boolean = true
): Candidate[] {
    const candidates: Candidate[] = [];

    // 添加单个句子
    for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        const text = textKey === 'a' ? item.a : item.b;
        if (text) {
            candidates.push({
                text: text,
                indices: [idx],
                matched: false,
                originalItem: item
            });
        }
    }

    // 如果允许合并且序列较短（<=3个），尝试合并相邻的句子
    if (merge && items.length <= 3) {
        // 合并相邻的两个句子
        for (let start = 0; start < items.length - 1; start++) {
            let mergedText = '';
            const indices: number[] = [];
            for (let j = start; j < Math.min(start + 2, items.length); j++) {
                const text = textKey === 'a' ? items[j].a : items[j].b;
                if (text) {
                    if (mergedText) {
                        mergedText += text;
                    } else {
                        mergedText = text;
                    }
                    indices.push(j);
                }
            }

            if (mergedText) {
                candidates.push({
                    text: mergedText,
                    indices: indices,
                    matched: false,
                    originalItems: indices.map(i => items[i])
                });
            }
        }

        // 如果序列很短（<=2个），也尝试合并所有句子
        if (items.length <= 2 && items.length > 1) {
            let mergedText = '';
            const indices: number[] = [];
            for (let j = 0; j < items.length; j++) {
                const text = textKey === 'a' ? items[j].a : items[j].b;
                if (text) {
                    if (mergedText) {
                        mergedText += text;
                    } else {
                        mergedText = text;
                    }
                    indices.push(j);
                }
            }

            if (mergedText && indices.length > 1) {
                // 检查是否已经作为两个句子的合并添加过
                const alreadyExists = candidates.some(c =>
                    'originalItems' in c &&
                    c.indices.length === indices.length &&
                    c.indices.every((val, idx) => val === indices[idx])
                );
                if (!alreadyExists) {
                    candidates.push({
                        text: mergedText,
                        indices: indices,
                        matched: false,
                        originalItems: indices.map(i => items[i])
                    });
                }
            }
        }
    }

    return candidates;
}

/**
 * 后处理：在相邻的DELETE和INSERT序列之间尝试重新匹配
 * @param alignment 初始对齐结果
 * @param similarityThreshold 相似度阈值
 * @param simOpts 相似度计算选项
 * @returns 优化后的对齐结果
 */
function rematchDeleteInsertSequences(
    alignment: AlignmentItem[],
    similarityThreshold: number = 0.6,
    simOpts: JaccardSimilarityOptions = {},
    normalizeOpts: NormalizeForSimilarityOptions = {}
): AlignmentItem[] {
    if (alignment.length === 0) {
        return alignment;
    }

    const result: AlignmentItem[] = [];
    let i = 0;

    while (i < alignment.length) {
        const currentItem = alignment[i];

        // 如果是DELETE或INSERT，查找连续的序列
        if (currentItem.type === 'delete' || currentItem.type === 'insert') {
            const deleteItems: AlignmentItem[] = [];
            const insertItems: AlignmentItem[] = [];

            // 收集连续的DELETE和INSERT序列
            while (i < alignment.length &&
                   (alignment[i].type === 'delete' || alignment[i].type === 'insert')) {
                const item = alignment[i];
                if (item.type === 'delete') {
                    deleteItems.push(item);
                } else {
                    insertItems.push(item);
                }
                i++;
            }

            // 如果既有DELETE又有INSERT，尝试匹配
            if (deleteItems.length > 0 && insertItems.length > 0) {
                const matchedPairs: Array<[Candidate, Candidate, number]> = [];

                // 如果一方较短，尝试合并相邻的句子
                let deleteCandidates: Candidate[];
                let insertCandidates: Candidate[];

                if (deleteItems.length < insertItems.length) {
                    // DELETE较短，生成DELETE的合并候选（以便匹配多个INSERT）
                    deleteCandidates = generateMergedCandidates(deleteItems, 'a');
                    insertCandidates = generateMergedCandidates(insertItems, 'b', false);
                } else if (insertItems.length < deleteItems.length) {
                    // INSERT较短，生成DELETE的合并候选（以便多个DELETE匹配一个INSERT）
                    deleteCandidates = generateMergedCandidates(deleteItems, 'a');
                    insertCandidates = generateMergedCandidates(insertItems, 'b', false);
                } else {
                    // 长度相等，都生成合并候选（但优先单个匹配）
                    deleteCandidates = generateMergedCandidates(deleteItems, 'a');
                    insertCandidates = generateMergedCandidates(insertItems, 'b');
                }

                // 按候选长度降序排序，优先匹配更长的（合并的）候选
                deleteCandidates.sort((a, b) => b.indices.length - a.indices.length);
                insertCandidates.sort((a, b) => b.indices.length - a.indices.length);

                for (const dCandidate of deleteCandidates) {
                    if (dCandidate.matched) {
                        continue;
                    }

                    let bestInsertCandidate: Candidate | null = null;
                    let bestSimilarity = 0.0;

                    for (const insCandidate of insertCandidates) {
                        if (insCandidate.matched) {
                            continue;
                        }

                        if (dCandidate.text && insCandidate.text) {
                            const sentA = normalizeForSimilarity(dCandidate.text, normalizeOpts);
                            const sentB = normalizeForSimilarity(insCandidate.text, normalizeOpts);
                            const similarity = jaccardSimilarity(sentA, sentB, simOpts);

                            if (similarity > bestSimilarity && similarity >= similarityThreshold) {
                                bestSimilarity = similarity;
                                bestInsertCandidate = insCandidate;
                            }
                        }
                    }

                    // 如果找到匹配，创建MATCH项
                    if (bestInsertCandidate !== null) {
                        matchedPairs.push([dCandidate, bestInsertCandidate, bestSimilarity]);
                        dCandidate.matched = true;
                        bestInsertCandidate.matched = true;
                    }
                }

                // 创建匹配映射：记录哪些索引已被匹配
                const deleteMatchedIndices = new Set<number>();
                const insertMatchedIndices = new Set<number>();
                const matchItems: Array<[number, AlignmentItem]> = [];  // (第一个delete_idx, match_item)

                for (const [dCandidate, insCandidate, sim] of matchedPairs) {
                    // 记录所有被匹配的索引
                    for (const idx of dCandidate.indices) {
                        deleteMatchedIndices.add(idx);
                    }
                    for (const idx of insCandidate.indices) {
                        insertMatchedIndices.add(idx);
                    }

                    // 创建MATCH项
                    // 收集所有A的原始索引
                    let aText: string;
                    let aIndices: number[];

                    if (dCandidate.indices.length === 1) {
                        aText = dCandidate.originalItem!.a!;
                        aIndices = dCandidate.originalItem!.a_indices ||
                                   [dCandidate.originalItem!.a_index ?? dCandidate.indices[0]];
                    } else {
                        // 合并的句子，收集所有原始索引
                        aIndices = [];
                        for (let j = 0; j < dCandidate.indices.length; j++) {
                            const origItem = dCandidate.originalItems![j];
                            const itemIndices = origItem.a_indices ||
                                               [origItem.a_index ?? dCandidate.indices[j]];
                            aIndices.push(...itemIndices);
                        }
                        aText = dCandidate.text;
                    }

                    // 收集所有B的原始索引
                    let bText: string;
                    let bIndices: number[];

                    if (insCandidate.indices.length === 1) {
                        bText = insCandidate.originalItem!.b!;
                        bIndices = insCandidate.originalItem!.b_indices ||
                                  [insCandidate.originalItem!.b_index ?? insCandidate.indices[0]];
                    } else {
                        // 合并的句子，收集所有原始索引
                        bIndices = [];
                        for (let j = 0; j < insCandidate.indices.length; j++) {
                            const origItem = insCandidate.originalItems![j];
                            const itemIndices = origItem.b_indices ||
                                               [origItem.b_index ?? insCandidate.indices[j]];
                            bIndices.push(...itemIndices);
                        }
                        bText = insCandidate.text;
                    }

                    const matchItem: AlignmentItem = {
                        type: 'match',
                        a: aText,
                        b: bText,
                        similarity: sim,
                        a_indices: aIndices,
                        b_indices: bIndices
                    };

                    // 保留行号信息（从原始项中收集）
                    const aLineNumbers: number[] = [];
                    const bLineNumbers: number[] = [];

                    // 处理A侧行号
                    if (dCandidate.originalItems) {
                        // 合并的句子，从多个原始项中收集行号
                        for (const origItem of dCandidate.originalItems) {
                            if (origItem) {
                                if (origItem.a_line_numbers && origItem.a_line_numbers.length > 0) {
                                    aLineNumbers.push(...origItem.a_line_numbers);
                                } else if (origItem.a_line_number !== undefined && origItem.a_line_number !== null) {
                                    aLineNumbers.push(origItem.a_line_number);
                                }
                            }
                        }
                    } else if (dCandidate.originalItem) {
                        // 单个句子
                        const origItem = dCandidate.originalItem;
                        if (origItem.a_line_numbers && origItem.a_line_numbers.length > 0) {
                            aLineNumbers.push(...origItem.a_line_numbers);
                        } else if (origItem.a_line_number !== undefined && origItem.a_line_number !== null) {
                            aLineNumbers.push(origItem.a_line_number);
                        }
                    }

                    // 处理B侧行号
                    if (insCandidate.originalItems) {
                        // 合并的句子，从多个原始项中收集行号
                        for (const origItem of insCandidate.originalItems) {
                            if (origItem) {
                                if (origItem.b_line_numbers && origItem.b_line_numbers.length > 0) {
                                    bLineNumbers.push(...origItem.b_line_numbers);
                                } else if (origItem.b_line_number !== undefined && origItem.b_line_number !== null) {
                                    bLineNumbers.push(origItem.b_line_number);
                                }
                            }
                        }
                    } else if (insCandidate.originalItem) {
                        // 单个句子
                        const origItem = insCandidate.originalItem;
                        if (origItem.b_line_numbers && origItem.b_line_numbers.length > 0) {
                            bLineNumbers.push(...origItem.b_line_numbers);
                        } else if (origItem.b_line_number !== undefined && origItem.b_line_number !== null) {
                            bLineNumbers.push(origItem.b_line_number);
                        }
                    }

                    // 设置行号信息
                    if (aLineNumbers.length > 0) {
                        matchItem.a_line_numbers = aLineNumbers;
                        matchItem.a_line_number = aLineNumbers[0];
                    }
                    if (bLineNumbers.length > 0) {
                        matchItem.b_line_numbers = bLineNumbers;
                        matchItem.b_line_number = bLineNumbers[0];
                    }

                    // 使用第一个DELETE索引作为键
                    matchItems.push([dCandidate.indices[0], matchItem]);
                }

                // 按照原始顺序重建：记录每个原始项在delete_items/insert_items中的索引
                const startPos = i - deleteItems.length - insertItems.length;
                let deleteCounter = 0;
                let insertCounter = 0;
                const matchItemsByDeletePos = new Map<number, AlignmentItem>();
                for (const [pos, item] of matchItems) {
                    matchItemsByDeletePos.set(pos, item);
                }

                for (let origPos = startPos; origPos < i; origPos++) {
                    const origItem = alignment[origPos];
                    if (origItem.type === 'delete') {
                        const dIdx = deleteCounter;
                        deleteCounter++;
                        if (deleteMatchedIndices.has(dIdx)) {
                            // 检查是否应该添加MATCH项（只在第一个匹配的索引处添加）
                            if (matchItemsByDeletePos.has(dIdx)) {
                                result.push(matchItemsByDeletePos.get(dIdx)!);
                            }
                            // 如果不在matchItemsByDeletePos中，说明是合并匹配的一部分，跳过
                        } else {
                            // 未匹配的DELETE
                            result.push(deleteItems[dIdx]);
                        }
                    } else if (origItem.type === 'insert') {
                        const insIdx = insertCounter;
                        insertCounter++;
                        if (insertMatchedIndices.has(insIdx)) {
                            // INSERT已被匹配，跳过（MATCH项会在对应的DELETE位置添加）
                            // pass
                        } else {
                            // 未匹配的INSERT
                            result.push(insertItems[insIdx]);
                        }
                    }
                }
            } else {
                // 没有同时存在DELETE和INSERT，直接添加
                result.push(...deleteItems);
                result.push(...insertItems);
            }
        } else {
            // 其他类型的项（MATCH等），直接添加
            result.push(currentItem);
            i++;
        }
    }

    return result;
}

/**
 * 后处理：在一定的序号上下范围内处理不相邻的DELETE和INSERT
 * @param alignment 对齐结果（已经过相邻匹配处理）
 * @param similarityThreshold 相似度阈值
 * @param simOpts 相似度计算选项
 * @param indexRange 序号范围，用于判断DELETE和INSERT是否在合理范围内（默认10）
 * @returns 优化后的对齐结果
 */
function rematchNonAdjacentDeleteInsert(
    alignment: AlignmentItem[],
    similarityThreshold: number = 0.6,
    simOpts: JaccardSimilarityOptions = {},
    indexRange: number = 10,
    normalizeOpts: NormalizeForSimilarityOptions = {}
): AlignmentItem[] {
    if (alignment.length === 0) {
        return alignment;
    }

    // 第一步：收集所有的DELETE和INSERT项，记录它们在结果中的位置和原始索引
    interface DeleteItem {
        pos: number;
        item: AlignmentItem;
        aIdx: number;
    }
    interface InsertItem {
        pos: number;
        item: AlignmentItem;
        bIdx: number;
    }

    const deleteItems: DeleteItem[] = [];
    const insertItems: InsertItem[] = [];

    for (let pos = 0; pos < alignment.length; pos++) {
        const item = alignment[pos];
        if (item.type === 'delete') {
            // 获取a_index
            let aIdx: number | null = null;
            if (item.a_indices && item.a_indices.length === 1) {
                aIdx = item.a_indices[0];
            } else if (item.a_index !== undefined && item.a_index !== null) {
                aIdx = item.a_index;
            }

            if (aIdx !== null) {
                deleteItems.push({ pos, item, aIdx });
            }
        } else if (item.type === 'insert') {
            // 获取b_index
            let bIdx: number | null = null;
            if (item.b_indices && item.b_indices.length === 1) {
                bIdx = item.b_indices[0];
            } else if (item.b_index !== undefined && item.b_index !== null) {
                bIdx = item.b_index;
            }

            if (bIdx !== null) {
                insertItems.push({ pos, item, bIdx });
            }
        }
    }

    if (deleteItems.length === 0 || insertItems.length === 0) {
        // 没有DELETE或INSERT，直接返回
        return alignment;
    }

    // 第二步：尝试匹配不相邻的DELETE和INSERT
    // 对于每个DELETE，在一定的范围内查找INSERT
    const matchedPairs: Array<[number, number, number]> = [];  // [(delete_pos, insert_pos, similarity), ...]
    const deleteMatched = new Set<number>();  // 已匹配的DELETE位置
    const insertMatched = new Set<number>();  // 已匹配的INSERT位置

    // 按a_index排序DELETE项，按b_index排序INSERT项
    deleteItems.sort((a, b) => a.aIdx - b.aIdx);
    insertItems.sort((a, b) => a.bIdx - b.bIdx);

    for (const { pos: dPos, item: dItem, aIdx: dAIdx } of deleteItems) {
        if (deleteMatched.has(dPos)) {
            continue;
        }

        let bestInsert: InsertItem | null = null;
        let bestSimilarity = 0.0;
        let bestInsertPos: number | null = null;

        // 在INSERT项中查找匹配
        for (const { pos: insPos, item: insItem, bIdx: insBIdx } of insertItems) {
            if (insertMatched.has(insPos)) {
                continue;
            }

            // 判断是否在合理范围内
            // 方法1：基于原始索引的差值（如果a_index和b_index接近，说明可能是同一内容）
            const indexDiff = Math.abs(dAIdx - insBIdx);

            // 方法2：基于在结果列表中的位置差值
            const positionDiff = Math.abs(dPos - insPos);

            // 如果索引差值或位置差值在范围内，尝试匹配
            if (indexDiff <= indexRange || positionDiff <= indexRange) {
                // 计算相似度
                if (dItem.a && insItem.b) {
                    const sentA = normalizeForSimilarity(dItem.a, normalizeOpts);
                    const sentB = normalizeForSimilarity(insItem.b, normalizeOpts);
                    const similarity = jaccardSimilarity(sentA, sentB, simOpts);

                    if (similarity > bestSimilarity && similarity >= similarityThreshold) {
                        bestSimilarity = similarity;
                        bestInsert = { pos: insPos, item: insItem, bIdx: insBIdx };
                        bestInsertPos = insPos;
                    }
                }
            }
        }

        // 如果找到匹配，记录
        if (bestInsert !== null && bestInsertPos !== null) {
            matchedPairs.push([dPos, bestInsertPos, bestSimilarity]);
            deleteMatched.add(dPos);
            insertMatched.add(bestInsertPos);
        }
    }

    // 如果没有找到匹配，直接返回原结果
    if (matchedPairs.length === 0) {
        return alignment;
    }

    // 第三步：构建新的结果列表，将匹配的DELETE和INSERT替换为MATCH
    const result: AlignmentItem[] = [];
    const deleteMatchedPositions = new Set(matchedPairs.map(([dPos]) => dPos));
    const insertMatchedPositions = new Set(matchedPairs.map(([, insPos]) => insPos));
    const matchItemsByDeletePos = new Map<number, AlignmentItem>();  // {delete_pos: match_item}

    // 创建匹配项
    for (const [dPos, insPos, sim] of matchedPairs) {
        const dItem = alignment[dPos];
        const insItem = alignment[insPos];

        // 收集索引
        let aIndices = dItem.a_indices || [];
        if (aIndices.length === 0 && dItem.a_index !== undefined && dItem.a_index !== null) {
            aIndices = [dItem.a_index];
        }

        let bIndices = insItem.b_indices || [];
        if (bIndices.length === 0 && insItem.b_index !== undefined && insItem.b_index !== null) {
            bIndices = [insItem.b_index];
        }

        const matchItem: AlignmentItem = {
            type: 'match',
            a: dItem.a,
            b: insItem.b,
            similarity: sim,
            a_indices: aIndices,
            b_indices: bIndices
        };

        // 保留行号信息
        // 处理A侧行号
        if (dItem.a_line_numbers && dItem.a_line_numbers.length > 0) {
            matchItem.a_line_numbers = dItem.a_line_numbers;
            matchItem.a_line_number = dItem.a_line_numbers[0];
        } else if (dItem.a_line_number !== undefined && dItem.a_line_number !== null) {
            matchItem.a_line_number = dItem.a_line_number;
            matchItem.a_line_numbers = [dItem.a_line_number];
        }

        // 处理B侧行号
        if (insItem.b_line_numbers && insItem.b_line_numbers.length > 0) {
            matchItem.b_line_numbers = insItem.b_line_numbers;
            matchItem.b_line_number = insItem.b_line_numbers[0];
        } else if (insItem.b_line_number !== undefined && insItem.b_line_number !== null) {
            matchItem.b_line_number = insItem.b_line_number;
            matchItem.b_line_numbers = [insItem.b_line_number];
        }

        matchItemsByDeletePos.set(dPos, matchItem);
    }

    // 构建结果：按照原始顺序，将匹配的项替换为MATCH
    for (let pos = 0; pos < alignment.length; pos++) {
        const item = alignment[pos];
        if (deleteMatchedPositions.has(pos)) {
            // DELETE已匹配，添加MATCH项
            const matchItem = matchItemsByDeletePos.get(pos);
            if (matchItem) {
                result.push(matchItem);
            }
        } else if (insertMatchedPositions.has(pos)) {
            // INSERT已匹配，跳过（MATCH项已在对应的DELETE位置添加）
            // pass
        } else {
            // 其他项，直接添加
            result.push(item);
        }
    }

    return result;
}

/**
 * 后处理：将单独的DELETE项合并到相邻的MATCH组中
 * @param alignment 对齐结果
 * @param simOpts 相似度计算选项
 * @returns 优化后的对齐结果
 */
function mergeDeleteIntoMatch(
    alignment: AlignmentItem[],
    simOpts: JaccardSimilarityOptions = {},
    normalizeOpts: NormalizeForSimilarityOptions = {}
): AlignmentItem[] {
    if (alignment.length === 0) {
        return alignment;
    }

    const result: AlignmentItem[] = [];
    let i = 0;

    while (i < alignment.length) {
        const currentItem = alignment[i];

        // 如果是单独的DELETE项，尝试合并到相邻的MATCH
        if (currentItem.type === 'delete' && currentItem.a) {
            // 检查前一个和后一个项
            const prevItem = i > 0 ? alignment[i - 1] : null;
            const nextItem = i < alignment.length - 1 ? alignment[i + 1] : null;

            let bestMatch: AlignmentItem | null = null;
            let bestSimilarity = 0.0;
            let mergeDirection: 'prev' | 'next' | null = null;

            // 尝试合并到前一个MATCH
            if (prevItem &&
                prevItem.type === 'match' &&
                prevItem.a &&
                prevItem.b) {
                const prevA = prevItem.a;
                const prevB = prevItem.b;
                const mergedA = prevA + currentItem.a;
                const sentA = normalizeForSimilarity(mergedA, normalizeOpts);
                const sentB = normalizeForSimilarity(prevB, normalizeOpts);
                const newSimilarity = jaccardSimilarity(sentA, sentB, simOpts);

                // 如果新相似度高于原相似度，则合并
                const prevSim = prevItem.similarity ?? 0.0;
                if (newSimilarity > prevSim) {
                    if (newSimilarity > bestSimilarity) {
                        bestSimilarity = newSimilarity;
                        bestMatch = prevItem;
                        mergeDirection = 'prev';
                    }
                }
            }

            // 尝试合并到后一个MATCH
            if (nextItem &&
                nextItem.type === 'match' &&
                nextItem.a &&
                nextItem.b) {
                const mergedA = currentItem.a + nextItem.a;
                const sentA = normalizeForSimilarity(mergedA, normalizeOpts);
                const sentB = normalizeForSimilarity(nextItem.b, normalizeOpts);
                const newSimilarity = jaccardSimilarity(sentA, sentB, simOpts);

                // 如果新相似度高于原相似度，则合并
                const nextSim = nextItem.similarity ?? 0.0;
                if (newSimilarity > nextSim) {
                    if (newSimilarity > bestSimilarity) {
                        bestSimilarity = newSimilarity;
                        bestMatch = nextItem;
                        mergeDirection = 'next';
                    }
                }
            }

            // 如果找到可以合并的MATCH，进行合并
            if (bestMatch !== null && mergeDirection !== null) {
                if (mergeDirection === 'prev') {
                    // 合并到前一个MATCH，更新result中最后一个项（前一个MATCH）
                    if (result.length > 0 && result[result.length - 1].type === 'match') {
                        result[result.length - 1].a = result[result.length - 1].a! + currentItem.a!;
                        result[result.length - 1].similarity = bestSimilarity;
                        // 更新索引数组
                        const deleteAIndices = currentItem.a_indices || [];
                        if (deleteAIndices.length > 0) {
                            if (!result[result.length - 1].a_indices) {
                                result[result.length - 1].a_indices = [];
                            }
                            result[result.length - 1].a_indices!.push(...deleteAIndices);
                        } else if (currentItem.a_index !== undefined && currentItem.a_index !== null) {
                            if (!result[result.length - 1].a_indices) {
                                result[result.length - 1].a_indices = [];
                            }
                            result[result.length - 1].a_indices!.push(currentItem.a_index);
                        }
                    }
                    // 跳过当前DELETE
                    i++;
                    continue;
                } else {  // mergeDirection === 'next'
                    // 合并到后一个MATCH，更新alignment中的后一个MATCH
                    // 这样在后续处理时会使用更新后的值
                    nextItem.a = currentItem.a! + nextItem.a!;
                    nextItem.similarity = bestSimilarity;
                    // 更新索引数组
                    const deleteAIndices = currentItem.a_indices || [];
                    if (deleteAIndices.length > 0) {
                        if (!nextItem.a_indices) {
                            nextItem.a_indices = [];
                        }
                        nextItem.a_indices = [...deleteAIndices, ...(nextItem.a_indices || [])];
                    } else if (currentItem.a_index !== undefined && currentItem.a_index !== null) {
                        if (!nextItem.a_indices) {
                            nextItem.a_indices = [];
                        }
                        nextItem.a_indices = [currentItem.a_index, ...(nextItem.a_indices || [])];
                    }
                    // 跳过当前DELETE
                    i++;
                    continue;
                }
            }
        }

        // 其他情况，直接添加
        result.push(currentItem);
        i++;
    }

    return result;
}

/**
 * 后处理：将单独的INSERT项合并到相邻的MATCH组中（与 mergeDeleteIntoMatch 对称，处理 b 侧）
 * @param alignment 对齐结果
 * @param simOpts 相似度计算选项
 * @returns 优化后的对齐结果
 */
function mergeInsertIntoMatch(
    alignment: AlignmentItem[],
    simOpts: JaccardSimilarityOptions = {},
    normalizeOpts: NormalizeForSimilarityOptions = {}
): AlignmentItem[] {
    if (alignment.length === 0) {
        return alignment;
    }

    const result: AlignmentItem[] = [];
    let i = 0;

    while (i < alignment.length) {
        const currentItem = alignment[i];

        // 如果是单独的INSERT项，尝试合并到相邻的MATCH
        if (currentItem.type === 'insert' && currentItem.b) {
            // 检查前一个和后一个项
            const prevItem = i > 0 ? alignment[i - 1] : null;
            const nextItem = i < alignment.length - 1 ? alignment[i + 1] : null;

            let bestMatch: AlignmentItem | null = null;
            let bestSimilarity = 0.0;
            let mergeDirection: 'prev' | 'next' | null = null;

            // 尝试合并到前一个MATCH（INSERT 的 b 追加到前一个 MATCH 的 b 后）
            if (prevItem &&
                prevItem.type === 'match' &&
                prevItem.a &&
                prevItem.b) {
                const prevA = prevItem.a;
                const prevB = prevItem.b;
                const mergedB = prevB + currentItem.b;
                const sentA = normalizeForSimilarity(prevA, normalizeOpts);
                const sentB = normalizeForSimilarity(mergedB, normalizeOpts);
                const newSimilarity = jaccardSimilarity(sentA, sentB, simOpts);

                const prevSim = prevItem.similarity ?? 0.0;
                // 结构条件：若归一化后 insert.b 是 prevMatch.a 的后缀，也允许合并（与“合并到下一 MATCH”的前缀条件对称）
                const normInsertBPrev = normalizeForSimilarity(currentItem.b, normalizeOpts);
                const insertIsSuffixOfPrevA = normInsertBPrev.length > 0 && sentA.endsWith(normInsertBPrev);

                if (newSimilarity > prevSim || insertIsSuffixOfPrevA) {
                    const simToUse = newSimilarity > prevSim ? newSimilarity : Math.max(newSimilarity, prevSim);
                    if (insertIsSuffixOfPrevA || simToUse > bestSimilarity) {
                        bestSimilarity = simToUse;
                        bestMatch = prevItem;
                        mergeDirection = 'prev';
                    }
                }
            }

            // 尝试合并到后一个MATCH（INSERT 的 b 拼到后一个 MATCH 的 b 前）
            if (nextItem &&
                nextItem.type === 'match' &&
                nextItem.a &&
                nextItem.b) {
                const mergedB = currentItem.b + nextItem.b;
                const sentA = normalizeForSimilarity(nextItem.a, normalizeOpts);
                const sentB = normalizeForSimilarity(mergedB, normalizeOpts);
                const newSimilarity = jaccardSimilarity(sentA, sentB, simOpts);

                const nextSim = nextItem.similarity ?? 0.0;
                // 与 DELETE 合并对称：DELETE 时下一 MATCH 的 b 已包含 delete 的 a（完整句），相似度必然高；
                // INSERT 时下一 MATCH 的 a 已包含 insert 的 b，仅靠相似度可能不升反降。
                // 若归一化后 insert.b 是 nextMatch.a 的前缀，则允许合并。
                const normInsertB = normalizeForSimilarity(currentItem.b, normalizeOpts);
                const insertIsPrefixOfNextA = normInsertB.length > 0 && sentA.startsWith(normInsertB);

                if (newSimilarity > nextSim || insertIsPrefixOfNextA) {
                    const simToUse = newSimilarity > nextSim ? newSimilarity : Math.max(newSimilarity, nextSim);
                    if (insertIsPrefixOfNextA || simToUse > bestSimilarity) {
                        bestSimilarity = simToUse;
                        bestMatch = nextItem;
                        mergeDirection = 'next';
                    }
                }
            }

            // 如果找到可以合并的MATCH，进行合并
            if (bestMatch !== null && mergeDirection !== null) {
                if (mergeDirection === 'prev') {
                    // 合并到前一个MATCH，更新 result 中最后一个项（前一个MATCH）
                    if (result.length > 0 && result[result.length - 1].type === 'match') {
                        const last = result[result.length - 1];
                        last.b = last.b! + currentItem.b!;
                        last.similarity = bestSimilarity;
                        const insertBIndices = currentItem.b_indices || [];
                        if (insertBIndices.length > 0) {
                            if (!last.b_indices) {
                                last.b_indices = [];
                            }
                            last.b_indices.push(...insertBIndices);
                        } else if (currentItem.b_index !== undefined && currentItem.b_index !== null) {
                            if (!last.b_indices) {
                                last.b_indices = [];
                            }
                            last.b_indices.push(currentItem.b_index);
                        }
                        // 合并 b 侧行号
                        if (currentItem.b_line_numbers && currentItem.b_line_numbers.length > 0) {
                            if (!last.b_line_numbers) {
                                last.b_line_numbers = last.b_line_number !== undefined && last.b_line_number !== null
                                    ? [last.b_line_number] : [];
                            }
                            last.b_line_numbers.push(...currentItem.b_line_numbers);
                        } else if (currentItem.b_line_number !== undefined && currentItem.b_line_number !== null) {
                            if (!last.b_line_numbers) {
                                last.b_line_numbers = last.b_line_number !== undefined && last.b_line_number !== null
                                    ? [last.b_line_number] : [];
                            }
                            last.b_line_numbers.push(currentItem.b_line_number);
                        }
                    }
                    i++;
                    continue;
                } else {
                    // mergeDirection === 'next'：合并到后一个MATCH
                    nextItem.b = currentItem.b! + nextItem.b!;
                    nextItem.similarity = bestSimilarity;
                    const insertBIndices = currentItem.b_indices || [];
                    if (insertBIndices.length > 0) {
                        if (!nextItem.b_indices) {
                            nextItem.b_indices = [];
                        }
                        nextItem.b_indices = [...insertBIndices, ...(nextItem.b_indices || [])];
                    } else if (currentItem.b_index !== undefined && currentItem.b_index !== null) {
                        if (!nextItem.b_indices) {
                            nextItem.b_indices = [];
                        }
                        nextItem.b_indices = [currentItem.b_index, ...(nextItem.b_indices || [])];
                    }
                    // 合并 b 侧行号（prepend）
                    if (currentItem.b_line_numbers && currentItem.b_line_numbers.length > 0) {
                        if (!nextItem.b_line_numbers) {
                            nextItem.b_line_numbers = nextItem.b_line_number !== undefined && nextItem.b_line_number !== null
                                ? [nextItem.b_line_number] : [];
                        }
                        nextItem.b_line_numbers = [...currentItem.b_line_numbers, ...(nextItem.b_line_numbers || [])];
                    } else if (currentItem.b_line_number !== undefined && currentItem.b_line_number !== null) {
                        if (!nextItem.b_line_numbers) {
                            nextItem.b_line_numbers = nextItem.b_line_number !== undefined && nextItem.b_line_number !== null
                                ? [nextItem.b_line_number] : [];
                        }
                        nextItem.b_line_numbers = [currentItem.b_line_number, ...(nextItem.b_line_numbers || [])];
                    }
                    i++;
                    continue;
                }
            }
        }

        // 其他情况，直接添加
        result.push(currentItem);
        i++;
    }

    return result;
}

/**
 * 后处理：检测和处理句子移动，创建movein和moveout条目（基于b侧id连续性分组）
 * @param alignment 对齐结果
 * @param movementThreshold 保留参数以兼容旧代码，但不再使用
 * @returns 处理后的对齐结果，包含movein和moveout条目
 *
 * 算法：
 * 1. 只检查b侧id（b_index）的连续性
 * 2. 把所有连续条目构成的块区分出来
 * 3. 把条目最少的块移动到大块之间，看是否能拼接为更大的块
 * 4. 如此循环，直到无法再合并
 */
function detectAndHandleMovements(
    alignment: AlignmentItem[],
    movementThreshold: number = 2
): AlignmentItem[] {
    if (alignment.length === 0) {
        return alignment;
    }

    /**
     * 获取条目的b_index
     */
    function getBIndex(item: AlignmentItem): number | null {
        if (item.b_indices && item.b_indices.length === 1) {
            return item.b_indices[0];
        } else if (item.b_index !== undefined && item.b_index !== null) {
            return item.b_index;
        }
        return null;
    }

    /**
     * 获取条目的a_index
     */
    function getAIndex(item: AlignmentItem): number | null {
        if (item.a_indices && item.a_indices.length === 1) {
            return item.a_indices[0];
        } else if (item.a_index !== undefined && item.a_index !== null) {
            return item.a_index;
        }
        return null;
    }

    // 第一步：收集所有match项，只关注b侧id的连续性
    type MatchItemTuple = [AlignmentItem, number, number];  // (item, pos, b_idx)
    const matchItems: MatchItemTuple[] = [];
    for (let pos = 0; pos < alignment.length; pos++) {
        const item = alignment[pos];
        if (item.type === 'match') {
            const bIdx = getBIndex(item);
            if (bIdx !== null) {
                matchItems.push([item, pos, bIdx]);
            }
        }
    }

    if (matchItems.length < 2) {
        // 少于2个match项，无法判断移动
        return alignment;
    }

    // 第二步：根据b_index的连续性分组为块，并预先计算每个块的min/max b_index
    interface BlockMetadata {
        minB: number;      // min_b（第一个b_index）
        maxB: number;      // max_b（最后一个b_index）
        firstPos: number;  // first_pos
        lastPos: number;   // last_pos
    }

    function groupIntoBlocksWithMetadata(matchItems: MatchItemTuple[]): [MatchItemTuple[][], BlockMetadata[]] {
        if (matchItems.length === 0) {
            return [[], []];
        }

        // 按位置排序（只排序一次）
        const sortedItems = [...matchItems].sort((a, b) => a[1] - b[1]);  // 按pos排序

        const blocks: MatchItemTuple[][] = [];
        const blockMetadata: BlockMetadata[] = [];
        let currentBlock: MatchItemTuple[] = [sortedItems[0]];

        for (let i = 1; i < sortedItems.length; i++) {
            const [, prevPos, prevBIdx] = sortedItems[i - 1];
            const [, currPos, currBIdx] = sortedItems[i];

            // 检查b_index是否连续（差值=1）
            if (currBIdx === prevBIdx + 1) {
                // 连续，加入当前块
                currentBlock.push(sortedItems[i]);
            } else {
                // 不连续，保存当前块并开始新块
                if (currentBlock.length > 0) {
                    // 由于块内b_index连续，min就是第一个，max就是最后一个
                    const firstBIdx = currentBlock[0][2];
                    const lastBIdx = currentBlock[currentBlock.length - 1][2];
                    blocks.push(currentBlock);
                    blockMetadata.push({
                        minB: firstBIdx,  // min_b（第一个b_index）
                        maxB: lastBIdx,   // max_b（最后一个b_index）
                        firstPos: currentBlock[0][1],  // first_pos
                        lastPos: currentBlock[currentBlock.length - 1][1]  // last_pos
                    });
                }
                currentBlock = [sortedItems[i]];
            }
        }

        // 添加最后一个块
        if (currentBlock.length > 0) {
            // 由于块内b_index连续，min就是第一个，max就是最后一个
            const firstBIdx = currentBlock[0][2];
            const lastBIdx = currentBlock[currentBlock.length - 1][2];
            blocks.push(currentBlock);
            blockMetadata.push({
                minB: firstBIdx,  // min_b（第一个b_index）
                maxB: lastBIdx,   // max_b（最后一个b_index）
                firstPos: currentBlock[0][1],  // first_pos
                lastPos: currentBlock[currentBlock.length - 1][1]  // last_pos
            });
        }

        return [blocks, blockMetadata];
    }

    // 迭代优化：尝试移动小块来合并成更大的块，直到只剩下一个块
    interface MovementInfo {
        original: AlignmentItem;
        moveout: AlignmentItem;
        movein: AlignmentItem;
        insertInfo: {
            moveout_insert_at_a?: number;
            movein_insert_pos?: number;
        };
    }
    const movements: MovementInfo[] = [];
    const maxIterations = 100;  // 最多迭代100次，避免无限循环
    let currentMatchItems = matchItems;

    for (let iteration = 0; iteration < maxIterations; iteration++) {
        const [blocks, blockMetadata] = groupIntoBlocksWithMetadata(currentMatchItems);

        if (blocks.length <= 1) {
            // 只有一个块或没有块，所有条目已连贯
            break;
        }

        // 找出所有最小的块（条目数最少），可能有多个相同大小的最小块
        const minBlockSize = Math.min(...blocks.map(block => block.length));
        const smallestBlocks: Array<[number, MatchItemTuple[]]> = [];
        for (let idx = 0; idx < blocks.length; idx++) {
            if (blocks[idx].length === minBlockSize) {
                smallestBlocks.push([idx, blocks[idx]]);
            }
        }

        // 尝试处理每个最小块，找到一个可以合并的
        let merged = false;
        for (const [smallestBlockIdx, smallestBlock] of smallestBlocks) {
            // 使用预先计算的元数据
            const { minB: smallestMinB, maxB: smallestMaxB, firstPos: smallestFirstPos, lastPos: smallestLastPos } = blockMetadata[smallestBlockIdx];

            let bestInsertPos: number | null = null;
            let bestMergedSize = 0;  // 合并后形成的连续块大小

            // 首先检查是否可以插入到两个块之间（形成更大的连续块）
            // 优化：使用预先计算的元数据，避免重复计算min/max
            for (let prevBlockIdx = 0; prevBlockIdx < blockMetadata.length; prevBlockIdx++) {
                if (prevBlockIdx === smallestBlockIdx) {
                    continue;
                }

                const { minB: prevMinB, maxB: prevMaxB, firstPos: prevFirstPos, lastPos: prevLastPos } = blockMetadata[prevBlockIdx];

                // 检查prev_block是否可以接在smallest之前
                if (prevMaxB + 1 !== smallestMinB) {
                    continue;
                }

                // 查找可以接在smallest之后的块
                for (let nextBlockIdx = 0; nextBlockIdx < blockMetadata.length; nextBlockIdx++) {
                    if (nextBlockIdx === smallestBlockIdx || nextBlockIdx === prevBlockIdx) {
                        continue;
                    }

                    const { minB: nextMinB, maxB: nextMaxB, firstPos: nextFirstPos } = blockMetadata[nextBlockIdx];

                    // 检查是否可以插入到prev_block和next_block之间
                    if (smallestMaxB + 1 === nextMinB) {
                        // 可以插入到两个块之间，形成更大的连续块
                        const insertPos = nextFirstPos;
                        const mergedSize = blocks[prevBlockIdx].length + smallestBlock.length + blocks[nextBlockIdx].length;
                        if (mergedSize > bestMergedSize) {
                            bestInsertPos = insertPos;
                            bestMergedSize = mergedSize;
                        }
                    }
                }
            }

            // 如果没有找到可以插入到两个块之间的位置，检查是否可以与单个块合并
            if (bestInsertPos === null) {
                for (let targetBlockIdx = 0; targetBlockIdx < blockMetadata.length; targetBlockIdx++) {
                    if (targetBlockIdx === smallestBlockIdx) {
                        continue;
                    }

                    const { minB: targetMinB, maxB: targetMaxB, firstPos: targetFirstPos, lastPos: targetLastPos } = blockMetadata[targetBlockIdx];

                    // 检查是否可以合并（最小块的b_index范围与目标块的b_index范围相邻）
                    let mergedSize = 0;
                    let insertPos: number | null = null;

                    if (smallestMaxB + 1 === targetMinB) {
                        // 最小块在目标块之前，可以合并
                        insertPos = targetFirstPos;
                        mergedSize = smallestBlock.length + blocks[targetBlockIdx].length;
                    } else if (targetMaxB + 1 === smallestMinB) {
                        // 最小块在目标块之后，可以合并
                        insertPos = targetLastPos + 1;
                        mergedSize = smallestBlock.length + blocks[targetBlockIdx].length;
                    }

                    if (insertPos !== null && mergedSize > bestMergedSize) {
                        bestInsertPos = insertPos;
                        bestMergedSize = mergedSize;
                    }
                }
            }

            // 如果找到了最佳插入位置，创建movein/moveout
            if (bestInsertPos !== null) {
                for (const [item, pos, bIdx] of smallestBlock) {
                    const aIdx = getAIndex(item);
                    if (aIdx === null) {
                        continue;
                    }

                    let originalSimilarity = item.similarity;
                    if (originalSimilarity === undefined || originalSimilarity === null) {
                        originalSimilarity = 0.0;
                    } else {
                        originalSimilarity = Number(originalSimilarity);
                    }

                    // 创建moveout和movein
                    // 显式保留所有字段，并添加original_b_index和original_a_index
                    const moveoutItem: AlignmentItem = {
                        ...item,
                        type: 'moveout',
                        similarity: originalSimilarity,
                        a_index: aIdx,
                        b_index: bIdx,
                        original_b_index: bIdx,  // 保留原始b_index
                        // 显式保留所有字段：a_indices, b_indices, a_line_number, b_line_number,
                        // a_line_numbers, b_line_numbers, id, group_id, offset等（通过展开运算符保留）
                    };

                    const moveinItem: AlignmentItem = {
                        ...item,
                        type: 'movein',
                        similarity: originalSimilarity,
                        a_index: aIdx,
                        b_index: bIdx,
                        original_a_index: aIdx,  // 保留原始a_index
                        // 显式保留所有字段：a_indices, b_indices, a_line_number, b_line_number,
                        // a_line_numbers, b_line_numbers, id, group_id, offset等（通过展开运算符保留）
                    };

                    movements.push({
                        original: item,
                        moveout: moveoutItem,
                        movein: moveinItem,
                        insertInfo: {
                            moveout_insert_at_a: aIdx,  // moveout在原位置
                            movein_insert_pos: bestInsertPos,  // movein插入到目标位置
                        }
                    });
                }

                merged = true;
                // 从match_items中移除已处理的项，以便下次迭代时不再处理
                // 使用位置集合来快速查找和移除
                const smallestPositions = new Set(smallestBlock.map(([, pos]) => pos));
                currentMatchItems = currentMatchItems.filter(([, pos]) => !smallestPositions.has(pos));
                // 找到一个可以合并的块后，跳出循环，继续下一次迭代
                break;
            }
        }

        if (!merged) {
            // 无法再合并，退出循环
            break;
        }
    }

    // 如果没有检测到移动，直接返回原结果
    if (movements.length === 0) {
        return alignment;
    }

    // 第三步：构建新的结果列表
    // 创建移动项的映射（使用WeakMap存储原始项的引用，但TypeScript中无法使用id()，改用Map）
    const matchToMovements = new Map<AlignmentItem, [AlignmentItem, AlignmentItem, MovementInfo['insertInfo']]>();
    for (const movement of movements) {
        matchToMovements.set(movement.original, [movement.moveout, movement.movein, movement.insertInfo]);
    }

    // 第一遍：处理A的顺序（替换match项，并插入需要额外插入的moveout）
    // 收集需要额外插入的moveout项（基于位置）
    const moveoutInsertions: { [key: number]: AlignmentItem[] } = {};
    for (const movement of movements) {
        if ('moveout_insert_pos' in movement.insertInfo) {
            // 需要额外插入的moveout（基于位置）
            const pos = (movement.insertInfo as any).moveout_insert_pos;
            if (!(pos in moveoutInsertions)) {
                moveoutInsertions[pos] = [];
            }
            moveoutInsertions[pos].push(movement.moveout);
        }
    }

    const resultAOrder: AlignmentItem[] = [];
    for (let pos = 0; pos < alignment.length; pos++) {
        const item = alignment[pos];
        // 先插入需要在此位置插入的moveout项
        if (pos in moveoutInsertions) {
            resultAOrder.push(...moveoutInsertions[pos]);
        }

        // 然后处理当前项
        const movementsForItem = matchToMovements.get(item);
        if (movementsForItem) {
            // 这是移动的match项，根据情况替换为moveout或movein
            const [moveout, movein, insertInfo] = movementsForItem;
            // 判断应该替换为什么：
            // - 如果moveout_insert_pos存在，说明moveout需要插入到后面，当前位置应该替换为movein（a异常、b正常的情况）
            // - 如果movein_insert_pos存在，说明movein需要插入到后面，当前位置应该替换为moveout（a正常、b异常的情况）
            // - 如果都不存在，说明是双侧异常的情况，需要根据具体情况处理
            if ('moveout_insert_pos' in insertInfo) {
                // a异常、b正常：当前位置替换为movein
                resultAOrder.push(movein);
            } else if ('movein_insert_pos' in insertInfo) {
                // a正常、b异常：当前位置替换为moveout
                resultAOrder.push(moveout);
            } else {
                // 双侧异常的情况，默认替换为moveout（这种情况应该很少）
                resultAOrder.push(moveout);
            }
        } else {
            resultAOrder.push(item);
        }
    }

    // 处理末尾插入的moveout
    if (alignment.length in moveoutInsertions) {
        resultAOrder.push(...moveoutInsertions[alignment.length]);
    }

    // 第二遍：处理B的顺序（插入movein项）
    // 收集所有需要额外插入的movein项（已经在当前位置的movein不需要再插入）
    type MoveinItemTuple = [number, AlignmentItem, boolean];  // (insert_pos或b_index, movein, is_position_based)
    const moveinItems: MoveinItemTuple[] = [];
    for (const movement of movements) {
        if ('movein_insert_pos' in movement.insertInfo) {
            // 基于位置的插入（a正常、b异常的情况，movein需要插入到后面）
            moveinItems.push([movement.insertInfo.movein_insert_pos!, movement.movein, true]);
        } else if ('movein_insert_at_b' in movement.insertInfo) {
            // 基于b_index的插入（这种情况应该很少，因为movein_insert_at_b通常意味着movein已经在当前位置）
            // 但为了兼容性，仍然处理
            moveinItems.push([(movement.insertInfo as any).movein_insert_at_b, movement.movein, false]);
        }
        // 如果只有moveout_insert_pos，说明movein已经在当前位置替换了，不需要再插入
    }

    // 按插入位置或b_index排序
    moveinItems.sort((a, b) => a[0] - b[0]);

    // 创建b_index到结果位置的映射
    const bIdxToPos: { [key: number]: number } = {};
    for (let pos = 0; pos < resultAOrder.length; pos++) {
        const item = resultAOrder[pos];
        if (item.b_indices) {
            for (const bIdx of item.b_indices) {
                bIdxToPos[bIdx] = pos;
            }
        } else if (item.b_index !== undefined && item.b_index !== null) {
            bIdxToPos[item.b_index] = pos;
        }
    }

    // 预先计算所有movein项应该插入的位置
    const insertions: { [key: number]: AlignmentItem[] } = {};

    for (const [insertKey, movein, isPositionBased] of moveinItems) {
        let insertPos: number;
        if (isPositionBased) {
            // 基于位置的插入（直接使用位置）
            insertPos = insertKey;
        } else {
            // 基于b_index的插入（需要查找位置）
            const bIdx = insertKey;
            insertPos = resultAOrder.length;  // 默认插入到末尾

            if (bIdx > 0) {
                let prevBIdx = bIdx - 1;
                if (prevBIdx in bIdxToPos) {
                    insertPos = bIdxToPos[prevBIdx] + 1;
                } else {
                    // 前一句也是新增的，继续往前找（最多查找10次，避免无限循环）
                    for (let pIdx = prevBIdx; pIdx >= Math.max(-1, prevBIdx - 10); pIdx--) {
                        if (pIdx in bIdxToPos) {
                            insertPos = bIdxToPos[pIdx] + 1;
                            break;
                        }
                    }
                }
            }
        }

        // 将movein项添加到对应位置的列表中
        if (!(insertPos in insertions)) {
            insertions[insertPos] = [];
        }
        insertions[insertPos].push(movein);
    }

    // 一次性构建结果，避免频繁insert
    const result: AlignmentItem[] = [];
    for (let pos = 0; pos <= resultAOrder.length; pos++) {  // +1 用于处理末尾插入
        // 先添加当前位置的movein项（如果有）
        if (pos in insertions) {
            result.push(...insertions[pos]);
        }

        // 然后添加原始项（如果不是末尾）
        if (pos < resultAOrder.length) {
            result.push(resultAOrder[pos]);
        }
    }

    return result;
}

/**
 * 获取对齐统计信息
 * @param alignment 对齐结果列表
 * @returns 统计信息
 */
export function getAlignmentStatistics(alignment: AlignmentItem[]): AlignmentStatistics {
    const stats: AlignmentStatistics = {
        total: alignment.length,
        match: 0,
        delete: 0,
        insert: 0,
        movein: 0,
        moveout: 0
    };

    for (const item of alignment) {
        switch (item.type) {
            case 'match':
                stats.match++;
                break;
            case 'delete':
                stats.delete++;
                break;
            case 'insert':
                stats.insert++;
                break;
            case 'movein':
                stats.movein++;
                break;
            case 'moveout':
                stats.moveout++;
                break;
        }
    }

    return stats;
}
