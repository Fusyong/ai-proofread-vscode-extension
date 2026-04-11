/**
 * 检查字词：对条目应用替换（variant → 前标记+preferred+后标记），从后往前替换避免偏移错位
 * 规划见 docs/custom-word-check-plan.md
 */

import * as vscode from 'vscode';
import type { WordCheckEntry } from './types';

/** 替换表中的 preferred 可能含换行；写入文档前压成一行，行间用两个空格连接。 */
export function normalizePreferredForApply(preferred: string): string {
    if (!/[\r\n]/.test(preferred)) {
        return preferred;
    }
    return preferred
        .split(/\r\n|\n|\r/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .join('  ');
}

function rangeIntervalsOverlap(doc: vscode.TextDocument, a: vscode.Range, b: vscode.Range): boolean {
    const a0 = doc.offsetAt(a.start);
    const a1 = doc.offsetAt(a.end);
    const b0 = doc.offsetAt(b.start);
    const b1 = doc.offsetAt(b.end);
    return Math.max(a0, b0) < Math.min(a1, b1);
}

/**
 * 按匹配区间几何重叠过滤：edits 须已按 range.start 偏移降序排列；优先保留更靠后的匹配，丢弃与其重叠的其余项（与替换、插入共用）。
 */
function dropOverlappingMatches(
    doc: vscode.TextDocument,
    edits: { range: vscode.Range; text: string }[]
): { range: vscode.Range; text: string }[] {
    const accepted: { range: vscode.Range; text: string }[] = [];
    for (const ed of edits) {
        if (!accepted.some((x) => rangeIntervalsOverlap(doc, ed.range, x.range))) {
            accepted.push(ed);
        }
    }
    return accepted;
}

export type ApplyReplaceResult = {
    ok: boolean;
    /** 实际写入编辑器的替换处数 */
    appliedCount: number;
    /** 因与其它匹配范围重叠而未执行（避免违反 VS Code 编辑 API） */
    skippedDueToOverlap: number;
};

/**
 * 对若干条目在文档中执行替换；替换文本为 prefix + preferred + suffix。
 * 按 range 从后往前应用，避免偏移错位。
 */
export async function applyReplaceInDocument(
    editor: vscode.TextEditor,
    entries: WordCheckEntry[],
    prefix: string,
    suffix: string
): Promise<ApplyReplaceResult> {
    const edits: { range: vscode.Range; text: string }[] = [];
    for (const e of entries) {
        const text = prefix + normalizePreferredForApply(e.preferred) + suffix;
        for (const range of e.ranges) {
            edits.push({ range, text });
        }
    }
    if (edits.length === 0) {
        return { ok: true, appliedCount: 0, skippedDueToOverlap: 0 };
    }
    const document = editor.document;
    edits.sort((a, b) => document.offsetAt(b.range.start) - document.offsetAt(a.range.start));
    const nonOverlapping = dropOverlappingMatches(document, edits);
    const skippedDueToOverlap = edits.length - nonOverlapping.length;
    const ok = await editor.edit((editBuilder) => {
        for (const { range, text } of nonOverlapping) {
            editBuilder.replace(range, text);
        }
    });
    return {
        ok,
        appliedCount: ok ? nonOverlapping.length : 0,
        skippedDueToOverlap,
    };
}

export type ApplyInsertResult = {
    ok: boolean;
    /** 在多少处匹配后写入了插入（与重叠过滤后的匹配数一致） */
    appliedCount: number;
    /** 因与其它匹配范围重叠而未插入（规则与替换相同） */
    skippedDueToOverlap: number;
};

/**
 * 在每条匹配范围结束之后插入 prefix + preferred + suffix（不删除原文）。
 * 先用与替换相同的几何重叠规则过滤匹配，再按插入位置从后往前合并同位插入。
 */
export async function applyInsertAfterRangesInDocument(
    editor: vscode.TextEditor,
    entries: WordCheckEntry[],
    prefix: string,
    suffix: string
): Promise<ApplyInsertResult> {
    const matchEdits: { range: vscode.Range; text: string }[] = [];
    for (const e of entries) {
        const text = prefix + normalizePreferredForApply(e.preferred) + suffix;
        for (const range of e.ranges) {
            matchEdits.push({ range, text });
        }
    }
    if (matchEdits.length === 0) {
        return { ok: true, appliedCount: 0, skippedDueToOverlap: 0 };
    }
    const document = editor.document;
    matchEdits.sort((a, b) => document.offsetAt(b.range.start) - document.offsetAt(a.range.start));
    const nonOverlapping = dropOverlappingMatches(document, matchEdits);
    const skippedDueToOverlap = matchEdits.length - nonOverlapping.length;

    const inserts: { pos: vscode.Position; text: string }[] = nonOverlapping.map((m) => ({
        pos: m.range.end,
        text: m.text,
    }));
    inserts.sort((a, b) => document.offsetAt(b.pos) - document.offsetAt(a.pos));
    const merged: { pos: vscode.Position; text: string }[] = [];
    for (const ed of inserts) {
        const last = merged[merged.length - 1];
        if (last && document.offsetAt(last.pos) === document.offsetAt(ed.pos)) {
            last.text += ed.text;
        } else {
            merged.push({ pos: ed.pos, text: ed.text });
        }
    }

    const ok = await editor.edit((editBuilder) => {
        for (const { pos, text } of merged) {
            editBuilder.insert(pos, text);
        }
    });
    return {
        ok,
        appliedCount: ok ? nonOverlapping.length : 0,
        skippedDueToOverlap,
    };
}
