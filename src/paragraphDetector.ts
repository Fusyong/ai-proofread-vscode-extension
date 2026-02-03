/**
 * 段落整理工具模块
 * 用于从PDF导出的硬换行文本中整理段落格式（添加空行、删除段内分行等）
 * 换行符约定：入口处统一使用 normalizeLineEndings，内部仅按 LF 按行处理。
 */

import { normalizeLineEndings } from './utils';

/**
 * 段落整理选项
 */
export interface ParagraphFormatOptions {
    /** 是否在段末添加空行 */
    addBlankLines?: boolean;
    /** 是否删除段内分行（将段内多行合并为一行） */
    removeLineBreaks?: boolean;
}

/**
 * 整理段落格式
 * @param text 要处理的文本（每行末断开，行与行之间没有空行）
 * @param fullDocumentText 可选的完整文档文本，用于计算行长度众数。如果提供，将使用整个文档来计算众数，而不是只使用text
 * @param options 处理选项
 * @returns 处理后的文本（段落结尾处添加了空行，如果启用选项则删除段内分行）
 */
export function formatParagraphs(
    text: string,
    fullDocumentText?: string,
    options: ParagraphFormatOptions = {}
): string {
    if (!text || text.trim() === '') {
        return text;
    }
    text = normalizeLineEndings(text);
    if (fullDocumentText !== undefined && fullDocumentText !== '') {
        fullDocumentText = normalizeLineEndings(fullDocumentText);
    }

    // 如果只需要删除段内分行，不需要段落分析，直接处理
    if (options.addBlankLines === false && options.removeLineBreaks === true) {
        return removeLineBreaksInParagraphs(text);
    }

    // 将文本按行分割（已统一为 LF）
    const lines = text.split('\n');
    if (lines.length === 0) {
        return text;
    }

    // 如果需要添加空行，才需要计算行长度众数
    let mode: number = 0;
    if (options.addBlankLines !== false) {
        // 计算行长度众数：始终以整个文档为基础
        if (fullDocumentText && fullDocumentText.trim() !== '') {
            // 使用整个文档来计算众数
            const fullDocumentLines = fullDocumentText.split('\n');
            const fullDocumentNonEmptyLines = fullDocumentLines.filter(line => line.trim() !== '');
            if (fullDocumentNonEmptyLines.length > 0) {
                const fullDocumentLineLengths = fullDocumentNonEmptyLines.map(line => line.length);
                mode = calculateMode(fullDocumentLineLengths);
            } else {
                // 如果整个文档没有非空行，使用当前文本
                const nonEmptyLines = lines.filter(line => line.trim() !== '');
                if (nonEmptyLines.length === 0) {
                    // 如果没有非空行，且不需要删除段内分行，直接返回
                    if (!options.removeLineBreaks) {
                        return text;
                    }
                } else {
                    const lineLengths = nonEmptyLines.map(line => line.length);
                    mode = calculateMode(lineLengths);
                }
            }
        } else {
            // 没有提供完整文档，使用当前文本
            const nonEmptyLines = lines.filter(line => line.trim() !== '');
            if (nonEmptyLines.length === 0) {
                // 如果没有非空行，且不需要删除段内分行，直接返回
                if (!options.removeLineBreaks) {
                    return text;
                }
            } else {
                const lineLengths = nonEmptyLines.map(line => line.length);
                mode = calculateMode(lineLengths);
            }
        }
    }

    // 结束标点符号：[。！？：；—…]+[’”）]*
    // 表示一个或多个结束标点，后面可能跟着引号或右括号
    const endingPunctuation = /[。！？：；—…]+[’”）]*$/;

    // 找到最后一个非空行的索引（用于判断是否在文末/选段末尾）
    let lastNonEmptyLineIndex = -1;
    for (let j = lines.length - 1; j >= 0; j--) {
        if (lines[j].trim() !== '') {
            lastNonEmptyLineIndex = j;
            break;
        }
    }

    // 结果数组
    const result: string[] = [];

    // 遍历每一行
    for (let i = 0; i < lines.length; i++) {
        const currentLine = lines[i];
        const trimmedLine = currentLine.trim();

        // 如果是空行，直接添加
        if (trimmedLine === '') {
            result.push(currentLine);
            continue;
        }

        const currentLength = currentLine.length;
        const nextLine = i < lines.length - 1 ? lines[i + 1] : null;
        const nextTrimmedLine = nextLine ? nextLine.trim() : '';
        const nextLength = nextLine ? nextLine.length : 0;

        // 计算当前行是否是段落结尾的得分
        let score = 0;

        // 1. 行长度分析
        const lengthDiff = Math.abs(currentLength - mode);
        const isInNormalRange = lengthDiff <= 3; // 是否在正常长度范围内

        if (lengthDiff > 3) {
            // 超出众数±3字符范围，可能是段落结尾
            if (currentLength < mode - 3) {
                score += 2; // 明显短于众数，更可能是段落结尾
            } else if (currentLength > mode + 3) {
                score += 1; // 明显长于众数，可能是段落结尾（如标题行）
            }
        } else {
            // 在众数±3字符范围内，且没有结束标点，往往是正常行（减少分数）
            if (!endingPunctuation.test(trimmedLine)) {
                score -= 2; // 在正常长度范围内且无结束标点，很可能是正常行
            }
        }

        // 2. 标点符号分析
        // 在正常长度范围内，仅凭句末标点不能直接判定为段落结尾，需要结合其他特征
        if (endingPunctuation.test(trimmedLine)) {
            if (isInNormalRange) {
                // 在正常长度范围内，仅凭句末标点只给1分（需要结合其他特征才能达到3分阈值）
                score += 1;
            } else {
                // 超出正常长度范围，句末标点可以给3分（因为长度异常本身就是一个特征）
                score += 3;
            }
        }

        // 3. 首行缩进分析（下一行可能是新段落的首行）
        // 首行缩进有两种表现：
        // 1. 前面有三四个空格
        // 2. 或者没有空格，但行长少两三个字符（相对于正常行）
        if (nextLine && nextTrimmedLine !== '') {
            let isNextLineIndented = false;

            // 检查下一行是否有缩进（3-4个空格/制表符）
            const nextLineIndent = nextLine.match(/^[\s\t]{3,4}/);
            if (nextLineIndent) {
                isNextLineIndented = true;
                score += 2; // 下一行有3-4个字符的缩进，当前行很可能是段落结尾
            } else {
                // 检查下一行是否没有空格但长度少2-3个字符（相对于众数）
                // 这可能是段落首行的另一种表现
                const nextLengthDiff = mode - nextLength;
                if (nextLengthDiff >= 2 && nextLengthDiff <= 3 && !nextLine.match(/^[\s\t]/)) {
                    isNextLineIndented = true;
                    score += 2; // 下一行长度少2-3字符且无前导空格，可能是段落首行
                }
            }

            // 如果下一行有缩进特征，检查首字符是否为大写字母、数字或中文（新段落特征）
            if (isNextLineIndented) {
                const nextFirstChar = nextTrimmedLine[0];
                if (nextFirstChar && /[A-Z0-9一二三四五六七八九十]/.test(nextFirstChar)) {
                    score += 1; // 首字符符合新段落特征，进一步确认
                }
            }
        }

        // 4. 末行长度比较分析
        if (nextLine && nextTrimmedLine !== '' && currentLength < nextLength) {
            // 当前行比下一行短，且下一行更长，更可能是段落结尾
            const lengthRatio = nextLength / currentLength;
            if (lengthRatio > 1.2) {
                score += 2; // 下一行明显更长
            } else if (lengthRatio > 1.1) {
                score += 1; // 下一行稍长
            }
        }

        // 5. 当前行是文档最后一行（不添加分数，因为文末不添加空行）
        // 注意：这里不再给最后一行加分，因为文末不添加空行

        // 6. 当前行本身有缩进（可能是段落首行，但前面没有空行）
        // 这种情况下，前一行应该是段落结尾
        // 这个逻辑会在处理前一行时通过检查下一行（即当前行）的缩进来判断

        // 综合判断：得分 >= 3 时，认为是段落结尾
        result.push(currentLine);

        // 检查是否是文本的最后一行或最后一个非空行
        // 如果是，则不添加空行（文末、选段末尾不添加空行）
        const isLastLine = i === lines.length - 1;
        const isLastNonEmptyLine = i === lastNonEmptyLineIndex;

        // 只有在启用了添加空行选项，且不是最后一行且不是最后一个非空行时，才添加空行
        if (options.addBlankLines !== false && score >= 3 && !isLastLine && !isLastNonEmptyLine) {
            result.push(''); // 添加空行（默认启用，除非明确设置为false）
        }
    }

    let processedText = result.join('\n');

    // 如果启用了删除段内分行选项，则处理段内分行
    if (options.removeLineBreaks) {
        processedText = removeLineBreaksInParagraphs(processedText);
    }

    return processedText;
}

