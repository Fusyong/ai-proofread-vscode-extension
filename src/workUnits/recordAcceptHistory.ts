/**
 * 接受/应用结果后写入 memoryHistory（与是否更新 active 记忆解耦）。
 */

import * as vscode from 'vscode';
import { extractSubstantiveEditPairs } from '../editorialMemory/recentSentenceSummary';
import { appendMemoryHistoryPairs } from '../memoryHistory';
import type { MemoryHistoryOrigin } from '../memoryHistory';
import type { TermPair } from '../convertCodec';

/** 编辑类：从原文/终稿抽句对写入 history */
export function recordEditAcceptHistory(args: {
    documentUri: vscode.Uri;
    original: string;
    finalText: string;
    origin: MemoryHistoryOrigin;
}): number {
    const pairs = extractSubstantiveEditPairs(args.original, args.finalText);
    return appendMemoryHistoryPairs({
        anchorUri: args.documentUri,
        kind: 'edit',
        origin: args.origin,
        documentId: args.documentUri.fsPath,
        pairs: pairs.map((p) => ({ source: p.before, target: p.after })),
    });
}

/** 转换类：写入句对 + 可选术语标记 */
export function recordConvertAcceptHistory(args: {
    documentUri: vscode.Uri;
    sourceUnit: string;
    finalTranslation: string;
    terms?: TermPair[];
    similarity?: number;
    origin: MemoryHistoryOrigin;
}): number {
    return appendMemoryHistoryPairs({
        anchorUri: args.documentUri,
        kind: 'convert',
        origin: args.origin,
        documentId: args.documentUri.fsPath,
        pairs: [
            {
                source: args.sourceUnit,
                target: args.finalTranslation,
                markers: args.terms?.map((t) => ({ source: t.source, target: t.target })),
                similarity: args.similarity,
            },
        ],
    });
}
