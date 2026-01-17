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
}

/**
 * 对齐参数配置
 */
export interface AlignmentOptions {
    windowSize?: number;                    // 搜索窗口大小（锚点左右各N个句子），默认10
    similarityThreshold?: number;            // 相似度阈值（0-1），默认0.6
    ngramSize?: number;                     // N-gram大小，默认2
    offset?: number;                        // 锚点偏移量，默认1
    maxWindowExpansion?: number;            // 最大窗口扩展倍数，默认3
    consecutiveFailThreshold?: number;      // 连续失败阈值，默认3
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

/**
 * 获取文本的n-gram集合（用于Jaccard相似度计算）
 * @param text 输入文本
 * @param n n-gram的大小，默认2（bigram）
 * @returns n-gram集合
 */
function getNgrams(text: string, n: number): Set<string> {
    if (text.length < n) {
        return new Set([text]);
    }

    const ngrams = new Set<string>();
    for (let i = 0; i <= text.length - n; i++) {
        ngrams.add(text.substring(i, i + n));
    }
    return ngrams;
}

/**
 * 计算两个文本的Jaccard相似度（基于n-gram）
 * @param textA 文本A
 * @param textB 文本B
 * @param n n-gram大小
 * @returns 相似度值，范围0-1
 */
function jaccardSimilarity(textA: string, textB: string, n: number = 2): number {
    if (!textA || !textB) {
        return 0.0;
    }

    if (textA === textB) {
        return 1.0;
    }

    const ngramsA = getNgrams(textA, n);
    const ngramsB = getNgrams(textB, n);

    // 计算交集
    let intersection = 0;
    for (const ngram of ngramsA) {
        if (ngramsB.has(ngram)) {
            intersection++;
        }
    }

    // 计算并集
    const union = ngramsA.size + ngramsB.size - intersection;

    if (union === 0) {
        return 0.0;
    }

    return intersection / union;
}

/**
 * 标准化句子（用于相似度计算）
 * @param sentence 原始句子
 * @returns 标准化后的句子
 */
function normalizeSentence(sentence: string): string {
    // 去除首尾空白
    let s = sentence.trim();
    // 统一全角空格为半角空格
    s = s.replace(/\u3000/g, ' ');
    // 合并多个连续空格为一个
    s = s.replace(/ +/g, ' ');
    return s;
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
        ngramSize = 2,
        offset = 1,
        maxWindowExpansion = 3,
        consecutiveFailThreshold = 3
    } = options;

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
        const sentA = normalizeSentence(sentencesA[aIdx]);

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

            const sentB = normalizeSentence(sentencesB[bIdx]);
            const similarity = jaccardSimilarity(sentA, sentB, ngramSize);

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

