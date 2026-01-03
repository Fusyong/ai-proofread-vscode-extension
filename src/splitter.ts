/**
 * 文本切分工具模块
*/

import * as fs from 'fs';
import * as path from 'path';

/**
 * 将文本大致按长度切分（在指定长度前后最近一个空行处）
 * @param text 要切分的文本
 * @param cutBy 切分长度
 * @returns 切分后的文本列表
 */
export function splitTextByLength(text: string, cutBy: number = 600): string[] {
    // 如果长度小于50，则按50字切分
    cutBy = Math.max(50, cutBy);

    // 按行分割文本
    const lines = text.split('\n');

    // 存储切分后的文本
    const result: string[] = [];
    let currentChunk: string[] = [];
    let currentLength = 0;

    for (const line of lines) {
        currentChunk.push(line);
        currentLength += line.length;

        // 如果当前块长度超过目标长度且遇到空行，则切分
        if (currentLength >= cutBy && !line.trim()) {
            result.push(currentChunk.join('\n'));
            currentChunk = [];
            currentLength = 0;
        }
    }

    // 添加最后一个块
    if (currentChunk.length > 0) {
        result.push(currentChunk.join('\n'));
    }

    return result;
}

/**
 * 将markdown文本按标题级别切分
 * @param text markdown文本
 * @param levels 要切分的标题级别列表
 * @returns 切分后的文本列表
 */
export function splitMarkdownByTitle(text: string, levels: number[] = [2]): string[] {
    // 按行分割文本
    const lines = text.split('\n');

    // 存储切分后的段落
    const rawParagraphs: string[] = [];
    let currentParagraph: string[] = [];

    for (const line of lines) {
        // 检查是否为要切分的标题
        let isTitleToCut = false;
        for (const level of levels) {
            if (line.startsWith('#'.repeat(level) + ' ')) {
                isTitleToCut = true;
                break;
            }
        }

        if (isTitleToCut) {
            // 如果当前段落不为空，添加到结果中
            if (currentParagraph.length > 0) {
                rawParagraphs.push(currentParagraph.join('\n'));
                currentParagraph = [];
            }
            // 将当前标题行添加到新段落
            currentParagraph.push(line);
        } else {
            // 将当前行添加到当前段落
            currentParagraph.push(line);
        }
    }

    // 添加最后一个段落（如果存在）
    if (currentParagraph.length > 0) {
        rawParagraphs.push(currentParagraph.join('\n'));
    }

    return rawParagraphs;
}

/**
 * 将markdown文本按标题级别切分，然后将每个段落按长度切分，保留完整上下文
 * @param text markdown文本
 * @param levels 要切分的标题级别列表
 * @param cutBy 切分长度
 * @returns 切分后的文本列表，每个元素包含完整上下文和目标文本
 */
export function splitMarkdownByTitleAndLengthWithContext(
    text: string,
    levels: number[] = [2],
    cutBy: number = 600
): Array<{ context: string; target: string }> {
    // 先按标题切分
    const sections = splitMarkdownByTitle(text, levels);

    // 存储结果
    const result: Array<{ context: string; target: string }> = [];

    // 处理每个段落
    for (const section of sections) {
        // 将段落按长度切分
        const pieces = splitTextByLength(section, cutBy);

        // 为每个片段添加完整上下文
        pieces.forEach(piece => {
            result.push({
                context: section,  // 完整的段落作为上下文
                target: piece     // 切分后的片段作为目标文本
            });
        });
    }

    return result;
}

/**
 * 将列表中的超长段落切分为多个短段落
 * @param textList 段落列表
 * @param threshold 段落最大长度，超过此长度的段落将被拆分
 * @param cutBy 拆分长段落时的目标长度
 * @returns 处理后的段落列表
 */
export function splitTextInListByLength(textList: string[], threshold: number = 1500, cutBy: number = 800): string[] {
    const textListShort: string[] = [];
    for (const text of textList) {
        if (text.length > threshold) {
            textListShort.push(...splitTextByLength(text, cutBy));
        } else {
            textListShort.push(text);
        }
    }
    return textListShort;
}

/**
 * 合并短段落到后一段
 * @param paragraphs 段落列表
 * @param minLength 段落最小长度，小于此长度的段落将被合并
 * @returns 合并短段落后的段落列表
 */
