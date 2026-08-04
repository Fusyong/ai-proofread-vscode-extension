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
    /** 资料检索命中 TreeView */
    referenceHit: boolean;
    /** 引文核查 TreeView */
    citations: boolean;
    /** 重文检查 TreeView */
    duplicates: boolean;
    /** 标题树 TreeView */
    numbering: boolean;
    /** 段内序号 TreeView */
    numberingSegments: boolean;
    /** 校对条目 TreeView */
    proofreadItems: boolean;
}

const SIDEBAR_TOGGLE_STATE_KEY = 'sidebarToggleState';

const state: SidebarToggleState = {
    modelRoutes: false,
    prompts: false,
    wordCheck: false,
    referenceHit: false,
    citations: false,
    duplicates: false,
    numbering: false,
    numberingSegments: false,
    proofreadItems: false,
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

interface SetVisibleOptions {
    persist?: boolean;
}

async function tryFocus(command: string): Promise<void> {
    try {
        await vscode.commands.executeCommand(command);
    } catch {
        /* 视图尚未创建时忽略 */
    }
}

/** 扩展激活时：默认隐藏所有按需视图 */
export async function hideAllOnDemandSidebarViews(): Promise<void> {
    await setModelRoutesVisible(false, { persist: false });
    await setPromptsViewsVisible(false, { persist: false });
    await setWordCheckViewsVisible(false, { persist: false });
    await setReferenceHitVisible(false, { persist: false });
    await setCitationsVisible(false, { persist: false });
    await setDuplicatesVisible(false, { persist: false });
    await setNumberingVisible(false, { persist: false });
    await setNumberingSegmentsVisible(false, { persist: false });
    await setProofreadItemsVisible(false, { persist: false });
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
    await setReferenceHitVisible(!!saved.referenceHit, { persist: false });
    await setCitationsVisible(!!saved.citations, { persist: false });
    await setDuplicatesVisible(!!saved.duplicates, { persist: false });
    await setNumberingVisible(!!saved.numbering, { persist: false });
    await setNumberingSegmentsVisible(!!saved.numberingSegments, { persist: false });
    await setProofreadItemsVisible(!!saved.proofreadItems, { persist: false });
    await persistSidebarToggleState();
}

export async function setModelRoutesVisible(visible: boolean, options?: SetVisibleOptions): Promise<void> {
    state.modelRoutes = visible;
    await vscode.commands.executeCommand('setContext', 'aiProofread.showModelRoutesView', visible);
    if (visible) {
        await tryFocus('ai-proofread.modelRoutes.focus');
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
        await tryFocus('ai-proofread.prompts.focus');
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

export async function setReferenceHitVisible(visible: boolean, options?: SetVisibleOptions): Promise<void> {
    state.referenceHit = visible;
    await vscode.commands.executeCommand('setContext', 'aiProofread.showReferencePrepResultsView', visible);
    if (visible) {
        await tryFocus('ai-proofread.referencePrepResults.focus');
    }
    if (options?.persist !== false) {
        await persistSidebarToggleState();
    }
    notify();
}

export async function toggleReferenceHitVisible(): Promise<boolean> {
    await setReferenceHitVisible(!state.referenceHit);
    return state.referenceHit;
}

export async function setCitationsVisible(visible: boolean, options?: SetVisibleOptions): Promise<void> {
    state.citations = visible;
    await vscode.commands.executeCommand('setContext', 'aiProofread.showCitationView', visible);
    if (visible) {
        await tryFocus('ai-proofread.citation.focus');
    }
    if (options?.persist !== false) {
        await persistSidebarToggleState();
    }
    notify();
}

export async function toggleCitationsVisible(): Promise<boolean> {
    await setCitationsVisible(!state.citations);
    return state.citations;
}

export async function setDuplicatesVisible(visible: boolean, options?: SetVisibleOptions): Promise<void> {
    state.duplicates = visible;
    await vscode.commands.executeCommand('setContext', 'aiProofread.showDuplicateView', visible);
    if (visible) {
        await tryFocus('ai-proofread.duplicate.focus');
    }
    if (options?.persist !== false) {
        await persistSidebarToggleState();
    }
    notify();
}

export async function toggleDuplicatesVisible(): Promise<boolean> {
    await setDuplicatesVisible(!state.duplicates);
    return state.duplicates;
}

export async function setNumberingVisible(visible: boolean, options?: SetVisibleOptions): Promise<void> {
    state.numbering = visible;
    await vscode.commands.executeCommand('setContext', 'aiProofread.showNumberingView', visible);
    if (visible) {
        await tryFocus('ai-proofread.numbering.focus');
    }
    if (options?.persist !== false) {
        await persistSidebarToggleState();
    }
    notify();
}

export async function toggleNumberingVisible(): Promise<boolean> {
    await setNumberingVisible(!state.numbering);
    return state.numbering;
}

export async function setNumberingSegmentsVisible(visible: boolean, options?: SetVisibleOptions): Promise<void> {
    state.numberingSegments = visible;
    await vscode.commands.executeCommand('setContext', 'aiProofread.showNumberingSegmentsView', visible);
    if (visible) {
        await tryFocus('ai-proofread.numberingSegments.focus');
    }
    if (options?.persist !== false) {
        await persistSidebarToggleState();
    }
    notify();
}

export async function toggleNumberingSegmentsVisible(): Promise<boolean> {
    await setNumberingSegmentsVisible(!state.numberingSegments);
    return state.numberingSegments;
}

export async function setProofreadItemsVisible(visible: boolean, options?: SetVisibleOptions): Promise<void> {
    state.proofreadItems = visible;
    await vscode.commands.executeCommand('setContext', 'aiProofread.showProofreadItemsView', visible);
    if (visible) {
        await tryFocus('ai-proofread.proofreadItems.focus');
    }
    if (options?.persist !== false) {
        await persistSidebarToggleState();
    }
    notify();
}

export async function toggleProofreadItemsVisible(): Promise<boolean> {
    await setProofreadItemsVisible(!state.proofreadItems);
    return state.proofreadItems;
}
