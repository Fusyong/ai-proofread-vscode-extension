/**
 * 多份 AlignmentReportJson 逐步按 a 文本序列模糊对齐，合并为多列校次表。
 */

import type { AlignmentReportJson } from './alignmentReportGenerator';
import { buildAlignmentReportJson } from './alignmentReportGenerator';
import { alignDocuments } from './documentAligner';
import {
    alignSentencesAnchor,
    type AlignmentItem,
    type AlignmentOptions,
    type AlignmentType,
} from './sentenceAligner';
import { jaccardSimilarity, normalizeForSimilarity } from './similarity';

export type MultiRowClass =
    | 'all_identical'
    | 'runs_consensus'
    | 'majority'
    | 'divergent'
    | 'structural';

export type CellSpan = 'start' | 'cont';

export interface MultiAlignmentSource {
    id: string;
    label: string;
    path: string;
    titleA: string;
    titleB: string;
    options?: Partial<AlignmentOptions>;
}

export interface MultiAlignmentCell {
    sourceId: string;
    type?: AlignmentType;
    b?: string;
    similarity?: number;
    aFromItem?: string;
    span?: CellSpan;
    a_indices?: number[];
    b_indices?: number[];
}

export interface MultiAlignmentRow {
    a: string;
    cells: MultiAlignmentCell[];
    class: MultiRowClass;
    sourceChange: number;
    runAgreement: number;
}

export interface MultiAlignmentTable {
    sources: MultiAlignmentSource[];
    rows: MultiAlignmentRow[];
}

export interface MultiAlignmentMergeOptions extends AlignmentOptions {
    /** 分类/连续量用的字级 n-gram，默认 2 */
    classifyNgramSize?: number;
}

export function multiRowClassLabel(c: MultiRowClass): string {
    switch (c) {
        case 'all_identical':
            return '全文一致';
        case 'runs_consensus':
            return '校次一致';
        case 'majority':
            return '多数一致';
        case 'divergent':
            return '校次分歧';
        case 'structural':
            return '结构空缺';
        default:
            return c;
    }
}

function normText(text: string | undefined, removeInnerWhitespace = true): string {
    return normalizeForSimilarity(text ?? '', { removeInnerWhitespace });
}

function textSimilarity(
    a: string | undefined,
    b: string | undefined,
    ngramSize: number,
    removeInnerWhitespace: boolean
): number {
    const na = normText(a, removeInnerWhitespace);
    const nb = normText(b, removeInnerWhitespace);
    if (!na && !nb) {
        return 1;
    }
    if (!na || !nb) {
        return 0;
    }
    if (na === nb) {
        return 1;
    }
    return jaccardSimilarity(na, nb, { n: ngramSize, granularity: 'char' });
}

function cellForSource(row: MultiAlignmentRow, sourceId: string): MultiAlignmentCell | undefined {
    return row.cells.find(c => c.sourceId === sourceId);
}

/** 可见列上取有效 b：缺列或无 b 视为空缺；cont 仍带文本时可用 */
function visibleBTexts(
    row: MultiAlignmentRow,
    visibleSourceIds: string[]
): Array<string | null> {
    return visibleSourceIds.map(id => {
        const cell = cellForSource(row, id);
        if (!cell || cell.b === undefined || cell.b === null) {
            return null;
        }
        return cell.b;
    });
}

/**
 * 按可见校次重算行分类与连续量。
 * 有任一可见列空缺 → structural；否则按文本关系分类。
 */