export function mergeShortParagraphs(paragraphs: string[], minLength: number = 100): string[] {
    const result: string[] = [];
    let tempParagraphs: string[] = [];

    for (const para of paragraphs) {
        const paraLength = para.length;

        if (paraLength < minLength) {
            // 短段落暂存
            tempParagraphs.push(para);
        } else {
            // 正常长度段落
            if (tempParagraphs.length > 0) {
                // 如果有暂存段落，合并后添加
                tempParagraphs.push(para);
                result.push(tempParagraphs.join('\n'));
                tempParagraphs = [];
            } else {
                // 直接添加
                result.push(para);
            }
        }
    }

    // 处理剩余的暂存段落
    if (tempParagraphs.length > 0) {
        result.push(tempParagraphs.join('\n'));
    }

    return result;
}

export interface SplitOptions {
    mode: 'length' | 'title' | 'title-length' | 'titleContext' | 'paragraphContext';
    cutBy?: number;
    levels?: number[];
    threshold?: number;
    minLength?: number;
    beforeParagraphs?: number;
    afterParagraphs?: number;
}

/**
 * 将文本切分并生成JSON和Markdown格式的输出
 * @param text 要切分的文本
 * @param options 切分选项
 * @returns 包含JSON和Markdown格式输出的对象
 */
export function splitText(
    text: string,
    options: SplitOptions = { mode: 'length' }  // 设置默认模式为length
): {
    jsonOutput: string;
    markdownOutput: string;
    segments: Array<{ target: string; context?: string }>;
} {
    let segments: Array<{ target: string; context?: string }>;

    if (options.mode === 'length') {
        // 按长度切分
        const textList = splitTextByLength(text, options.cutBy);
        segments = textList.map(x => ({ target: x }));
    } else if (options.mode === 'title') {
        // 按标题切分
        const textList = splitMarkdownByTitle(text, options.levels);
        segments = textList.map(x => ({ target: x }));
    } else if (options.mode === 'titleContext') {
        // 按标题和长度切分，带上下文
        segments = splitMarkdownByTitleAndLengthWithContext(text, options.levels, options.cutBy);
    } else if (options.mode === 'paragraphContext') {
        // 按长度切分，使用前后段落作为上下文
        segments = splitMarkdownByLengthWithParagraphsAsContext(
            text,
            options.cutBy,
            options.beforeParagraphs,
            options.afterParagraphs
        );
    } else {
        // 标题加长度切分：先按标题切分，然后处理长短段落
        let textList = splitMarkdownByTitle(text, options.levels);
        textList = splitTextInListByLength(textList, options.threshold, options.cutBy);
        textList = mergeShortParagraphs(textList, options.minLength);
        segments = textList.map(x => ({ target: x }));
    }

    // 生成JSON输出
    const jsonOutput = JSON.stringify(segments, null, 2);

    // 生成Markdown输出（用---分隔）
    const markdownOutput = segments.map(x => x.target).join('\n---\n');

    return {
        jsonOutput,
        markdownOutput,
        segments
    };
}

/**
 * 处理文件切分
 * @param filePath 要处理的文件路径
 * @param options 切分选项
 * @returns 切分后的文件路径信息
 */