/**
 * 删除Markdown段内的分行符，但保留列表、代码块等特殊格式
 * @param text 要处理的文本
 * @returns 处理后的文本
 */
function removeLineBreaksInParagraphs(text: string): string {
    if (!text || text.trim() === '') {
        return text;
    }

    const lines = text.split('\n');
    const result: string[] = [];
    let i = 0;

    while (i < lines.length) {
        const currentLine = lines[i];
        const trimmedLine = currentLine.trim();

        // 空行直接添加
        if (trimmedLine === '') {
            result.push(currentLine);
            i++;
            continue;
        }

        // 检查是否是特殊格式（需要保留分行）
        if (isSpecialFormatLine(trimmedLine)) {
            // 处理特殊格式块（如代码块、列表等）
            const { processedLines, nextIndex } = processSpecialFormatBlock(lines, i);
            result.push(...processedLines);
            i = nextIndex;
            continue;
        }

        // 普通段落：收集段落内的所有行，合并为一行
        const paragraphLines: string[] = [];
        let inParagraph = true;

        while (inParagraph && i < lines.length) {
            const line = lines[i];
            const trimmed = line.trim();

            if (trimmed === '') {
                // 遇到空行，段落结束
                break;
            }

            if (isSpecialFormatLine(trimmed)) {
                // 遇到特殊格式，段落结束
                break;
            }

            paragraphLines.push(line);
            i++;
        }

        // 合并段落内的行（将换行符替换为空格）
        if (paragraphLines.length > 0) {
            const mergedParagraph = paragraphLines
                .map(line => line.trim())
                .filter(line => line !== '')
                .join(' ');
            result.push(mergedParagraph);
        }
    }

    return result.join('\n');
}

