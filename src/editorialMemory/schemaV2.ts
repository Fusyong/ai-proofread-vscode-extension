/**
 * 编辑记忆 v2：全局结构化条目 + 最近 d 次校对的扁平本轮记忆（currentRounds）
 */

export interface MemoryEntry {
    id: string;
    createdAt: string;
    original: string;
    changedTo: string;
    repeated: number;
    weight: number;
}

/** 单次校对会话的扁平记忆（合并后文本，可多行） */
export interface CurrentRoundFlat {
    id: string;
    createdAt: string;
    body: string;
}

export interface ActiveMemoryV2 {
    version: 2;
    global: MemoryEntry[];
    /** 最近若干次校对（新在前），至多 d 条；条间不重复（归一化后完全相同则不入栈） */
    currentRounds: CurrentRoundFlat[];
}

export interface ArchiveMemoryV2 {
    version: 2;
    entries: MemoryEntry[];
}

/** 仅维护 global */
export type GlobalMemoryPatchOp =
    | {
          op: 'add';
          entry: Partial<MemoryEntry> & Pick<MemoryEntry, 'original' | 'changedTo'>;
      }
    | { op: 'remove'; id: string }
    | { op: 'set_weight'; id: string; weight: number }
    | { op: 'bump_weight'; id: string; delta: number };

export interface MemoryPatchResponse {
    substantive?: boolean;
    /** 对全局条目的补丁（仅 global；repeated 表示重复/复现强度） */
    global_ops?: GlobalMemoryPatchOp[];
    /** 本轮校对合并后的扁平要点（将压入 currentRounds 栈顶，可能与历史去重） */
    current_round_flat?: string;
}

/** 面向 merge 轮次的结构化材料（无文档 path） */
export interface MemoryRoundContext {
    document_id: string;
    selection_range: string;
    original_selected: string;
    final_selected: string;
    item_level_changes?: Array<{ original: string; corrected: string }>;
    user_edited_away_from_model: boolean;
}

export function createEmptyActiveV2(): ActiveMemoryV2 {
    return { version: 2, global: [], currentRounds: [] };
}

export function createEmptyArchiveV2(): ArchiveMemoryV2 {
    return { version: 2, entries: [] };
}

export function newMemoryEntryId(): string {
    return `em_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function newRoundId(): string {
    return `round_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeMemoryEntry(partial: Partial<MemoryEntry> & Pick<MemoryEntry, 'original' | 'changedTo'>): MemoryEntry {
    const now = new Date().toISOString();
    const repeated = Math.max(1, Math.floor(Number(partial.repeated) || 1));
    const weight = Math.max(0, Math.min(1000, Math.floor(Number(partial.weight) || 0)));
    return {
        id: partial.id && String(partial.id).trim() ? String(partial.id).trim() : newMemoryEntryId(),
        createdAt: partial.createdAt && String(partial.createdAt).trim() ? String(partial.createdAt) : now,
        original: String(partial.original ?? ''),
        changedTo: String(partial.changedTo ?? ''),
        repeated,
        weight,
    };
}

/** 单行展示（供注入与 patch 上下文） */
export function formatMemoryEntryLine(e: MemoryEntry): string {
    const o = e.original.replace(/\s+/g, ' ').trim();
    const c = e.changedTo.replace(/\s+/g, ' ').trim();
    return `${o} <changed to> ${c} <repeated> ${e.repeated} <weight> ${e.weight} [id:${e.id}] [at:${e.createdAt}]`;
}

export function formatCurrentRoundsForPrompt(rounds: CurrentRoundFlat[]): string {
    if (!rounds.length) {
        return '';
    }
    return rounds
        .map((r, i) => {
            const head = `[第${i + 1}次·${r.createdAt} id:${r.id}]`;
            return `${head}\n${r.body.trim()}`;
        })
        .join('\n\n---\n\n');
}

export function clipText(s: string, max: number): string {
    if (s.length <= max) {
        return s;
    }
    return s.slice(0, max) + '\n…(截断)';
}

export function normalizeFlatBody(s: string): string {
    return s.trim().replace(/\s+/g, ' ');
}