export async function handleFileSplit(
    filePath: string,
    options: {
        mode: 'length' | 'title' | 'title-length' | 'titleContext' | 'paragraphContext';
        cutBy?: number;
        levels?: number[];
        threshold?: number;
        minLength?: number;
        beforeParagraphs?: number;
        afterParagraphs?: number;
    }
): Promise<{
    jsonFilePath: string;
    markdownFilePath: string;
    logFilePath: string;
    segments: Array<{ target: string; context?: string }>;
    stats: {
        segmentCount: number;
        maxSegmentLength: number;
        minSegmentLength: number;
    };
}> {
    const text = fs.readFileSync(filePath, 'utf8');
    const currentFileDir = path.dirname(filePath);
    const baseFileName = path.basename(filePath, path.extname(filePath));

    // 生成输出文件路径
    const jsonFilePath = path.join(currentFileDir, `${baseFileName}.json`);
    const markdownFilePath = path.join(currentFileDir, `${baseFileName}.json.md`);
    const logFilePath = path.join(currentFileDir, `${baseFileName}.log`);

    // 执行文本切分
    const { jsonOutput, markdownOutput, segments } = splitText(text, options);

    // 写入JSON文件
    fs.writeFileSync(jsonFilePath, jsonOutput, 'utf8');

    // 写入Markdown文件
    fs.writeFileSync(markdownFilePath, markdownOutput, 'utf8');

    // 显示结果统计
    let statsMessage = '';
    if (options.mode === 'length') {
        statsMessage = `切分长度: ${options.cutBy}\n\n`;
    } else if (options.mode === 'title') {
        statsMessage = `切分标题级别: ${options.levels!.join(',')}\n\n`;
    } else if (options.mode === 'titleContext') {
        statsMessage = `切分模式: 以标题范围为上下文\n` +
            `标题级别: ${options.levels!.join(',')}\n` +
            `切分长度: ${options.cutBy}\n\n`;
    } else if (options.mode === 'paragraphContext') {
        statsMessage = `切分模式: 扩展前后段落为上下文\n` +
            `切分长度: ${options.cutBy}\n` +
            `前文段落数: ${options.beforeParagraphs}\n` +
            `后文段落数: ${options.afterParagraphs}\n\n`;
    } else {
        statsMessage = `切分模式: 标题加长度切分\n` +
            `标题级别: ${options.levels!.join(',')}\n` +
            `长度阈值: ${options.threshold}\n` +
            `切分长度: ${options.cutBy}\n` +
            `最小长度: ${options.minLength}\n\n`;
    }

    statsMessage += `片段号\t字符数\t上下文长度\t起始文字\n${'-'.repeat(50)}\n`;
    let totalTargetLength = 0;
    let totalContextLength = 0;
    segments.forEach((segment, index) => {
        const targetLength = segment.target.trim().length;
        const contextLength = segment.context ? segment.context.trim().length : 0;
        const firstLine = segment.target.trim().split('\n')[0].slice(0, 15);
        statsMessage += `No.${index + 1}\t${targetLength}\t${contextLength}\t${firstLine}\n`;
        totalTargetLength += targetLength;
        totalContextLength += contextLength;
    });
    if (options.mode === 'titleContext' || options.mode === 'paragraphContext') {
        statsMessage += `\n合计\t${totalTargetLength}\t${totalContextLength}\t总计${totalTargetLength + totalContextLength}`;
    } else {
        statsMessage += `\n合计\t${totalTargetLength}`;
    }

    // 写入统计信息
    const timestamp = new Date().toLocaleString();
    statsMessage = `\n[${timestamp}]\n${statsMessage}\n${'='.repeat(50)}\n`;
    fs.appendFileSync(logFilePath, statsMessage, 'utf8');

    // 计算切分统计数据
    const segmentLengths = segments.map(segment => segment.target.trim().length);
    const stats = {
        segmentCount: segments.length,
        maxSegmentLength: Math.max(...segmentLengths),
        minSegmentLength: Math.min(...segmentLengths)
    };

    return {
        jsonFilePath,
        markdownFilePath,
        logFilePath,
        segments,
        stats
    };
}

/**
 * 构建基于标题级别的上下文
 * @param text 完整文本
 * @param selectionStartLine 选中文本起始行号（从0开始）
 * @param selectionEndLine 选中文本结束行号（从0开始）
 * @param contextLevel 上下文级别（如"1"、"2"等）
 * @returns 上下文文本
 */
export function buildTitleBasedContext(
    text: string,
    selectionStartLine: number,
    selectionEndLine: number,
    contextLevel: string
): string {
    const lines = text.split('\n');
    const level = contextLevel.charAt(0);

    // 从本行开始向上查找最近的指定级别标题
    let startLine = selectionStartLine + 1;
    while (startLine > 0) {
        const line = lines[startLine - 1];
        if (line.startsWith(`${'#'.repeat(parseInt(level))} `)) {
            break;
        }
        startLine--;
    }

    // 向下查找下一个同级别标题
    let endLine = selectionEndLine;
    while (endLine < lines.length - 1) {
        const line = lines[endLine + 1];
        if (line.startsWith(`${'#'.repeat(parseInt(level))} `)) {
            break;
        }
        endLine++;
    }

    // 提取上下文
    return lines.slice(startLine-1, endLine + 1).join('\n');
}

/**
 * 构建基于前后段落的上下文
 * @param text 完整文本
 * @param selectionStartLine 选中文本起始行号（从0开始）
 * @param selectionEndLine 选中文本结束行号（从0开始）
 * @param beforeParagraphs 前文段落数量
 * @param afterParagraphs 后文段落数量
 * @returns 上下文文本
 */
