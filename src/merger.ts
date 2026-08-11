/**
 * 文件合并工具模块
 */

import * as fs from 'fs';

export type MergeMode = 'update' | 'concat';

export interface MergeResult {
    updated: number;
    /** 参与合并的有效单元数（当前侧除去忽略项后） */
    total: number;
    /** 当前侧因忽略标题级别而跳过的单元数 */
    skipped: number;
}

/**
 * 判断 JSON 单元是否以指定级别的 ATX 标题开头（与切分逻辑一致：行首 `#`×n + 空格）。
 * 以 target 字段为准；跳过开头空行后检查第一行。
 */
export function unitStartsWithHeadingLevels(
    item: unknown,
    levels: number[]
): boolean {
    if (!levels.length || typeof item !== 'object' || item === null) {
        return false;
    }
    const target = (item as { target?: unknown }).target;
    if (typeof target !== 'string' || !target) {
        return false;
    }

    const levelSet = new Set(levels);
    const lines = target.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    for (const line of lines) {
        if (line.trim() === '') {
            continue;
        }
        for (const level of levelSet) {
            if (line.startsWith('#'.repeat(level) + ' ')) {
                return true;
            }
        }
        return false;
    }
    return false;
}

function applyFieldMerge(
    currentItem: Record<string, unknown>,
    sourceValue: unknown,
    targetField: string,
    mergeMode: MergeMode
): void {
    if (mergeMode === 'concat') {
        if (currentItem[targetField] && typeof currentItem[targetField] === 'string') {
            currentItem[targetField] =
                (currentItem[targetField] as string) + '\n\n' + sourceValue;
        } else {
            currentItem[targetField] = sourceValue;
        }
    } else {
        currentItem[targetField] = sourceValue;
    }
}

export async function mergeTwoFiles(
    currentFilePath: string,
    sourceFilePath: string,
    targetField: 'target' | 'reference' | 'context',
    sourceField: 'target' | 'reference' | 'context',
    mergeMode: MergeMode = 'update',
    ignoreHeadingLevels: number[] = []
): Promise<MergeResult> {
    // 读取当前文件
    const currentContent = JSON.parse(fs.readFileSync(currentFilePath, 'utf8'));
    const sourceContent = JSON.parse(fs.readFileSync(sourceFilePath, 'utf8'));

    // 确保两个文件都是数组
    if (!Array.isArray(currentContent) || !Array.isArray(sourceContent)) {
        throw new Error('两个文件都必须是JSON数组');
    }

    const ignoreLevels = ignoreHeadingLevels.filter((n) => n >= 1 && n <= 6);
    const mergeableIndices: number[] = [];
    for (let i = 0; i < currentContent.length; i++) {
        if (!unitStartsWithHeadingLevels(currentContent[i], ignoreLevels)) {
            mergeableIndices.push(i);
        }
    }
    const skipped = currentContent.length - mergeableIndices.length;

    // 除去当前侧忽略单元后，有效单元数须与来源相同
    if (mergeableIndices.length !== sourceContent.length) {
        if (ignoreLevels.length === 0) {
            throw new Error(
                `两个文件的数组长度必须相同（当前 ${currentContent.length}，来源 ${sourceContent.length}）`
            );
        }
        throw new Error(
            `除去当前文件中忽略标题级别的单元后，两侧有效单元数须相同` +
                `（当前有效 ${mergeableIndices.length}，来源 ${sourceContent.length}，已忽略 ${skipped}）`
        );
    }

    // 按有效单元顺序一一对应合并
    let updated = 0;
    for (let s = 0; s < sourceContent.length; s++) {
        const currentItem = currentContent[mergeableIndices[s]];
        const sourceItem = sourceContent[s];

        if (typeof currentItem !== 'object' || currentItem === null) {
            continue;
        }
        if (typeof sourceItem !== 'object' || sourceItem === null) {
            continue;
        }

        if (sourceItem[sourceField]) {
            applyFieldMerge(currentItem, sourceItem[sourceField], targetField, mergeMode);
            updated++;
        }
    }

    // 保存更新后的文件
    fs.writeFileSync(currentFilePath, JSON.stringify(currentContent, null, 2), 'utf8');

    return {
        updated,
        total: mergeableIndices.length,
        skipped,
    };
}

/**
 * 将单个 Markdown 文件的内容合并到 JSON 的每个项中
 * 即每一个 JSON 项都合并一次同一文本
 * @param currentFilePath 当前 JSON 文件路径
 * @param markdownFilePath Markdown 文件路径
 * @param targetField 要更新的字段（target、reference 或 context）
 * @param mergeMode 合并模式：update 覆盖，concat 拼接
 * @param ignoreHeadingLevels 当前侧若单元以这些级别标题开头则跳过
 */
export async function mergeMarkdownIntoJson(
    currentFilePath: string,
    markdownFilePath: string,
    targetField: 'target' | 'reference' | 'context',
    mergeMode: MergeMode = 'update',
    ignoreHeadingLevels: number[] = []
): Promise<MergeResult> {
    const currentContent = JSON.parse(fs.readFileSync(currentFilePath, 'utf8'));
    const markdownContent = fs.readFileSync(markdownFilePath, 'utf8');

    if (!Array.isArray(currentContent)) {
        throw new Error('JSON 文件必须是数组格式');
    }

    const ignoreLevels = ignoreHeadingLevels.filter((n) => n >= 1 && n <= 6);
    let updated = 0;
    let skipped = 0;
    for (let i = 0; i < currentContent.length; i++) {
        const currentItem = currentContent[i];

        if (typeof currentItem !== 'object' || currentItem === null) {
            continue;
        }

        if (unitStartsWithHeadingLevels(currentItem, ignoreLevels)) {
            skipped++;
            continue;
        }

        applyFieldMerge(currentItem, markdownContent, targetField, mergeMode);
        updated++;
    }

    fs.writeFileSync(currentFilePath, JSON.stringify(currentContent, null, 2), 'utf8');

    return {
        updated,
        total: updated,
        skipped,
    };
}
