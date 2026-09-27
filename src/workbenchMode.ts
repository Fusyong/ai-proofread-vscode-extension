/**
 * 工作台模式：校对（默认）| 翻译。影响面板按钮文案与 JSON 动作路由。
 */

import * as vscode from 'vscode';

export type WorkbenchMode = 'proofread' | 'translate';

const STATE_KEY = 'workbenchMode';

export function getWorkbenchMode(context: vscode.ExtensionContext): WorkbenchMode {
    const v = context.globalState.get<string>(STATE_KEY, 'proofread');
    return v === 'translate' ? 'translate' : 'proofread';
}

export async function setWorkbenchMode(
    context: vscode.ExtensionContext,
    mode: WorkbenchMode
): Promise<void> {
    await context.globalState.update(STATE_KEY, mode);
}

export async function toggleWorkbenchMode(context: vscode.ExtensionContext): Promise<WorkbenchMode> {
    const next: WorkbenchMode = getWorkbenchMode(context) === 'translate' ? 'proofread' : 'translate';
    await setWorkbenchMode(context, next);
    return next;
}

export function workbenchModeLabel(mode: WorkbenchMode): string {
    return mode === 'translate' ? '翻译' : '校对';
}
