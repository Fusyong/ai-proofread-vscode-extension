/**
 * 检查字词：对当前文档全文扫描，找出表中词条的出现位置
 * 规划见 docs/xh7-word-check-plan.md
 * 文档无分词，采用纯字面匹配；按「先长后短」排序 key，占用区间不重叠。
 * 词表（variant_to_standard、variant_to_preferred_single、variant_to_preferred_multi）支持分词后再检查，见 scanDocumentWithSegmentation。
 */

import * as vscode from 'vscode';
import type { WordCheckEntry } from './types';
import type { JiebaWasmModule } from '../jiebaLoader';

/** 正则元字符转义，用于字面匹配 */
function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
 * 当字典全为单字时（如表一字、表二字），使用逐字遍历以 O(n) 完成，避免 3500+ 次全文正则导致的阻塞。
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
    const keys = Object.keys(dict);

    const allSingleChar = keys.length > 0 && keys.every((k) => k.length === 1);
    if (allSingleChar) {
        return scanDocumentSingleCharDict(document, text, rangeStartOffset, dict, cancelToken);
    }

    const entries: WordCheckEntry[] = [];
    const sortedKeys = keys.sort((a, b) => b.length - a.length);
    const consumed: { start: number; end: number }[] = [];

    for (let i = 0; i < sortedKeys.length; i++) {
        if (cancelToken?.isCancellationRequested) break;
        const variant = sortedKeys[i];
        const preferred = dict[variant];
        if (!preferred) continue;

        const re = new RegExp(escapeRegex(variant), 'gu');
        const ranges: vscode.Range[] = [];
        let m: RegExpExecArray | null;
        re.lastIndex = 0;
        while ((m = re.exec(text)) !== null) {
            if (cancelToken?.isCancellationRequested) break;
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

/** 单字字典的 O(n) 扫描：逐字遍历，避免 3500+ 次全文正则 */
function scanDocumentSingleCharDict(
    document: vscode.TextDocument,
    text: string,
    rangeStartOffset: number,
    dict: Record<string, string>,
    cancelToken?: vscode.CancellationToken
): WordCheckEntry[] {
    const dictSet = new Set(Object.keys(dict));
    const entryMap = new Map<string, WordCheckEntry>();

    let offset = 0;
    for (const ch of text) {
        if (cancelToken?.isCancellationRequested) break;
        if (dictSet.has(ch)) {
            const preferred = dict[ch];
            if (preferred) {
                const startOffset = rangeStartOffset + offset;
                const endOffset = rangeStartOffset + offset + ch.length;
                const rangeObj = new vscode.Range(
                    document.positionAt(startOffset),
                    document.positionAt(endOffset)
                );
                const key = `${ch}|${preferred}`;
                const existing = entryMap.get(key);
                if (existing) {
                    existing.ranges.push(rangeObj);
                } else {
                    entryMap.set(key, { variant: ch, preferred, ranges: [rangeObj] });
                }
            }
        }
        offset += ch.length;
    }
    return Array.from(entryMap.values());
}

/**
 * 分词后再检查：仅当 jieba 分词结果为完整词时，才与字典匹配。
 * 用于 dict7 的异形词表（variant_to_standard、variant_to_preferred_single、variant_to_preferred_multi），减少误报。
 */
export function scanDocumentWithSegmentation(
    document: vscode.TextDocument,
    dict: Record<string, string>,
    jieba: JiebaWasmModule,
    cancelToken?: vscode.CancellationToken,
    range?: vscode.Range
): WordCheckEntry[] {
    const scanRange = range ?? new vscode.Range(0, 0, document.lineCount, 0);
    const text = document.getText(scanRange);
    const rangeStartOffset = document.offsetAt(scanRange.start);

    const tokens = jieba.tokenize(text, 'default', true);
    const dictSet = new Set(Object.keys(dict));
    const entryMap = new Map<string, WordCheckEntry>();

    for (const tok of tokens) {
        if (cancelToken?.isCancellationRequested) break;
        if (!dictSet.has(tok.word)) continue;

        const preferred = dict[tok.word];
        if (!preferred) continue;

        const startOffset = rangeStartOffset + tok.start;
        const endOffset = rangeStartOffset + tok.end;
        const rangeObj = new vscode.Range(
            document.positionAt(startOffset),
            document.positionAt(endOffset)
        );

        const key = `${tok.word}|${preferred}`;
        const existing = entryMap.get(key);
        if (existing) {
            existing.ranges.push(rangeObj);
        } else {
            entryMap.set(key, { variant: tok.word, preferred, ranges: [rangeObj] });
        }
    }
    return Array.from(entryMap.values());
}
