import { describe, expect, it } from 'vitest';
import {
    isNoisyGrepSnippet,
    normalizeRelPath,
    sanitizeGrepSnippetForExport,
    stripGrepNoiseLines,
} from './grepNoise';

describe('grepNoise', () => {
    it('normalizes path separators', () => {
        expect(normalizeRelPath('a\\b\\c.md')).toBe('a/b/c.md');
        expect(normalizeRelPath('./x/y.md')).toBe('x/y.md');
    });

    it('flags time codes and TOC as noise', () => {
        expect(isNoisyGrepSnippet('02:42')).toBe(true);
        expect(isNoisyGrepSnippet('作品原文\n词句注释')).toBe(true);
        expect(isNoisyGrepSnippet('短')).toBe(true);
    });

    it('flags TOC + short verse + embedded time code', () => {
        const sn = [
            '8作者简介',
            '### 作品原文',
            '蜀道难①',
            '噫吁嚱②，危乎高哉！蜀道之难，难于上青天！',
            '02:42',
        ].join('\n');
        expect(isNoisyGrepSnippet(sn)).toBe(true);
        expect(sanitizeGrepSnippetForExport(sn)).toBe('');
    });

    it('strips time codes from long excerpts but keeps verse', () => {
        const sn = [
            '《蜀道难》是唐代大诗人李白的代表诗作。此诗袭用乐府旧题，以浪漫主义的手法，展开丰富的想象，艺术地再现了蜀道峥嵘。',
            '### 目录',
            '1作品原文',
            '8作者简介',
            '### 作品原文',
            '蜀道难①',
            '噫吁嚱②，危乎高哉！蜀道之难，难于上青天！',
            '02:42',
            '唐诗李白《蜀道难》朗诵',
            '蚕丛及鱼凫③，开国何茫然④！尔来四万八千岁，不与秦塞通人烟。',
            '西当太白有鸟道，可以横绝峨眉巅。地崩山摧壮士死，然后天梯石栈相钩连。',
        ].join('\n');
        const out = sanitizeGrepSnippetForExport(sn);
        expect(out).toBeTruthy();
        expect(out).not.toMatch(/02:42/);
        expect(out).not.toMatch(/作者简介/);
        expect(out).not.toMatch(/朗诵/);
        expect(out).toContain('难于上青天');
        expect(out).toContain('蚕丛及鱼凫');
    });

    it('does not strip birth-death years', () => {
        const sn = '李白（701—762），字太白，唐代诗人，作《蜀道难》。\n李白（1910—1949）另有其人。';
        expect(sanitizeGrepSnippetForExport(sn)).toContain('701—762');
        expect(sanitizeGrepSnippetForExport(sn)).toContain('1910—1949');
        expect(isNoisyGrepSnippet(sn)).toBe(false);
    });

    it('keeps real evidence snippets', () => {
        expect(
            isNoisyGrepSnippet('李白（701—762），字太白，唐代诗人，作《蜀道难》。')
        ).toBe(false);
    });

    it('strips noise lines for inspection', () => {
        const cleaned = stripGrepNoiseLines('作品原文\n02:42\n李白字太白。');
        expect(cleaned).toBe('李白字太白。');
    });
});
