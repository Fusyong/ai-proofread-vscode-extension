import type { DictPrepLookupPoint } from '../localDict/dictPrepPrompt';

export type ReferenceSourceId = 'dict' | 'grep_md' | 'citation' | 'web';

export type ReferencePrepStrength = 'light' | 'standard' | 'thorough';

export type ReferencePrepIntent =
    | 'entity_name'
    | 'term_norm'
    | 'citation'
    | 'general_fact'
    | 'word_usage';

export interface ReferencePrepDictQuery {
    dictId: string | null;
    candidates: string[];
    why?: string;
}

export interface ReferencePrepGrepQuery {
    patterns: string[];
    contextLines?: number;
}

export interface ReferencePrepPlanQuery {
    queryId: string;
    intent: ReferencePrepIntent;
    priority: number;
    dict?: ReferencePrepDictQuery;
    grep?: ReferencePrepGrepQuery;
}

export interface ReferencePrepPlan {
    sufficient: boolean;
    queries: ReferencePrepPlanQuery[];
    prune: Array<{ hitId: string; reason?: string }>;
}

export interface CorpusHit {
    hitId: string;
    source: 'dict' | 'grep_md';
    queryId: string;
    baseValue: number;
    aggregatedValue: number;
    file?: string;
    line?: number;
    snippet: string;
    digest: string;
    referenceBlock: string;
    status: 'active' | 'pruned';
}

export interface ReferencePrepRound {
    roundId: string;
    startedAt: string;
    finishedAt?: string;
    plan: ReferencePrepPlan;
    queryCount: number;
}

/** JSON 批量：单条规划（兼容 dictPrep 查词点） */
export interface ReferencePrepJsonPlanItem {
    index: number;
    plannedPoints: DictPrepLookupPoint[];
    /** 多轮 referencePrep 的 queries（新格式） */
    plannedQueries?: ReferencePrepPlanQuery[];
}

export interface ReferencePrepProcessFileV010 {
    version: '0.1.0';
    sourceJsonPath?: string;
    targetPreview?: string;
    enabledSources: ReferenceSourceId[];
    strength: ReferencePrepStrength;
    dicts?: Array<{ id: string; name: string; mdxPath: string }>;
    rounds: ReferencePrepRound[];
    corpus: CorpusHit[];
    mergedReference?: string;
    plan?: {
        items?: ReferencePrepJsonPlanItem[];
    };
}
