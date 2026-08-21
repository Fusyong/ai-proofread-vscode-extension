/**
 * QuickPick：把上次选择标为「上次」并设为当前高亮项，便于直接回车沿用。
 */

import * as vscode from 'vscode';
import { markLastChoiceDescription } from './quickPickMark';

/**
 * 单选 QuickPick。若 `lastValue` 能匹配某一项，该项会标「上次」并在打开后成为活动项。
 * 须在 `show()` 之后再设 `activeItems`（VS Code 会在 show 时重置活动项）。
 */
export async function showQuickPickWithDefault<T extends vscode.QuickPickItem>(
    items: readonly T[],
    options: vscode.QuickPickOptions & {
        lastValue?: string;
        getValue?: (item: T) => string;
    } = {}
): Promise<T | undefined> {
    const getValue = options.getValue ?? ((item: T) => item.label);
    const lastValue = options.lastValue;
    const marked = items.map((item) => {
        const isLast = lastValue !== undefined && getValue(item) === lastValue;
        const description = markLastChoiceDescription(item.description, isLast);
        return description === item.description ? item : { ...item, description };
    });

    const qp = vscode.window.createQuickPick<T>();
    qp.items = marked;
    qp.placeholder = options.placeHolder;
    qp.ignoreFocusOut = options.ignoreFocusOut ?? false;
    qp.matchOnDescription = options.matchOnDescription ?? false;
    qp.matchOnDetail = options.matchOnDetail ?? false;
    if (options.title) {
        qp.title = options.title;
    }

    return new Promise((resolve) => {
        let settled = false;
        const finish = (value: T | undefined) => {
            if (settled) {
                return;
            }
            settled = true;
            qp.dispose();
            resolve(value);
        };

        qp.onDidAccept(() => {
            finish(qp.selectedItems[0] ?? qp.activeItems[0]);
        });
        qp.onDidHide(() => {
            finish(undefined);
        });

        qp.show();
        if (lastValue !== undefined) {
            const match = qp.items.find((item) => getValue(item) === lastValue);
            if (match) {
                qp.activeItems = [match];
            }
        }
    });
}