export function classifyRow(
    row: Pick<MultiAlignmentRow, 'a' | 'cells'>,
    visibleSourceIds: string[],
    options: { ngramSize?: number; removeInnerWhitespace?: boolean } = {}
): Pick<MultiAlignmentRow, 'class' | 'sourceChange' | 'runAgreement'> {
    const ngramSize = options.ngramSize ?? 2;
    const removeInnerWhitespace = options.removeInnerWhitespace !== false;
    const a = row.a ?? '';
    const bs = visibleBTexts(row as MultiAlignmentRow, visibleSourceIds);

    if (visibleSourceIds.length === 0) {
        return { class: 'structural', sourceChange: 1, runAgreement: 1 };
    }

    if (bs.some(b => b === null)) {
        return {
            class: 'structural',
            sourceChange: average(
                bs.map(b => (b === null ? 0 : textSimilarity(a, b, ngramSize, removeInnerWhitespace)))
            ),
            runAgreement: pairwiseAverage(
                bs.filter((b): b is string => b !== null),
                (x, y) => textSimilarity(x, y, ngramSize, removeInnerWhitespace)
            ),
        };
    }

    const bTexts = bs as string[];
    const norms = bTexts.map(b => normText(b, removeInnerWhitespace));
    const aNorm = normText(a, removeInnerWhitespace);

    const sourceChange = average(
        bTexts.map(b => textSimilarity(a, b, ngramSize, removeInnerWhitespace))
    );
    const runAgreement = pairwiseAverage(bTexts, (x, y) =>
        textSimilarity(x, y, ngramSize, removeInnerWhitespace)
    );

    if (norms.every(n => n === aNorm)) {
        return { class: 'all_identical', sourceChange, runAgreement };
    }
    if (norms.length > 0 && norms.every(n => n === norms[0])) {
        return { class: 'runs_consensus', sourceChange, runAgreement };
    }

    const counts = new Map<string, number>();
    for (const n of norms) {
        counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    let bestCount = 0;
    let bestNorm = '';
    for (const [n, c] of counts) {
        if (c > bestCount) {
            bestCount = c;
            bestNorm = n;
        }
    }
    const needMajority = Math.floor(norms.length / 2) + 1;
    if (bestCount >= needMajority && bestCount < norms.length && bestNorm !== aNorm) {
        return { class: 'majority', sourceChange, runAgreement };
    }

    return { class: 'divergent', sourceChange, runAgreement };
}

export function reclassifyTable(
    table: MultiAlignmentTable,
    visibleSourceIds?: string[],
    options: { ngramSize?: number; removeInnerWhitespace?: boolean } = {}
): MultiAlignmentTable {
    const ids = visibleSourceIds ?? table.sources.map(s => s.id);
    return {
        ...table,
        rows: table.rows.map(row => {
            const c = classifyRow(row, ids, options);
            return { ...row, ...c };
        }),
    };
}

function average(nums: number[]): number {
    if (nums.length === 0) {
        return 1;
    }
    return nums.reduce((s, n) => s + n, 0) / nums.length;
}

function pairwiseAverage<T>(items: T[], sim: (a: T, b: T) => number): number {
    if (items.length <= 1) {
        return 1;
    }
    const scores: number[] = [];
    for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
            scores.push(sim(items[i], items[j]));
        }
    }
    return average(scores);
}

function emptyCellsForSources(
    sources: MultiAlignmentSource[],
    exceptId?: string
): MultiAlignmentCell[] {
    return sources
        .filter(s => s.id !== exceptId)
        .map(s => ({ sourceId: s.id, span: 'start' as CellSpan }));
}

function itemToCell(sourceId: string, item: AlignmentItem, span: CellSpan = 'start'): MultiAlignmentCell {
    return {
        sourceId,
        type: item.type,
        b: item.b,
        similarity: item.similarity,
        aFromItem: item.a,
        span,
        a_indices:
            item.a_indices ??
            (item.a_index !== undefined && item.a_index !== null ? [item.a_index] : undefined),
        b_indices:
            item.b_indices ??
            (item.b_index !== undefined && item.b_index !== null ? [item.b_index] : undefined),
    };
}

function cloneCellsWithSpan(cells: MultiAlignmentCell[], span: CellSpan): MultiAlignmentCell[] {
    return cells.map(c => ({
        ...c,
        span: span === 'cont' ? 'cont' : c.span === 'cont' ? 'cont' : 'start',
        // 跨度延续行仍保留 b，便于行级分类与 diff 自洽
        b: c.b,
    }));
}

export function tableFromReport(
    report: AlignmentReportJson,
    source: MultiAlignmentSource,
    classifyOpts: { ngramSize?: number; removeInnerWhitespace?: boolean } = {}
): MultiAlignmentTable {
    const rows: MultiAlignmentRow[] = (report.items ?? []).map(item => {
        const row: MultiAlignmentRow = {
            a: item.a ?? '',
            cells: [itemToCell(source.id, item)],
            class: 'structural',
            sourceChange: 1,
            runAgreement: 1,
        };
        const c = classifyRow(row, [source.id], classifyOpts);
        return { ...row, ...c };
    });
    return { sources: [source], rows };
}

