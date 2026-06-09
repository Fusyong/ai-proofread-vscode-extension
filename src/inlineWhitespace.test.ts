import { describe, expect, it } from 'vitest';

import {
    DEFAULT_DELETE_INLINE_WHITESPACE_OPTIONS,
    deleteInlineWhitespace,
    type DeleteInlineWhitespaceOptions
} from './inlineWhitespace';

const defaults: DeleteInlineWhitespaceOptions = DEFAULT_DELETE_INLINE_WHITESPACE_OPTIONS;

describe('deleteInlineWhitespace', () => {
    it('removes a single space between Chinese characters', () => {
        expect(deleteInlineWhitespace('中 文', defaults)).toBe('中文');
    });

    it('removes a single space between Chinese characters and Chinese punctuation', () => {
        expect(deleteInlineWhitespace('他说， 你好', defaults)).toBe('他说，你好');
        expect(deleteInlineWhitespace('中 ， 文', defaults)).toBe('中，文');
    });

    it('keeps consecutive spaces longer than maxConsecutive', () => {
        expect(deleteInlineWhitespace('中  文', defaults)).toBe('中  文');
    });

    it('removes longer runs when maxConsecutive allows', () => {
        expect(deleteInlineWhitespace('中  文', { ...defaults, maxConsecutive: 2 })).toBe('中文');
    });

    it('preserves leading and trailing whitespace by default', () => {
        expect(deleteInlineWhitespace('  中 文  ', defaults)).toBe('  中文  ');
    });

    it('still only removes Han or Chinese punctuation adjacent whitespace when preserveLineEdges is disabled', () => {
        expect(deleteInlineWhitespace(' 中 文 ', { ...defaults, preserveLineEdges: false })).toBe(
            ' 中文 '
        );
        expect(deleteInlineWhitespace('  中 文  ', { ...defaults, preserveLineEdges: false })).toBe(
            '  中文  '
        );
    });

    it('preserves whitespace around Latin characters', () => {
        expect(deleteInlineWhitespace('word test', defaults)).toBe('word test');
        expect(deleteInlineWhitespace('中文 word', defaults)).toBe('中文 word');
    });

    it('preserves whitespace around digits', () => {
        expect(deleteInlineWhitespace('第 1 章', defaults)).toBe('第 1 章');
    });

    it('preserves whitespace next to ASCII punctuation', () => {
        expect(deleteInlineWhitespace('中文, word', defaults)).toBe('中文, word');
    });

    it('preserves line endings', () => {
        expect(deleteInlineWhitespace('中 文\r\n字 符', defaults)).toBe('中文\r\n字符');
    });

    it('handles tabs and full-width spaces', () => {
        expect(deleteInlineWhitespace('中\t文', defaults)).toBe('中文');
        expect(deleteInlineWhitespace('中\u3000文', defaults)).toBe('中文');
    });

    it('leaves lines without removable whitespace unchanged', () => {
        expect(deleteInlineWhitespace('中文', defaults)).toBe('中文');
    });
});
