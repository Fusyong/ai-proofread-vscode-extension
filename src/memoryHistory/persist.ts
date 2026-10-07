/**
 * 记忆历史 jsonl 持久化（edit / convert 分文件）。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FilePathUtils } from '../utils';
import type { AlignmentKind } from '../promptAlignment';
import type { MemoryHistoryRecord } from './types';

const EDIT_FILE = 'editorial-memory-history.jsonl';
const CONVERT_FILE = 'translation-memory-history.jsonl';

export function getMemoryHistoryPath(anchorUri: vscode.Uri, kind: AlignmentKind): string {
    const root = FilePathUtils.getProofreadWorkspaceRoot(anchorUri);
    const name = kind === 'convert' ? CONVERT_FILE : EDIT_FILE;
    return path.join(root, '.proofread', name);
}

function maxRecords(): number {
    const n = vscode.workspace.getConfiguration('ai-proofread').get<number>('memoryHistory.maxRecords', 5000);
    return Math.max(100, Math.floor(n || 5000));
}

export function isMemoryHistoryEnabled(): boolean {
    return vscode.workspace.getConfiguration('ai-proofread').get<boolean>('memoryHistory.enabled', true) !== false;
}

const FIELD_MAX = 800;

export function truncateHistoryField(text: string, max = FIELD_MAX): string {
    const s = String(text ?? '');
    if (s.length <= max) {
        return s;
    }
    return s.slice(0, max) + '…';
}

/** 追加一条记录；超限时轮转最旧段到 .jsonl.1 */
export function appendMemoryHistoryRecord(anchorUri: vscode.Uri, record: MemoryHistoryRecord): void {
    if (!isMemoryHistoryEnabled()) {
        return;
    }
    const filePath = getMemoryHistoryPath(anchorUri, record.kind);
    FilePathUtils.ensureDirExists(path.dirname(filePath));
    const line = JSON.stringify(record) + '\n';
    fs.appendFileSync(filePath, line, 'utf8');
    rotateIfNeeded(filePath);
}

function rotateIfNeeded(filePath: string): void {
    if (!fs.existsSync(filePath)) {
        return;
    }
    const text = fs.readFileSync(filePath, 'utf8');
    const lines = text.split('\n').filter((l) => l.trim());
    const max = maxRecords();
    if (lines.length <= max) {
        return;
    }
    const keep = lines.slice(-Math.floor(max * 0.8));
    const archived = lines.slice(0, lines.length - keep.length);
    const archPath = filePath + '.1';
    fs.appendFileSync(archPath, archived.join('\n') + '\n', 'utf8');
    fs.writeFileSync(filePath, keep.join('\n') + '\n', 'utf8');
}

export function readMemoryHistory(
    anchorUri: vscode.Uri,
    kind: AlignmentKind,
    options?: { limit?: number }
): MemoryHistoryRecord[] {
    const filePath = getMemoryHistoryPath(anchorUri, kind);
    if (!fs.existsSync(filePath)) {
        return [];
    }
    const text = fs.readFileSync(filePath, 'utf8');
    const out: MemoryHistoryRecord[] = [];
    for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) {
            continue;
        }
        try {
            const row = JSON.parse(t) as MemoryHistoryRecord;
            if (row && row.source != null && row.target != null) {
                out.push(row);
            }
        } catch {
            /* skip bad line */
        }
    }
    if (options?.limit != null && options.limit > 0 && out.length > options.limit) {
        return out.slice(-options.limit);
    }
    return out;
}
