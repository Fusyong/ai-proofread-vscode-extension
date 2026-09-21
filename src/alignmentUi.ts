/**
 * 句子对齐相关 UI 提示（算法选择等）
 */

import * as vscode from 'vscode';
import type { AlignmentAlgorithm } from './sentenceAligner';

/**
 * 让用户选择对齐算法；取消返回 undefined。
 * @param configuredDefault 来自 settings 的默认值
 */
export async function promptAlignmentAlgorithm(
    configuredDefault: AlignmentAlgorithm = 'anchor'
): Promise<AlignmentAlgorithm | undefined> {
    const items: Array<vscode.QuickPickItem & { value: AlignmentAlgorithm }> = [
        {
            label: configuredDefault === 'anchor' ? '锚点算法（默认）' : '锚点算法',
            description: '相似度匹配，支持调序/移动检测',
            value: 'anchor'
        },
        {
            label: configuredDefault === 'wordDiff' ? '词流反解（默认）' : '词流反解',
            description: '整篇词级 diff 投影句对；低相似拆删增；调序自动回退锚点',
            value: 'wordDiff'
        }
    ];

    // 把配置默认项放到第一位
    items.sort((a, b) => {
        if (a.value === configuredDefault) {
            return -1;
        }
        if (b.value === configuredDefault) {
            return 1;
        }
        return 0;
    });

    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: '选择句子对齐算法',
        title: '对齐算法',
        ignoreFocusOut: true
    });

    return picked?.value;
}
