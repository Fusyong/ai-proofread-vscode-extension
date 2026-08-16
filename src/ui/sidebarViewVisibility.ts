/**
 * Activity Bar 按需 TreeView 的显示状态（与 setContext 同步）
 *
 * 配置类视图可跨启动记住；结果类视图仅在对应命令跑完后出现，不持久化，
 * 同时只显示其中一棵，避免侧栏堆叠。
 */

import * as vscode from 'vscode';
import { getExtensionContext } from '../extensionContextHolder';
import { focusWordCheckView } from '../xh7/wordCheckView';

export interface SidebarConfigState {
    modelRoutes: boolean;
    prompts: boolean;
    /** 词典/通规检查类型 + 自定义替换表 */
    wordCheckConfig: boolean;
}

export type SidebarResultKey =
    | 'wordCheck'
    | 'referenceHit'
    | 'citations'
    | 'duplicates'
    | 'numbering'
    | 'numberingSegments'
    | 'proofreadItems';

export interface SidebarResultState {
    wordCheck: boolean;
    referenceHit: boolean;
    citations: boolean;
    duplicates: boolean;
    numbering: boolean;
    numberingSegments: boolean;
    proofreadItems: boolean;
}

export interface SidebarToggleState extends SidebarConfigState, SidebarResultState {}

const SIDEBAR_TOGGLE_STATE_KEY = 'sidebarToggleState';

