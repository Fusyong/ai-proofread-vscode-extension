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
export function cutTextByLength(text: string, cutBy: number = 600): string[] {
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
        const pieces = cutTextByLength(section, cutBy);

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
export function cutTextInListByLength(textList: string[], threshold: number = 1500, cutBy: number = 800): string[] {
    const textListShort: string[] = [];
    for (const text of textList) {
        if (text.length > threshold) {
            textListShort.push(...cutTextByLength(text, cutBy));
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
    mode: 'length' | 'title' | 'title-length' | 'context';
    cutBy?: number;
    levels?: number[];
    threshold?: number;
    minLength?: number;
}

/**
 * 将文本切分并生成JSON和Markdown格式的输出
 * @param text 要切分的文本
 * @param options 切分选项
 * @returns 包含JSON和Markdown格式输出的对象
 */
export function splitText(
    text: string,
    options: {
        mode: 'length' | 'title' | 'title-length' | 'context';
        cutBy?: number;
        levels?: number[];
        threshold?: number;
        minLength?: number;
    }
): {
    jsonOutput: string;
    markdownOutput: string;
    segments: Array<{ target: string; context?: string }>;
} {
    let segments: Array<{ target: string; context?: string }>;

    if (options.mode === 'length') {
        // 按长度切分
        const textList = cutTextByLength(text, options.cutBy);
        segments = textList.map(x => ({ target: x }));
    } else if (options.mode === 'title') {
        // 按标题切分
        const textList = splitMarkdownByTitle(text, options.levels);
        segments = textList.map(x => ({ target: x }));
    } else if (options.mode === 'context') {
        // 按标题和长度切分，带上下文
        segments = splitMarkdownByTitleAndLengthWithContext(text, options.levels, options.cutBy);
    } else {
        // 标题加长度切分：先按标题切分，然后处理长短段落
        let textList = splitMarkdownByTitle(text, options.levels);
        textList = cutTextInListByLength(textList, options.threshold, options.cutBy);
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
        mode: 'length' | 'title' | 'title-length' | 'context';
        cutBy?: number;
        levels?: number[];
        threshold?: number;
        minLength?: number;
    }
): Promise<{
    jsonFilePath: string;
    markdownFilePath: string;
    logFilePath: string;
    segments: Array<{ target: string; context?: string }>;
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
    } else if (options.mode === 'context') {
        statsMessage = `切分模式: 带上下文切分\n` +
            `标题级别: ${options.levels!.join(',')}\n` +
            `切分长度: ${options.cutBy}\n\n`;
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
    if (options.mode === 'context') {
        statsMessage += `\n合计\t${totalTargetLength}\t${totalContextLength}\t总计${totalTargetLength + totalContextLength}`;
    } else {
        statsMessage += `\n合计\t${totalTargetLength}`;
    }

    // 写入统计信息
    const timestamp = new Date().toLocaleString();
    statsMessage = `\n[${timestamp}]\n${statsMessage}\n${'='.repeat(50)}\n`;
    fs.appendFileSync(logFilePath, statsMessage, 'utf8');

    return {
        jsonFilePath,
        markdownFilePath,
        logFilePath,
        segments
    };
}