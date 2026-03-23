/**
 * 检查字词：TreeView 数据提供者，仅一级条目，无子节点
 * 规划见 docs/xh7-word-check-plan.md
 */

import * as vscode from 'vscode';
import type { WordCheckEntry } from './types';
import { getShortNotesForPreferred } from './notesResolver';
import {
    type WordCheckSortFilterState,
    DEFAULT_WORD_CHECK_SORT_FILTER,
    applySortAndFilter,
    isFilterActive,
    sumOccurrences,
    type WordCheckSortMode,
} from './wordCheckSortFilter';

const KEY_SORT = 'ai-proofread.wordCheck.sortMode';
const KEY_FILTER_TEXT = 'ai-proofread.wordCheck.filterText';
const KEY_FILTER_TYPES = 'ai-proofread.wordCheck.filterCheckTypes';
const KEY_FILTER_MIN = 'ai-proofread.wordCheck.filterMinCount';

export class WordCheckTreeDataProvider implements vscode.TreeDataProvider<WordCheckEntry> {
    private _onDidChangeTreeData = new vscode.EventEmitter<WordCheckEntry | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private rawEntries: WordCheckEntry[] = [];
    private documentUri: vscode.Uri | null = null;
    private sortFilter: WordCheckSortFilterState = {
        sort: DEFAULT_WORD_CHECK_SORT_FILTER.sort,
        filter: {
            text: DEFAULT_WORD_CHECK_SORT_FILTER.filter.text,
            checkTypes: [...DEFAULT_WORD_CHECK_SORT_FILTER.filter.checkTypes],
            minCount: DEFAULT_WORD_CHECK_SORT_FILTER.filter.minCount,
        },
    };

    constructor(private readonly context: vscode.ExtensionContext) {
        this.loadSortFilterFromStorage();
    }

    private loadSortFilterFromStorage(): void {
        const ws = this.context.workspaceState;
        const sort = ws.get<WordCheckSortMode>(KEY_SORT);
        const text = ws.get<string>(KEY_FILTER_TEXT);
        const types = ws.get<string[]>(KEY_FILTER_TYPES);
        const min = ws.get<number>(KEY_FILTER_MIN);
        if (sort) {
            this.sortFilter.sort = sort;
        }
        if (typeof text === 'string') {
            this.sortFilter.filter.text = text;
        }
        if (Array.isArray(types)) {
            this.sortFilter.filter.checkTypes = [...types];
        }
        if (typeof min === 'number' && min >= 0) {
            this.sortFilter.filter.minCount = min;
        }
    }

    getSortFilterState(): WordCheckSortFilterState {
        return {
            sort: this.sortFilter.sort,
            filter: { ...this.sortFilter.filter, checkTypes: [...this.sortFilter.filter.checkTypes] },
        };
    }

    async persistSortFilterState(state: WordCheckSortFilterState): Promise<void> {
        this.sortFilter = {
            sort: state.sort,
            filter: { ...state.filter, checkTypes: [...state.filter.checkTypes] },
        };
        const ws = this.context.workspaceState;
        await ws.update(KEY_SORT, this.sortFilter.sort);
        await ws.update(KEY_FILTER_TEXT, this.sortFilter.filter.text);
        await ws.update(KEY_FILTER_TYPES, this.sortFilter.filter.checkTypes);
        await ws.update(KEY_FILTER_MIN, this.sortFilter.filter.minCount);
    }

    /** 扫描完成或替换后更新原始列表并重绘 */
    refresh(entries: WordCheckEntry[], documentUri: vscode.Uri | null, _runLabel?: string): void {
        this.rawEntries = entries;
        this.documentUri = documentUri;
        this._onDidChangeTreeData.fire();
    }

    private getDisplayEntries(): WordCheckEntry[] {
        return applySortAndFilter(this.rawEntries, this.sortFilter);
    }

    /** 更新排序筛选后仅刷新视图 */
    refreshViewOnly(): void {
        this._onDidChangeTreeData.fire();
    }

    getViewTitleStats(): {
        rawEntryCount: number;
        rawOccurrenceCount: number;
        displayEntryCount: number;
        displayOccurrenceCount: number;
        isFiltered: boolean;
    } {
        const raw = this.rawEntries;
        const display = this.getDisplayEntries();
        const rawOcc = sumOccurrences(raw);
        const displayOcc = sumOccurrences(display);
        const filtered = isFilterActive(this.sortFilter.filter) || display.length !== raw.length;
        return {
            rawEntryCount: raw.length,
            rawOccurrenceCount: rawOcc,
            displayEntryCount: display.length,
            displayOccurrenceCount: displayOcc,
            isFiltered: filtered,
        };
    }

    getTreeItem(element: WordCheckEntry): vscode.TreeItem {
        const label = `${element.variant}：${element.preferred}`;
        const count = element.ranges.length;
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.id = `${element.variant}|${element.preferred}`;
        const countDesc = count > 0 ? `${count}` : '';
        item.description = element.checkTypeLabel
            ? countDesc
                ? `${countDesc} · ${element.checkTypeLabel}`
                : element.checkTypeLabel
            : countDesc;
        const isHai7Preset = element.checkTypeLabel?.startsWith('hai7') ?? false;
        const shortNotes = isHai7Preset ? '' : getShortNotesForPreferred(element.preferred, element.variant);
        const withCustom =
            element.rawComment != null
                ? element.rawComment + (shortNotes ? '\n\n' + shortNotes : '')
                : shortNotes;
        item.tooltip = withCustom ? `${label}\n\n${withCustom}` : label;
        item.contextValue = 'wordCheckEntry';
        // 双击/激活条目时：先揭示当前处再前进（单击时 selection 已把索引置 0，故第一次激活定位第一处，再次激活定位下一处）
        item.command = { command: 'ai-proofread.wordCheck.revealCurrentAndAdvance', title: '下一处' };
        return item;
    }

    getChildren(_element?: WordCheckEntry): WordCheckEntry[] {
        if (_element) return [];
        return this.getDisplayEntries();
    }

    getDocumentUri(): vscode.Uri | null {
        return this.documentUri;
    }

    /** 当前树中可见条目（已排序筛选） */
    getEntries(): WordCheckEntry[] {
        return this.getDisplayEntries();
    }

    /** 完整扫描结果（替换删除等应基于此项） */
    getRawEntries(): WordCheckEntry[] {
        return this.rawEntries;
    }

    getEntryById(itemId: string | undefined): WordCheckEntry | undefined {
        if (!itemId || !itemId.includes('|')) return undefined;
        return this.rawEntries.find((e) => `${e.variant}|${e.preferred}` === itemId);
    }

    /** 从当前结果集中收集去重后的检查类型标签（含空串占位） */
    collectCheckTypeLabels(): string[] {
        const set = new Set<string>();
        for (const e of this.rawEntries) {
            set.add(e.checkTypeLabel ?? '');
        }
        return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh-CN'));
    }
}
