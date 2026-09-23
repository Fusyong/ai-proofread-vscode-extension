import { describe, expect, it } from 'vitest';
import {
    expandFormFeedTemplate,
    precedingPageNumberLineStart,
    replaceFormFeeds,
    type FormFeedReplaceOptions,
} from './formFeedReplacer';

describe('expandFormFeedTemplate', () => {
    it('replaces \\p with page number', () => {
        expect(expandFormFeedTemplate('page \\p', 3, '\n')).toBe('page 3');
    });

    it('replaces \\n with eol', () => {
        expect(expandFormFeedTemplate('a\\nb', 1, '\r\n')).toBe('a\r\nb');
    });

    it('supports negative page', () => {
        expect(expandFormFeedTemplate('\\p', -2, '\n')).toBe('-2');
    });

    it('escapes double backslash', () => {
        expect(expandFormFeedTemplate('\\\\p', 1, '\n')).toBe('\\p');
    });

    it('empty template yields empty string', () => {
        expect(expandFormFeedTemplate('', 1, '\n')).toBe('');
    });
});

describe('precedingPageNumberLineStart', () => {
    it('detects spaced page number line before form feed (pdftotext layout)', () => {
        const text = '正文\n                                                        1\n\f下一页';
        const ff = text.indexOf('\f');
        expect(precedingPageNumberLineStart(text, ff)).toBe(text.indexOf('                                                        1'));
    });

    it('returns ffIndex when previous line is not a bare page number', () => {
        const text = '正文末句。\n\f下一页';
        const ff = text.indexOf('\f');
        expect(precedingPageNumberLineStart(text, ff)).toBe(ff);
    });

    it('handles CRLF', () => {
        const text = 'a\r\n   12\r\n\f下一页';
        const ff = text.indexOf('\f');
        expect(precedingPageNumberLineStart(text, ff)).toBe(text.indexOf('   12'));
    });
});