interface AEntry {
    /** 在原 rows / items 中的下标 */
    index: number;
    text: string;
}

interface Partition {
    aEntries: AEntry[];
    /** insertsBefore[i]：位于 aEntries[i] 之前的 insert-only 下标 */
    insertsBefore: number[][];
    insertsAfter: number[];
}

function partitionRows(rows: MultiAlignmentRow[]): Partition {
    const aEntries: AEntry[] = [];
    const insertsBefore: number[][] = [];
    const pending: number[] = [];
    const insertsAfter: number[] = [];

    for (let i = 0; i < rows.length; i++) {
        if ((rows[i].a ?? '').trim()) {
            insertsBefore.push([...pending]);
            pending.length = 0;
            aEntries.push({ index: i, text: rows[i].a });
        } else {
            pending.push(i);
        }
    }
    insertsAfter.push(...pending);
    return { aEntries, insertsBefore, insertsAfter };
}

function partitionItems(items: AlignmentItem[]): Partition {
    const aEntries: AEntry[] = [];
    const insertsBefore: number[][] = [];
    const pending: number[] = [];
    const insertsAfter: number[] = [];

    for (let i = 0; i < items.length; i++) {
        if ((items[i].a ?? '').trim()) {
            insertsBefore.push([...pending]);
            pending.length = 0;
            aEntries.push({ index: i, text: items[i].a! });
        } else {
            pending.push(i);
        }
    }
    insertsAfter.push(...pending);
    return { aEntries, insertsBefore, insertsAfter };
}

function indicesOf(item: AlignmentItem, side: 'a' | 'b'): number[] {
    if (side === 'a') {
        if (item.a_indices && item.a_indices.length > 0) {
            return item.a_indices;
        }
        if (item.a_index !== undefined && item.a_index !== null) {
            return [item.a_index];
        }
        return [];
    }
    if (item.b_indices && item.b_indices.length > 0) {
        return item.b_indices;
    }
    if (item.b_index !== undefined && item.b_index !== null) {
        return [item.b_index];
    }
    return [];
}

function mapInsertRowsFromOld(
    oldRows: MultiAlignmentRow[],
    insertIndices: number[],
    newSourceId: string
): MultiAlignmentRow[] {
    return insertIndices.map(idx => {
        const old = oldRows[idx];
        return {
            a: old.a,
            cells: [
                ...old.cells,
                { sourceId: newSourceId, span: 'start' as CellSpan },
            ],
            class: old.class,
            sourceChange: old.sourceChange,
            runAgreement: old.runAgreement,
        };
    });
}

function mapInsertRowsFromNew(
    items: AlignmentItem[],
    insertIndices: number[],
    sources: MultiAlignmentSource[],
    newSourceId: string
): MultiAlignmentRow[] {
    return insertIndices.map(idx => {
        const item = items[idx];
        return {
            a: item.a ?? '',
            cells: [
                ...emptyCellsForSources(sources, newSourceId),
                itemToCell(newSourceId, item),
            ],
            class: 'structural' as MultiRowClass,
            sourceChange: 1,
            runAgreement: 1,
        };
    });
}

/**
 * 将一份新的 alignment 报告并入已有多列表（按 a 序列模糊对齐）。
 */
