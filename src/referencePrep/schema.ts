import type { DictPrepLookupPoint } from '../localDict/dictPrepPrompt';

export type ReferenceSourceId = 'dict' | 'grep_md' | 'bm25' | 'vector' | 'citation' | 'web' | 'wikipedia';

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

export type CorpusHitSource = 'dict' | 'grep_md' | 'bm25' | 'vector' | 'wikipedia' | 'web';

export type WikipediaLang = 'zh' | 'en';

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

export interface ReferencePrepWikipediaQuery {
    searchTerms?: string[];
    titles?: string[];
    lang?: WikipediaLang;
    includeWikidata?: boolean;
    why?: string;
}

export interface ReferencePrepWebQuery {
    searchTerms?: string[];
    why?: string;
}

export interface ReferencePrepPlanQuery {
    queryId: string;
    intent: ReferencePrepIntent;
    priority: number;
    dict?: ReferencePrepDictQuery;
    grep?: ReferencePrepGrepQuery;
    wikipedia?: ReferencePrepWikipediaQuery;
    web?: ReferencePrepWebQuery;
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
    /** wikipedia */
    pageTitle?: string;
    pageUrl?: string;
    wikiLang?: WikipediaLang;
    wikidataId?: string;
    wikidataClaims?: string;
}

export interface ReferencePrepRound {
    roundId: string;
    startedAt: string;
    finishedAt?: string;
    plan: ReferencePrepPlan;
    queryCount: number;
    /** 本轮 Wikipedia API 网络请求次数（不含缓存命中） */
    wikiRequestsUsed?: number;
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
    /** 选区记录 id（v0.3 文档内多记录；读写层总会补齐） */
    id?: string;
    userInput?: string;
    resourceScope?: ResourceScope;
    catalogSnapshotId?: string;
    indexVersions?: IndexVersions;
}

/** 同一锚点文档内的一条选区检索记录 */
export interface ReferencePrepRecord {
    id: string;
    targetPreview?: string;
    userInput?: string;
    enabledSources: ReferenceSourceId[];
    strength: ReferencePrepStrength;
    dicts?: Array<{ id: string; name: string; mdxPath: string }>;
    rounds: ReferencePrepRound[];
    corpus: CorpusHit[];
    mergedReference?: string;
    plan?: {
        items?: ReferencePrepJsonPlanItem[];
    };
    resourceScope?: ResourceScope;
    catalogSnapshotId?: string;
    indexVersions?: IndexVersions;
}

/**
 * v0.3：一文一过程文件，内含多条选区记录。
 * 运行时仍以 ReferencePrepProcessFileV020（含 id）作为当前工作记录。
 */
export interface ReferencePrepProcessFileV030 {
    version: '0.3.0';
    sourceJsonPath?: string;
    activeRecordId: string;
    records: ReferencePrepRecord[];
}

export type ReferencePrepProcessFile =
    | ReferencePrepProcessFileV010
    | ReferencePrepProcessFileV020
    | ReferencePrepProcessFileV030;

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

export function newReferencePrepRecordId(): string {
    return `rec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function upgradeProcessToV020(proc: ReferencePrepProcessFileV010 | ReferencePrepProcessFileV020): ReferencePrepProcessFileV020 {
    if (proc.version === '0.2.0') {
        return {
            ...proc,
            id: proc.id ?? newReferencePrepRecordId(),
            corpus: proc.corpus.map(normalizeCorpusHit),
        };
    }
    return {
        ...proc,
        version: '0.2.0',
        id: newReferencePrepRecordId(),
        corpus: proc.corpus.map(normalizeCorpusHit),
    };
}

export function workingProcessFromRecord(
    record: ReferencePrepRecord,
    sourceJsonPath?: string
): ReferencePrepProcessFileV020 {
    return {
        version: '0.2.0',
        id: record.id,
        sourceJsonPath,
        targetPreview: record.targetPreview,
        userInput: record.userInput,
        enabledSources: record.enabledSources,
        strength: record.strength,
        dicts: record.dicts,
        rounds: record.rounds,
        corpus: record.corpus.map(normalizeCorpusHit),
        mergedReference: record.mergedReference,
        plan: record.plan,
        resourceScope: record.resourceScope,
        catalogSnapshotId: record.catalogSnapshotId,
        indexVersions: record.indexVersions,
    };
}

export function recordFromWorkingProcess(proc: ReferencePrepProcessFileV020): ReferencePrepRecord {
    return {
        id: proc.id ?? newReferencePrepRecordId(),
        targetPreview: proc.targetPreview,
        userInput: proc.userInput,
        enabledSources: proc.enabledSources,
        strength: proc.strength,
        dicts: proc.dicts,
        rounds: proc.rounds,
        corpus: proc.corpus.map(normalizeCorpusHit),
        mergedReference: proc.mergedReference,
        plan: proc.plan,
        resourceScope: proc.resourceScope,
        catalogSnapshotId: proc.catalogSnapshotId,
        indexVersions: proc.indexVersions,
    };
}

export function upgradeProcessToV030(proc: ReferencePrepProcessFile): ReferencePrepProcessFileV030 {
    if (proc.version === '0.3.0') {
        const records = proc.records.map((r) => ({
            ...r,
            id: r.id || newReferencePrepRecordId(),
            corpus: (r.corpus ?? []).map(normalizeCorpusHit),
        }));
        const activeRecordId =
            records.some((r) => r.id === proc.activeRecordId) ? proc.activeRecordId : records[0]?.id ?? newReferencePrepRecordId();
        return {
            version: '0.3.0',
            sourceJsonPath: proc.sourceJsonPath,
            activeRecordId,
            records: records.length
                ? records
                : [
                      {
                          id: activeRecordId,
                          enabledSources: [],
                          strength: 'standard',
                          rounds: [],
                          corpus: [],
                      },
                  ],
        };
    }
    const v020 = upgradeProcessToV020(proc);
    const record = recordFromWorkingProcess(v020);
    return {
        version: '0.3.0',
        sourceJsonPath: v020.sourceJsonPath,
        activeRecordId: record.id,
        records: [record],
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
    if (source === 'wikipedia') return enabled.includes('wikipedia');
    if (source === 'web') return enabled.includes('web');
    return false;
}
