/**
 * 检查字词：对当前文档全文扫描，找出表中词条的出现位置
 * 规划见 docs/xh7-word-check-plan.md
 * 按「先长后短」排序 key（词表有长度差异，字表均一字），且占用区间不重叠：已匹配的字符不再参与更短 key 的匹配。
 */

import * as vscode from 'vscode';
import type { WordCheckEntry } from './types';

/** 正则特殊字符转义 */
function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 全词匹配：前后不能是「字」（字母、数字、中文等），避免「人才」匹配到「人才库」
 */
function buildWordBoundaryRegex(variant: string): RegExp {
    const escaped = escapeRegex(variant);
    return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'gu');
}

/** 已占用的区间（文档偏移，左闭右开） */
function overlapsOrAdjacent(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
    return a.start < b.end && a.end > b.start;
}

function addConsumed(consumed: { start: number; end: number }[], start: number, end: number): void {
    const overlapping = consumed.filter((c) => overlapsOrAdjacent(c, { start, end }));
    if (overlapping.length === 0) {
        consumed.push({ start, end });
        return;
    }
    const minStart = Math.min(start, ...overlapping.map((c) => c.start));
    const maxEnd = Math.max(end, ...overlapping.map((c) => c.end));
    for (let i = consumed.length - 1; i >= 0; i--) {
        if (overlapping.includes(consumed[i])) consumed.splice(i, 1);
    }
    consumed.push({ start: minStart, end: maxEnd });
}

function isOverlapping(consumed: { start: number; end: number }[], start: number, end: number): boolean {
    return consumed.some((c) => c.start < end && c.end > start);
}

/**
 * 对文档（或指定范围）扫描，返回该字典中在文本里出现过的条目及其 ranges（文档坐标）。
 * 字典按键长「先长后短」排序；每段文档区间只归属最先匹配到的（最长）key，避免「一呼百应」既匹配整词又被子串「一呼」重复计入。
 */
export function scanDocument(
    document: vscode.TextDocument,
    dict: Record<string, string>,
    cancelToken?: vscode.CancellationToken,
    range?: vscode.Range
): WordCheckEntry[] {
    const scanRange = range ?? new vscode.Range(0, 0, document.lineCount, 0);
    const text = document.getText(scanRange);
    const rangeStartOffset = document.offsetAt(scanRange.start);
    const entries: WordCheckEntry[] = [];
    const keys = Object.keys(dict).sort((a, b) => b.length - a.length);
    const consumed: { start: number; end: number }[] = [];

    for (let i = 0; i < keys.length; i++) {
        if (cancelToken?.isCancellationRequested) break;
        const variant = keys[i];
        const preferred = dict[variant];
        if (!preferred) continue;

        const re = buildWordBoundaryRegex(variant);
        const ranges: vscode.Range[] = [];
        let m: RegExpExecArray | null;
        re.lastIndex = 0;
        while ((m = re.exec(text)) !== null) {
            const startOffset = rangeStartOffset + m.index;
            const endOffset = rangeStartOffset + m.index + m[0].length;
            if (isOverlapping(consumed, startOffset, endOffset)) continue;
            ranges.push(
                new vscode.Range(document.positionAt(startOffset), document.positionAt(endOffset))
            );
            addConsumed(consumed, startOffset, endOffset);
        }
        if (ranges.length > 0) {
            entries.push({ variant, preferred, ranges });
        }
    }
    return entries;
}
