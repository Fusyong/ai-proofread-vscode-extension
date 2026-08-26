import { describe, expect, it } from 'vitest';

import {
    DEFAULT_DELETE_EXCESS_BLANK_LINES_OPTIONS,
    deleteExcessBlankLines,
    type DeleteExcessBlankLinesOptions
} from './excessBlankLines';

const defaults: DeleteExcessBlankLinesOptions = DEFAULT_DELETE_EXCESS_BLANK_LINES_OPTIONS;

describe('deleteExcessBlankLines', () => {
    it('keeps at most one consecutive blank line by default', () => {
        expect(deleteExcessBlankLines('a\n\n\nb\n', defaults)).toBe('a\n\nb\n');
    });

    it('can remove all blank lines when maxConsecutive is 0', () => {
        expect(deleteExcessBlankLines('a\n\n\nb\n\nc', { ...defaults, maxConsecutive: 0 })).toBe(
            'a\nb\nc'
        );
    });

    it('can keep more consecutive blank lines', () => {
        expect(deleteExcessBlankLines('a\n\n\n\nb', { ...defaults, maxConsecutive: 2 })).toBe(
            'a\n\n\nb'
        );
    });

    it('treats whitespace-only lines as blank and strips them when keeping', () => {
        expect(deleteExcessBlankLines('a\n  \n\t\n\nb\n', defaults)).toBe('a\n\nb\n');
    });

    it('does not treat whitespace-only lines as blank when disabled', () => {
        expect(
            deleteExcessBlankLines('a\n  \n\n\nb', {
                maxConsecutive: 1,
                treatWhitespaceOnlyAsBlank: false
            })
        ).toBe('a\n  \n\nb');
    });

    it('preserves CRLF when present', () => {
        expect(deleteExcessBlankLines('a\r\n\r\n\r\nb\r\n', defaults)).toBe('a\r\n\r\nb\r\n');
    });

    it('preserves absence of trailing newline', () => {
        expect(deleteExcessBlankLines('a\n\n\nb', defaults)).toBe('a\n\nb');
    });

    it('leaves text without excess blank lines unchanged', () => {
        expect(deleteExcessBlankLines('a\n\nb\nc\n', defaults)).toBe('a\n\nb\nc\n');
    });

    it('handles empty string', () => {
        expect(deleteExcessBlankLines('', defaults)).toBe('');
    });

    it('collapses a file that is only blank lines', () => {
        expect(deleteExcessBlankLines('\n\n\n', defaults)).toBe('\n');
        expect(deleteExcessBlankLines('\n\n\n', { ...defaults, maxConsecutive: 0 })).toBe('');
        expect(deleteExcessBlankLines('\n\n\n', { ...defaults, maxConsecutive: 2 })).toBe('\n\n');
    });

    it('strips spaces on a single kept whitespace-only blank line', () => {
        expect(deleteExcessBlankLines('a\n   \nb\n', defaults)).toBe('a\n\nb\n');
    });
});
