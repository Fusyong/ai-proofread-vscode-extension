/**
 * 对照通用规范汉字表：非通用规范字、未界定字 的逐字扫描（按汉字匹配，查集合）
 */

import * as vscode from 'vscode';
import type { WordCheckEntry } from './types';
import { getTgsccData } from './tableLoader';
import type { CheckType } from './types';

/** 单字汉字（CJK 统一汉字） */
const CJK_CHAR_REGEX = /[\u4e00-\u9fff]/gu;

/**
 * 非通用规范字：文档中不在 tgscc_list 中的汉字。
 * 未界定字：文档中不在 traditional、variant、tgscc_list 任一表中的汉字。
 */
export function scanDocumentTgsccSpecial(
    document: vscode.TextDocument,
    type: CheckType,
    cancelToken?: vscode.CancellationToken,
    range?: vscode.Range
): WordCheckEntry[] {
    const data = getTgsccData();
    if (!data) return [];

    const scanRange = range ?? new vscode.Range(0, 0, document.lineCount, 0);
    const text = document.getText(scanRange);
    const rangeStartOffset = document.offsetAt(scanRange.start);

    const isUndefined = type === 'tgscc_undefined';
    const preferred = isUndefined ? '未界定字' : '非通用规范字';

    const excludeSet = isUndefined
        ? new Set<string>([...data.listSet, ...data.traditionalKeys, ...data.variantKeys])
        : data.listSet;

    const entryMap = new Map<string, WordCheckEntry>();
    let m: RegExpExecArray | null;
    CJK_CHAR_REGEX.lastIndex = 0;
    while ((m = CJK_CHAR_REGEX.exec(text)) !== null) {
        if (cancelToken?.isCancellationRequested) break;
        const ch = m[0];
        if (excludeSet.has(ch)) continue;
        const startOffset = rangeStartOffset + m.index;
        const endOffset = rangeStartOffset + m.index + ch.length;
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
    return Array.from(entryMap.values());
}

export function isTgsccSpecialType(type: CheckType): type is 'tgscc_non_standard' | 'tgscc_undefined' {
    return type === 'tgscc_non_standard' || type === 'tgscc_undefined';
}
