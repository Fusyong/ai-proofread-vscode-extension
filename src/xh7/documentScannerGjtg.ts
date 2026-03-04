/**
 * 古籍印刷通用字规范字形表（gjtg.txt）：逐字扫描，凡不在表中的汉字视为「非古籍通规字形」。
 */

import * as vscode from 'vscode';
import type { WordCheckEntry } from './types';
import { getGjtgAllowedSet } from './tableLoader';

/** 单字汉字（CJK 统一汉字） */
const CJK_CHAR_REGEX = /[\u4e00-\u9fff]/gu;

const PREFERRED_LABEL = '非古籍通规字形';

/**
 * 扫描文档中不在古籍通规字形表中的汉字，每个字报为一条（variant=该字，preferred=非古籍通规字形）。
 */
export function scanDocumentGjtg(
    document: vscode.TextDocument,
    cancelToken?: vscode.CancellationToken,
    range?: vscode.Range
): WordCheckEntry[] {
    const allowedSet = getGjtgAllowedSet();
    if (!allowedSet || allowedSet.size === 0) return [];

    const scanRange = range ?? new vscode.Range(0, 0, document.lineCount, 0);
    const text = document.getText(scanRange);
    const rangeStartOffset = document.offsetAt(scanRange.start);

    const entryMap = new Map<string, WordCheckEntry>();
    let m: RegExpExecArray | null;
    CJK_CHAR_REGEX.lastIndex = 0;
    while ((m = CJK_CHAR_REGEX.exec(text)) !== null) {
        if (cancelToken?.isCancellationRequested) break;
        const ch = m[0];
        if (allowedSet.has(ch)) continue;
        const startOffset = rangeStartOffset + m.index;
        const endOffset = rangeStartOffset + m.index + ch.length;
        const rangeObj = new vscode.Range(
            document.positionAt(startOffset),
            document.positionAt(endOffset)
        );
        const key = `${ch}|${PREFERRED_LABEL}`;
        const existing = entryMap.get(key);
        if (existing) {
            existing.ranges.push(rangeObj);
        } else {
            entryMap.set(key, { variant: ch, preferred: PREFERRED_LABEL, ranges: [rangeObj] });
        }
    }
    return Array.from(entryMap.values());
}