const state: SidebarToggleState = {
    modelRoutes: false,
    prompts: false,
    wordCheckConfig: false,
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

async function persistSidebarConfigState(): Promise<void> {
    const ctx = getExtensionContext();
    if (ctx) {
        const config: SidebarConfigState = {
            modelRoutes: state.modelRoutes,
            prompts: state.prompts,
            wordCheckConfig: state.wordCheckConfig,
        };
        await ctx.globalState.update(SIDEBAR_TOGGLE_STATE_KEY, config);
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
    /** 显示结果树时是否收起其他结果树，默认 true */
    exclusive?: boolean;
}

async function tryFocus(command: string): Promise<void> {
    try {
        await vscode.commands.executeCommand(command);
    } catch {
        /* 视图尚未创建时忽略 */
    }
}

async function hideOtherResultViews(keep: SidebarResultKey): Promise<void> {
    const hideOpts: SetVisibleOptions = { persist: false, exclusive: false };
    if (keep !== 'wordCheck' && state.wordCheck) {
        await setWordCheckResultVisible(false, hideOpts);
    }
    if (keep !== 'referenceHit' && state.referenceHit) {
        await setReferenceHitVisible(false, hideOpts);
    }
    if (keep !== 'citations' && state.citations) {
        await setCitationsVisible(false, hideOpts);
    }
    if (keep !== 'duplicates' && state.duplicates) {
        await setDuplicatesVisible(false, hideOpts);
    }
    if (keep !== 'numbering' && state.numbering) {
        await setNumberingVisible(false, hideOpts);
    }
    if (keep !== 'numberingSegments' && state.numberingSegments) {
        await setNumberingSegmentsVisible(false, hideOpts);
    }
    if (keep !== 'proofreadItems' && state.proofreadItems) {
        await setProofreadItemsVisible(false, hideOpts);
    }
}

/** 收起全部结果树（配置类视图不动） */
export async function hideAllResultViews(): Promise<void> {
    const hideOpts: SetVisibleOptions = { persist: false, exclusive: false };
    await setWordCheckResultVisible(false, hideOpts);
    await setReferenceHitVisible(false, hideOpts);
    await setCitationsVisible(false, hideOpts);
    await setDuplicatesVisible(false, hideOpts);
    await setNumberingVisible(false, hideOpts);
    await setNumberingSegmentsVisible(false, hideOpts);
    await setProofreadItemsVisible(false, hideOpts);
}

/** 扩展激活时：默认隐藏所有按需视图 */
export async function hideAllOnDemandSidebarViews(): Promise<void> {
    await setModelRoutesVisible(false, { persist: false });
    await setPromptsViewsVisible(false, { persist: false });
    await setSourceTextCharacteristicsVisible(false);
    await setDictPrepPromptsVisible(false);
    await setWordCheckConfigVisible(false, { persist: false });
    await hideAllResultViews();
    await persistSidebarConfigState();
}

/** 扩展激活时：只恢复配置类视图；结果树一律隐藏 */
export async function restoreSidebarToggleStateOnActivate(): Promise<void> {
    const saved = getExtensionContext()?.globalState.get<Partial<SidebarConfigState> & Partial<SidebarResultState>>(
        SIDEBAR_TOGGLE_STATE_KEY
    );
    await hideAllOnDemandSidebarViews();
    if (!saved) {
        return;
    }
    await setModelRoutesVisible(!!saved.modelRoutes, { persist: false });
    await setPromptsViewsVisible(!!saved.prompts, { persist: false });
    await setWordCheckConfigVisible(!!saved.wordCheckConfig, { persist: false });
    await persistSidebarConfigState();
}

export async function setModelRoutesVisible(visible: boolean, options?: SetVisibleOptions): Promise<void> {
    state.modelRoutes = visible;
    await vscode.commands.executeCommand('setContext', 'aiProofread.showModelRoutesView', visible);
    if (visible) {
        await tryFocus('ai-proofread.modelRoutes.focus');
    }
    if (options?.persist !== false) {
        await persistSidebarConfigState();
    }
    notify();
}

export async function toggleModelRoutesVisible(): Promise<boolean> {
    await setModelRoutesVisible(!state.modelRoutes);
    return state.modelRoutes;
}

/** 只显示主提示词树，不连带源文本特性 / 检索规划提示词 */
export async function setPromptsViewsVisible(visible: boolean, options?: SetVisibleOptions): Promise<void> {
    state.prompts = visible;
    await vscode.commands.executeCommand('setContext', 'aiProofread.showPromptsView', visible);
    if (!visible) {
        await setSourceTextCharacteristicsVisible(false);
        await setDictPrepPromptsVisible(false);
    }
    if (visible) {
        await tryFocus('ai-proofread.prompts.focus');
    }
    if (options?.persist !== false) {
        await persistSidebarConfigState();
    }
    notify();
}

export async function togglePromptsViewsVisible(): Promise<boolean> {
    await setPromptsViewsVisible(!state.prompts);
    return state.prompts;
}

export async function setSourceTextCharacteristicsVisible(visible: boolean): Promise<void> {
    await vscode.commands.executeCommand('setContext', 'aiProofread.showSourceTextCharacteristicsView', visible);
    if (visible) {
        await tryFocus('ai-proofread.sourceTextCharacteristics.focus');
    }
}

export async function setDictPrepPromptsVisible(visible: boolean): Promise<void> {
    await vscode.commands.executeCommand('setContext', 'aiProofread.showDictPrepPromptsView', visible);
    if (visible) {
        await tryFocus('ai-proofread.dictPrepPrompts.focus');
    }
}

export async function setWordCheckConfigVisible(visible: boolean, options?: SetVisibleOptions): Promise<void> {
    state.wordCheckConfig = visible;
    await vscode.commands.executeCommand('setContext', 'aiProofread.showDictCheckTypesView', visible);
    await vscode.commands.executeCommand('setContext', 'aiProofread.showTgsccCheckTypesView', visible);
    await vscode.commands.executeCommand('setContext', 'aiProofread.showCustomTablesView', visible);
    if (options?.persist !== false) {
        await persistSidebarConfigState();
    }
    notify();
}

/** 只显示字词检查结果树 */
export async function setWordCheckResultVisible(visible: boolean, options?: SetVisibleOptions): Promise<void> {
    if (visible && options?.exclusive !== false) {
        await hideOtherResultViews('wordCheck');
    }
    state.wordCheck = visible;
    await vscode.commands.executeCommand('setContext', 'aiProofread.showWordCheckView', visible);
    if (visible) {
        await focusWordCheckView();
    }
    notify();
}

/** @deprecated 兼容旧调用：等同于显示/隐藏结果树 */
export async function setWordCheckViewsVisible(visible: boolean, options?: SetVisibleOptions): Promise<void> {
    await setWordCheckResultVisible(visible, options);
}

export async function toggleWordCheckViewsVisible(): Promise<boolean> {
    await setWordCheckResultVisible(!state.wordCheck);
    return state.wordCheck;
}

export async function setReferenceHitVisible(visible: boolean, options?: SetVisibleOptions): Promise<void> {
    if (visible && options?.exclusive !== false) {
        await hideOtherResultViews('referenceHit');
    }
    state.referenceHit = visible;
    await vscode.commands.executeCommand('setContext', 'aiProofread.showReferencePrepResultsView', visible);
    if (visible) {
        await tryFocus('ai-proofread.referencePrepResults.focus');
    }
    notify();
}

export async function toggleReferenceHitVisible(): Promise<boolean> {
    await setReferenceHitVisible(!state.referenceHit);
    return state.referenceHit;
}

export async function setCitationsVisible(visible: boolean, options?: SetVisibleOptions): Promise<void> {
    if (visible && options?.exclusive !== false) {
        await hideOtherResultViews('citations');
    }
    state.citations = visible;
    await vscode.commands.executeCommand('setContext', 'aiProofread.showCitationView', visible);
    if (visible) {
        await tryFocus('ai-proofread.citation.focus');
    }
    notify();
}

export async function toggleCitationsVisible(): Promise<boolean> {
    await setCitationsVisible(!state.citations);
    return state.citations;
}

export async function setDuplicatesVisible(visible: boolean, options?: SetVisibleOptions): Promise<void> {
    if (visible && options?.exclusive !== false) {
        await hideOtherResultViews('duplicates');
    }
    state.duplicates = visible;
    await vscode.commands.executeCommand('setContext', 'aiProofread.showDuplicateView', visible);
    if (visible) {
        await tryFocus('ai-proofread.duplicate.focus');
    }
    notify();
}

export async function toggleDuplicatesVisible(): Promise<boolean> {
    await setDuplicatesVisible(!state.duplicates);
    return state.duplicates;
}

export async function setNumberingVisible(visible: boolean, options?: SetVisibleOptions): Promise<void> {
    if (visible && options?.exclusive !== false) {
        await hideOtherResultViews('numbering');
    }
    state.numbering = visible;
    await vscode.commands.executeCommand('setContext', 'aiProofread.showNumberingView', visible);
    if (visible) {
        await tryFocus('ai-proofread.numbering.focus');
    }
    notify();
}

export async function toggleNumberingVisible(): Promise<boolean> {
    await setNumberingVisible(!state.numbering);
    return state.numbering;
}

export async function setNumberingSegmentsVisible(visible: boolean, options?: SetVisibleOptions): Promise<void> {
    if (visible && options?.exclusive !== false) {
        await hideOtherResultViews('numberingSegments');
    }
    state.numberingSegments = visible;
    await vscode.commands.executeCommand('setContext', 'aiProofread.showNumberingSegmentsView', visible);
    if (visible) {
        await tryFocus('ai-proofread.numberingSegments.focus');
    }
    notify();
}

export async function toggleNumberingSegmentsVisible(): Promise<boolean> {
    await setNumberingSegmentsVisible(!state.numberingSegments);
    return state.numberingSegments;
}

export async function setProofreadItemsVisible(visible: boolean, options?: SetVisibleOptions): Promise<void> {
    if (visible && options?.exclusive !== false) {
        await hideOtherResultViews('proofreadItems');
    }
    state.proofreadItems = visible;
    await vscode.commands.executeCommand('setContext', 'aiProofread.showProofreadItemsView', visible);
    if (visible) {
        await tryFocus('ai-proofread.proofreadItems.focus');
    }
    notify();
}

export async function toggleProofreadItemsVisible(): Promise<boolean> {
    await setProofreadItemsVisible(!state.proofreadItems);
    return state.proofreadItems;
}
