/**
 * 将分页符（form feed, U+000C / `\f`）替换为页码注释、标题或自定义模板。
 *
 * 分页符常见于 Xpdf `pdftotext`（尤其 `-layout`）导出的文本：
 * 上一页正文 → 页脚页码行（如大量空格 + `12`）→ `\f` → 下一页正文。
 * 文件末尾也常残留「末页页码 + `\f`」。可选用 `removePrecedingPageNumber`
 * 在替换时一并清掉紧挨在 `\f` 前的纯页码行。
 */

export type FormFeedReplaceMode = 'comment' | 'heading' | 'custom';

export interface FormFeedReplaceOptions {
    mode: FormFeedReplaceMode;
    /** 第一个被处理的分页符对应的页码，可为负数 */
    startPage: number;
    /** 从第几个分页符开始处理（1-based），默认 1 */
    startIndex: number;
    /** 每几个处理一次，默认 1（即每个都处理） */
    every: number;
    /**
     * 自定义替换模板（仅 mode === 'custom'）。
     * 留空表示直接删除；`\p` 表示页码；`\n` 表示换行；`\\` 表示反斜杠。
     */
    customTemplate?: string;
    /**
     * 是否删除紧挨在分页符前、整行仅为空白+阿拉伯数字的页脚页码行
     *（pdftotext layout 常见形态）。默认 true。
     */
    removePrecedingPageNumber?: boolean;
}

export const DEFAULT_FORM_FEED_REPLACE_OPTIONS: FormFeedReplaceOptions = {
    mode: 'comment',
    startPage: 1,
    startIndex: 1,
    every: 1,
    removePrecedingPageNumber: true,
};

export interface FormFeedReplaceResult {
    text: string;
    /** 实际被替换（或删除）的分页符数量 */
    replacedCount: number;
    /** 文本中分页符总数 */
    totalCount: number;
    /** 随分页符一并删除的页脚页码行数 */
    removedPageNumberCount: number;
}

const FORM_FEED = '\f';

/** 页脚页码行：仅空白 + 一个非负整型阿拉伯数字（可带前后空格/Tab） */
const PAGE_NUMBER_LINE_RE = /^[ \t]*\d+[ \t]*$/;

function detectEol(text: string): '\r\n' | '\n' {
    return text.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * 展开自定义模板：`\p`→页码，`\n`→换行，`\\`→`\`。
 */
export function expandFormFeedTemplate(
    template: string,
    page: number,
    eol: string
): string {
    let out = '';
    for (let i = 0; i < template.length; i++) {
        if (template[i] === '\\' && i + 1 < template.length) {
            const next = template[i + 1];
            if (next === 'p') {
                out += String(page);
                i += 1;
                continue;
            }
            if (next === 'n') {
                out += eol;
                i += 1;
                continue;
            }
            if (next === '\\') {
                out += '\\';
                i += 1;
                continue;
            }
        }
        out += template[i];
    }
    return out;
}

function buildReplacement(
    options: FormFeedReplaceOptions,
    page: number,
    eol: string
): string {
    switch (options.mode) {
        case 'comment':
            return `${eol}${eol}<!--  page ${page} -->${eol}${eol}`;
        case 'heading':
            return `${eol}${eol}## page ${page}${eol}${eol}`;
        case 'custom':
            return expandFormFeedTemplate(options.customTemplate ?? '', page, eol);
        default: {
            const _exhaustive: never = options.mode;
            return _exhaustive;
        }
    }
}

function shouldProcess(
    oneBasedIndex: number,
    startIndex: number,
    every: number
): boolean {
    if (oneBasedIndex < startIndex) {
        return false;
    }
    return (oneBasedIndex - startIndex) % every === 0;
}

/**
 * 若 `\f` 紧前一行仅为页脚页码，返回该行起始下标；否则返回 `ffIndex`（只替换分页符本身）。
 */
export function precedingPageNumberLineStart(text: string, ffIndex: number): number {
    if (ffIndex <= 0 || text[ffIndex] !== FORM_FEED) {
        return ffIndex;
    }

    // 要求 `\f` 紧前为换行（pdftotext 常见：`…页码\n\f`）
    if (text[ffIndex - 1] !== '\n') {
        return ffIndex;
    }

    let lineContentEnd = ffIndex - 1; // 指向 `\n`
    if (lineContentEnd > 0 && text[lineContentEnd - 1] === '\r') {
        lineContentEnd -= 1; // CRLF：行内容止于 `\r` 之前
    }

    let lineStart = lineContentEnd;
    while (lineStart > 0 && text[lineStart - 1] !== '\n') {
        lineStart -= 1;
    }

    const line = text.slice(lineStart, lineContentEnd);
    if (PAGE_NUMBER_LINE_RE.test(line)) {
        return lineStart;
    }
    return ffIndex;
}

/**
 * 替换文本中的分页符。未命中「从第 x 个起每 y 个」规则的分页符保持原样。
 * 页码仅对实际处理的分页符递增。保留原文换行风格。
 */
export function replaceFormFeeds(
    text: string,
    options: FormFeedReplaceOptions = DEFAULT_FORM_FEED_REPLACE_OPTIONS
): FormFeedReplaceResult {
    const startPage = Math.trunc(options.startPage);
    const startIndex = Math.max(1, Math.floor(options.startIndex));
    const every = Math.max(1, Math.floor(options.every));
    const removePrecedingPageNumber = options.removePrecedingPageNumber !== false;
    const eol = detectEol(text);

    const ffIndices: number[] = [];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === FORM_FEED) {
            ffIndices.push(i);
        }
    }

    const totalCount = ffIndices.length;
    if (totalCount === 0) {
        return { text, replacedCount: 0, totalCount: 0, removedPageNumberCount: 0 };
    }

    type Span = { from: number; to: number; replacement: string; removedPageNum: boolean };
    const spans: Span[] = [];
    let page = startPage;
    let replacedCount = 0;
    let removedPageNumberCount = 0;

    for (let i = 0; i < ffIndices.length; i++) {
        const oneBased = i + 1;
        const ffIndex = ffIndices[i];
        if (!shouldProcess(oneBased, startIndex, every)) {
            continue;
        }

        let from = ffIndex;
        let removedPageNum = false;
        if (removePrecedingPageNumber) {
            const pageLineStart = precedingPageNumberLineStart(text, ffIndex);
            if (pageLineStart < ffIndex) {
                from = pageLineStart;
                removedPageNum = true;
            }
        }

        spans.push({
            from,
            to: ffIndex + 1,
            replacement: buildReplacement(options, page, eol),
            removedPageNum,
        });
        page += 1;
        replacedCount += 1;
        if (removedPageNum) {
            removedPageNumberCount += 1;
        }
    }

    if (spans.length === 0) {
        return { text, replacedCount: 0, totalCount, removedPageNumberCount: 0 };
    }

    // 从后往前拼接，避免下标漂移
    let result = text;
    for (let i = spans.length - 1; i >= 0; i--) {
        const { from, to, replacement } = spans[i];
        result = result.slice(0, from) + replacement + result.slice(to);
    }

    return { text: result, replacedCount, totalCount, removedPageNumberCount };
}
