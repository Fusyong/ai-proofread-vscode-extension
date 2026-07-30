import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    getReferencePrepProcessPath,
    listProcessRecords,
    loadProcessFile,
    loadProcessRecord,
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
    recordId?: string;
}

function sessionHasWork(proc: ReferencePrepProcessFileV020): boolean {
    return proc.corpus.length > 0 || proc.rounds.length > 0;
}

export function loadSessionAtAnchor(anchorPath: string): ReferencePrepSessionEntry | null {
    const proc = loadProcessFile(anchorPath);
    if (!proc || !sessionHasWork(proc)) {
        return null;
    }
    return summarizeSession(anchorPath, proc);
}

/** 同一文档内所有有内容的选区记录 */
export function loadSessionsAtAnchor(anchorPath: string): ReferencePrepSessionEntry[] {
    return listProcessRecords(anchorPath)
        .filter(sessionHasWork)
        .map((proc) => summarizeSession(anchorPath, proc));
}

export function loadRecentSessions(context: vscode.ExtensionContext): ReferencePrepSessionEntry[] {
    const raw = context.workspaceState.get<ReferencePrepSessionEntry[]>(KEY_RECENT_SESSIONS, []);
    return raw.filter((e) => {
        if (!e.anchorPath || !fs.existsSync(getReferencePrepProcessPath(e.anchorPath))) return false;
        if (e.recordId) {
            return !!loadProcessRecord(e.anchorPath, e.recordId);
        }
        return true;
    });
}

function sameSession(a: ReferencePrepSessionEntry, b: ReferencePrepSessionEntry): boolean {
    if (path.normalize(a.anchorPath) !== path.normalize(b.anchorPath)) return false;
    if (a.recordId && b.recordId) return a.recordId === b.recordId;
    if (a.recordId || b.recordId) return false;
    return targetsMatch(a.userInput ?? a.targetPreview, b.userInput ?? b.targetPreview ?? '');
}

