import { describe, expect, it } from 'vitest';

import { markTitles, parseToc, stripLeadingMarkdownHeading } from './titleMarker';

describe('stripLeadingMarkdownHeading', () => {
    it('removes leading heading markers of any depth', () => {
        expect(stripLeadingMarkdownHeading('# 绪论')).toBe('绪论');
        expect(stripLeadingMarkdownHeading('## 第一章')).toBe('第一章');
        expect(stripLeadingMarkdownHeading('###### 附录')).toBe('附录');
        expect(stripLeadingMarkdownHeading('####### 细目')).toBe('细目');
        expect(stripLeadingMarkdownHeading('########## 更深')).toBe('更深');
    });

    it('leaves lines without a heading marker unchanged', () => {
        expect(stripLeadingMarkdownHeading('第一章 绪论')).toBe('第一章 绪论');
        expect(stripLeadingMarkdownHeading('#hashtag')).toBe('#hashtag');
    });
});

describe('parseToc', () => {
    it('reads nested markdown lists and applies baseLevel', () => {
        const toc = `* 第一编
    * 第一章
        * 第一节`;
        expect(parseToc(toc, 4, 1)).toEqual([
            { name: '第一编', level: 1 },
            { name: '第一章', level: 2 },
            { name: '第一节', level: 3 },
        ]);
        expect(parseToc(toc, 4, 2)[0].level).toBe(2);
    });
});

describe('markTitles', () => {
    const tocItems = [
        { name: '第一编', level: 1 },
        { name: '第一章', level: 2 },
    ];

    it('marks unmarked title lines with the toc level', () => {
        const [marked, notFound] = markTitles(
            ['第一编', '正文一段。', '第一章'],
            tocItems
        );
        expect(marked).toEqual(['# 第一编', '正文一段。', '## 第一章']);
        expect(notFound).toEqual([]);
    });

    it('matches lines that already have heading markers', () => {
        const [marked, notFound] = markTitles(
            ['## 第一编', '正文一段。', '### 第一章'],
            tocItems
        );
        expect(marked).toEqual(['# 第一编', '正文一段。', '## 第一章']);
        expect(notFound).toEqual([]);
    });

    it('rewrites an existing heading to the new toc level', () => {
        const [marked] = markTitles(
            ['###### 第一编'],
            [{ name: '第一编', level: 3 }]
        );
        expect(marked).toEqual(['### 第一编']);
    });

    it('matches and rewrites headings deeper than level 6', () => {
        const [marked, notFound] = markTitles(
            ['####### 细目', '########## 更深'],
            [
                { name: '细目', level: 7 },
                { name: '更深', level: 2 },
            ]
        );
        expect(marked).toEqual(['####### 细目', '## 更深']);
        expect(notFound).toEqual([]);
    });

    it('still matches titles after ignoring page numbers and dots', () => {
        const [marked, notFound] = markTitles(
            ['第一编……3', '## 第一章  12'],
            tocItems
        );
        expect(marked).toEqual(['# 第一编……3', '## 第一章  12']);
        expect(notFound).toEqual([]);
    });

    it('reports toc items that are not found', () => {
        const [, notFound] = markTitles(['无关正文'], tocItems);
        expect(notFound).toEqual(tocItems);
    });
});
