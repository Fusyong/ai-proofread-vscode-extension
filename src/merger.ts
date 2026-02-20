/**
 * 文件合并工具模块
 */

import * as fs from 'fs';

export type MergeMode = 'update' | 'concat';

export async function mergeTwoFiles(
    currentFilePath: string,
    sourceFilePath: string,
    targetField: 'target' | 'reference' | 'context',
    sourceField: 'target' | 'reference' | 'context',
    mergeMode: MergeMode = 'update'
): Promise<{ updated: number; total: number }> {
    // 读取当前文件
    const currentContent = JSON.parse(fs.readFileSync(currentFilePath, 'utf8'));
    const sourceContent = JSON.parse(fs.readFileSync(sourceFilePath, 'utf8'));

    // 确保两个文件都是数组
    if (!Array.isArray(currentContent) || !Array.isArray(sourceContent)) {
        throw new Error('两个文件都必须是JSON数组');
    }

    // 确保数组长度相同
    if (currentContent.length !== sourceContent.length) {
        throw new Error('两个文件的数组长度必须相同');
    }

    // 更新字段
    let updated = 0;
    for (let i = 0; i < currentContent.length; i++) {
        const currentItem = currentContent[i];
        const sourceItem = sourceContent[i];

        // 确保两个项目都是对象
        if (typeof currentItem !== 'object' || typeof sourceItem !== 'object') {
            continue;
        }

        // 如果源字段存在，根据模式处理
        if (sourceItem[sourceField]) {
            if (mergeMode === 'concat') {
                // 拼接模式：如果目标字段已存在，则拼接；否则直接设置
                if (currentItem[targetField] && typeof currentItem[targetField] === 'string') {
                    currentItem[targetField] = currentItem[targetField] + '\n\n' + sourceItem[sourceField];
                } else {
                    currentItem[targetField] = sourceItem[sourceField];
                }
            } else {
                // 更新模式：直接覆盖
                currentItem[targetField] = sourceItem[sourceField];
            }
            updated++;
        }
    }

    // 保存更新后的文件
    fs.writeFileSync(currentFilePath, JSON.stringify(currentContent, null, 2), 'utf8');

    return {
        updated,
        total: currentContent.length
    };
}

/**
 * 将单个 Markdown 文件的内容合并到 JSON 的每个项中
 * 即每一个 JSON 项都合并一次同一文本
 * @param currentFilePath 当前 JSON 文件路径
 * @param markdownFilePath Markdown 文件路径
 * @param targetField 要更新的字段（target、reference 或 context）
 * @param mergeMode 合并模式：update 覆盖，concat 拼接
 */
export async function mergeMarkdownIntoJson(
    currentFilePath: string,
    markdownFilePath: string,
    targetField: 'target' | 'reference' | 'context',
    mergeMode: MergeMode = 'update'
): Promise<{ updated: number; total: number }> {
    const currentContent = JSON.parse(fs.readFileSync(currentFilePath, 'utf8'));
    const markdownContent = fs.readFileSync(markdownFilePath, 'utf8');

    if (!Array.isArray(currentContent)) {
        throw new Error('JSON 文件必须是数组格式');
    }

    let updated = 0;
    for (let i = 0; i < currentContent.length; i++) {
        const currentItem = currentContent[i];

        if (typeof currentItem !== 'object' || currentItem === null) {
            continue;
        }

        if (mergeMode === 'concat') {
            if (currentItem[targetField] && typeof currentItem[targetField] === 'string') {
                currentItem[targetField] = currentItem[targetField] + '\n\n' + markdownContent;
            } else {
                currentItem[targetField] = markdownContent;
            }
        } else {
            currentItem[targetField] = markdownContent;
        }
        updated++;
    }

    fs.writeFileSync(currentFilePath, JSON.stringify(currentContent, null, 2), 'utf8');

    return {
        updated,
        total: currentContent.length
    };
}