export async function recordRecentSession(
    context: vscode.ExtensionContext,
    anchorPath: string,
    proc: ReferencePrepProcessFileV020
): Promise<void> {
    const entry = summarizeSession(anchorPath, proc);
    const prev = loadRecentSessions(context).filter((e) => !sameSession(e, entry));
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
    kind: 'continue_record' | 'fresh_selection' | 'continue_other';
    anchorPath: string;
    recordId?: string;
    storedTarget?: string;
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
    const localSessions = loadSessionsAtAnchor(params.anchorPath);
    const matching = localSessions.find((e) =>
        targetsMatch(e.userInput ?? e.targetPreview, params.target)
    );
    const otherLocal = localSessions.filter((e) => e !== matching);
    const recentOthers = loadRecentSessions(params.context).filter(
        (e) => path.normalize(e.anchorPath) !== path.normalize(params.anchorPath)
    );

    if (localSessions.length === 0 && recentOthers.length === 0) {
        return {
            freshProcess: true,
            continuation: false,
            anchorPath: params.anchorPath,
        };
    }

    const items: PickItem[] = [];

    if (matching) {
        items.push({
            label: '$(history) 继续本选区',
            description: formatSessionDescription(matching),
            detail: '在本选区已有资料上追加 1 轮规划与检索',
            kind: 'continue_record',
            anchorPath: params.anchorPath,
            recordId: matching.recordId,
            storedTarget: matching.userInput ?? matching.targetPreview,
        });
        items.push({
            label: '$(add) 重新准备本选区',
            description: '清空本选区 corpus，其它选区记录保留',
            kind: 'fresh_selection',
            anchorPath: params.anchorPath,
            recordId: matching.recordId,
        });
    } else {
        items.push({
            label: '$(add) 为当前选区新建记录',
            description: '与同文档其它选区的检索记录相互独立',
            kind: 'fresh_selection',
            anchorPath: params.anchorPath,
        });
    }

    for (const entry of otherLocal.slice(0, 6)) {
        items.push({
            label: `$(file) 继续同文档选区`,
            description: formatSessionDescription(entry),
            detail: (entry.targetPreview ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
            kind: 'continue_record',
            anchorPath: params.anchorPath,
            recordId: entry.recordId,
            storedTarget: entry.userInput ?? entry.targetPreview,
        });
    }

    for (const entry of recentOthers.slice(0, 6)) {
        items.push({
            label: `$(folder) ${formatSessionLabel(entry)}`,
            description: formatSessionDescription(entry),
            detail: entry.anchorPath,
            kind: 'continue_other',
            anchorPath: entry.anchorPath,
            recordId: entry.recordId,
            storedTarget: entry.userInput ?? entry.targetPreview,
        });
    }

    const picked = await vscode.window.showQuickPick(items, {
        title: params.title ?? '参考资料准备',
        placeHolder: matching
            ? '可继续本选区，或新建/切换其它选区记录'
            : '当前选区尚无记录；可新建，或继续同文档其它选区',
        ignoreFocusOut: true,
    });
    if (!picked) return undefined;

    if (picked.kind === 'fresh_selection') {
        return {
            freshProcess: true,
            continuation: false,
            anchorPath: params.anchorPath,
            recordId: matching && picked.recordId === matching.recordId ? picked.recordId : undefined,
        };
    }

    const storedTarget = picked.storedTarget;
    const useStoredTarget = !!storedTarget?.trim() && (
        picked.kind === 'continue_other' ||
        picked.kind === 'continue_record' && !targetsMatch(storedTarget, params.target)
    );

    if (!useStoredTarget && !targetsMatch(storedTarget, params.target)) {
        const ok = await confirmTargetMismatch();
        if (!ok) return undefined;
    }

    return {
        freshProcess: false,
        continuation: true,
        anchorPath: picked.anchorPath,
        recordId: picked.recordId,
        maxRoundsOverride: 1,
        targetOverride: useStoredTarget ? storedTarget : undefined,
    };
}

type ExistingRefPickItem = vscode.QuickPickItem & {
    anchorPath: string;
    recordId?: string;
};

/** 选用已有过程文件中的 mergedReference 做校对（不重新检索） */
export async function pickExistingReferenceForProofread(params: {
    context: vscode.ExtensionContext;
    anchorPath: string;
    selectedText: string;
}): Promise<ExistingReferencePickResult | undefined> {
    const items: ExistingRefPickItem[] = [];
    const normCurrent = path.normalize(params.anchorPath);
    const seen = new Set<string>();

    const pushProc = (anchor: string, proc: ReferencePrepProcessFileV020, label: string) => {
        const ref = getMergedReferenceFromProcess(proc);
        const active = proc.corpus.filter((h) => h.status === 'active').length;
        if (!ref.trim() || active <= 0 || !proc.id) return;
        const key = `${path.normalize(anchor)}::${proc.id}`;
        if (seen.has(key)) return;
        seen.add(key);
        const session = summarizeSession(anchor, proc);
        items.push({
            label,
            description: formatSessionDescription(session),
            detail: (session.targetPreview ?? '').replace(/\s+/g, ' ').trim().slice(0, 100) || anchor,
            anchorPath: anchor,
            recordId: proc.id,
        });
    };

    for (const proc of listProcessRecords(params.anchorPath)) {
        pushProc(params.anchorPath, proc, '$(file) 当前文档选区');
    }

    for (const entry of loadRecentSessions(params.context)) {
        if (path.normalize(entry.anchorPath) === normCurrent || entry.activeHits <= 0) continue;
        const proc = entry.recordId
            ? loadProcessRecord(entry.anchorPath, entry.recordId)
            : loadProcessFile(entry.anchorPath);
        if (proc) {
            pushProc(entry.anchorPath, proc, `$(folder) ${formatSessionLabel(entry)}`);
        }
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
            placeHolder: '选择要使用的参考资料会话（同文档可有多条选区记录）',
            ignoreFocusOut: true,
        });
    }
    if (!picked) return undefined;

    const proc = picked.recordId
        ? loadProcessRecord(picked.anchorPath, picked.recordId)
        : loadProcessFile(picked.anchorPath);
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
