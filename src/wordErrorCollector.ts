/**
 * 常用词语错误收集模块
 * 基于勘误表对齐结果，在句子对齐基础上切分小句、对齐小句、提取 1:1 词级替换。
 * 输出格式：错误词语=正确词语#错误词语所在小句
 */

import * as Diff from 'diff';
import type { JiebaWasmModule } from './jiebaLoader';
import type { AlignmentItem } from './sentenceAligner';
import { splitClauses } from './splitter';
import { jaccardSimilarity, normalizeForSimilarity } from './similarity';

/** 小句对齐结果：原文小句与校对后小句的对应 */
export interface ClausePair {
    clauseA: string;
    clauseB: string;
}

/** 词语替换记录 */
export interface WordReplacement {
    wrong: string;
    correct: string;
    clause: string;
}

/** 收集选项 */
export interface WordErrorCollectorOptions {
    /** 小句分隔符，默认 ['，', '；'] */
    delimiters?: string[];
    /** 小句对齐相似度阈值，默认 0.4 */
    clauseSimilarityThreshold?: number;
    /** 是否使用 jieba 词级相似度做小句对齐，默认 true */
    useWordSimilarity?: boolean;
    /** jieba 模块（词级对齐和分词 diff 必需） */
    jieba: JiebaWasmModule;
    /** jieba 分词模式：default 或 search */
    cutMode?: 'default' | 'search';
}

/** 判断小句是否有效（非空且非仅空白/标点） */
function isMeaningfulClause(clause: string): boolean {
    const trimmed = clause.trim();
    if (!trimmed) return false;
    // 去掉空白和标点后检查是否还有内容
    const content = trimmed.replace(/\s/g, '').replace(/\p{P}/gu, '');
    return content.length > 0;
}

/**
 * 对齐两个小句列表
 * 使用贪心匹配：按顺序为每个 clauseA 找最相似的 clauseB，相似度需超过阈值
 */
export function alignClauses(
    clausesA: string[],
    clausesB: string[],
    options: WordErrorCollectorOptions
): ClausePair[] {
    const threshold = options.clauseSimilarityThreshold ?? 0.4;
    const jieba = options.jieba;
    const useWord = options.useWordSimilarity !== false;
    const cutMode = options.cutMode ?? 'default';

    const simOpts = useWord && jieba
        ? { n: 1, granularity: 'word' as const, jieba, cutMode }
        : { n: 2, granularity: 'char' as const };

    const pairs: ClausePair[] = [];
    const bUsed = new Set<number>();

    for (const clauseA of clausesA) {
        if (!isMeaningfulClause(clauseA)) continue;

        const normA = normalizeForSimilarity(clauseA, { removeInnerWhitespace: true });
        let bestIdx = -1;
        let bestSim = threshold;

        for (let j = 0; j < clausesB.length; j++) {
            if (bUsed.has(j)) continue;
            const clauseB = clausesB[j];
            if (!isMeaningfulClause(clauseB)) continue;

            const normB = normalizeForSimilarity(clauseB, { removeInnerWhitespace: true });
            const sim = jaccardSimilarity(normA, normB, simOpts);
            if (sim > bestSim) {
                bestSim = sim;
                bestIdx = j;
            }
        }

        if (bestIdx >= 0) {
            bUsed.add(bestIdx);
            pairs.push({ clauseA, clauseB: clausesB[bestIdx] });
        }
    }

    return pairs;
}

/**
 * 从一对小句中提取 1:1 词级替换
 * 使用 jieba 分词后用 diffArrays 做 token 级 diff（diffWords 对中文会按字符切分，导致「五伯」被拆成「伯」）
 */
export function extractWordReplacements(
    clauseA: string,
    clauseB: string,
    jieba: JiebaWasmModule,
    cutMode: 'default' | 'search' = 'default'
): WordReplacement | null {
    const cut = cutMode === 'search' && typeof jieba.cut_for_search === 'function'
        ? (t: string) => jieba.cut_for_search(t, true)
        : (t: string) => jieba.cut(t, true);

    const tokensA = cut(clauseA).filter(w => !/^\s*$/.test(w));
    const tokensB = cut(clauseB).filter(w => !/^\s*$/.test(w));

    if (tokensA.length === 0 || tokensB.length === 0) return null;

    const changes = Diff.diffArrays(tokensA, tokensB);

    const removedTokens: string[] = [];
    const addedTokens: string[] = [];

    for (const part of changes) {
        const arr = part.value as string[];
        if (!Array.isArray(arr) || arr.length === 0) continue;
        if (part.removed) removedTokens.push(...arr);
        if (part.added) addedTokens.push(...arr);
    }

    if (removedTokens.length !== 1 || addedTokens.length !== 1) return null;

    const wrong = removedTokens[0].trim();
    const correct = addedTokens[0].trim();
    if (!wrong || !correct) return null;

    return { wrong, correct, clause: clauseA.trim() };
}

/**
 * 从对齐结果中收集常用词语错误
 * 仅处理 type='match' 的项，去重合并后返回
 */
export function collectWordErrors(
    alignment: AlignmentItem[],
    options: WordErrorCollectorOptions
): WordReplacement[] {
    const { jieba, cutMode = 'default', delimiters } = options;

    const keyToClauses = new Map<string, { wrong: string; correct: string; clauses: Set<string> }>();

    for (const item of alignment) {
        if (item.type !== 'match' || !item.a || !item.b) continue;

        const clausesA = splitClauses(item.a, delimiters);
        const clausesB = splitClauses(item.b, delimiters);

        if (clausesA.length === 0 || clausesB.length === 0) continue;

        const pairs = alignClauses(clausesA, clausesB, options);

        for (const { clauseA, clauseB } of pairs) {
            const rep = extractWordReplacements(clauseA, clauseB, jieba, cutMode);
            if (!rep) continue;

            const key = `${rep.wrong}\0${rep.correct}`;
            let entry = keyToClauses.get(key);
            if (!entry) {
                entry = { wrong: rep.wrong, correct: rep.correct, clauses: new Set() };
                keyToClauses.set(key, entry);
            }
            entry.clauses.add(rep.clause);
        }
    }

    const result: WordReplacement[] = [];
    for (const entry of keyToClauses.values()) {
        const { wrong, correct, clauses } = entry;
        for (const clause of clauses) {
            result.push({ wrong, correct, clause });
        }
    }

    return result;
}

/**
 * 转义 CSV 字段（含逗号、引号、换行时用双引号包裹，内部引号加倍）
 */
function escapeCsvField(field: string): string {
    if (/[,"\n\r]/.test(field)) {
        return '"' + field.replace(/"/g, '""') + '"';
    }
    return field;
}

/**
 * 将收集结果格式化为 CSV
 * 格式：错误词语,正确词语,错误词语所在小句,错词长度,正词长度（含表头，便于筛选）
 */
export function formatWordErrors(entries: WordReplacement[]): string {
    const header = '错误词语,正确词语,错误词语所在小句,错词长度,正词长度';
    const rows = entries.map(e =>
        [
            escapeCsvField(e.wrong),
            escapeCsvField(e.correct),
            escapeCsvField(e.clause),
            String(e.wrong.length),
            String(e.correct.length)
        ].join(',')
    );
    return [header, ...rows].join('\n');
}

/**
 * 从配置字符串解析小句分隔符
 * 如 "，；" 解析为 ['，', '；']
 */
export function parseDelimitersFromConfig(configStr: string): string[] {
    if (!configStr || !configStr.trim()) {
        return ['，', '；', '。', '？', '！'];
    }
    return Array.from(configStr.trim());
}