export function addAlignmentReport(
    table: MultiAlignmentTable,
    report: AlignmentReportJson,
    source: MultiAlignmentSource,
    options: MultiAlignmentMergeOptions = {}
): MultiAlignmentTable {
    const classifyOpts = {
        ngramSize: options.classifyNgramSize ?? 2,
        removeInnerWhitespace: options.removeInnerWhitespace !== false,
    };

    if (table.sources.length === 0) {
        return tableFromReport(report, source, classifyOpts);
    }

    const oldPart = partitionRows(table.rows);
    const newItems = report.items ?? [];
    const newPart = partitionItems(newItems);

    const alignOpts: AlignmentOptions = {
        ...options,
        algorithm: 'anchor',
    };
    const alignment = alignSentencesAnchor(
        oldPart.aEntries.map(e => e.text),
        newPart.aEntries.map(e => e.text),
        alignOpts
    );

    const newSources = [...table.sources, source];
    const out: MultiAlignmentRow[] = [];
    const usedOldInsertBuckets = new Set<number>();
    const usedNewInsertBuckets = new Set<number>();

    const flushInsertsAroundOldA = (oldAEntryPos: number) => {
        if (oldAEntryPos < 0 || oldAEntryPos >= oldPart.insertsBefore.length) {
            return;
        }
        if (usedOldInsertBuckets.has(oldAEntryPos)) {
            return;
        }
        usedOldInsertBuckets.add(oldAEntryPos);
        out.push(
            ...mapInsertRowsFromOld(table.rows, oldPart.insertsBefore[oldAEntryPos], source.id)
        );
    };

    const flushInsertsAroundNewA = (newAEntryPos: number) => {
        if (newAEntryPos < 0 || newAEntryPos >= newPart.insertsBefore.length) {
            return;
        }
        if (usedNewInsertBuckets.has(newAEntryPos)) {
            return;
        }
        usedNewInsertBuckets.add(newAEntryPos);
        out.push(
            ...mapInsertRowsFromNew(newItems, newPart.insertsBefore[newAEntryPos], table.sources, source.id)
        );
    };

    for (const item of alignment) {
        const oldIdxs = indicesOf(item, 'a');
        const newIdxs = indicesOf(item, 'b');

        if (item.type === 'match' || item.type === 'movein' || item.type === 'moveout') {
            if (oldIdxs.length === 0 && newIdxs.length === 0) {
                continue;
            }
            // 对齐结果里 a/b 索引针对 aEntries 数组
            const firstOld = oldIdxs[0] ?? -1;
            const firstNew = newIdxs[0] ?? -1;
            if (firstOld >= 0) {
                flushInsertsAroundOldA(firstOld);
            }
            if (firstNew >= 0) {
                flushInsertsAroundNewA(firstNew);
            }
            // 其余 bucket 在该 match 跨度内也冲掉，避免漏插
            for (const oi of oldIdxs) {
                flushInsertsAroundOldA(oi);
            }
            for (const ni of newIdxs) {
                flushInsertsAroundNewA(ni);
            }

            const fineIsNew = newIdxs.length >= oldIdxs.length && newIdxs.length > 0;
            if (fineIsNew) {
                // 新侧更细或等长：按新侧行数展开
                for (let k = 0; k < newIdxs.length; k++) {
                    const newEntry = newPart.aEntries[newIdxs[k]];
                    const newItem = newItems[newEntry.index];
                    const span: CellSpan = k === 0 ? 'start' : 'cont';
                    let baseCells: MultiAlignmentCell[];
                    if (oldIdxs.length === 1) {
                        const oldRow = table.rows[oldPart.aEntries[oldIdxs[0]].index];
                        baseCells = cloneCellsWithSpan(oldRow.cells, span);
                    } else if (oldIdxs.length > 1) {
                        // 两侧都多：按位置对齐，超出则用第一行 cells 的 cont
                        const oi = oldIdxs[Math.min(k, oldIdxs.length - 1)];
                        const oldRow = table.rows[oldPart.aEntries[oi].index];
                        baseCells = cloneCellsWithSpan(
                            oldRow.cells,
                            k === 0 || oi === oldIdxs[0] ? 'start' : 'cont'
                        );
                    } else {
                        baseCells = emptyCellsForSources(table.sources);
                    }
                    const mergedNewCell = itemToCell(
                        source.id,
                        newItem,
                        span === 'cont' ? 'cont' : 'start'
                    );
                    out.push({
                        a: newItem.a ?? item.a ?? '',
                        cells: [...baseCells, mergedNewCell],
                        class: 'structural',
                        sourceChange: 1,
                        runAgreement: 1,
                    });
                }
            } else {
                // 旧侧更细：按旧侧行数展开，新 b 写在首行并复制到 cont
                const newEntry = newPart.aEntries[newIdxs[0]];
                const newItem = newItems[newEntry.index];
                for (let k = 0; k < oldIdxs.length; k++) {
                    const oldRow = table.rows[oldPart.aEntries[oldIdxs[k]].index];
                    const span: CellSpan = k === 0 ? 'start' : 'cont';
                    out.push({
                        a: oldRow.a,
                        cells: [
                            ...oldRow.cells,
                            {
                                ...itemToCell(source.id, newItem, span),
                                b: newItem.b,
                            },
                        ],
                        class: 'structural',
                        sourceChange: 1,
                        runAgreement: 1,
                    });
                }
            }
        } else if (item.type === 'delete') {
            for (const oi of oldIdxs) {
                flushInsertsAroundOldA(oi);
                const oldRow = table.rows[oldPart.aEntries[oi].index];
                out.push({
                    a: oldRow.a,
                    cells: [...oldRow.cells, { sourceId: source.id, span: 'start' }],
                    class: 'structural',
                    sourceChange: 1,
                    runAgreement: 1,
                });
            }
        } else if (item.type === 'insert') {
            for (const ni of newIdxs) {
                flushInsertsAroundNewA(ni);
                const newEntry = newPart.aEntries[ni];
                const newItem = newItems[newEntry.index];
                out.push({
                    a: newItem.a ?? '',
                    cells: [
                        ...emptyCellsForSources(table.sources),
                        itemToCell(source.id, newItem),
                    ],
                    class: 'structural',
                    sourceChange: 1,
                    runAgreement: 1,
                });
            }
        }
    }

    // 未冲刷的 insert buckets（对齐未触及的边缘）
    for (let i = 0; i < oldPart.insertsBefore.length; i++) {
        flushInsertsAroundOldA(i);
    }
    for (let i = 0; i < newPart.insertsBefore.length; i++) {
        flushInsertsAroundNewA(i);
    }
    out.push(...mapInsertRowsFromOld(table.rows, oldPart.insertsAfter, source.id));
    out.push(
        ...mapInsertRowsFromNew(newItems, newPart.insertsAfter, table.sources, source.id)
    );

    const merged: MultiAlignmentTable = { sources: newSources, rows: out };
    return reclassifyTable(merged, newSources.map(s => s.id), classifyOpts);
}

