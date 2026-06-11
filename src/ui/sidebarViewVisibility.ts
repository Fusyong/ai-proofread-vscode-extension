/**
 * Activity Bar 按需 TreeView 的显示状态（与 setContext 同步，供欢迎页开关等使用）
 */

import * as vscode from 'vscode';
import { getExtensionContext } from '../extensionContextHolder';
import { focusWordCheckView } from '../xh7/wordCheckView';

export interface SidebarToggleState {
    modelRoutes: boolean;
    prompts: boolean;
    wordCheck: boolean;
}

const SIDEBAR_TOGGLE_STATE_KEY = 'sidebarToggleState';

const state: SidebarToggleState = {
    modelRoutes: false,
    prompts: false,
    wordCheck: false,
};

type StateListener = (state: SidebarToggleState) => void;
const listeners = new Set<StateListener>();

function notify(): void {
    const snapshot = getSidebarToggleState();
    for (const fn of listeners) {
        fn(snapshot);
    }
}

async function persistSidebarToggleState(): Promise<void> {
    const ctx = getExtensionContext();
    if (ctx) {
        await ctx.globalState.update(SIDEBAR_TOGGLE_STATE_KEY, getSidebarToggleState());
    }
}

export function getSidebarToggleState(): SidebarToggleState {
    return { ...state };
}

export function onSidebarToggleStateChanged(listener: StateListener): vscode.Disposable {
    listeners.add(listener);
    return new vscode.Disposable(() => listeners.delete(listener));
}

/** 扩展激活时：默认隐藏所有按需视图 */
export async function hideAllOnDemandSidebarViews(): Promise<void> {
    await setModelRoutesVisible(false, { persist: false });
    await setPromptsViewsVisible(false, { persist: false });
    await setWordCheckViewsVisible(false, { persist: false });
    await persistSidebarToggleState();
}

/** 扩展激活时：从 globalState 恢复侧栏开关，无记录则全部隐藏 */
export async function restoreSidebarToggleStateOnActivate(): Promise<void> {
    const saved = getExtensionContext()?.globalState.get<SidebarToggleState>(SIDEBAR_TOGGLE_STATE_KEY);
    if (!saved) {
        await hideAllOnDemandSidebarViews();
        return;
    }
    await setModelRoutesVisible(!!saved.modelRoutes, { persist: false });
    await setPromptsViewsVisible(!!saved.prompts, { persist: false });
    await setWordCheckViewsVisible(!!saved.wordCheck, { persist: false });
    await persistSidebarToggleState();
}

interface SetVisibleOptions {
    persist?: boolean;
}

export async function setModelRoutesVisible(visible: boolean, options?: SetVisibleOptions): Promise<void> {
    state.modelRoutes = visible;
    await vscode.commands.executeCommand('setContext', 'aiProofread.showModelRoutesView', visible);
    if (visible) {
        await vscode.commands.executeCommand('ai-proofread.modelRoutes.focus');
    }
    if (options?.persist !== false) {
        await persistSidebarToggleState();
    }
    notify();
}

export async function toggleModelRoutesVisible(): Promise<boolean> {
    await setModelRoutesVisible(!state.modelRoutes);
    return state.modelRoutes;
}

export async function setPromptsViewsVisible(visible: boolean, options?: SetVisibleOptions): Promise<void> {
    state.prompts = visible;
    await vscode.commands.executeCommand('setContext', 'aiProofread.showPromptsView', visible);
    await vscode.commands.executeCommand('setContext', 'aiProofread.showDictPrepPromptsView', visible);
    await vscode.commands.executeCommand('setContext', 'aiProofread.showSourceTextCharacteristicsView', visible);
    if (visible) {
        await vscode.commands.executeCommand('ai-proofread.prompts.focus');
    }
    if (options?.persist !== false) {
        await persistSidebarToggleState();
    }
    notify();
}

export async function togglePromptsViewsVisible(): Promise<boolean> {
    await setPromptsViewsVisible(!state.prompts);
    return state.prompts;
}

export async function setWordCheckViewsVisible(visible: boolean, options?: SetVisibleOptions): Promise<void> {
    state.wordCheck = visible;
    await vscode.commands.executeCommand('setContext', 'aiProofread.showWordCheckView', visible);
    await vscode.commands.executeCommand('setContext', 'aiProofread.showDictCheckTypesView', visible);
    await vscode.commands.executeCommand('setContext', 'aiProofread.showTgsccCheckTypesView', visible);
    await vscode.commands.executeCommand('setContext', 'aiProofread.showCustomTablesView', visible);
    if (visible) {
        await focusWordCheckView();
    }
    if (options?.persist !== false) {
        await persistSidebarToggleState();
    }
    notify();
}

export async function toggleWordCheckViewsVisible(): Promise<boolean> {
    await setWordCheckViewsVisible(!state.wordCheck);
    return state.wordCheck;
}
