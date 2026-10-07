/**
 * 写入记忆历史的便捷 API（edit / convert）。
 */

import * as vscode from 'vscode';
import type { AlignmentKind } from '../promptAlignment';
import { appendMemoryHistoryRecord, truncateHistoryField } from './persist';
import {
    newHistoryId,
    type MemoryHistoryMarker,
    type MemoryHistoryOrigin,
    type MemoryHistoryRecord,
} from './types';

export type AppendHistoryPair = {
    source: string;
    target: string;
    markers?: MemoryHistoryMarker[];
    similarity?: number;
};

export type AppendHistoryArgs = {
    anchorUri: vscode.Uri;
    kind: AlignmentKind;
    origin: MemoryHistoryOrigin;
    pairs: AppendHistoryPair[];
    documentId?: string;
};

/** 批量追加实质不同的句对/转换对 */
export function appendMemoryHistoryPairs(args: AppendHistoryArgs): number {
    const { anchorUri, kind, origin, pairs, documentId } = args;
    let n = 0;
    const now = new Date().toISOString();
    for (const p of pairs) {
        const source = truncateHistoryField(p.source).trim();
        const target = truncateHistoryField(p.target).trim();
        if (!source || !target || source === target) {
            continue;
        }
        const record: MemoryHistoryRecord = {
            id: newHistoryId(kind === 'convert' ? 'ch' : 'eh'),
            createdAt: now,
            kind,
            source,
            target,
            markers: p.markers?.map((m) => ({
                source: truncateHistoryField(m.source, 200),
                target: truncateHistoryField(m.target, 200),
            })),
            similarity: p.similarity,
            origin,
            documentId,
        };
        appendMemoryHistoryRecord(anchorUri, record);
        n++;
    }
    return n;
}
