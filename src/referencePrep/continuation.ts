import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    getReferencePrepProcessPath,
    loadProcessFile,
} from './processFile';
import {
    summarizeSession,
    targetsMatch,
    type ReferencePrepSessionEntry,
} from './continuationLogic';
import { buildMergedReference } from './retrieval/executor';
import type { ReferencePrepProcessFileV020 } from './schema';

export type { ReferencePrepSessionEntry } from './continuationLogic';
export { targetsMatch, summarizeSession } from './continuationLogic';

const KEY_RECENT_SESSIONS = 'ai-proofread.referencePrep.recentSessions';
const MAX_RECENT = 10;

export interface ExistingReferencePickResult {
    anchorPath: string;
    mergedReference: string;
    process: ReferencePrepProcessFileV020;
}

export function getMergedReferenceFromProcess(proc: ReferencePrepProcessFileV020): string {
    return proc.mergedReference?.trim() || buildMergedReference(proc.corpus);
}

export interface ContinuationPickResult {
    freshProcess: boolean;
    continuation: boolean;
    anchorPath: string;
    maxRoundsOverride?: number;
    targetOverride?: string;
}

export function loadSessionAtAnchor(anchorPath: string): ReferencePrepSessionEntry | null {
    const proc = loadProcessFile(anchorPath);
    if (!proc || (proc.corpus.length === 0 && proc.rounds.length === 0)) {
        return null;
    }
    return summarizeSession(anchorPath, proc);
}

export function loadRecentSessions(context: vscode.ExtensionContext): ReferencePrepSessionEntry[] {
    const raw = context.workspaceState.get<ReferencePrepSessionEntry[]>(KEY_RECENT_SESSIONS, []);
    return raw.filter((e) => e.anchorPath && fs.existsSync(getReferencePrepProcessPath(e.anchorPath)));
}

export async function recordRecentSession(
    context: vscode.ExtensionContext,
    anchorPath: string,
    proc: ReferencePrepProcessFileV020
): Promise<void> {
    const entry = summarizeSession(anchorPath, proc);
    const prev = loadRecentSessions(context).filter((e) => e.anchorPath !== anchorPath);
    const next = [entry, ...prev].slice(0, MAX_RECENT);
    await context.workspaceState.update(KEY_RECENT_SESSIONS, next);
}

function formatSessionLabel(entry: ReferencePrepSessionEntry): string {
    const base = path.basename(entry.anchorPath);
    const preview = (entry.targetPreview ?? '').replace(/\s+/g, ' ').trim().slice(0, 36);
    const previewBit = preview ? ` · ${preview}${(entry.targetPreview?.length ?? 0) > 36 ? '…' : ''}` : '';
    return `${base}${previewBit}`;
}

function formatSessionDescription(entry: ReferencePrepSessionEntry): string {
    const t = entry.updatedAt ? new Date(entry.updatedAt).toLocaleString() : '';
    return `${entry.activeHits} 条命中 · ${entry.roundCount} 轮${t ? ` · ${t}` : ''}`;
}

type PickItem = vscode.QuickPickItem & {
    kind: 'continue_current' | 'fresh_current' | 'continue_other';
    anchorPath: string;
};

export async function confirmTargetMismatch(): Promise<boolean> {
    const pick = await vscode.window.showQuickPick(
        [
            { label: '仍继续', description: '在已有 corpus 上追加检索' },
            { label: '取消', description: '返回重新选择' },
        ],
        {
            title: '选区/检索描述已变化',
            placeHolder: '与上次准备时的文本不一致，继续可能混入无关资料',
            ignoreFocusOut: true,
        }
    );
    return pick?.label === '仍继续';
}

