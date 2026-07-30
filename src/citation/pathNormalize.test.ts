import { describe, expect, it } from 'vitest';
import { normalizeRelPath, relPathEqualsOrUnder } from './pathNormalize';

describe('pathNormalize', () => {
    it('normalizes backslash to slash', () => {
        expect(normalizeRelPath('张大千\\张大千.md')).toBe('张大千/张大千.md');
    });

    it('matches scope with mixed separators', () => {
        expect(relPathEqualsOrUnder('张大千\\张大千.md', '张大千/张大千.md')).toBe(true);
        expect(relPathEqualsOrUnder('张大千\\张大千.md', '张大千')).toBe(true);
        expect(relPathEqualsOrUnder('莫高窟\\简介.md', '张大千')).toBe(false);
    });
});