describe('replaceFormFeeds', () => {
    it('replaces with HTML comment and blank lines', () => {
        const { text, replacedCount, totalCount } = replaceFormFeeds('a\fb', {
            mode: 'comment',
            startPage: 1,
            startIndex: 1,
            every: 1,
            removePrecedingPageNumber: false,
        });
        expect(text).toBe('a\n\n<!--  page 1 -->\n\nb');
        expect(replacedCount).toBe(1);
        expect(totalCount).toBe(1);
    });

    it('replaces with heading and blank lines', () => {
        const { text } = replaceFormFeeds('a\fb', {
            mode: 'heading',
            startPage: 2,
            startIndex: 1,
            every: 1,
            removePrecedingPageNumber: false,
        });
        expect(text).toBe('a\n\n## page 2\n\nb');
    });

    it('increments page for each processed form feed', () => {
        const { text, replacedCount } = replaceFormFeeds('a\fb\fc', {
            mode: 'heading',
            startPage: 1,
            startIndex: 1,
            every: 1,
            removePrecedingPageNumber: false,
        });
        expect(text).toBe('a\n\n## page 1\n\nb\n\n## page 2\n\nc');
        expect(replacedCount).toBe(2);
    });

    it('preserves CRLF', () => {
        const { text } = replaceFormFeeds('a\r\n\fb', {
            mode: 'comment',
            startPage: 1,
            startIndex: 1,
            every: 1,
            removePrecedingPageNumber: false,
        });
        expect(text).toBe('a\r\n\r\n\r\n<!--  page 1 -->\r\n\r\nb');
    });

    it('allows negative start page', () => {
        const { text } = replaceFormFeeds('\f\f', {
            mode: 'heading',
            startPage: -1,
            startIndex: 1,
            every: 1,
            removePrecedingPageNumber: false,
        });
        expect(text).toBe('\n\n## page -1\n\n\n\n## page 0\n\n');
    });

    it('starts from the x-th form feed', () => {
        const { text, replacedCount, totalCount } = replaceFormFeeds('A\fB\fC\fD', {
            mode: 'heading',
            startPage: 10,
            startIndex: 2,
            every: 1,
            removePrecedingPageNumber: false,
        });
        expect(totalCount).toBe(3);
        expect(replacedCount).toBe(2);
        expect(text).toBe('A\fB\n\n## page 10\n\nC\n\n## page 11\n\nD');
    });

    it('processes every y-th form feed from startIndex', () => {
        const { text, replacedCount } = replaceFormFeeds('\f\f\f\f', {
            mode: 'heading',
            startPage: 1,
            startIndex: 1,
            every: 2,
            removePrecedingPageNumber: false,
        });
        expect(replacedCount).toBe(2);
        expect(text).toBe('\n\n## page 1\n\n\f\n\n## page 2\n\n\f');
    });

    it('custom empty template deletes form feeds', () => {
        const { text, replacedCount } = replaceFormFeeds('a\fb\fc', {
            mode: 'custom',
            startPage: 1,
            startIndex: 1,
            every: 1,
            customTemplate: '',
            removePrecedingPageNumber: false,
        });
        expect(text).toBe('abc');
        expect(replacedCount).toBe(2);
    });

    it('custom template with \\p and \\n', () => {
        const { text } = replaceFormFeeds('a\fb', {
            mode: 'custom',
            startPage: 5,
            startIndex: 1,
            every: 1,
            customTemplate: '\\n--- page \\p ---\\n',
            removePrecedingPageNumber: false,
        });
        expect(text).toBe('a\n--- page 5 ---\nb');
    });

    it('returns unchanged when no form feeds', () => {
        const input = 'no form feed';
        const { text, replacedCount, totalCount, removedPageNumberCount } = replaceFormFeeds(
            input,
            {
                mode: 'comment',
                startPage: 1,
                startIndex: 1,
                every: 1,
            }
        );
        expect(text).toBe(input);
        expect(replacedCount).toBe(0);
        expect(totalCount).toBe(0);
        expect(removedPageNumberCount).toBe(0);
    });

    it('clamps startIndex and every to at least 1', () => {
        const opts: FormFeedReplaceOptions = {
            mode: 'custom',
            startPage: 1,
            startIndex: 0,
            every: 0,
            customTemplate: '[\\p]',
            removePrecedingPageNumber: false,
        };
        const { text, replacedCount } = replaceFormFeeds('a\fb', opts);
        expect(replacedCount).toBe(1);
        expect(text).toBe('a[1]b');
    });

    it('removes pdftotext footer page number line before form feed by default', () => {
        // 形态同大赛投稿 md：页脚「空格+页码」+ \n + \f + 下页正文
        const input =
            '传统审校软件……\n' +
            '                                                        1\n' +
            '\f' +
            '       本扩展安装在 VS Code 中';
        const { text, replacedCount, removedPageNumberCount } = replaceFormFeeds(input, {
            mode: 'heading',
            startPage: 1,
            startIndex: 1,
            every: 1,
        });
        expect(replacedCount).toBe(1);
        expect(removedPageNumberCount).toBe(1);
        expect(text).toBe(
            '传统审校软件……\n\n\n## page 1\n\n       本扩展安装在 VS Code 中'
        );
        expect(text).not.toContain('\f');
        expect(text).not.toMatch(/\n\s*1\n/);
    });

    it('can keep footer page number when option is false', () => {
        const input = 'a\n  3\n\fb';
        const { text, removedPageNumberCount } = replaceFormFeeds(input, {
            mode: 'custom',
            startPage: 3,
            startIndex: 1,
            every: 1,
            customTemplate: '[\\p]',
            removePrecedingPageNumber: false,
        });
        expect(removedPageNumberCount).toBe(0);
        expect(text).toBe('a\n  3\n[3]b');
    });

    it('handles trailing form feed after last page number', () => {
        const input = '末页正文\n                                                        17\n\f';
        const { text, replacedCount, removedPageNumberCount } = replaceFormFeeds(input, {
            mode: 'comment',
            startPage: 17,
            startIndex: 1,
            every: 1,
        });
        expect(replacedCount).toBe(1);
        expect(removedPageNumberCount).toBe(1);
        expect(text).toBe('末页正文\n\n\n<!--  page 17 -->\n\n');
    });
});
