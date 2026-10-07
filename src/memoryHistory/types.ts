/**
 * 记忆全量历史（不参与 LLM 注入；供聚类一致性检查）。
 * kind=edit|convert 表示对齐语义，与并行/串行无关（见 origin）。
 */

import type { AlignmentKind } from '../promptAlignment';

export type MemoryHistoryOrigin =
    | 'selection_accept'
    | 'selection_with_memory'
    | 'parallel_apply'
    | 'serial_segment'
    | 'em_accept'
    | 'tm_merge';

export type MemoryHistoryMarker = {
    source: string;
    target: string;
};

export type MemoryHistoryRecord = {
    id: string;
    createdAt: string;
    kind: AlignmentKind;
    source: string;
    target: string;
    markers?: MemoryHistoryMarker[];
    similarity?: number;
    origin: MemoryHistoryOrigin;
    documentId?: string;
};

export function newHistoryId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
