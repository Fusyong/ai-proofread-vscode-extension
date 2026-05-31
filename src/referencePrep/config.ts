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

export function getStrengthPreset(strength: ReferencePrepStrength): StrengthPreset {
    return STRENGTH_PRESETS[strength] ?? STRENGTH_PRESETS.standard;
}

export function getDefaultEnabledSources(): ReferenceSourceId[] {
    const config = vscode.workspace.getConfiguration('ai-proofread');
    const raw = config.get<string[]>('referencePrep.enabledSources', ['dict', 'grep_md']);
    const allowed: ReferenceSourceId[] = ['dict', 'grep_md', 'citation', 'web'];
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

export function getDictPrepConfigKeys() {
    const config = vscode.workspace.getConfiguration('ai-proofread');
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
