/**
 * 自定义替换表：正则表每条规则扫描一遍（跨规则 consumed 不重叠）；非正则表为字面匹配（可选词界）。
 * 规划见 docs/custom-word-check-plan.md
 */

import * as vscode from 'vscode';
import type { WordCheckEntry } from './types';
import type { CustomRule, CompiledCustomRule, CustomTable } from './types';
import type { JiebaWasmModule } from '../jiebaLoader';

/** 正则元字符转义，用于字面匹配 */
function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isOverlapping(consumed: { start: number; end: number }[], start: number, end: number): boolean {
    return consumed.some((c) => c.start < end && c.end > start);
}

function addConsumed(consumed: { start: number; end: number }[], start: number, end: number): void {
    const overlapping = consumed.filter((c) => c.start < end && c.end > start);
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

/**
 * 正则表：每条规则对文档扫描一遍，跨规则维护 consumed 不重叠。
 */
export function scanDocumentWithCompiledRules(
    document: vscode.TextDocument,
    compiled: CompiledCustomRule[],
    cancelToken?: vscode.CancellationToken,
    range?: vscode.Range
): WordCheckEntry[] {
    const scanRange = range ?? new vscode.Range(0, 0, document.lineCount, 0);
    const text = document.getText(scanRange);
    const rangeStartOffset = document.offsetAt(scanRange.start);
    const consumed: { start: number; end: number }[] = [];
    const entryMap = new Map<string, WordCheckEntry>();

    for (let r = 0; r < compiled.length; r++) {
        if (cancelToken?.isCancellationRequested) break;
        const { regex, replaceTemplate, rawComment } = compiled[r];
        regex.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = regex.exec(text)) !== null) {
            if (cancelToken?.isCancellationRequested) break;
            const startOffset = rangeStartOffset + m.index;
            const endOffset = rangeStartOffset + m.index + m[0].length;
            if (isOverlapping(consumed, startOffset, endOffset)) continue;
            const variant = m[0];
            const preferred = variant.replace(regex, replaceTemplate);
            const key = `${variant}|${preferred}`;
            const rangeObj = new vscode.Range(
                document.positionAt(startOffset),
                document.positionAt(endOffset)
            );
            const existing = entryMap.get(key);
            if (existing) {
                existing.ranges.push(rangeObj);
            } else {
                entryMap.set(key, { variant, preferred, ranges: [rangeObj], rawComment });
            }
            addConsumed(consumed, startOffset, endOffset);
        }
    }
    return Array.from(entryMap.values());
}

/**
 * 非正则表：字面匹配（无词界，匹配所有出现），先长后短 + consumed 不重叠；挂上 rawComment。
 * 当所有规则均为单字时，使用 O(n) 逐字遍历，避免大量全文正则导致的阻塞。
 */
export function scanDocumentWithLiteralRules(
    document: vscode.TextDocument,
    rules: CustomRule[],
    cancelToken?: vscode.CancellationToken,
    range?: vscode.Range
): WordCheckEntry[] {
    const scanRange = range ?? new vscode.Range(0, 0, document.lineCount, 0);
    const text = document.getText(scanRange);
    const rangeStartOffset = document.offsetAt(scanRange.start);

    const allSingleChar = rules.length > 0 && rules.every((r) => r.find.length === 1);
    if (allSingleChar) {
        return scanLiteralRulesSingleChar(document, text, rangeStartOffset, rules, cancelToken);
    }

    const consumed: { start: number; end: number }[] = [];
    const entryMap = new Map<string, WordCheckEntry>();
    const commentByFind = new Map<string, string>();
    for (const r of rules) if (r.rawComment) commentByFind.set(r.find, r.rawComment);

    const sorted = [...rules].sort((a, b) => b.find.length - a.find.length);
    for (let i = 0; i < sorted.length; i++) {
        if (cancelToken?.isCancellationRequested) break;
        const rule = sorted[i];
        const regex = new RegExp(escapeRegex(rule.find), 'gu');
        regex.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = regex.exec(text)) !== null) {
            if (cancelToken?.isCancellationRequested) break;
            const startOffset = rangeStartOffset + m.index;
            const endOffset = rangeStartOffset + m.index + m[0].length;
            if (isOverlapping(consumed, startOffset, endOffset)) continue;
            const variant = m[0];
            const preferred = rule.replace;
            const key = `${variant}|${preferred}`;
            const rangeObj = new vscode.Range(
                document.positionAt(startOffset),
                document.positionAt(endOffset)
            );
            const rawComment = commentByFind.get(rule.find);
            const existing = entryMap.get(key);
            if (existing) {
                existing.ranges.push(rangeObj);
            } else {
                entryMap.set(key, { variant, preferred, ranges: [rangeObj], rawComment });
            }
            addConsumed(consumed, startOffset, endOffset);
        }
    }
    return Array.from(entryMap.values());
}