export function buildParagraphBasedContext(
    text: string,
    selectionStartLine: number,
    selectionEndLine: number,
    beforeParagraphs: number = 2,
    afterParagraphs: number = 2
): string {
    // 将文本按行分割
    const textLines = text.split('\n');

    // 找到选中文本所在段落的边界
    let paragraphStart = selectionStartLine;
    let paragraphEnd = selectionEndLine;

    // 向上查找段落开始
    while (paragraphStart > 0) {
        const prevLine = textLines[paragraphStart - 1];
        if (prevLine.trim() === '') {
            // 遇到空行，说明找到了段落边界
            break;
        }
        paragraphStart--;
    }

    // 向下查找段落结束
    while (paragraphEnd < textLines.length - 1) {
        const nextLine = textLines[paragraphEnd + 1];
        if (nextLine.trim() === '') {
            // 遇到空行，说明找到了段落边界
            break;
        }
        paragraphEnd++;
    }

    // 获取前文段落
    let beforeStart = paragraphStart;
    let beforeCount = 0;

    while (beforeCount < beforeParagraphs && beforeStart > 0) {
        // 向上跳过空行
        while (beforeStart > 0 && textLines[beforeStart - 1].trim() === '') {
            beforeStart--;
        }
        // 向上查找段落开始
        while (beforeStart > 0 && textLines[beforeStart - 1].trim() !== '') {
            beforeStart--;
        }
        beforeCount++;
    }

    // 获取后文段落
    let afterEnd = paragraphEnd;
    let afterCount = 0;

    while (afterCount < afterParagraphs && afterEnd < textLines.length - 1) {
        // // 向下跳过空行
        // while (afterEnd < textLines.length - 1 && textLines[afterEnd + 1].trim() === '') {
        //     afterEnd++;
        // }
        // 向下查找段落结束
        while (afterEnd < textLines.length - 1 && textLines[afterEnd + 1].trim() !== '') {
            afterEnd++;
        }
        afterCount++;
    }

    // 提取上下文文本（包含前后段落）
    const contextStart = Math.max(0, beforeStart);
    const contextEnd = Math.min(textLines.length - 1, afterEnd);
    return textLines.slice(contextStart, contextEnd + 1).join('\n');
}

/**
 * 将markdown文本按长度切分，使用前后段落作为上下文
 * @param text markdown文本
 * @param cutBy 切分长度
 * @param beforeParagraphs 前文段落数量
 * @param afterParagraphs 后文段落数量
 * @returns 切分后的文本列表，每个元素包含完整上下文和目标文本
 */
export function splitMarkdownByLengthWithParagraphsAsContext(
    text: string,
    cutBy: number = 600,
    beforeParagraphs: number = 1,
    afterParagraphs: number = 1
): Array<{ context: string; target: string }> {
    // 按长度切分文本
    const pieces = splitTextByLength(text, cutBy);

    // 存储结果
    const result: Array<{ context: string; target: string }> = [];

    // 将文本按行分割
    const textLines = text.split('\n');

    // 为每个片段添加前后段落上下文
    pieces.forEach((piece, index) => {
        // 找到当前片段在原文中的位置
        const pieceStart = text.indexOf(piece);
        if (pieceStart === -1) {
            // 如果找不到片段，使用空上下文
            result.push({
                context: '',
                target: piece
            });
            return;
        }

        // 计算片段在文本中的行号范围
        const beforeText = text.substring(0, pieceStart);
        const targetStartLine = beforeText.split('\n').length - 1;
        const targetEndLine = targetStartLine + piece.split('\n').length - 1;

        // 找到target所在段落的边界
        let targetParagraphStart = targetStartLine;
        let targetParagraphEnd = targetEndLine;

        // 向上查找段落开始
        while (targetParagraphStart > 0) {
            const prevLine = textLines[targetParagraphStart - 1];
            if (prevLine.trim() === '') {
                break;
            }
            targetParagraphStart--;
        }

        // 向下查找段落结束
        while (targetParagraphEnd < textLines.length - 1) {
            const nextLine = textLines[targetParagraphEnd + 1];
            if (nextLine.trim() === '') {
                break;
            }
            targetParagraphEnd++;
        }

        // 获取前文段落（排除target所在段落）
        let beforeStart = targetParagraphStart;
        let beforeCount = 0;
        const beforeParagraphsList: string[] = [];

        while (beforeCount < beforeParagraphs && beforeStart > 0) {
            // 向上跳过空行
            while (beforeStart > 0 && textLines[beforeStart - 1].trim() === '') {
                beforeStart--;
            }

            // 如果已经到文档开头，停止
            if (beforeStart === 0) {
                break;
            }

            // 向上查找段落开始
            let paraStart = beforeStart;
            while (paraStart > 0 && textLines[paraStart - 1].trim() !== '') {
                paraStart--;
            }

            // 提取段落内容（不包含target所在段落）
            if (paraStart < targetParagraphStart) {
                const paraLines = textLines.slice(paraStart, targetParagraphStart);
                // 移除末尾的空行
                while (paraLines.length > 0 && paraLines[paraLines.length - 1].trim() === '') {
                    paraLines.pop();
                }
                if (paraLines.length > 0) {
                    beforeParagraphsList.unshift(paraLines.join('\n'));
                    beforeCount++;
                }
                // 更新beforeStart为当前段落开始，继续向上查找
                beforeStart = paraStart;
            } else {
                // 没有找到前文段落，停止
                break;
            }
        }

        // 获取后文段落（排除target所在段落）
        let searchStart = targetParagraphEnd;
        let afterCount = 0;
        const afterParagraphsList: string[] = [];

        while (afterCount < afterParagraphs && searchStart < textLines.length - 1) {
            // 向下跳过空行
            while (searchStart < textLines.length - 1 && textLines[searchStart + 1].trim() === '') {
                searchStart++;
            }

            // 如果已经到文档末尾，停止
            if (searchStart >= textLines.length - 1) {
                break;
            }

            // 向下查找段落结束
            let paraEnd = searchStart + 1;
            while (paraEnd < textLines.length - 1 && textLines[paraEnd + 1].trim() !== '') {
                paraEnd++;
            }

            // 提取段落内容（不包含target所在段落）
            if (paraEnd > targetParagraphEnd) {
                const paraStart = searchStart + 1;
                const paraLines = textLines.slice(paraStart, paraEnd + 1);
                // 移除开头的空行
                while (paraLines.length > 0 && paraLines[0].trim() === '') {
                    paraLines.shift();
                }
                if (paraLines.length > 0) {
                    afterParagraphsList.push(paraLines.join('\n'));
                    afterCount++;
                }
                // 更新searchStart为当前段落结束，继续向下查找下一个段落
                searchStart = paraEnd;
            } else {
                // 没有找到后文段落，停止
                break;
            }
        }

        // 构建带标签的上下文
        const contextParts: string[] = [];

        if (beforeParagraphsList.length > 0) {
            contextParts.push(`<before>\n${beforeParagraphsList.join('\n\n')}\n</before>`);
        }

        if (afterParagraphsList.length > 0) {
            contextParts.push(`<after>\n${afterParagraphsList.join('\n\n')}\n</after>`);
        }

        const contextText = contextParts.join('\n\n');

        result.push({
            context: contextText,
            target: piece
        });
    });

    return result;
}

