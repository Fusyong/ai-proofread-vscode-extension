/**
 * 文档内重复句核查 — 类型定义（与引文核验共用归一化与相似度配置）
 */

/** 单次出现位置；startOffset/endOffset 为 TextDocument 原始缓冲区中的绝对字符偏移（UTF-16 码元） */
export interface DuplicateOccurrence {
    /** 在分句列表中的下标 */
    sentenceIndex: number;
    /** 句原文（trim） */
    text: string;
    startLine: number;
    endLine: number;
    startOffset: number;
    endOffset: number;
}

/** 归一化后完全一致的一组 */
export interface DuplicateExactGroup {
    kind: 'exact';
    /** 归一化键的预览（截断） */
    preview: string;
    occurrences: DuplicateOccurrence[];
}

/** 近似重复（Jaccard 达阈值，且与 exact 组不重复） */
export interface DuplicateFuzzyGroup {
    kind: 'fuzzy';
    score: number;
    occurrences: DuplicateOccurrence[];
}

export interface DuplicateScanResult {
    exactGroups: DuplicateExactGroup[];
    fuzzyGroups: DuplicateFuzzyGroup[];
}

export type DuplicateScanMode = 'exact' | 'fuzzy' | 'both';
