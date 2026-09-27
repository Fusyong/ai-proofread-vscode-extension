/**
 * 工作台工作流：并行（校对等，默认）| 串行（翻译等）。
 * 影响面板按钮文案与 JSON 动作路由（并行校对 vs 顺序翻译）。
 */

import * as vscode from 'vscode';

/** 内部仍用 proofread|translate；语义 = 并行|串行 */
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

/** 用户可见：并行（校对等）| 串行（翻译等） */
export function workbenchModeLabel(mode: WorkbenchMode): string {
    return mode === 'translate' ? '串行（翻译等）' : '并行（校对等）';
}

export function workbenchModeShortLabel(mode: WorkbenchMode): string {
    return mode === 'translate' ? '串行' : '并行';
}