/**
 * 获取行内句子结尾的完整结束位置（包括所有连续的句末标点和后续的引号/括号）
 * @param line 当前行
 * @param pos 当前位置
 * @returns 句子结尾的结束位置（不包含），如果不是句子结尾则返回pos
 */
function getSentenceEndPosInLine(line: string, pos: number): number {
    if (pos >= line.length) {
        return pos;
    }

    const char = line[pos];

    // 基本句末标点
    if (['。', '！', '？', '…'].includes(char)) {
        // 先收集所有连续的句末标点（允许多个连用，如 ？！！、……………………）
        let endPos = pos + 1;
        while (endPos < line.length && ['。', '！', '？', '…'].includes(line[endPos])) {
            endPos++;
        }

        // 然后检查后面是否跟引号、括号等
        const quoteChars = ['"', '”', "'", '’', '）', ']', '】', '》', '」', '』'];
        while (endPos < line.length && quoteChars.includes(line[endPos])) {
            endPos++;
        }

        // 中文句号总是句子结尾（小数点应该是英文句号.）
        return endPos;
    }

    // 英文句号
    if (char === '.') {
        // 如果前后都是数字，可能是小数点
        if (pos > 0 && pos < line.length - 1) {
            if (/\d/.test(line[pos - 1]) && /\d/.test(line[pos + 1])) {
                return pos; // 不是句子结尾
            }
        }
        // 如果后面跟的是小写字母或数字，可能不是句子结尾
        if (pos < line.length - 1) {
            const nextChar = line[pos + 1];
            if (/[a-z0-9]/.test(nextChar)) {
                return pos; // 不是句子结尾
            }
        }
        // 在中文文本中，英文句号也可能是句子结尾
        if (pos > 0) {
            const prevChar = line[pos - 1];
            // 检查前一个字符是否是中文
            if (/[\u4e00-\u9fff]/.test(prevChar)) {
                let endPos = pos + 1;
                // 检查后面是否跟引号、括号等
                const quoteChars = ['"', '”', "'", '’', '）', ']', '】', '》', '」', '』'];
                while (endPos < line.length && quoteChars.includes(line[endPos])) {
                    endPos++;
                }
                return endPos;
            }
        }
        // 检查是否是数字后的句号（可能是小数点）
        if (char === '.' && pos > 0) {
            const prevChar = line[pos - 1];
            if (/\d/.test(prevChar) && pos < line.length && /\d/.test(line[pos])) {
                return pos; // 不是句子结尾
            }
        }
    }

    return pos; // 不是句子结尾
}

/**
 * 判断是否是Markdown标题
 */
