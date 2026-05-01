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

export interface MergeRoundPayload {
    document_id: string;
    heading_path: string;
    selection_range: string;
    original_selected: string;
    final_selected: string;
    item_level_changes?: Array<{ original: string; corrected: string }>;
    user_edited_away_from_model: boolean;
}

export interface MergeLlmResult {
    global_md: string;
    sections: Array<{ path: string; body_md: string }>;
    classification_notes?: string;
    recent_append?: string;
}