export async function pickReferencePrepContinuation(params: {
    context: vscode.ExtensionContext;
    anchorPath: string;
    target: string;
    title?: string;
}): Promise<ContinuationPickResult | undefined> {
    const currentSession = loadSessionAtAnchor(params.anchorPath);
    const recentOthers = loadRecentSessions(params.context).filter(
        (e) => path.normalize(e.anchorPath) !== path.normalize(params.anchorPath)
    );

    if (!currentSession && recentOthers.length === 0) {
        return {
            freshProcess: true,
            continuation: false,
            anchorPath: params.anchorPath,
        };
    }

    const items: PickItem[] = [];

    if (currentSession) {
        items.push({
            label: '$(history) 继续上次',
            description: formatSessionDescription(currentSession),
            detail: '在已有资料上追加 1 轮规划与检索',
            kind: 'continue_current',
            anchorPath: params.anchorPath,
        });
        items.push({
            label: '$(add) 重新开始',
            description: '清空 corpus，从头准备',
            kind: 'fresh_current',
            anchorPath: params.anchorPath,
        });
    }

    for (const entry of recentOthers.slice(0, 8)) {
        items.push({
            label: `$(folder) ${formatSessionLabel(entry)}`,
            description: formatSessionDescription(entry),
            detail: entry.anchorPath,
            kind: 'continue_other',
            anchorPath: entry.anchorPath,
        });
    }

    if (!currentSession) {
        items.unshift({
            label: '$(add) 全新开始（当前文档）',
            description: '不沿用最近工作，为当前锚点新建过程',
            kind: 'fresh_current',
            anchorPath: params.anchorPath,
        });
    }

    if (items.length === 0) {
        return {
            freshProcess: true,
            continuation: false,
            anchorPath: params.anchorPath,
        };
    }

    const picked = await vscode.window.showQuickPick(items, {
        title: params.title ?? '参考资料准备',
        placeHolder: currentSession
            ? '可继续上次工作，或重新开始'
            : '选择要继续的最近工作，或取消后将对当前文档全新开始',
        ignoreFocusOut: true,
    });
    if (!picked) return undefined;

    if (picked.kind === 'fresh_current') {
        return {
            freshProcess: true,
            continuation: false,
            anchorPath: params.anchorPath,
        };
    }

    const continueAnchor = picked.anchorPath;
    const proc = loadProcessFile(continueAnchor);
    const storedTarget = proc?.userInput ?? proc?.targetPreview;
    const useStoredTarget = picked.kind === 'continue_other' && storedTarget?.trim();

    if (!useStoredTarget && !targetsMatch(storedTarget, params.target)) {
        const ok = await confirmTargetMismatch();
        if (!ok) return undefined;
    }

    return {
        freshProcess: false,
        continuation: true,
        anchorPath: continueAnchor,
        maxRoundsOverride: 1,
        targetOverride: useStoredTarget ? storedTarget : undefined,
    };
}

type ExistingRefPickItem = vscode.QuickPickItem & { anchorPath: string };

/** 选用已有过程文件中的 mergedReference 做校对（不重新检索） */
export async function pickExistingReferenceForProofread(params: {
    context: vscode.ExtensionContext;
    anchorPath: string;
    selectedText: string;
}): Promise<ExistingReferencePickResult | undefined> {
    const items: ExistingRefPickItem[] = [];
    const normCurrent = path.normalize(params.anchorPath);

    const currentProc = loadProcessFile(params.anchorPath);
    if (currentProc) {
        const ref = getMergedReferenceFromProcess(currentProc);
        const active = currentProc.corpus.filter((h) => h.status === 'active').length;
        if (ref.trim() && active > 0) {
            const session = summarizeSession(params.anchorPath, currentProc);
            items.push({
                label: '$(file) 当前文档',
                description: formatSessionDescription(session),
                detail: params.anchorPath,
                anchorPath: params.anchorPath,
            });
        }
    }

    for (const entry of loadRecentSessions(params.context)) {
        if (path.normalize(entry.anchorPath) === normCurrent || entry.activeHits <= 0) continue;
        items.push({
            label: `$(folder) ${formatSessionLabel(entry)}`,
            description: formatSessionDescription(entry),
            detail: entry.anchorPath,
            anchorPath: entry.anchorPath,
        });
    }

    if (items.length === 0) {
        vscode.window.showErrorMessage(
            '未找到已准备的参考资料。请先执行「仅准备参考资料」或「准备参考资料并验证」。'
        );
        return undefined;
    }

    let picked: ExistingRefPickItem | undefined;
    if (items.length === 1) {
        picked = items[0];
    } else {
        picked = await vscode.window.showQuickPick(items, {
            title: '用已有参考资料验证',
            placeHolder: '选择要使用的参考资料会话',
            ignoreFocusOut: true,
        });
    }
    if (!picked) return undefined;

    const proc = loadProcessFile(picked.anchorPath);
    if (!proc) {
        vscode.window.showErrorMessage('过程文件已不存在或无法读取。');
        return undefined;
    }
    const mergedReference = getMergedReferenceFromProcess(proc);
    if (!mergedReference.trim()) {
        vscode.window.showErrorMessage('所选会话没有可用参考资料。');
        return undefined;
    }

    const storedTarget = proc.userInput ?? proc.targetPreview;
    if (!targetsMatch(storedTarget, params.selectedText)) {
        const mismatchPick = await vscode.window.showQuickPick(
            [
                { label: '仍用此资料校对', description: '选区与准备时不一致，reference 可能不完全匹配' },
                { label: '取消', description: '返回重新选择' },
            ],
            {
                title: '选区与准备时不一致',
                ignoreFocusOut: true,
            }
        );
        if (mismatchPick?.label !== '仍用此资料校对') return undefined;
    }

    return { anchorPath: picked.anchorPath, mergedReference, process: proc };
}