                const sentB = normalizeSentence(sentencesB[bIdx]);
                const similarity = jaccardSimilarity(sentA, sentB, ngramSize);

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
        ngramSize
    );

    // 后处理：在一定的序号上下范围内处理不相邻的DELETE和INSERT
    const resultAfterNonAdjacentRematch = rematchNonAdjacentDeleteInsert(
        resultAfterRematch,
        similarityThreshold,
        ngramSize,
        windowSize  // 使用窗口大小作为索引范围
    );

    // 后处理：将单独的DELETE项合并到相邻的MATCH组中
    const resultAfterMerge = mergeDeleteIntoMatch(
        resultAfterNonAdjacentRematch,
        ngramSize
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
 * @param ngramSize n-gram大小
 * @returns 优化后的对齐结果
 */
function rematchDeleteInsertSequences(
    alignment: AlignmentItem[],
    similarityThreshold: number = 0.6,
    ngramSize: number = 2
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
                            const sentA = normalizeSentence(dCandidate.text);
                            const sentB = normalizeSentence(insCandidate.text);
                            const similarity = jaccardSimilarity(sentA, sentB, ngramSize);

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
 * @param ngramSize n-gram大小
 * @param indexRange 序号范围，用于判断DELETE和INSERT是否在合理范围内（默认10）
 * @returns 优化后的对齐结果
 */
function rematchNonAdjacentDeleteInsert(
    alignment: AlignmentItem[],
    similarityThreshold: number = 0.6,
    ngramSize: number = 2,
    indexRange: number = 10
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
                    const sentA = normalizeSentence(dItem.a);
                    const sentB = normalizeSentence(insItem.b);
                    const similarity = jaccardSimilarity(sentA, sentB, ngramSize);

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
 * @param ngramSize n-gram大小
 * @returns 优化后的对齐结果
 */
function mergeDeleteIntoMatch(
    alignment: AlignmentItem[],
    ngramSize: number = 2
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
                const sentA = normalizeSentence(mergedA);
                const sentB = normalizeSentence(prevB);
                const newSimilarity = jaccardSimilarity(sentA, sentB, ngramSize);

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
                const sentA = normalizeSentence(mergedA);
                const sentB = normalizeSentence(nextItem.b);
                const newSimilarity = jaccardSimilarity(sentA, sentB, ngramSize);

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
 * 后处理：检测和处理句子移动，创建movein和moveout条目
 * @param alignment 对齐结果
 * @param movementThreshold 移动阈值，a_index和b_index差值超过此值认为是移动（默认2）
 * @returns 处理后的对齐结果，包含movein和moveout条目
 */
function detectAndHandleMovements(
    alignment: AlignmentItem[],
    movementThreshold: number = 2
): AlignmentItem[] {
    if (alignment.length === 0) {
        return alignment;
    }

    interface MatchItemInfo {
        item: AlignmentItem;
        aIdx: number;
        bIdx: number;
        pos: number;
    }

    // 第一步：收集所有match项的索引信息，用于上下文判断
    const matchItems: MatchItemInfo[] = [];
    for (let pos = 0; pos < alignment.length; pos++) {
        const item = alignment[pos];
        if (item.type === 'match') {
            // 获取a_index和b_index
            let aIdx: number | null = null;
            let bIdx: number | null = null;

            if (item.a_indices && item.a_indices.length === 1) {
                aIdx = item.a_indices[0];
            } else if (item.a_index !== undefined && item.a_index !== null) {
                aIdx = item.a_index;
            }

            if (item.b_indices && item.b_indices.length === 1) {
                bIdx = item.b_indices[0];
            } else if (item.b_index !== undefined && item.b_index !== null) {
                bIdx = item.b_index;
            }

            if (aIdx !== null && bIdx !== null) {
                matchItems.push({ item, aIdx, bIdx, pos });
            }
        }
    }

    // 第二步：检测移动的match项（考虑相邻关系）
    interface Movement {
        original: AlignmentItem;
        moveout: AlignmentItem;
        movein: AlignmentItem;
    }
    const movements: Movement[] = [];

    for (let idx = 0; idx < matchItems.length; idx++) {
        const { item, aIdx, bIdx, pos } = matchItems[idx];
        const movementDistance = Math.abs(bIdx - aIdx);

        // 基本条件：索引差值必须超过阈值
        if (movementDistance <= movementThreshold) {
            continue;
        }

        // 关键修复：检查相邻的match项，避免将相邻条目误判为移动
        let isRealMovement = true;

        // 检查前一个match项
        if (idx > 0) {
            const prev = matchItems[idx - 1];
            // 检查在结果列表中的位置是否相邻或接近（中间最多间隔2个非match项）
            if (pos - prev.pos <= 3) {
                // 检查a_index和b_index是否连续或接近连续
                const aIdxDiff = Math.abs(aIdx - prev.aIdx);
                const bIdxDiff = Math.abs(bIdx - prev.bIdx);
                // 如果a_index和b_index的差值都较小（<=2），说明是连续的，不应该判断为移动
                if (aIdxDiff <= 2 && bIdxDiff <= 2) {
                    isRealMovement = false;
                }
            }
        }

        // 检查后一个match项（如果前一个检查已经判断不是移动，则跳过）
        if (isRealMovement && idx < matchItems.length - 1) {
            const next = matchItems[idx + 1];
            // 检查在结果列表中的位置是否相邻或接近
            if (next.pos - pos <= 3) {
                // 检查a_index和b_index是否连续或接近连续
                const aIdxDiff = Math.abs(next.aIdx - aIdx);
                const bIdxDiff = Math.abs(next.bIdx - bIdx);
                // 如果a_index和b_index的差值都较小（<=2），说明是连续的，不应该判断为移动
                if (aIdxDiff <= 2 && bIdxDiff <= 2) {
                    isRealMovement = false;
                }
            }
        }

        // 只有当确实是真正的移动时才创建movein和moveout条目
        if (isRealMovement) {
            // 检测到移动，创建movein和moveout条目
            // 获取原始相似度值，确保正确传递
            let originalSimilarity = item.similarity;
            if (originalSimilarity === undefined || originalSimilarity === null) {
                originalSimilarity = 0.0;
            } else {
                originalSimilarity = Number(originalSimilarity);
            }

            // moveout：在原位置（a_idx），显示原文和校对后（表示从这里移出）
            const moveoutItem: AlignmentItem = {
                type: 'moveout',
                a: item.a,
                b: item.b,  // 保留对侧句子
                similarity: originalSimilarity,
                a_index: aIdx,
                b_index: bIdx,  // 保留b_index用于显示
            };

            // movein：在新位置（b_idx），显示原文和校对后（表示移入到这里）
            const moveinItem: AlignmentItem = {
                type: 'movein',
                a: item.a,  // 保留对侧句子
                b: item.b,
                similarity: originalSimilarity,
                a_index: aIdx,  // 保留a_index用于显示
                b_index: bIdx,
            };

            movements.push({
                original: item,
                moveout: moveoutItem,
                movein: moveinItem
            });
        }
    }

    // 如果没有检测到移动，直接返回原结果
    if (movements.length === 0) {
        return alignment;
    }

    // 第二步：构建新的结果列表
    // 对于移动的match项，替换为movein和moveout
    // movein保持A的顺序（在原位置），moveout保持B的顺序（在新位置）

    // 创建移动项的映射（使用Map存储原始项的引用）
    const matchToMovements = new Map<AlignmentItem, [AlignmentItem, AlignmentItem]>();
    for (const movement of movements) {
        matchToMovements.set(movement.original, [movement.moveout, movement.movein]);
    }

    // 第一遍：处理A的顺序（创建moveout项，在原位置）
    const resultAOrder: AlignmentItem[] = [];
    for (const item of alignment) {
        const movementsForItem = matchToMovements.get(item);
        if (movementsForItem) {
            // 这是移动的match项，替换为moveout（在原位置）
            const [moveout] = movementsForItem;
            resultAOrder.push(moveout);
        } else {
            resultAOrder.push(item);
        }
    }

    // 第二遍：处理B的顺序（插入movein项）
    // 需要找到每个movein应该插入的位置（按b_index排序）
    const moveinItems: Array<[number, AlignmentItem]> = [];
    for (const movement of movements) {
        const bIdx = movement.movein.b_index!;
        moveinItems.push([bIdx, movement.movein]);
    }

    // 按b_index排序movein项
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

    // 优化：预先计算所有movein项应该插入的位置
    // 使用字典存储：位置 -> [movein项列表]
    const insertions: { [key: number]: AlignmentItem[] } = {};

    for (const [bIdx, movein] of moveinItems) {
        // 找到movein应该插入的位置
        let insertPos = resultAOrder.length;  // 默认插入到末尾

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

        // 将movein项添加到对应位置的列表中
        if (!(insertPos in insertions)) {
            insertions[insertPos] = [];
        }
        insertions[insertPos].push(movein);
    }

    // 优化：一次性构建结果，避免频繁insert
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
