/**
 * 文本切分工具模块
 * 换行符约定：所有接受外部文本的入口处统一调用 normalizeLineEndings，内部仅使用 LF (\n)。
 */

import * as fs from 'fs';
import * as path from 'path';
import { normalizeLineEndings } from './utils';

/**
 * 将文本大致按长度切分（在指定长度前后最近一个空行处）
 * @param text 要切分的文本
 * @param cutBy 切分长度
 * @returns 切分后的文本列表
 */
export function splitTextByLength(text: string, cutBy: number = 600): string[] {
    text = normalizeLineEndings(text);
    // 如果长度小于50，则按50字切分
    cutBy = Math.max(50, cutBy);

    // 按行分割文本（已统一为 LF，行间仅 \n）
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
    text = normalizeLineEndings(text);
    // 按行分割文本（已统一为 LF）
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
    text = normalizeLineEndings(text);
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
    const rawText = fs.readFileSync(filePath, 'utf8');
    const text = normalizeLineEndings(rawText);
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
    text = normalizeLineEndings(text);
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
 * 构建基于前后段落的上下文（带标签格式）
 * @param text 完整文本
 * @param selectionStart 选中文本起始字符位置（从0开始）
 * @param selectionEnd 选中文本结束字符位置（从0开始，不包含）
 * @param beforeParagraphs 前文段落数量
 * @param afterParagraphs 后文段落数量
 * @returns 带标签的上下文文本，格式为 <before>...</before> 和 <after>...</after>
 */
export function buildParagraphBasedContext(
    text: string,
    selectionStart: number,
    selectionEnd: number,
    beforeParagraphs: number = 2,
    afterParagraphs: number = 2
): string {
    text = normalizeLineEndings(text);
    // 将文本按行分割（已统一为 LF，行间 +1 即换行符）
    const textLines = text.split('\n');

    // 计算选中文本的行号范围
    const beforeSelectionText = text.substring(0, selectionStart);
    const selectionStartLine = beforeSelectionText.split('\n').length - 1;
    const selectionText = text.substring(selectionStart, selectionEnd);
    const selectionEndLine = selectionStartLine + selectionText.split('\n').length - 1;

    // 找到选中文本所在段落的边界
    let paragraphStart = selectionStartLine;
    let paragraphEnd = selectionEndLine;

    // 如果selectionEndLine指向空行，向上找到最后一个非空行
    while (paragraphEnd >= paragraphStart && paragraphEnd < textLines.length && textLines[paragraphEnd].trim() === '') {
        paragraphEnd--;
    }
    // 确保paragraphEnd不小于paragraphStart
    if (paragraphEnd < paragraphStart) {
        paragraphEnd = paragraphStart;
    }

    // 向上查找段落开始
    while (paragraphStart > 0) {
        const prevLine = textLines[paragraphStart - 1];
        if (prevLine.trim() === '') {
            // 遇到空行，说明找到了段落边界
            break;
        }
        paragraphStart--;
    }

    // 向下查找段落结束（确保包含所有连续的非空行）
    while (paragraphEnd < textLines.length - 1) {
        const nextLine = textLines[paragraphEnd + 1];
        if (nextLine.trim() === '') {
            // 遇到空行，说明找到了段落边界
            break;
        }
        paragraphEnd++;
    }

    // 获取前文段落（排除target所在段落）
    let beforeStart = paragraphStart;
    let beforeCount = 0;
    const beforeParagraphsList: string[] = [];

    // 如果选中文本前面还有文字（在同一个段落内），先添加这部分作为第一个before段落
    // 使用字符位置精确提取，而不是行号
    if (selectionStart > 0) {
        // 找到段落开始的字符位置
        let paragraphStartPos = 0;
        for (let i = 0; i < paragraphStart; i++) {
            paragraphStartPos += textLines[i].length + 1; // +1 为换行符 \n（已统一为 LF）
        }

        // 如果选中文本开始位置大于段落开始位置，说明前面有文字
        if (selectionStart > paragraphStartPos) {
            const beforeText = text.substring(paragraphStartPos, selectionStart);
            // 移除末尾的空行和空白字符
            const trimmedBeforeText = beforeText.replace(/\s+$/, '');
            if (trimmedBeforeText.trim().length > 0) {
                beforeParagraphsList.push(trimmedBeforeText);
                beforeCount++;
            }
        }
    }

    // 继续向上查找其他前文段落
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
        if (paraStart < paragraphStart) {
            const paraLines = textLines.slice(paraStart, paragraphStart);
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
    let afterCount = 0;
    const afterParagraphsList: string[] = [];

    // 如果选中文本后面还有文字（在同一个段落内），先添加这部分作为第一个after段落
    // 使用字符位置精确提取，而不是行号
    if (selectionEnd < text.length) {
        // 找到段落结束的字符位置（包含段落最后一行的最后一个字符）
        let paragraphEndPos = 0;
        for (let i = 0; i <= paragraphEnd; i++) {
            paragraphEndPos += textLines[i].length;
            if (i < paragraphEnd) {
                paragraphEndPos += 1; // +1 为换行符 \n（已统一为 LF）
            }
        }

        // 如果选中文本结束位置小于段落结束位置，说明后面有文字
        if (selectionEnd < paragraphEndPos) {
            const afterText = text.substring(selectionEnd, paragraphEndPos);
            // 移除开头的空白字符和空行
            const trimmedAfterText = afterText.replace(/^\s+/, '');
            // 移除末尾的空行和空白字符
            const finalAfterText = trimmedAfterText.replace(/\s+$/, '');
            if (finalAfterText.trim().length > 0) {
                afterParagraphsList.push(finalAfterText);
                afterCount++;
            }
        }
    }

    // 继续向下查找其他后文段落
    // 从paragraphEnd的下一个位置开始查找（paragraphEnd是当前段落的最后一行）
    let searchStart = paragraphEnd;
    while (afterCount < afterParagraphs && searchStart < textLines.length - 1) {
        // 移动到下一个位置（跳过当前段落）
        searchStart++;

        // 向下跳过空行（包括只包含空白字符的行）
        while (searchStart < textLines.length && textLines[searchStart].trim() === '') {
            searchStart++;
        }

        // 如果已经到文档末尾，停止
        if (searchStart >= textLines.length) {
            break;
        }

        // 找到下一个段落的开始位置
        const paraStart = searchStart;

        // 向下查找段落结束
        let paraEnd = paraStart;
        while (paraEnd < textLines.length - 1 && textLines[paraEnd + 1].trim() !== '') {
            paraEnd++;
        }

        // 提取段落内容
        const paraLines = textLines.slice(paraStart, paraEnd + 1);
        // 移除开头的空行（虽然理论上不应该有，但为了安全）
        while (paraLines.length > 0 && paraLines[0].trim() === '') {
            paraLines.shift();
        }
        if (paraLines.length > 0) {
            afterParagraphsList.push(paraLines.join('\n'));
            afterCount++;
        }
        // 更新searchStart为当前段落结束，继续向下查找下一个段落
        searchStart = paraEnd;
    }

    // 构建带标签的上下文
    const contextParts: string[] = [];

    if (beforeParagraphsList.length > 0) {
        contextParts.push(`<before>\n${beforeParagraphsList.join('\n\n')}\n</before>`);
    }

    if (afterParagraphsList.length > 0) {
        contextParts.push(`<after>\n${afterParagraphsList.join('\n\n')}\n</after>`);
    }

    return contextParts.join('\n\n');
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
    text = normalizeLineEndings(text);
    // 按长度切分文本
    const pieces = splitTextByLength(text, cutBy);

    // 存储结果
    const result: Array<{ context: string; target: string }> = [];

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

        // 计算片段的字符位置范围
        const pieceEnd = pieceStart + piece.length;

        // 使用buildParagraphBasedContext获取带标签的上下文
        const contextText = buildParagraphBasedContext(
            text,
            pieceStart,
            pieceEnd,
            beforeParagraphs,
            afterParagraphs
        );

        result.push({
            context: contextText,
            target: piece
        });
    });

    return result;
}

