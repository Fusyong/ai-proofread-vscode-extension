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

    it('removes a single space between Chinese characters and Latin letters', () => {
        expect(deleteInlineWhitespace('中文 word', defaults)).toBe('中文word');
        expect(deleteInlineWhitespace('hello 世界', defaults)).toBe('hello世界');
        expect(deleteInlineWhitespace('中 Ａ', defaults)).toBe('中Ａ');
    });

    it('removes a single space between Chinese characters and Arabic digits', () => {
        expect(deleteInlineWhitespace('第 1 章', defaults)).toBe('第1章');
        expect(deleteInlineWhitespace('1 章', defaults)).toBe('1章');
        expect(deleteInlineWhitespace('第 １ 章', defaults)).toBe('第１章');
    });

    it('keeps consecutive spaces longer than maxConsecutive', () => {
        expect(deleteInlineWhitespace('中  文', defaults)).toBe('中  文');
    });

    it('removes longer runs when maxConsecutive allows', () => {
        expect(deleteInlineWhitespace('中  文', { ...defaults, maxConsecutive: 2 })).toBe('中文');
    });

    it('preserves leading and trailing spaces by default', () => {
        expect(deleteInlineWhitespace('  中 文  ', defaults)).toBe('  中文  ');
    });

    it('does not remove line-edge spaces that lack a Han neighbor even when preserveLineEdges is disabled', () => {
        expect(deleteInlineWhitespace(' 中 文 ', { ...defaults, preserveLineEdges: false })).toBe(
            ' 中文 '
        );
        expect(deleteInlineWhitespace('  中 文  ', { ...defaults, preserveLineEdges: false })).toBe(
            '  中文  '
        );
    });

    it('preserves all-space lines when preserveLineEdges is enabled', () => {
        expect(deleteInlineWhitespace('   ', defaults)).toBe('   ');
    });

    it('preserves spaces between Latin letters', () => {
        expect(deleteInlineWhitespace('word test', defaults)).toBe('word test');
    });

    it('preserves spaces between digits', () => {
        expect(deleteInlineWhitespace('1 2', defaults)).toBe('1 2');
    });

    it('preserves spaces between Chinese punctuation only', () => {
        expect(deleteInlineWhitespace('， 。', defaults)).toBe('， 。');
    });

    it('preserves whitespace next to ASCII punctuation', () => {
        expect(deleteInlineWhitespace('中文, word', defaults)).toBe('中文, word');
    });

    it('preserves line endings', () => {
        expect(deleteInlineWhitespace('中 文\r\n字 符', defaults)).toBe('中文\r\n字符');
    });

    it('does not remove tabs or full-width spaces', () => {
        expect(deleteInlineWhitespace('中\t文', defaults)).toBe('中\t文');
        expect(deleteInlineWhitespace('中\u3000文', defaults)).toBe('中\u3000文');
    });

    it('leaves lines without removable whitespace unchanged', () => {
        expect(deleteInlineWhitespace('中文', defaults)).toBe('中文');
    });
});