/**
 * 按顺序逐步合并多份报告。
 */
export function mergeAlignmentReports(
    reports: Array<{ report: AlignmentReportJson; source: MultiAlignmentSource }>,
    options: MultiAlignmentMergeOptions = {}
): MultiAlignmentTable {
    if (reports.length === 0) {
        return { sources: [], rows: [] };
    }
    const classifyOpts = {
        ngramSize: options.classifyNgramSize ?? 2,
        removeInnerWhitespace: options.removeInnerWhitespace !== false,
    };
    let table = tableFromReport(reports[0].report, reports[0].source, classifyOpts);
    for (let i = 1; i < reports.length; i++) {
        table = addAlignmentReport(table, reports[i].report, reports[i].source, options);
    }
    return table;
}

export interface MarkdownProofreadInput {
    /** 校对稿全文 */
    text: string;
    /** 列显示名（常用文件名） */
    label: string;
    /** 溯源路径 */
    path: string;
}

/**
 * 原文 Markdown 分别与各校次 Markdown 做句子对齐，再逐步合并为多列表。
 * 每次对齐使用 options 的浅拷贝，避免 algorithmDisplayName 等互相覆盖。
 */
export function mergeMarkdownProofreads(
    textA: string,
    titleA: string,
    proofreads: MarkdownProofreadInput[],
    options: MultiAlignmentMergeOptions = {}
): MultiAlignmentTable {
    if (proofreads.length === 0) {
        return { sources: [], rows: [] };
    }
    const bundles = proofreads.map((p, i) => {
        const pairOpts: AlignmentOptions = { ...options };
        const { alignment } = alignDocuments(textA, p.text, pairOpts);
        const report = buildAlignmentReportJson(alignment, titleA, p.label, pairOpts, 0);
        const source: MultiAlignmentSource = {
            id: `run${i}`,
            label: p.label,
            path: p.path,
            titleA,
            titleB: p.label,
            options: report.options,
        };
        return { report, source };
    });
    return mergeAlignmentReports(bundles, options);
}

export function classStats(rows: MultiAlignmentRow[]): Record<MultiRowClass, number> {
    const stats: Record<MultiRowClass, number> = {
        all_identical: 0,
        runs_consensus: 0,
        majority: 0,
        divergent: 0,
        structural: 0,
    };
    for (const row of rows) {
        stats[row.class]++;
    }
    return stats;
}