/**
 * 判断是否是Markdown标题（内部辅助函数）
 */
function _isMarkdownTitle(line: string): boolean {
    const stripped = line.trimStart();
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
 * 判断是否是列表项（内部辅助函数）
 */
function _isListItem(line: string): boolean {
    const stripped = line.trimStart();
    // 无序列表：-、*、+
    if (stripped.startsWith('- ') || stripped.startsWith('* ') || stripped.startsWith('+ ')) {
        return true;
    }
    // 有序列表：数字. 或 数字)
    if (/^\d+[.)]\s+/.test(stripped)) {
        return true;
    }
    return false;
}

/**
 * 简化版中文句子切分（按句末标点和连续换行切分，保留所有空白字符）
 *
 * 适用于纯文本，不考虑Markdown格式、列表项等特殊情况。
 * 连续两个以上的换行（忽略行中空白字符）视作句子结束标记。
 *
 * 基于Python版本的split_chinese_sentences_simple实现
 *
 * @param text 要切分的文本
 * @returns 切分后的句子列表（保留所有空白字符，包括首尾换行符）
 */
export function splitChineseSentencesSimple(text: string): string[] {
    text = normalizeLineEndings(text);

    // 句子结尾模式：
    // 1. 句末标点：[。！？…]+ 后面可能跟引号、括号等（含弯引号 ""'' 与直引号 " ' U+201d U+2019，后引号归属上一句）
    // 2. 英文句号（需要排除小数点等情况）
    // 3. 连续两个以上的换行（忽略行中空白字符）：\n[\s]*\n+
    const pattern = /([。！？…]+["')）\]】」』\u201d\u2019]*)|([.!?]+["')）\]】」』\u201d\u2019]*)|(\n(\s*\n)+)/g;

    const sentences: string[] = [];
    let lastEnd = 0;
    let match: RegExpExecArray | null;

    // 重置正则表达式的lastIndex
    pattern.lastIndex = 0;

    while ((match = pattern.exec(text)) !== null) {
        let endPos = match.index + match[0].length;

        // 检查是否是小数点或缩写
        if (match[2]) {  // 英文标点
            // 检查前后是否是数字
            if (endPos > 0 && endPos <= text.length && text[endPos - 1] === '.') {
                const prevPos = match.index - 1;
                if (prevPos >= 0 && /\d/.test(text[prevPos])) {
                    if (endPos < text.length && /\d/.test(text[endPos])) {
                        continue;  // 是小数点，跳过
                    }
                }
            }
        }

        // 如果是句末标点（不是连续换行），需要包含后面的换行符和空行
        // 直到遇到下一个非空行
        if (match[1] || match[2]) {  // 句末标点
            // 从endPos开始，查找后面的换行符和空行
            let trailingPos = endPos;
            while (trailingPos < text.length) {
                // 检查当前位置是否是换行符
                if (text[trailingPos] === '\n') {
                    trailingPos += 1;
                    // 检查后面是否还有空行（只包含空白字符的行）
                    // 查找下一个换行符或非空白字符
                    let tempPos = trailingPos;
                    while (tempPos < text.length && (text[tempPos] === ' ' || text[tempPos] === '\t')) {
                        tempPos += 1;
                    }
                    // 如果下一个字符是换行符，说明是空行，继续包含
                    if (tempPos < text.length && text[tempPos] === '\n') {
                        trailingPos = tempPos + 1;
                        continue;
                    }
                    // 如果下一个字符是非空白字符，停止
                    else if (tempPos < text.length && !/\s/.test(text[tempPos])) {
                        break;
                    }
                    // 如果到达文本末尾，停止
                    else {
                        break;
                    }
                } else {
                    // 不是换行符，停止
                    break;
                }
            }

            // 更新endPos以包含后面的换行符和空行
            endPos = trailingPos;
        }

        // 提取句子
        const sentence = text.substring(lastEnd, endPos);
        if (sentence) {
            sentences.push(sentence);
        }
        lastEnd = endPos;
    }

    // 添加最后一句
    if (lastEnd < text.length) {
        const sentence = text.substring(lastEnd);
        if (sentence) {
            sentences.push(sentence);
        }
    }

    return sentences;
}

/**
 * 将中文文本按句子切分（基于splitChineseSentencesSimple，增加Markdown特殊处理）
 *
 * 特殊处理：
 * 1. Markdown标题作为一句，不切分
 * 2. Markdown列表中每一项作为一句，不切分
 * 3. 其他文本使用splitChineseSentencesSimple进行切分
 * 4. 保留所有空白字符（包括首尾换行符），任何时候都保持原文不变
 *
 * 基于Python版本的split_chinese_sentences实现
 *
 * @param text 要切分的文本
 * @returns 切分后的句子列表（保留所有空白字符）
 */
export function splitChineseSentences(text: string): string[] {
    if (!text || !text.trim()) {
        return [];
    }

    text = normalizeLineEndings(text);
    // 按行分割并保留每行末尾的 \n（类似 Python splitlines(keepends=True)）；内部已统一为 LF
    const lines: string[] = [];
    let lastIndex = 0;
    let idx: number;
    while ((idx = text.indexOf('\n', lastIndex)) !== -1) {
        lines.push(text.substring(lastIndex, idx + 1));
        lastIndex = idx + 1;
    }
    if (lastIndex < text.length) {
        lines.push(text.substring(lastIndex));
    } else if (text.endsWith('\n')) {
        lines.push('\n');
    }

    const sentences: string[] = [];
    const currentText: string[] = [];  // 收集普通文本（非标题、非列表项）

    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        const isTitle = _isMarkdownTitle(line);
        const isListItem = _isListItem(line);

        // 处理Markdown标题：作为完整句子
        if (isTitle) {
            // 先处理之前收集的普通文本
            if (currentText.length > 0) {
                const textChunk = currentText.join('');
                const chunkSentences = splitChineseSentencesSimple(textChunk);
                sentences.push(...chunkSentences);
                currentText.length = 0;  // 清空数组
            }

            // 标题本身作为一句，包含后面的空行
            let titleSentence = line;
            // 检查后面的行是否是空行，如果是，包含它们
            let j = i + 1;
            while (j < lines.length) {
                const nextLine = lines[j];
                // 如果下一行是空行（只包含空白字符），包含它
                if (!nextLine.trim()) {
                    titleSentence += nextLine;
                    j += 1;
                } else {
                    // 遇到非空行，停止
                    break;
                }
            }
            sentences.push(titleSentence);
            i = j;  // 跳过已处理的行
            continue;
        }

        // 处理Markdown列表项：每一项作为完整句子
        if (isListItem) {
            // 先处理之前收集的普通文本
            if (currentText.length > 0) {
                const textChunk = currentText.join('');
                const chunkSentences = splitChineseSentencesSimple(textChunk);
                sentences.push(...chunkSentences);
                currentText.length = 0;  // 清空数组
            }

            // 列表项本身作为一句，包含后面的空行
            let listSentence = line;
            // 检查后面的行是否是空行，如果是，包含它们
            let j = i + 1;
            while (j < lines.length) {
                const nextLine = lines[j];
                // 如果下一行是空行（只包含空白字符），包含它
                if (!nextLine.trim()) {
                    listSentence += nextLine;
                    j += 1;
                } else {
                    // 遇到非空行，停止
                    break;
                }
            }
            sentences.push(listSentence);
            i = j;  // 跳过已处理的行
            continue;
        }

        // 普通文本：收集起来，稍后统一处理
        currentText.push(line);
        i += 1;
    }

    // 处理剩余的普通文本
    if (currentText.length > 0) {
        const textChunk = currentText.join('');
        const chunkSentences = splitChineseSentencesSimple(textChunk);
        sentences.push(...chunkSentences);
    }

    // 过滤空句子（但保留只包含空白字符的句子）
    return sentences.filter(s => s.length > 0);
}

/**
 * 在原文中查找每个句子的位置并计算行号（内部辅助函数）
 *
 * @param text 原始文本
 * @param sentences 句子列表（按顺序）
 * @returns (sentence, start_line, end_line) 列表
 */
function _findSentencePositions(text: string, sentences: string[]): Array<[string, number, number]> {
    // 调用方已对 text 做 normalizeLineEndings，此处仅含 LF，行间长度为 1
    const lines = text.split('\n');
    const lineStarts: number[] = [];
    let currentPos = 0;
    for (const line of lines) {
        lineStarts.push(currentPos);
        currentPos += line.length + 1;  // +1 为换行符 \n
    }

    const result: Array<[string, number, number]> = [];
    let searchStart = 0;  // 从上次找到的位置之后开始搜索

    for (const sentence of sentences) {
        if (!sentence) {
            continue;
        }

        // 在原文中查找句子（从searchStart位置开始）
        let pos = text.indexOf(sentence, searchStart);

        if (pos === -1) {
            // 如果找不到，尝试去掉首尾空白字符再找
            const sentenceStripped = sentence.trim();
            if (sentenceStripped) {
                pos = text.indexOf(sentenceStripped, searchStart);
                if (pos !== -1) {
                    // 找到了，但需要调整位置以匹配原始句子（包含空白字符）
                    // 这里简化处理：使用找到的位置
                }
            }
        }

        if (pos === -1) {
            // 仍然找不到，跳过这个句子（或使用默认值）
            // 为了健壮性，尝试在整个文本中查找
            pos = text.indexOf(sentence);
            if (pos === -1) {
                // 如果还是找不到，跳过
                continue;
            }
        }

        // 计算行号：使用句子中第一个非空白字符的位置
        // 因为句子开头可能包含前导换行符，这些换行符属于前一行
        // 我们需要找到句子中第一个非空白字符来确定句子真正开始的行号
        let sentenceStartPos = pos;
        for (let i = 0; i < sentence.length; i++) {
            const char = sentence[i];
            if (!/\s/.test(char)) {  // 找到第一个非空白字符
                sentenceStartPos = pos + i;
                break;
            }
        }
        // 如果句子只包含空白字符，sentenceStartPos 保持为 pos（句子开头的位置）

        // 计算行号
        const startLine = _getLineNumber(sentenceStartPos, lineStarts);
        const endPos = pos + sentence.length - 1;
        const endLine = _getLineNumber(endPos, lineStarts);

        result.push([sentence, startLine, endLine]);

        // 更新搜索起始位置（从当前句子结束位置之后开始）
        searchStart = pos + sentence.length;
    }

    return result;
}

/**
 * 根据字符位置和行起始位置列表，计算行号（从1开始）（内部辅助函数）
 *
 * @param pos 字符位置
 * @param lineStarts 每行在原始文本中的起始字符位置列表
 * @returns 行号（从1开始）
 */
function _getLineNumber(pos: number, lineStarts: number[]): number {
    if (lineStarts.length === 0) {
        return 1;
    }

    // 使用二分查找
    let left = 0;
    let right = lineStarts.length - 1;
    let lineNumber = 1;

    while (left <= right) {
        const mid = Math.floor((left + right) / 2);
        if (lineStarts[mid] <= pos) {
            lineNumber = mid + 1;
            left = mid + 1;
        } else {
            right = mid - 1;
        }
    }

    return lineNumber;
}

/**
 * 将中文文本按句子切分，并跟踪每个句子在原始文本中的行号
 *
 * 基于 splitChineseSentences 或 splitChineseSentencesSimple 的结果，
 * 然后在原文中查找每个句子的位置并计算行号。
 *
 * 基于Python版本的split_chinese_sentences_with_line_numbers实现
 *
 * @param text 要切分的文本
 * @param useSimple 是否使用 splitChineseSentencesSimple，默认false
 * @returns 切分后的句子列表，每个元素为 [sentence, startLine, endLine]
 *   - sentence: 切分后的句子文本
 *   - startLine: 句子开头所在的行号（从1开始）
 *   - endLine: 句子结尾所在的行号（从1开始）
 */
export function splitChineseSentencesWithLineNumbers(
    text: string,
    useSimple: boolean = false
): Array<[string, number, number]> {
    if (!text || !text.trim()) {
        return [];
    }

    text = normalizeLineEndings(text);

    // 先获取句子列表
    const sentences = useSimple
        ? splitChineseSentencesSimple(text)
        : splitChineseSentences(text);

    if (sentences.length === 0) {
        return [];
    }

    // 在原文中查找每个句子的位置并计算行号
    return _findSentencePositions(text, sentences);
}
