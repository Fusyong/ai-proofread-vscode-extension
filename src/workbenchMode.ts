/**
 * 工作台调度：并行工作台（默认）| 串行工作台（实验）。
 * 不再用 proofread|translate 兼指业务与调度；对齐语义见当前提示词 AlignmentKind。
 */

import * as vscode from 'vscode';
import type { ExecutionMode } from './promptAlignment';

/** @deprecated 兼容旧 globalState；语义 = ExecutionMode */
export type WorkbenchMode = 'proofread' | 'translate';

const STATE_KEY = 'workbenchMode';
const PANEL_KEY = 'workbenchPanelExecution';

/** 当前打开的工作台调度（parallel 默认台 / serial 实验台） */
export function getWorkbenchExecution(context: vscode.ExtensionContext): ExecutionMode {
    const v = context.globalState.get<string>(PANEL_KEY);
    if (v === 'serial' || v === 'parallel') {
        return v;
    }
    // 迁移旧 WorkbenchMode
    const legacy = context.globalState.get<string>(STATE_KEY, 'proofread');
    return legacy === 'translate' ? 'serial' : 'parallel';
}

export async function setWorkbenchExecution(
    context: vscode.ExtensionContext,
    mode: ExecutionMode
): Promise<void> {
    await context.globalState.update(PANEL_KEY, mode);
    // 同步旧键，避免残留逻辑读到过时值
    await context.globalState.update(STATE_KEY, mode === 'serial' ? 'translate' : 'proofread');
}

/** @deprecated 使用 getWorkbenchExecution */
export function getWorkbenchMode(context: vscode.ExtensionContext): WorkbenchMode {
    return getWorkbenchExecution(context) === 'serial' ? 'translate' : 'proofread';
}

/** @deprecated 使用 setWorkbenchExecution */
export async function setWorkbenchMode(
    context: vscode.ExtensionContext,
    mode: WorkbenchMode
): Promise<void> {
    await setWorkbenchExecution(context, mode === 'translate' ? 'serial' : 'parallel');
}

export async function toggleWorkbenchMode(context: vscode.ExtensionContext): Promise<WorkbenchMode> {
    const next: ExecutionMode = getWorkbenchExecution(context) === 'serial' ? 'parallel' : 'serial';
    await setWorkbenchExecution(context, next);
    return next === 'serial' ? 'translate' : 'proofread';
}

export function workbenchModeLabel(mode: WorkbenchMode): string {
    return mode === 'translate' ? '串行工作台（实验）' : '并行工作台';
}

export function workbenchModeShortLabel(mode: WorkbenchMode): string {
    return mode === 'translate' ? '串行·实验' : '并行';
}

export function workbenchExecutionLabel(mode: ExecutionMode): string {
    return mode === 'serial' ? '串行工作台（实验）' : '并行工作台';
}
