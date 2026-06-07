import type { ReferencePrepStrength } from './schema';

export interface StrengthPreset {
    maxRounds: number;
    maxQueriesPerRound: number;
    maxTotalLookups: number;
    grepMaxHitsPerRound: number;
    grepMaxSnippetChars: number;
    valuePruneThreshold: number;
    maxPointsPerItem: number;
}

export const STRENGTH_PRESETS: Record<ReferencePrepStrength, StrengthPreset> = {
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

export function getStrengthPresetValues(strength: ReferencePrepStrength): StrengthPreset {
    return STRENGTH_PRESETS[strength] ?? STRENGTH_PRESETS.standard;
}
