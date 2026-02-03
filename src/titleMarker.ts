/**
 * 标题标记工具
 * 根据目录表在Markdown文本中寻找标题并添加标记
 * 换行符约定：入口处统一使用 normalizeLineEndings，内部仅按 LF 按行处理。
 */

import { normalizeLineEndings } from './utils';

export interface TocItem {
    name: string;
    level: number;
}

/**
 * 清理标题，以便比较目录表和正文中的标题是否一致
 * @param title 原始标题
 * @returns 清理后的标题
 */
export function cleanTitle(title: string): string {
    // 移除常见的无关标记，使得不同来源的标题可以更好地对应对比
    // 移除 Markdown 脚注
    // 移除上标注码
    // 移除空白字符、点号、省略号、数字、带圈序号、间隔号、项目符号等杂项
    return title
        .replace(/\[\s*\^[\da-zA-Z]+\s*\]/g, '')  // 移除脚注码，如 [^1] [^abc]
        .replace(/\^[\da-zA-Z]+\^/g, '')          // 移除上标注码，如 ^1^ ^abc^
        .replace(/[\s\.…\d\u2460-\u2473\u3251-\u325F]/g, '') // 移除杂项符号：空白字符、点号、省略号、数字、带圈序号①-㉟
        .trim();
}

/**
 * 解析用户提供的目录列表，提取目录项及其层级结构
 * @param content 目录文件内容
 * @param indentLevel 缩进级别，默认4个空格
 * @param baseLevel 基础级别，默认1
 * @returns 包含目录项信息的列表
 */
export function parseToc(
    content: string,
    indentLevel: number = 4,
    baseLevel: number = 1
): TocItem[] {
    content = normalizeLineEndings(content);
    const lines = content.split('\n');
    const tocItems: TocItem[] = [];

    for (const line of lines) {
        const lineStripped = line.trim();
        if (!lineStripped) {
            continue;
        }

        // 计算缩进级别
        const startChar = lineStripped[0];
        if (startChar === '*' || startChar === '-' || startChar === '+') {
            // 计算星号前的空格数来确定级别
            const leadingSpaces = line.length - line.trimStart().length;
            const level = Math.floor(leadingSpaces / indentLevel) + baseLevel;

            // 去除目录项的符号
            let namePart = lineStripped.substring(1).trimStart();

            // 清理标题
            namePart = cleanTitle(namePart);

            // 去除省略号、空格、点号等忽略符号
            const omitChars = [' ', '…', '.'];
            namePart = namePart
                .split('')
                .filter(char => !omitChars.includes(char))
                .join('');

            if (namePart.trim()) {
                tocItems.push({
                    name: namePart.trim(),
                    level: level
                });
            }
        }
    }

    return tocItems;
}

/**
 * 根据目录列表在文本文件中标记标题
 * @param textLines 文本行数组
 * @param tocItems 目录项列表
 * @returns 元组，包含标记后的行数组和未找到的目录项列表
 */
export function markTitles(
    textLines: string[],
    tocItems: TocItem[]
): [string[], TocItem[]] {
    // 创建一个新的数组来存储标记后的行
    const markedLines = [...textLines];
    const notFound: TocItem[] = [];

    // 标记标题
    for (const item of tocItems) {
        const itemName = item.name;
        const itemLevel = item.level;
        let found = false;

        for (let i = 0; i < textLines.length; i++) {
            const line = textLines[i];
            // 移除空格、拼音、括号以便比较
            const cleanedLine = cleanTitle(line.trim());

            if (itemName === cleanedLine) {
                // 使用目录项的级别作为标题级别
                markedLines[i] = `${'#'.repeat(itemLevel)} ${line.trim()}`;
                found = true;
                // 注意：不 break，与 Python 版本保持一致，会标记所有匹配的行
            }
        }

        if (!found) {
            notFound.push(item);
        }
    }

    return [markedLines, notFound];
}
