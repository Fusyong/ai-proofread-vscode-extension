import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FilePathUtils } from '../../utils';
import { ReferenceStore } from '../../citation/referenceStore';
import type { RefSentenceRow } from '../../citation/referenceStore';

const VECTOR_FILENAME = 'reference-vectors.json';

export interface VectorIndexEntry {
    id: number;
    file_path: string;
    start_line?: number;
    end_line?: number;
    content: string;
    /** character bigram TF vector (sparse) */
    vec: Record<string, number>;
    norm: number;
}

export interface VectorIndexFile {
    builtAt: string;
    referencesRoot: string;
    entries: VectorIndexEntry[];
}

function getVectorIndexPath(): string | null {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) return null;
    return path.join(ws, '.proofread', VECTOR_FILENAME);
}

function charBigrams(text: string): Record<string, number> {
    const t = text.replace(/\s+/g, '');
    const vec: Record<string, number> = {};
    for (let i = 0; i < t.length - 1; i++) {
        const bg = t.slice(i, i + 2);
        vec[bg] = (vec[bg] ?? 0) + 1;
    }
    return vec;
}

function vecNorm(vec: Record<string, number>): number {
    let s = 0;
    for (const v of Object.values(vec)) s += v * v;
    return Math.sqrt(s) || 1;
}

function cosineSimilarity(a: Record<string, number>, an: number, b: Record<string, number>, bn: number): number {
    let dot = 0;
    const smaller = Object.keys(a).length < Object.keys(b).length ? a : b;
    const other = smaller === a ? b : a;
    for (const k of Object.keys(smaller)) {
        if (other[k]) dot += smaller[k] * other[k];
    }
    return dot / (an * bn);
}

function queryVector(text: string): { vec: Record<string, number>; norm: number } {
    const vec = charBigrams(text);
    return { vec, norm: vecNorm(vec) };
}

export function loadVectorIndex(referencesRoot: string): VectorIndexFile | null {
    const p = getVectorIndexPath();
    if (!p || !fs.existsSync(p)) return null;
    try {
        const data = JSON.parse(fs.readFileSync(p, 'utf8')) as VectorIndexFile;
        if (path.normalize(data.referencesRoot) === path.normalize(referencesRoot)) return data;
    } catch {
        return null;
    }
    return null;
}

export async function buildVectorIndex(context: vscode.ExtensionContext): Promise<VectorIndexFile | null> {
    const store = ReferenceStore.getInstance(context);
    const root = store.getReferencesRoot();
    if (!root) return null;

    let rows: RefSentenceRow[] = [];
    try {
        const dbPath = store.getDbPath();
        if (!dbPath || !fs.existsSync(dbPath)) {
            await store.rebuildIndex(undefined, false);
        }
        rows = await store.getAllSentences(50000);
    } catch {
        return null;
    }

    const entries: VectorIndexEntry[] = rows.map((r) => {
        const vec = charBigrams(r.content);
        return {
            id: r.id,
            file_path: r.file_path,
            start_line: r.start_line,
            end_line: r.end_line,
            content: r.content,
            vec,
            norm: vecNorm(vec),
        };
    });

    const index: VectorIndexFile = {
        builtAt: new Date().toISOString(),
        referencesRoot: root,
        entries,
    };

    const p = getVectorIndexPath();
    if (p) {
        FilePathUtils.ensureDirExists(path.dirname(p));
        fs.writeFileSync(p, JSON.stringify(index), 'utf8');
    }
    return index;
}

export async function searchVector(
    context: vscode.ExtensionContext,
    query: string,
    topK: number,
    minScore: number,
    scopePaths?: string[]
): Promise<Array<{ row: VectorIndexEntry; score: number }>> {
    const store = ReferenceStore.getInstance(context);
    const root = store.getReferencesRoot();
    if (!root) return [];

    let index = loadVectorIndex(root);
    if (!index || index.entries.length === 0) {
        index = await buildVectorIndex(context);
    }
    if (!index) return [];

    const { vec, norm } = queryVector(query);
    const scopeSet = scopePaths?.length ? new Set(scopePaths) : null;

    const scored = index.entries
        .filter((e) => !scopeSet || [...scopeSet].some((p) => e.file_path === p || e.file_path.startsWith(p + '/')))
        .map((e) => ({ row: e, score: cosineSimilarity(vec, norm, e.vec, e.norm) }))
        .filter((x) => x.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);

    return scored;
}
