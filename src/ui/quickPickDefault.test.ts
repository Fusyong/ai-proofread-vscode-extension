import { describe, expect, it } from 'vitest';
import { markLastChoiceDescription } from './quickPickMark';

describe('markLastChoiceDescription', () => {
    it('leaves non-last items unchanged', () => {
        expect(markLastChoiceDescription('不启用重复功能', false)).toBe('不启用重复功能');
        expect(markLastChoiceDescription(undefined, false)).toBeUndefined();
    });

    it('marks the last item', () => {
        expect(markLastChoiceDescription(undefined, true)).toBe('上次');
        expect(markLastChoiceDescription('不启用重复功能', true)).toBe('不启用重复功能 · 上次');
    });

    it('does not duplicate the mark', () => {
        expect(markLastChoiceDescription('上次', true)).toBe('上次');
        expect(markLastChoiceDescription('说明 · 上次', true)).toBe('说明 · 上次');
    });
});