function isMarkdownTitle(line: string): boolean {
    const stripped = line.trim();
    if (!stripped.startsWith('#')) {
        return false;
    }
    // 检查格式：## 标题 或 ## 标题（多个#号）
    if (stripped.length > 1) {
        return stripped[1] === ' ' || stripped[1] === '#';
    }
    return false;
}

/**
 * 判断是否是列表项
 */
function isListItem(line: string): boolean {
    const stripped = line.trim();
    // 无序列表：-、*、+
    if (stripped.match(/^[-*+]\s/)) {
        return true;
    }
    // 有序列表：数字. 或 数字)
    if (stripped.match(/^\d+[.)]\s/)) {
        return true;
    }
    return false;
}

/**
 * 提取列表项的内容部分（去除标记）
 */
function extractListContent(line: string): string {
    const stripped = line.trim();
    // 无序列表
    const match1 = stripped.match(/^[-*+]\s+(.+)/);
    if (match1) {
        return match1[1].trim();
    }
    // 有序列表
    const match2 = stripped.match(/^\d+[.)]\s+(.+)/);
    if (match2) {
        return match2[1].trim();
    }
    return stripped;
}

/**
 * 判断文本是否以句末标点结尾
 */
function endsWithSentencePunct(text: string): boolean {
    if (!text) {
        return false;
    }
    // 去除末尾可能的引号、括号等
    text = text.replace(/["”'’)）\]】》」』]+$/, '');
    if (!text) {
        return false;
    }
    return ['。', '！', '？', '…', '.', '!', '?'].includes(text[text.length - 1]);
}

/**
 * 切分中文句子
 * @param text 要切分的文本
 * @param preserveFormatting 是否保留格式（如Markdown标记）
 * @returns 切分后的句子列表
 */
export function splitChineseSentences(
    text: string,
    preserveFormatting: boolean = true
): string[] {
    if (!text || text.trim().length === 0) {
        return [];
    }

    const sentences: string[] = [];
    let currentSentence: string[] = [];
    let inQuote = false;
    let quoteChar: string | null = null;

    // 如果保留格式，使用splitlines并保留换行符（类似Python的splitlines(keepends=True)）
    // Python的splitlines(keepends=True)的行为：
    // - 每一行（除了最后一行）都会保留换行符
    // - 如果文本以换行符结尾，最后一行也会保留换行符
    // - 空行会被保留为'\n'
    // - 如果文本以换行符结尾，split会产生一个最后的空字符串，需要特殊处理
    const lines = preserveFormatting
        ? (() => {
            const parts = text.split(/\r?\n/);
            const result: string[] = [];
            const endsWithNewline = text.endsWith('\n') || text.endsWith('\r\n');

            for (let i = 0; i < parts.length; i++) {
                if (i < parts.length - 1) {
                    // 不是最后一部分，添加换行符
                    result.push(parts[i] + '\n');
                } else {
                    // 最后一部分
                    if (endsWithNewline && parts[i] === '') {
                        // 文本以换行符结尾且最后一部分是空字符串
                        // 这表示最后有一个空行，应该保留为'\n'
                        result.push('\n');
                    } else {
                        // 最后一部分非空，或者文本不以换行符结尾
                        result.push(parts[i]);
                    }
                }
            }
            return result;
        })()
        : [text];

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        const isLastLine = lineIdx === lines.length - 1;

        // 检查是否是标题或列表项
        const isTitle = preserveFormatting && isMarkdownTitle(line);
        const isList = preserveFormatting && isListItem(line);
        const isEmptyLine = !line.trim();

        // 如果遇到空行，且当前句子不为空，则切分
        if (isEmptyLine && currentSentence.length > 0) {
            const sentence = currentSentence.join('').trim();
            if (sentence) {
                sentences.push(sentence);
            }
            currentSentence = [];
            continue;
        }

        // 处理标题：标题本身作为一句，即使没有标点
        if (isTitle) {
            if (currentSentence.length > 0) {
                const sentence = currentSentence.join('').trim();
                if (sentence) {
                    sentences.push(sentence);
                }
                currentSentence = [];
            }
            sentences.push(line.trimEnd());
            continue;
        }

        // 处理列表项：列表项末尾可能没有标点，但遇到空行或新列表项时切分
        if (isList) {
            // 如果当前句子不为空，先保存
            if (currentSentence.length > 0) {
                const sentence = currentSentence.join('').trim();
                if (sentence) {
                    sentences.push(sentence);
                }
                currentSentence = [];
            }

            // 检查列表项内容是否以句末标点结尾
            const listContent = extractListContent(line);
            if (listContent && endsWithSentencePunct(listContent)) {
                sentences.push(line.trimEnd());
            } else {
                // 列表项没有句末标点，先暂存，等待后续内容或空行
                // line已经包含换行符（因为splitlines(keepends=True)的效果）
                currentSentence.push(line);
            }
            continue;
        }

        // 普通文本行：逐字符处理
        let i = 0;
        while (i < line.length) {
            const char = line[i];
            currentSentence.push(char);

            // 处理引号状态
            const quoteChars = ['“', '”', "‘", '’', '「', '」', '『', '』'];
            if (quoteChars.includes(char)) {
                if (!inQuote) {
                    inQuote = true;
                    quoteChar = char;
                } else if (char === quoteChar ||
                          (['“', '”'].includes(char) && ['“', '”'].includes(quoteChar || ''))) {
                    inQuote = false;
                    quoteChar = null;
                }
            }

            // 检查是否是句子结尾（不在引号内）
            if (!inQuote) {
                const endPos = getSentenceEndPosInLine(line, i);
                if (endPos > i) {
                    // 收集从当前位置+1到句子结尾的所有字符（当前位置已添加）
                    for (let j = i + 1; j < endPos; j++) {
                        if (j < line.length) {
                            currentSentence.push(line[j]);
                        }
                    }
                    const sentence = currentSentence.join('').trim();
                    if (sentence) {
                        sentences.push(sentence);
                    }
                    currentSentence = [];
                    i = endPos;
                    continue;
                }
            }

            i++;
        }

        // 注意：line已经包含换行符（因为splitlines(keepends=True)的效果），不需要额外添加

        // 如果当前行以列表项或标题结尾，且下一行是空行或新列表项/标题，则切分
        if (currentSentence.length > 0 && !isLastLine && preserveFormatting) {
            const nextLine = lines[lineIdx + 1];
            if (!nextLine.trim() || isMarkdownTitle(nextLine) || isListItem(nextLine)) {
                const sentence = currentSentence.join('').trim();
                if (sentence) {
                    sentences.push(sentence);
                }
                currentSentence = [];
            }
        }
    }

    // 处理最后一句
    if (currentSentence.length > 0) {
        const sentence = currentSentence.join('').trim();
        if (sentence) {
            sentences.push(sentence);
        }
    }

    // Python代码在添加句子时已经检查了if sentence，所以理论上不应该有空句子
    // 但为了安全起见，我们仍然过滤空句子
    return sentences.filter(s => s.length > 0);
}

/**
 * 切分中文句子并跟踪行号
 * @param text 要切分的文本
 * @param preserveFormatting 是否保留格式（如Markdown标记）
 * @returns 切分后的句子列表，每个元素为 [sentence, startLine, endLine]
 */
export function splitChineseSentencesWithLineNumbers(
    text: string,
    preserveFormatting: boolean = true
): Array<[string, number, number]> {
    if (!text || text.trim().length === 0) {
        return [];
    }

    const sentences: Array<[string, number, number]> = [];
    let currentSentence: string[] = [];
    let sentenceStartLine = 1; // 当前句子开始的行号（从1开始）
    let inQuote = false;
    let quoteChar: string | null = null;

    // 如果保留格式，使用splitlines并保留换行符（类似Python的splitlines(keepends=True)）
    // Python的splitlines(keepends=True)的行为：
    // - 每一行（除了最后一行）都会保留换行符
    // - 如果文本以换行符结尾，最后一行也会保留换行符
    // - 空行会被保留为'\n'
    // - 如果文本以换行符结尾，split会产生一个最后的空字符串，需要特殊处理
    const lines = preserveFormatting
        ? (() => {
            const parts = text.split(/\r?\n/);
            const result: string[] = [];
            const endsWithNewline = text.endsWith('\n') || text.endsWith('\r\n');

            for (let i = 0; i < parts.length; i++) {
                if (i < parts.length - 1) {
                    // 不是最后一部分，添加换行符
                    result.push(parts[i] + '\n');
                } else {
                    // 最后一部分
                    if (endsWithNewline && parts[i] === '') {
                        // 文本以换行符结尾且最后一部分是空字符串
                        // 这表示最后有一个空行，应该保留为'\n'
                        result.push('\n');
                    } else {
                        // 最后一部分非空，或者文本不以换行符结尾
                        result.push(parts[i]);
                    }
                }
            }
            return result;
        })()
        : [text];

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        const currentLineNumber = lineIdx + 1; // 当前行号（从1开始）
        const isLastLine = lineIdx === lines.length - 1;

        // 检查是否是标题或列表项
        const isTitle = preserveFormatting && isMarkdownTitle(line);
        const isList = preserveFormatting && isListItem(line);
        const isEmptyLine = !line.trim();

        // 如果遇到空行，且当前句子不为空，则切分
        if (isEmptyLine && currentSentence.length > 0) {
            const sentence = currentSentence.join('').trim();
            if (sentence) {
                // 句子结束行是上一行（空行之前）
                const endLine = currentLineNumber > 1 ? currentLineNumber - 1 : 1;
                sentences.push([sentence, sentenceStartLine, endLine]);
            }
            currentSentence = [];
            continue;
        }

        // 处理标题：标题本身作为一句，即使没有标点
        if (isTitle) {
            if (currentSentence.length > 0) {
                const sentence = currentSentence.join('').trim();
                if (sentence) {
                    // 句子结束行是上一行（标题之前）
                    const endLine = currentLineNumber > 1 ? currentLineNumber - 1 : 1;
                    sentences.push([sentence, sentenceStartLine, endLine]);
                }
                currentSentence = [];
            }
            // 标题本身作为一句
            const titleText = line.trimEnd();
            if (titleText) {
                sentences.push([titleText, currentLineNumber, currentLineNumber]);
            }
            continue;
        }

        // 处理列表项：列表项末尾可能没有标点，但遇到空行或新列表项时切分
        if (isList) {
            // 如果当前句子不为空，先保存
            if (currentSentence.length > 0) {
                const sentence = currentSentence.join('').trim();
                if (sentence) {
                    // 句子结束行是上一行（列表项之前）
                    const endLine = currentLineNumber > 1 ? currentLineNumber - 1 : 1;
                    sentences.push([sentence, sentenceStartLine, endLine]);
                }
                currentSentence = [];
            }
            sentenceStartLine = currentLineNumber;

            // 检查列表项内容是否以句末标点结尾
            const listContent = extractListContent(line);
            if (listContent && endsWithSentencePunct(listContent)) {
                const listText = line.trimEnd();
                if (listText) {
                    sentences.push([listText, currentLineNumber, currentLineNumber]);
                }
            } else {
                // 列表项没有句末标点，先暂存，等待后续内容或空行
                if (currentSentence.length === 0) {
                    sentenceStartLine = currentLineNumber;
                }
                // line已经包含换行符（因为splitlines(keepends=True)的效果）
                currentSentence.push(line);
            }
            continue;
        }

        // 普通文本行：逐字符处理
        if (currentSentence.length === 0) {
            sentenceStartLine = currentLineNumber;
        }

        let i = 0;
        while (i < line.length) {
            const char = line[i];
            currentSentence.push(char);

            // 处理引号状态
            const quoteChars = ['“', '”', "‘", '’', '「', '」', '『', '』'];
            if (quoteChars.includes(char)) {
                if (!inQuote) {
                    inQuote = true;
                    quoteChar = char;
                } else if (char === quoteChar ||
                          (['“', '”'].includes(char) && ['“', '”'].includes(quoteChar || ''))) {
                    inQuote = false;
                    quoteChar = null;
                }
            }

            // 检查是否是句子结尾（不在引号内）
            if (!inQuote) {
                const endPos = getSentenceEndPosInLine(line, i);
                if (endPos > i) {
                    // 收集从当前位置+1到句子结尾的所有字符（当前位置已添加）
                    for (let j = i + 1; j < endPos; j++) {
                        if (j < line.length) {
                            currentSentence.push(line[j]);
                        }
                    }
                    const sentence = currentSentence.join('').trim();
                    if (sentence) {
                        sentences.push([sentence, sentenceStartLine, currentLineNumber]);
                    }
                    currentSentence = [];
                    i = endPos;
                    continue;
                }
            }

            i++;
        }

        // 注意：line已经包含换行符（因为splitlines(keepends=True)的效果），不需要额外添加

        // 如果当前行以列表项或标题结尾，且下一行是空行或新列表项/标题，则切分
        if (currentSentence.length > 0 && !isLastLine && preserveFormatting) {
            const nextLine = lines[lineIdx + 1];
            if (!nextLine.trim() || isMarkdownTitle(nextLine) || isListItem(nextLine)) {
                const sentence = currentSentence.join('').trim();
                if (sentence) {
                    sentences.push([sentence, sentenceStartLine, currentLineNumber]);
                }
                currentSentence = [];
            }
        }
    }

    // 处理最后一句
    if (currentSentence.length > 0) {
        const sentence = currentSentence.join('').trim();
        if (sentence) {
            // 最后一句结束行是最后一行
            const lastLineNumber = lines.length;
            sentences.push([sentence, sentenceStartLine, lastLineNumber]);
        }
    }

    // 过滤空句子
    return sentences.filter(([s]) => s.length > 0);
}