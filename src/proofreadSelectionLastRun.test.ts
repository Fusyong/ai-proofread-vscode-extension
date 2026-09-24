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
            contextBuildMethod: '按长度扩展前后文',
            headingLevel: '9 级标题',
            repetitionMode: 'all',
            beforeMinLength: 300,
            afterMinLength: 0,
            includeTargetInContext: true,
            temperature: 0.4,
            useReference: true,
            referenceFilePath: '  D:\\refs\\a.md  '
        });
        expect(parsed).toEqual({
            contextBuildMethod: '按长度扩展前后文',
            repetitionMode: 'all',
            beforeMinLength: 300,
            afterMinLength: 0,
            includeTargetInContext: true,
            temperature: 0.4,
            useReference: true,
            referenceFilePath: 'D:\\refs\\a.md'
        });
    });

    it('maps legacy contextBuildMethod「前后增加段落」', () => {
        const parsed = parseProofreadSelectionLastRun({
            contextBuildMethod: '前后增加段落'
        });
        expect(parsed?.contextBuildMethod).toBe('按长度扩展前后文');
    });

    it('clamps min lengths to [0, 10000]', () => {
        const parsed = parseProofreadSelectionLastRun({
            beforeMinLength: 99999,
            afterMinLength: -2
        });
        expect(parsed?.beforeMinLength).toBe(10000);
        expect(parsed?.afterMinLength).toBe(0);
    });

    it('drops temperature outside [0, 2)', () => {
        expect(parseProofreadSelectionLastRun({ temperature: 2 })?.temperature).toBeUndefined();
        expect(parseProofreadSelectionLastRun({ temperature: -0.1 })?.temperature).toBeUndefined();
        expect(parseProofreadSelectionLastRun({ temperature: 1.9 })?.temperature).toBe(1.9);
    });
});
