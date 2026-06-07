import * as vscode from 'vscode';
import { resolveModelRoute } from '../modelRoutes/modelRouteResolver';
import type { ReferencePrepStrength, ReferenceSourceId } from './schema';

export interface StrengthPreset {
    maxRounds: number;
    maxQueriesPerRound: number;
    maxTotalLookups: number;
    grepMaxHitsPerRound: number;
    grepMaxSnippetChars: number;
    valuePruneThreshold: number;
    maxPointsPerItem: number;
}

export interface ScopeConfig {
    dictCountThreshold: number;
    fileCountThreshold: number;
    dirDepthThreshold: number;
    headingCountThreshold: number;
    tocCharsThreshold: number;
    fallbackWidenMinHits: number;
}

export interface ScoringWeights {
    llmPriority: number;
    channelScore: number;
    cooccurrence: number;
    scopeMatch: number;
    clusterBoost: number;
}

export interface RerankConfig {
    enabled: boolean;
    includeReason: boolean;
    maxCandidates: number;
}

export interface VectorConfig {
    enabled: boolean;
    topK: number;
    minScore: number;
}

const STRENGTH_PRESETS: Record<ReferencePrepStrength, StrengthPreset> = {
    light: {
        maxRounds: 1,
        maxQueriesPerRound: 4,
        maxTotalLookups: 40,
        grepMaxHitsPerRound: 12,
        grepMaxSnippetChars: 6000,
        valuePruneThreshold: 0.3,
        maxPointsPerItem: 4,
    },
    standard: {
        maxRounds: 3,
        maxQueriesPerRound: 6,
        maxTotalLookups: 100,
        grepMaxHitsPerRound: 30,
        grepMaxSnippetChars: 12000,
        valuePruneThreshold: 0.25,
        maxPointsPerItem: 6,
    },
    thorough: {
        maxRounds: 5,
        maxQueriesPerRound: 10,
        maxTotalLookups: 200,
        grepMaxHitsPerRound: 50,
        grepMaxSnippetChars: 20000,
        valuePruneThreshold: 0.2,
        maxPointsPerItem: 10,
    },
};

function cfg() {
    return vscode.workspace.getConfiguration('ai-proofread');
}

export function getStrengthPreset(strength: ReferencePrepStrength): StrengthPreset {
    const preset = STRENGTH_PRESETS[strength] ?? STRENGTH_PRESETS.standard;
    const config = cfg();
    return {
        ...preset,
        grepMaxHitsPerRound: config.get<number>(
            'referencePrep.grep.maxHitsPerRound',
            preset.grepMaxHitsPerRound
        ),
        grepMaxSnippetChars: config.get<number>(
            'referencePrep.grep.maxSnippetChars',
            preset.grepMaxSnippetChars
        ),
    };
}

export function getDefaultEnabledSources(): ReferenceSourceId[] {
    const config = cfg();
    const raw = config.get<string[]>('referencePrep.enabledSources', ['dict', 'grep_md']);
    const allowed: ReferenceSourceId[] = ['dict', 'grep_md', 'bm25', 'vector', 'citation', 'web'];
    const out = raw.filter((x): x is ReferenceSourceId => (allowed as string[]).includes(x));
    return out.length > 0 ? out : ['dict', 'grep_md'];
}

export function getReferencePrepLlmConfig(): { platform: string; model: string } {
    const { platform, model } = resolveModelRoute('referencePrep');
    if (!model) {
        throw new Error('未配置模型：ai-proofread.proofread.models.' + platform);
    }
    return { platform, model };
}

export function getReferencePrepRerankLlmConfig(): { platform: string; model: string } {
    const { platform, model } = resolveModelRoute('referencePrepRerank');
    if (!model) {
        return getReferencePrepLlmConfig();
    }
    return { platform, model };
}

export function getDictPrepConfigKeys() {
    const config = cfg();
    return {
        maxDefinitionChars: config.get<number>('referencePrep.dict.maxDefinitionChars', config.get<number>('dictPrep.maxDefinitionChars', 6000)),
        cacheEnabled: config.get<boolean>('referencePrep.dict.cache.enabled', config.get<boolean>('dictPrep.cache.enabled', true)),
        cacheTtlHours: config.get<number>('referencePrep.dict.cache.ttlHours', config.get<number>('dictPrep.cache.ttlHours', 0)),
        maxTotalLookupsPerRun: config.get<number>(
            'referencePrep.dict.maxTotalLookupsPerRun',
            config.get<number>('dictPrep.maxTotalLookupsPerRun', 100)
        ),
    };
}

export function getScopeConfig(): ScopeConfig {
    const config = cfg();
    return {
        dictCountThreshold: config.get<number>('referencePrep.scope.dictCountThreshold', 8),
        fileCountThreshold: config.get<number>('referencePrep.scope.fileCountThreshold', 100),
        dirDepthThreshold: config.get<number>('referencePrep.scope.dirDepthThreshold', 4),
        headingCountThreshold: config.get<number>('referencePrep.scope.headingCountThreshold', 40),
        tocCharsThreshold: config.get<number>('referencePrep.scope.tocCharsThreshold', 8000),
        fallbackWidenMinHits: config.get<number>('referencePrep.scope.fallbackWidenMinHits', 2),
    };
}

export function getScoringWeights(): ScoringWeights {
    const config = cfg();
    const w = config.get<Partial<ScoringWeights>>('referencePrep.scoring.weights', {});
    return {
        llmPriority: w.llmPriority ?? 0.35,
        channelScore: w.channelScore ?? 0.25,
        cooccurrence: w.cooccurrence ?? 0.15,
        scopeMatch: w.scopeMatch ?? 0.15,
        clusterBoost: w.clusterBoost ?? 0.1,
    };
}

export function getRerankConfig(): RerankConfig {
    const config = cfg();
    return {
        enabled: config.get<boolean>('referencePrep.rerank.enabled', true),
        includeReason: config.get<boolean>('referencePrep.rerank.includeReason', true),
        maxCandidates: config.get<number>('referencePrep.rerank.maxCandidates', 40),
    };
}

export function getVectorConfig(): VectorConfig {
    const config = cfg();
    return {
        enabled: config.get<boolean>('referencePrep.vector.enabled', true),
        topK: config.get<number>('referencePrep.vector.topK', 20),
        minScore: config.get<number>('referencePrep.vector.minScore', 0.15),
    };
}

export function getBm25TopK(): number {
    return cfg().get<number>('referencePrep.bm25.topK', 25);
}

export function getGrepMaxFiles(): number {
    return cfg().get<number>('referencePrep.grep.maxFiles', 500);
}
