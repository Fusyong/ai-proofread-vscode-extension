import { describe, expect, it } from 'vitest';
import { getStrengthPresetValues } from './strengthPresets';

describe('getStrengthPreset', () => {
    it('light uses fewer rounds and grep budget than thorough', () => {
        const light = getStrengthPresetValues('light');
        const thorough = getStrengthPresetValues('thorough');
        expect(light.maxRounds).toBe(1);
        expect(thorough.maxRounds).toBe(5);
        expect(light.maxQueriesPerRound).toBeLessThan(thorough.maxQueriesPerRound);
        expect(light.grepMaxHitsPerRound).toBeLessThan(thorough.grepMaxHitsPerRound);
        expect(light.grepMaxSnippetChars).toBeLessThan(thorough.grepMaxSnippetChars);
        expect(light.maxTotalLookups).toBeLessThan(thorough.maxTotalLookups);
    });

    it('standard is between light and thorough', () => {
        const light = getStrengthPresetValues('light');
        const standard = getStrengthPresetValues('standard');
        const thorough = getStrengthPresetValues('thorough');
        expect(standard.maxRounds).toBeGreaterThan(light.maxRounds);
        expect(standard.maxRounds).toBeLessThan(thorough.maxRounds);
    });
});
