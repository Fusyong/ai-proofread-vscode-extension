/**
 * 删除行中空白字符
 *
 * 仅删除半角空格（不处理 Tab、全角空格）。
 * 删除条件：空格两侧至少一侧为汉字，另一侧为汉字、中文标点、拉丁字母或阿拉伯数字。
 */

/** 汉字 */
const HAN_CHAR_RE = /\p{Script=Han}/u;

/** 仅半角空格（不含 Tab、全角空格、换行） */
const HALFWIDTH_SPACE_RUN_RE = / +/g;

/** 拉丁字母：半角 A-Za-z、全角 Ａ-Ｚａ-ｚ */
const LATIN_LETTER_RE = /[A-Za-zＡ-Ｚａ-ｚ]/u;

/** 阿拉伯数字：半角 0-9、全角 ０-９ */
const ARABIC_DIGIT_RE = /[0-9０-９]/u;

export interface DeleteInlineWhitespaceOptions {
    /** 仅删除连续个数小于等于此值的空白序列，默认 1 */
    maxConsecutive: number;
    /** 保留行首行尾半角空格，默认 true */
    preserveLineEdges: boolean;
}

export const DEFAULT_DELETE_INLINE_WHITESPACE_OPTIONS: DeleteInlineWhitespaceOptions = {
    maxConsecutive: 1,
    preserveLineEdges: true
};

function isHanChar(ch: string): boolean {
    return ch.length > 0 && HAN_CHAR_RE.test(ch);
}

/** 中文标点：Unicode 标点，但不含 ASCII 拉丁标点 */
function isChinesePunctuation(ch: string): boolean {
    if (!ch || /[\x21-\x7e]/.test(ch)) {
        return false;
    }
    return /\p{P}/u.test(ch);
}

function isLatinLetter(ch: string): boolean {
    return LATIN_LETTER_RE.test(ch);
}

function isArabicDigit(ch: string): boolean {
    return ARABIC_DIGIT_RE.test(ch);
}

/** 可与汉字配对、从而删除其间半角空格的字符 */
function isAllowedHanNeighbor(ch: string): boolean {
    return isHanChar(ch) || isChinesePunctuation(ch) || isLatinLetter(ch) || isArabicDigit(ch);
}

function shouldDeleteWhitespaceRun(
    match: string,
    charBefore: string,
    charAfter: string,
    options: DeleteInlineWhitespaceOptions
): boolean {
    if (match.length > options.maxConsecutive) {
        return false;
    }
    if (!charBefore || !charAfter) {
        return false;
    }
    return (
        (isHanChar(charBefore) || isHanChar(charAfter)) &&
        isAllowedHanNeighbor(charBefore) &&
        isAllowedHanNeighbor(charAfter)
    );
}

function processLineMiddle(middle: string, options: DeleteInlineWhitespaceOptions): string {
    return middle.replace(HALFWIDTH_SPACE_RUN_RE, (match, offset: number) => {
        const charBefore = offset > 0 ? middle[offset - 1] : '';
        const charAfter =
            offset + match.length < middle.length ? middle[offset + match.length] : '';
        return shouldDeleteWhitespaceRun(match, charBefore, charAfter, options) ? '' : match;
    });
}

function processLine(line: string, options: DeleteInlineWhitespaceOptions): string {
    if (!options.preserveLineEdges) {
        return processLineMiddle(line, options);
    }

    const leadingMatch = line.match(/^ */);
    const leading = leadingMatch ? leadingMatch[0] : '';
    const trailingMatch = line.match(/ *$/);
    const trailing = trailingMatch ? trailingMatch[0] : '';
    if (leading.length + trailing.length >= line.length) {
        return line;
    }
    const middle = line.slice(leading.length, line.length - trailing.length);
    return leading + processLineMiddle(middle, options) + trailing;
}

/**
 * 删除文本行内符合条件的半角空格，保留换行结构。
 */
export function deleteInlineWhitespace(
    text: string,
    options: DeleteInlineWhitespaceOptions = DEFAULT_DELETE_INLINE_WHITESPACE_OPTIONS
): string {
    const segments = text.split(/(\r\n|\r|\n)/);
    for (let i = 0; i < segments.length; i += 2) {
        segments[i] = processLine(segments[i], options);
    }
    return segments.join('');
}