/**
 * 非正则表 + 匹配词语边界：先分词，仅当分词结果中完整出现表中的 find 时才报告，并挂上 rawComment。
 */
export function scanDocumentWithLiteralRulesWithSegmentation(
    document: vscode.TextDocument,
    rules: CustomRule[],
    jieba: JiebaWasmModule,
    cancelToken?: vscode.CancellationToken,
    range?: vscode.Range
): WordCheckEntry[] {
    const scanRange = range ?? new vscode.Range(0, 0, document.lineCount, 0);
    const text = document.getText(scanRange);
    const rangeStartOffset = document.offsetAt(scanRange.start);

    const findToReplace = new Map<string, string>();
    const findToComment = new Map<string, string>();
    for (const r of rules) {
        findToReplace.set(r.find, r.replace);
        if (r.rawComment) findToComment.set(r.find, r.rawComment);
    }
    const findSet = new Set(findToReplace.keys());

    const tokens = jieba.tokenize(text, 'default', true);
    const entryMap = new Map<string, WordCheckEntry>();

    for (const tok of tokens) {
        if (cancelToken?.isCancellationRequested) break;
        if (!findSet.has(tok.word)) continue;

        const preferred = findToReplace.get(tok.word);
        if (!preferred) continue;

        const startOffset = rangeStartOffset + tok.start;
        const endOffset = rangeStartOffset + tok.end;
        const rangeObj = new vscode.Range(
            document.positionAt(startOffset),
            document.positionAt(endOffset)
        );
        const rawComment = findToComment.get(tok.word);

        const key = `${tok.word}|${preferred}`;
        const existing = entryMap.get(key);
        if (existing) {
            existing.ranges.push(rangeObj);
        } else {
            entryMap.set(key, { variant: tok.word, preferred, ranges: [rangeObj], rawComment });
        }
    }
    return Array.from(entryMap.values());
}

/** 单字规则的字面匹配：O(n) 逐字遍历 */
function scanLiteralRulesSingleChar(
    document: vscode.TextDocument,
    text: string,
    rangeStartOffset: number,
    rules: CustomRule[],
    cancelToken?: vscode.CancellationToken
): WordCheckEntry[] {
    const findToReplace = new Map<string, string>();
    const findToComment = new Map<string, string>();
    for (const r of rules) {
        findToReplace.set(r.find, r.replace);
        if (r.rawComment) findToComment.set(r.find, r.rawComment);
    }
    const entryMap = new Map<string, WordCheckEntry>();

    let offset = 0;
    for (const ch of text) {
        if (cancelToken?.isCancellationRequested) break;
        const preferred = findToReplace.get(ch);
        if (preferred) {
            const startOffset = rangeStartOffset + offset;
            const endOffset = rangeStartOffset + offset + ch.length;
            const rangeObj = new vscode.Range(
                document.positionAt(startOffset),
                document.positionAt(endOffset)
            );
            const rawComment = findToComment.get(ch);
            const key = `${ch}|${preferred}`;
            const existing = entryMap.get(key);
            if (existing) {
                existing.ranges.push(rangeObj);
            } else {
                entryMap.set(key, { variant: ch, preferred, ranges: [rangeObj], rawComment });
            }
        }
        offset += ch.length;
    }
    return Array.from(entryMap.values());
}

/**
 * 按表类型分发：正则表用 compiled 扫描，非正则表用 rules 字面扫描。
 * 非正则表且 matchWordBoundary 为 true 时，由调用方使用 scanDocumentWithLiteralRulesWithSegmentation + jieba 进行分词后再匹配。
 */
export function scanDocumentWithCustomTable(
    document: vscode.TextDocument,
    table: CustomTable,
    cancelToken?: vscode.CancellationToken,
    range?: vscode.Range
): WordCheckEntry[] {
    if (table.isRegex && table.compiled && table.compiled.length > 0) {
        return scanDocumentWithCompiledRules(document, table.compiled, cancelToken, range);
    }
    return scanDocumentWithLiteralRules(document, table.rules, cancelToken, range);
}