/**
 * 判断是否是特殊格式行（需要保留分行）
 * @param line 要检查的行（已trim）
 * @returns 是否是特殊格式
 */
function isSpecialFormatLine(line: string): boolean {
    // 标题（# 开头）
    if (/^#{1,6}\s/.test(line)) {
        return true;
    }

    // 列表项（-、*、+ 开头，或数字. 开头）
    if (/^[-*+]\s/.test(line) || /^\d+\.\s/.test(line)) {
        return true;
    }

    // 引用块（> 开头）
    if (/^>\s/.test(line)) {
        return true;
    }

    // 代码块标记（``` 或 ```）
    if (/^```/.test(line)) {
        return true;
    }

    // 分隔线（--- 或 ***）
    if (/^[-*]{3,}$/.test(line)) {
        return true;
    }

    // 表格行（| 开头和结尾）
    if (/^\|.*\|$/.test(line)) {
        return true;
    }

    return false;
}

/**
 * 处理特殊格式块（代码块、列表等），保持原样
 * @param lines 所有行
 * @param startIndex 开始索引
 * @returns 处理后的行和下一个索引
 */
function processSpecialFormatBlock(lines: string[], startIndex: number): { processedLines: string[]; nextIndex: number } {
    const processedLines: string[] = [];
    let i = startIndex;
    const firstLine = lines[i].trim();

    // 代码块（``` 开头）
    if (/^```/.test(firstLine)) {
        // 找到代码块结束
        processedLines.push(lines[i]);
        i++;
        while (i < lines.length) {
            processedLines.push(lines[i]);
            if (/^```/.test(lines[i].trim())) {
                i++;
                break;
            }
            i++;
        }
        return { processedLines, nextIndex: i };
    }

    // 列表项：收集连续的列表项
    if (/^[-*+]\s/.test(firstLine) || /^\d+\.\s/.test(firstLine)) {
        while (i < lines.length) {
            const line = lines[i];
            const trimmed = line.trim();

            if (trimmed === '') {
                // 空行可能表示列表结束，也可能只是列表项之间的分隔
                // 检查下一行是否还是列表项
                if (i + 1 < lines.length) {
                    const nextTrimmed = lines[i + 1].trim();
                    if (/^[-*+]\s/.test(nextTrimmed) || /^\d+\.\s/.test(nextTrimmed)) {
                        // 下一行还是列表项，保留空行
                        processedLines.push(line);
                        i++;
                        continue;
                    } else {
                        // 下一行不是列表项，列表结束
                        break;
                    }
                } else {
                    break;
                }
            }

            if (isSpecialFormatLine(trimmed) && !(/^[-*+]\s/.test(trimmed) || /^\d+\.\s/.test(trimmed))) {
                // 遇到其他特殊格式，列表结束
                break;
            }

            // 如果是列表项，保持原样
            if (/^[-*+]\s/.test(trimmed) || /^\d+\.\s/.test(trimmed)) {
                processedLines.push(line);
                i++;
            } else {
                // 可能是列表项的续行（缩进的行），保持原样
                processedLines.push(line);
                i++;
            }
        }
        return { processedLines, nextIndex: i };
    }

    // 其他特殊格式（标题、引用块、分隔线、表格行）：单行处理
    processedLines.push(lines[i]);
    i++;
    return { processedLines, nextIndex: i };
}

/**
 * 计算数组的众数（出现次数最多的值）
 * @param values 数值数组
 * @returns 众数值
 */
function calculateMode(values: number[]): number {
    if (values.length === 0) {
        return 0;
    }

    // 统计每个值出现的次数
    const frequency: Map<number, number> = new Map();
    for (const value of values) {
        frequency.set(value, (frequency.get(value) || 0) + 1);
    }

    // 找到出现次数最多的值
    let maxCount = 0;
    let mode = values[0];

    for (const [value, count] of frequency.entries()) {
        if (count > maxCount) {
            maxCount = count;
            mode = value;
        }
    }

    return mode;
}

