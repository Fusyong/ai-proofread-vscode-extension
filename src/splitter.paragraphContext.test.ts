import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => ({
            get: (_key: string, defaultValue: unknown) => defaultValue
        })
    }
}));

import {
    buildParagraphBasedContext,
    extractAfterContextByMinLength,
    extractBeforeContextByMinLength
} from './splitter';

describe('extractBeforeContextByMinLength / extractAfterContextByMinLength', () => {
    const text = [
        'AAA第一段内容足够长啦一二三四五六七八九十',
        '',
        'BBB第二段内容足够长啦一二三四五六七八九十',
        '',
        'CCC目标段落在这里',
        '',
        'DDD第四段内容足够长啦一二三四五六七八九十',
        '',
        'EEE第五段内容足够长啦一二三四五六七八九十'
    ].join('\n');

    const target = 'CCC目标段落在这里';
    const targetStart = text.indexOf(target);
    const targetEnd = targetStart + target.length;

    it('returns empty when minLength is 0', () => {
        expect(extractBeforeContextByMinLength(text, targetStart, 0)).toBe('');
        expect(extractAfterContextByMinLength(text, targetEnd, 0)).toBe('');
    });

    it('extends backward to the first blank-line cut after reaching minLength', () => {
        // 只要一点点就会越过空行，吃到 BBB 整段
        const before = extractBeforeContextByMinLength(text, targetStart, 5);
        expect(before).toContain('BBB第二段');
        expect(before).not.toContain('AAA第一段');
        expect(before).not.toContain(target);
    });

    it('extends further when minLength requires more than one paragraph', () => {
        const before = extractBeforeContextByMinLength(text, targetStart, 40);
        expect(before).toContain('AAA第一段');
        expect(before).toContain('BBB第二段');
    });

    it('extends forward to the first blank-line cut after reaching minLength', () => {
        const after = extractAfterContextByMinLength(text, targetEnd, 5);
        expect(after).toContain('DDD第四段');
        expect(after).not.toContain('EEE第五段');
        expect(after).not.toContain(target);
    });

    it('cuts before a Markdown heading when extending forward', () => {
        const withHeading = [
            '目标段',
            '下文续写一二三四五六七八九十',
            '## 下一节标题',
            '不应进入下文上下文'
        ].join('\n');
        const start = withHeading.indexOf('目标段');
        const end = start + '目标段'.length;
        const after = extractAfterContextByMinLength(withHeading, end, 5);
        expect(after).toContain('下文续写');
        expect(after).not.toContain('下一节标题');
        expect(after).not.toContain('不应进入');
    });

    it('starts before-context at a Markdown heading when extending backward', () => {
        const withHeading = [
            '更早的段落不应进入',
            '## 本节标题',
            '上文续写一二三四五六七八九十',
            '目标段'
        ].join('\n');
        const start = withHeading.indexOf('目标段');
        const before = extractBeforeContextByMinLength(withHeading, start, 5);
        expect(before).toContain('## 本节标题');
        expect(before).toContain('上文续写');
        expect(before).not.toContain('更早的段落');
    });

    it('treats whitespace-only lines as blank cut points', () => {
        const withSpaces = [
            'AAA不应进入',
            '   ',
            'BBB应进入一二三',
            '目标'
        ].join('\n');
        const start = withSpaces.indexOf('目标');
        const before = extractBeforeContextByMinLength(withSpaces, start, 3);
        expect(before).toContain('BBB应进入');
        expect(before).not.toContain('AAA不应进入');
    });
});

describe('buildParagraphBasedContext', () => {
    const text = ['前文甲', '', '目标乙', '', '后文丙'].join('\n');
    const start = text.indexOf('目标乙');
    const end = start + '目标乙'.length;

    it('omits target by default', () => {
        const ctx = buildParagraphBasedContext(text, start, end, 1, 1, false);
        expect(ctx).toContain('<before>');
        expect(ctx).toContain('前文甲');
        expect(ctx).toContain('<after>');
        expect(ctx).toContain('后文丙');
        expect(ctx).not.toMatch(/<target>/);
    });

    it('keeps target in the middle when includeTargetInContext is true', () => {
        const ctx = buildParagraphBasedContext(text, start, end, 1, 1, true);
        expect(ctx).toMatch(
            /<before>\n前文甲\n<\/before>\n\n<target>\n目标乙\n<\/target>\n\n<after>\n后文丙\n<\/after>/
        );
    });
});
