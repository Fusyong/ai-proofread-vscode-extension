/**
 * 编辑记忆 v2：全局结构化条目 + 最近 d 次校对的扁平本轮记忆（currentRounds）
 */

/** global 条目各字段写入上限（程序截断，避免异常超长输出） */
export const MEMORY_ENTRY_FIELD_MAX = {
    original: 800,
    changedTo: 800,
    note: 800,
} as const;

export interface MemoryEntry {
    id: string;
    createdAt: string;
    original: string;
    changedTo: string;
    /** 优先级 0–1000；超员挤档时低权重先入存档 */
    weight: number;
    /**
     * 修改说明（可选）：语法、逻辑、体例通则等写规律与适用条件；
     * 字词层面若以例词/短句表达即可，可省略或简要点睛。
     */
    note?: string;
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
    /** 对全局条目的补丁（仅 global） */
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

function clipMemoryEntryField(s: string, max: number): string {
    const t = String(s ?? '').trim();
    if (t.length <= max) {
        return t;
    }
    return t.slice(0, max) + '…';
}

export function normalizeMemoryEntry(partial: Partial<MemoryEntry> & Pick<MemoryEntry, 'original' | 'changedTo'>): MemoryEntry {
    const now = new Date().toISOString();
    const weight = Math.max(0, Math.min(1000, Math.floor(Number(partial.weight) || 0)));
    const original = clipMemoryEntryField(partial.original ?? '', MEMORY_ENTRY_FIELD_MAX.original);
    const changedTo = clipMemoryEntryField(partial.changedTo ?? '', MEMORY_ENTRY_FIELD_MAX.changedTo);
    const noteRaw = partial.note != null ? String(partial.note).trim() : '';
    const note =
        noteRaw.length > 0 ? clipMemoryEntryField(noteRaw, MEMORY_ENTRY_FIELD_MAX.note) : undefined;
    const base: MemoryEntry = {
        id: partial.id && String(partial.id).trim() ? String(partial.id).trim() : newMemoryEntryId(),
        createdAt: partial.createdAt && String(partial.createdAt).trim() ? String(partial.createdAt) : now,
        original,
        changedTo,
        weight,
    };
    return note !== undefined ? { ...base, note } : base;
}

/** 从磁盘或松散对象恢复 MemoryEntry（丢弃 `repeated` 等已废除字段） */
export function coerceMemoryEntryRow(e: unknown): MemoryEntry | null {
    if (!e || typeof e !== 'object') {
        return null;
    }
    const o = e as Record<string, unknown>;
    if (typeof o.original !== 'string' || typeof o.changedTo !== 'string') {
        return null;
    }
    return normalizeMemoryEntry({
        id: typeof o.id === 'string' ? o.id : undefined,
        createdAt: typeof o.createdAt === 'string' ? o.createdAt : undefined,
        original: o.original,
        changedTo: o.changedTo,
        weight: typeof o.weight === 'number' ? o.weight : undefined,
        note: typeof o.note === 'string' ? o.note : undefined,
    });
}

/** 单行展示（供注入与 patch 上下文） */
export function formatMemoryEntryLine(e: MemoryEntry): string {
    const o = e.original.replace(/\s+/g, ' ').trim();
    const c = e.changedTo.replace(/\s+/g, ' ').trim();
    const noteSeg =
        e.note && e.note.trim().length > 0
            ? ` <note> ${e.note.replace(/\s+/g, ' ').trim()}`
            : '';
    return `${o} <changed to> ${c} <weight> ${e.weight}${noteSeg} [id:${e.id}] [at:${e.createdAt}]`;
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
