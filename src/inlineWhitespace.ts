/**
 * 删除行中空白字符（仅处理汉字、中文标点之间的空白）
 */

/** 汉字 */
const HAN_CHAR_RE = /\p{Script=Han}/u;

/** 行内空白（不含换行） */
const INLINE_WHITESPACE_RUN_RE = /[ \t\u3000]+/g;

export interface DeleteInlineWhitespaceOptions {
    /** 仅删除连续个数小于等于此值的空白序列，默认 1 */
    maxConsecutive: number;
    /** 保留行首行尾空白，默认 true */
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

function isHanOrChinesePunctuation(ch: string): boolean {
    return isHanChar(ch) || isChinesePunctuation(ch);
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
    return isHanOrChinesePunctuation(charBefore) && isHanOrChinesePunctuation(charAfter);
}

function processLineMiddle(middle: string, options: DeleteInlineWhitespaceOptions): string {
    return middle.replace(INLINE_WHITESPACE_RUN_RE, (match, offset: number) => {
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

    const leadingMatch = line.match(/^[ \t\u3000]*/);
    const leading = leadingMatch ? leadingMatch[0] : '';
    const trailingMatch = line.match(/[ \t\u3000]*$/);
    const trailing = trailingMatch ? trailingMatch[0] : '';
    const middle = line.slice(leading.length, line.length - trailing.length);
    return leading + processLineMiddle(middle, options) + trailing;
}

/**
 * 删除文本行内符合条件的空白字符，保留换行结构。
 * 仅删除汉字与中文标点之间的空白。
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
