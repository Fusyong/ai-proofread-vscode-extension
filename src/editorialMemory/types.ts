/** 磁盘 path 块（可选 doc、关注分、正文） */
export interface EditorialPathBlock {
    docRel?: string;
    path: string;
    attentionScore: number;
    /** ### path 起至下一 ### path 或 ## 前（可含 ### doc、attention、bullets） */
    fullRaw: string;
}

export interface ParsedEditorialMemory {
    preamble: string;
    globalBody: string;
    structureBlocks: EditorialPathBlock[];
    recentSectionBody: string;
    pendingBlocks: EditorialPathBlock[];
}
