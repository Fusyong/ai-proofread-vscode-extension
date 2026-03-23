/**
 * 字词检查 TreeView：排序与筛选（纯函数，便于单测）
 */

import * as vscode from 'vscode';
import type { WordCheckEntry } from './types';

/** 与 workspaceState 持久化一致 */
export type WordCheckSortMode = 'document' | 'countDesc' | 'countAsc' | 'variantZh' | 'preferredZh' | 'typeThenDocument';

export interface WordCheckFilterState {
    /** 在 variant / preferred 中子串匹配；trim 后空表示不限制 */
    text: string;
    /** 包含的检查类型标签；空数组表示不限制（显示全部类型） */
    checkTypes: string[];
    /** 最少出现次数，1 表示至少 1 处；0 表示不限制 */
    minCount: number;
}

export interface WordCheckSortFilterState {
    sort: WordCheckSortMode;
    filter: WordCheckFilterState;
}

export const DEFAULT_WORD_CHECK_SORT_FILTER: WordCheckSortFilterState = {
    sort: 'document',
    filter: { text: '', checkTypes: [], minCount: 0 },
};

function comparePosition(a: vscode.Position, b: vscode.Position): number {
    if (a.line !== b.line) return a.line - b.line;
    return a.character - b.character;
}

/** 该条在文档中首次出现的位置（用于「文档顺序」） */
export function getEarliestStart(entry: WordCheckEntry): vscode.Position {
    if (entry.ranges.length === 0) {
        return new vscode.Position(Number.MAX_SAFE_INTEGER, 0);
    }
    let best = entry.ranges[0].start;
    for (let i = 1; i < entry.ranges.length; i++) {
        const s = entry.ranges[i].start;
        if (comparePosition(s, best) < 0) best = s;
    }
    return best;
}

function compareEntriesDocument(a: WordCheckEntry, b: WordCheckEntry): number {
    return comparePosition(getEarliestStart(a), getEarliestStart(b));
}

function compareEntriesTypeThenDocument(a: WordCheckEntry, b: WordCheckEntry): number {
    const la = a.checkTypeLabel ?? '';
    const lb = b.checkTypeLabel ?? '';
    const c = la.localeCompare(lb, 'zh-CN');
    if (c !== 0) return c;
    return compareEntriesDocument(a, b);
}

export function applyFilter(entries: WordCheckEntry[], filter: WordCheckFilterState): WordCheckEntry[] {
    const t = filter.text.trim();
    const typeSet = filter.checkTypes.length > 0 ? new Set(filter.checkTypes) : null;
    const min = filter.minCount;

    return entries.filter((e) => {
        if (min > 0 && e.ranges.length < min) return false;
        if (typeSet) {
            const label = e.checkTypeLabel ?? '';
            if (!typeSet.has(label)) return false;
        }
        if (t) {
            const inV = e.variant.includes(t);
            const inP = e.preferred.includes(t);
            if (!inV && !inP) return false;
        }
        return true;
    });
}

export function applySort(entries: WordCheckEntry[], sort: WordCheckSortMode): WordCheckEntry[] {
    const copy = [...entries];
    switch (sort) {
        case 'document':
            copy.sort(compareEntriesDocument);
            break;
        case 'countDesc':
            copy.sort((a, b) => b.ranges.length - a.ranges.length || compareEntriesDocument(a, b));
            break;
        case 'countAsc':
            copy.sort((a, b) => a.ranges.length - b.ranges.length || compareEntriesDocument(a, b));
            break;
        case 'variantZh':
            copy.sort((a, b) => a.variant.localeCompare(b.variant, 'zh-CN') || compareEntriesDocument(a, b));
            break;
        case 'preferredZh':
            copy.sort((a, b) => a.preferred.localeCompare(b.preferred, 'zh-CN') || compareEntriesDocument(a, b));
            break;
        case 'typeThenDocument':
            copy.sort(compareEntriesTypeThenDocument);
            break;
        default:
            copy.sort(compareEntriesDocument);
    }
    return copy;
}

export function applySortAndFilter(raw: WordCheckEntry[], state: WordCheckSortFilterState): WordCheckEntry[] {
    const filtered = applyFilter(raw, state.filter);
    return applySort(filtered, state.sort);
}

export function isFilterActive(filter: WordCheckFilterState): boolean {
    return (
        filter.text.trim().length > 0 ||
        filter.checkTypes.length > 0 ||
        filter.minCount > 0
    );
}

export function sumOccurrences(entries: WordCheckEntry[]): number {
    return entries.reduce((s, e) => s + e.ranges.length, 0);
}
