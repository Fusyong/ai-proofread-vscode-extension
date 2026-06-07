import type { DictPrepLookupPoint } from '../localDict/dictPrepPrompt';

export type ReferenceSourceId = 'dict' | 'grep_md' | 'bm25' | 'vector' | 'citation' | 'web';

export type ReferencePrepStrength = 'light' | 'standard' | 'thorough';

export type ReferencePrepIntent =
    | 'entity_name'
    | 'term_norm'
    | 'citation'
    | 'general_fact'
    | 'word_usage';

export type RetrievalUnit =
    | 'line_context'
    | 'sentence'
    | 'md_paragraph'
    | 'heading_section'
    | 'file_outline';

export type CorpusHitKind = 'evidence' | 'navigation_hint';

export type CorpusHitSource = 'dict' | 'grep_md' | 'bm25' | 'vector';

export interface ReferencePrepDictQuery {
    dictId: string | null;
    candidates: string[];
    why?: string;
}

export interface ReferencePrepGrepQuery {
    patterns: string[];
    contextLines?: number;
    unit?: RetrievalUnit;
    scopePaths?: string[];
    searchPhrases?: string[];
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

export interface SuggestedScope {
    file: string;
    headingPath?: string;
}

export interface CorpusHit {
    hitId: string;
    source: CorpusHitSource;
    queryId: string;
    baseValue: number;
    aggregatedValue: number;
    snippet: string;
    digest: string;
    referenceBlock: string;
    status: 'active' | 'pruned';
    /** v0.2 */
    refTag?: string;
    kind?: CorpusHitKind;
    unit?: RetrievalUnit;
    relPath?: string;
    file?: string;
    line?: number;
    startLine?: number;
    endLine?: number;
    startOffset?: number;
    endOffset?: number;
    headingPath?: string;
    paragraphIndex?: number;
    matchedKey?: string;
    dictId?: string;
    grepPatterns?: string[];
    rgCommand?: string;
    bm25Score?: number;
    vectorScore?: number;
    llmPriority?: number;
    finalScore?: number;
    rerankScore?: number;
    fileMtimeMs?: number;
    pruneReason?: string;
    rerankReason?: string;
    roundId?: string;
    suggestedScope?: SuggestedScope;
    channelScores?: Partial<Record<CorpusHitSource, number>>;
}

export interface ReferencePrepRound {
    roundId: string;
    startedAt: string;
    finishedAt?: string;
    plan: ReferencePrepPlan;
    queryCount: number;
}

export interface ReferencePrepJsonPlanItem {
    index: number;
    plannedPoints: DictPrepLookupPoint[];
    plannedQueries?: ReferencePrepPlanQuery[];
}

export interface ResourceScope {
    dictIds: string[];
    filePaths: string[];
    excludePaths: string[];
    headingPathsByFile: Record<string, string[]>;
    llmFiltered: boolean;
    filterReason?: string;
    widened?: boolean;
    widenReason?: string;
}

export interface IndexVersions {
    citationDb?: string;
    vectorIndex?: string;
    catalogSnapshotId?: string;
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

export interface ReferencePrepProcessFileV020 extends Omit<ReferencePrepProcessFileV010, 'version'> {
    version: '0.2.0';
    userInput?: string;
    resourceScope?: ResourceScope;
    catalogSnapshotId?: string;
    indexVersions?: IndexVersions;
}

export type ReferencePrepProcessFile = ReferencePrepProcessFileV010 | ReferencePrepProcessFileV020;

/** 将 v0.1 corpus hit 规范为 v0.2 字段默认值 */
export function normalizeCorpusHit(h: CorpusHit): CorpusHit {
    return {
        ...h,
        kind: h.kind ?? 'evidence',
        unit: h.unit ?? 'line_context',
        relPath: h.relPath ?? h.file,
        startLine: h.startLine ?? h.line,
        endLine: h.endLine ?? h.line,
        llmPriority: h.llmPriority ?? h.baseValue,
        finalScore: h.finalScore ?? h.aggregatedValue,
        aggregatedValue: h.finalScore ?? h.aggregatedValue,
    };
}

export function upgradeProcessToV020(proc: ReferencePrepProcessFile): ReferencePrepProcessFileV020 {
    if (proc.version === '0.2.0') {
        return {
            ...proc,
            corpus: proc.corpus.map(normalizeCorpusHit),
        };
    }
    return {
        ...proc,
        version: '0.2.0',
        corpus: proc.corpus.map(normalizeCorpusHit),
    };
}

export function isRetrievalSourceEnabled(
    enabled: ReferenceSourceId[],
    source: CorpusHitSource
): boolean {
    if (source === 'grep_md') return enabled.includes('grep_md');
    if (source === 'bm25') return enabled.includes('bm25');
    if (source === 'vector') return enabled.includes('vector');
    if (source === 'dict') return enabled.includes('dict');
    return false;
}
