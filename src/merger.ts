import * as vscode from 'vscode';
import * as fs from 'fs';

interface JsonItem {
    target?: string;
    reference?: string;
    context?: string;
}

export async function mergeTwoFiles(
    currentFilePath: string,
    sourceFilePath: string,
    targetField: 'target' | 'reference' | 'context',
    sourceField: 'target' | 'reference' | 'context'
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

        // 如果源字段存在，无论目标字段是否存在，都使用源字段更新或添加目标字段
        if (sourceItem[sourceField]) {
            currentItem[targetField] = sourceItem[sourceField];
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