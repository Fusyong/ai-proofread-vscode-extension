/**
 * 检查字词：对条目应用替换（variant → 前标记+preferred+后标记），从后往前替换避免偏移错位
 * 规划见 docs/custom-word-check-plan.md
 */

import * as vscode from 'vscode';
import type { WordCheckEntry } from './types';

/**
 * 对若干条目在文档中执行替换；替换文本为 prefix + preferred + suffix。
 * 按 range 从后往前应用，避免偏移错位。
 */
export async function applyReplaceInDocument(
    editor: vscode.TextEditor,
    entries: WordCheckEntry[],
    prefix: string,
    suffix: string
): Promise<boolean> {
    const edits: { range: vscode.Range; text: string }[] = [];
    for (const e of entries) {
        const text = prefix + e.preferred + suffix;
        for (const range of e.ranges) {
            edits.push({ range, text });
        }
    }
    if (edits.length === 0) return true;
    const document = editor.document;
    edits.sort((a, b) => document.offsetAt(b.range.start) - document.offsetAt(a.range.start));
    return editor.edit((editBuilder) => {
        for (const { range, text } of edits) {
            editBuilder.replace(range, text);
        }
    });
}
