import * as vscode from 'vscode';
import { resolveModelRoute } from '../modelRoutes/modelRouteResolver';
import type { ReferencePrepStrength, ReferenceSourceId } from './schema';
import { getStrengthPresetValues, type StrengthPreset } from './strengthPresets';

export type { StrengthPreset } from './strengthPresets';

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

function cfg() {
    return vscode.workspace.getConfiguration('ai-proofread');
}

/** 核查强度预设；轮次、查询数、grep 预算等均以 strength 为准（非全局设置覆盖）。 */
export function getStrengthPreset(strength: ReferencePrepStrength): StrengthPreset {
    return getStrengthPresetValues(strength);
}

export function getDefaultEnabledSources(): ReferenceSourceId[] {
    const config = cfg();
    const raw = config.get<string[]>('referencePrep.enabledSources', ['dict', 'grep_md']);
    const allowed: ReferenceSourceId[] = ['dict', 'grep_md', 'bm25', 'vector', 'citation', 'web'];
    const out = raw.filter((x): x is ReferenceSourceId => (allowed as string[]).includes(x));
    return out.length > 0 ? out : ['dict', 'grep_md'];
}

function requireModel(routeId: Parameters<typeof resolveModelRoute>[0]): { platform: string; model: string } {
    const { platform, model } = resolveModelRoute(routeId);
    if (!model) {
        throw new Error('未配置模型：ai-proofread.proofread.models.' + platform);
    }
    return { platform, model };
}

export function getReferencePrepLlmConfig(): { platform: string; model: string } {
    return requireModel('referencePrep');
}

export function getReferencePrepScopeLlmConfig(): { platform: string; model: string } {
    return requireModel('referencePrepScope');
}

export function getReferencePrepRerankLlmConfig(): { platform: string; model: string } {
    return requireModel('referencePrepRerank');
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
