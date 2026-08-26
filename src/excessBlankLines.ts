/**
 * 删除多余空行：将连续空行压到不超过指定行数。
 */

export interface DeleteExcessBlankLinesOptions {
    /** 连续空行最多保留几行（可为 0），默认 1 */
    maxConsecutive: number;
    /**
     * 仅包含空白字符的行是否视作空行，默认 true。
     * 为 true 时，保留下来的空行会去掉行内空白，写成真正的空行。
     */
    treatWhitespaceOnlyAsBlank: boolean;
}

export const DEFAULT_DELETE_EXCESS_BLANK_LINES_OPTIONS: DeleteExcessBlankLinesOptions = {
    maxConsecutive: 1,
    treatWhitespaceOnlyAsBlank: true
};

function detectEol(text: string): '\r\n' | '\n' {
    return text.includes('\r\n') ? '\r\n' : '\n';
}

function isBlankLine(line: string, treatWhitespaceOnlyAsBlank: boolean): boolean {
    if (treatWhitespaceOnlyAsBlank) {
        return /^\s*$/.test(line);
    }
    return line.length === 0;
}

/**
 * 删除多余空行。保留原文本换行风格（含 CRLF 则用 CRLF，否则 LF）。
 * 若原文以换行结尾，结果也以换行结尾。
 */
export function deleteExcessBlankLines(
    text: string,
    options: DeleteExcessBlankLinesOptions = DEFAULT_DELETE_EXCESS_BLANK_LINES_OPTIONS
): string {
    const maxConsecutive = Math.max(0, Math.floor(options.maxConsecutive));
    const treatWhitespaceOnlyAsBlank = options.treatWhitespaceOnlyAsBlank;
    const eol = detectEol(text);
    const endsWithNewline = /(?:\r?\n)$/.test(text);

    const parts = text.split(/\r?\n/);
    // 末尾空段来自文件末换行，不是独立内容行
    const lines = endsWithNewline ? parts.slice(0, -1) : parts;

    const result: string[] = [];
    let blankRun = 0;

    for (const line of lines) {
        if (isBlankLine(line, treatWhitespaceOnlyAsBlank)) {
            blankRun += 1;
            if (blankRun <= maxConsecutive) {
                result.push(treatWhitespaceOnlyAsBlank ? '' : line);
            }
        } else {
            blankRun = 0;
            result.push(line);
        }
    }

    let out = result.join(eol);
    if (endsWithNewline && result.length > 0) {
        out += eol;
    }
    return out;
}
