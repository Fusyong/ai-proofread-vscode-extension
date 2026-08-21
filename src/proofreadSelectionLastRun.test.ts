import { describe, expect, it } from 'vitest';
import { parseProofreadSelectionLastRun } from './proofreadSelectionLastRun';

describe('parseProofreadSelectionLastRun', () => {
    it('rejects non-objects', () => {
        expect(parseProofreadSelectionLastRun(undefined)).toBeUndefined();
        expect(parseProofreadSelectionLastRun('x')).toBeUndefined();
        expect(parseProofreadSelectionLastRun(null)).toBeUndefined();
    });

    it('keeps valid fields and drops invalid enums', () => {
        const parsed = parseProofreadSelectionLastRun({
            contextBuildMethod: '前后增加段落',
            headingLevel: '9 级标题',
            repetitionMode: 'all',
            beforeParagraphs: 3,
            afterParagraphs: 0,
            temperature: 0.4,
            useReference: true,
            referenceFilePath: '  D:\\refs\\a.md  '
        });
        expect(parsed).toEqual({
            contextBuildMethod: '前后增加段落',
            repetitionMode: 'all',
            beforeParagraphs: 3,
            afterParagraphs: 0,
            temperature: 0.4,
            useReference: true,
            referenceFilePath: 'D:\\refs\\a.md'
        });
    });

    it('clamps paragraph counts to [0, 10]', () => {
        const parsed = parseProofreadSelectionLastRun({
            beforeParagraphs: 99,
            afterParagraphs: -2
        });
        expect(parsed?.beforeParagraphs).toBe(10);
        expect(parsed?.afterParagraphs).toBe(0);
    });

    it('drops temperature outside [0, 2)', () => {
        expect(parseProofreadSelectionLastRun({ temperature: 2 })?.temperature).toBeUndefined();
        expect(parseProofreadSelectionLastRun({ temperature: -0.1 })?.temperature).toBeUndefined();
        expect(parseProofreadSelectionLastRun({ temperature: 1.9 })?.temperature).toBe(1.9);
    });
});
