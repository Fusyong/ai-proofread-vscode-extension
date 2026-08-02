import type { ReferencePrepStrength } from './schema';

export interface StrengthPreset {
    maxRounds: number;
    maxQueriesPerRound: number;
    maxTotalLookups: number;
    grepMaxHitsPerRound: number;
    grepMaxSnippetChars: number;
    /** @deprecated 仅影响极端噪声硬 prune；软筛选用 minSelectScore */
    valuePruneThreshold: number;
    /** @deprecated 语义由 maxSelectedPerQuery / maxCandidateHitsPerQuery 替代 */
    maxPointsPerItem: number;
    wikipediaMaxHitsPerRound: number;
    wikipediaMaxExtractChars: number;
    maxCandidateHitsPerQuery: number;
    maxSelectedPerQuery: number;
    maxSelectedCharsPerQuery: number;
    minSelectScore: number;
    maxEntriesPrimary: number;
    maxEntriesRelevance: number;
    maxEntriesLength: number;
}

export const STRENGTH_PRESETS: Record<ReferencePrepStrength, StrengthPreset> = {
    light: {
        maxRounds: 1,
        maxQueriesPerRound: 4,
        maxTotalLookups: 40,
        grepMaxHitsPerRound: 12,
        grepMaxSnippetChars: 6000,
        valuePruneThreshold: 0.05,
        maxPointsPerItem: 4,
        wikipediaMaxHitsPerRound: 3,
        wikipediaMaxExtractChars: 2000,
        maxCandidateHitsPerQuery: 8,
        maxSelectedPerQuery: 3,
        maxSelectedCharsPerQuery: 4000,
        minSelectScore: 0.35,
        maxEntriesPrimary: 4,
        maxEntriesRelevance: 2,
        maxEntriesLength: 2,
    },
    standard: {
        maxRounds: 3,
        maxQueriesPerRound: 6,
        maxTotalLookups: 100,
        grepMaxHitsPerRound: 30,
        grepMaxSnippetChars: 12000,
        valuePruneThreshold: 0.05,
        maxPointsPerItem: 6,
        wikipediaMaxHitsPerRound: 5,
        wikipediaMaxExtractChars: 4000,
        maxCandidateHitsPerQuery: 14,
        maxSelectedPerQuery: 5,
        maxSelectedCharsPerQuery: 8000,
        minSelectScore: 0.3,
        maxEntriesPrimary: 6,
        maxEntriesRelevance: 3,
        maxEntriesLength: 2,
    },
    thorough: {
        maxRounds: 5,
        maxQueriesPerRound: 10,
        maxTotalLookups: 200,
        grepMaxHitsPerRound: 50,
        grepMaxSnippetChars: 20000,
        valuePruneThreshold: 0.05,
        maxPointsPerItem: 10,
        wikipediaMaxHitsPerRound: 8,
        wikipediaMaxExtractChars: 6000,
        maxCandidateHitsPerQuery: 20,
        maxSelectedPerQuery: 8,
        maxSelectedCharsPerQuery: 12000,
        minSelectScore: 0.25,
        maxEntriesPrimary: 8,
        maxEntriesRelevance: 4,
        maxEntriesLength: 3,
    },
};

export function getStrengthPresetValues(strength: ReferencePrepStrength): StrengthPreset {
    return STRENGTH_PRESETS[strength] ?? STRENGTH_PRESETS.standard;
}
