import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FilePathUtils } from '../utils';
import type { ActiveMemoryV2, ArchiveMemoryV2, CurrentRoundFlat } from './schemaV2';
import { coerceMemoryEntryRow, createEmptyActiveV2, createEmptyArchiveV2, formatMemoryEntryLine, newRoundId } from './schemaV2';

export function loadArchive(pathArch: string): ArchiveMemoryV2 {
    try {
        if (!fs.existsSync(pathArch)) {
            return createEmptyArchiveV2();
        }
        const j = JSON.parse(fs.readFileSync(pathArch, 'utf8')) as ArchiveMemoryV2;
        if (j && j.version === 2 && Array.isArray(j.entries)) {
            const entries = j.entries.map((x) => coerceMemoryEntryRow(x)).filter((x): x is NonNullable<typeof x> => x != null);
            return { version: 2, entries };
        }
    } catch {
        /* empty */
    }
    return createEmptyArchiveV2();
}

/** 将磁盘上的 v2（含旧 recent/current 数组）规范为 global + currentRounds */
export function normalizeLoadedActive(raw: Record<string, unknown>): ActiveMemoryV2 {
    const empty = createEmptyActiveV2();
    if (!raw || raw.version !== 2) {
        return empty;
    }
    const global = Array.isArray(raw.global)
        ? raw.global.map((e) => coerceMemoryEntryRow(e)).filter((e): e is NonNullable<typeof e> => e != null)
        : [];

    if (Array.isArray(raw.currentRounds)) {
        const cr: CurrentRoundFlat[] = [];
        for (const x of raw.currentRounds as unknown[]) {
            if (!x || typeof x !== 'object') {
                continue;
            }
            const o = x as CurrentRoundFlat;
            if (typeof o.body === 'string' && typeof o.id === 'string') {
                cr.push({
                    id: o.id,
                    createdAt: typeof o.createdAt === 'string' ? o.createdAt : new Date().toISOString(),
                    body: o.body,
                });
            }
        }
        return { version: 2, global, currentRounds: cr };
    }

    const linesOut: string[] = [];
    const pushEntries = (arr: unknown) => {
        if (!Array.isArray(arr)) {
            return;
        }
        for (const e of arr) {
            const row = coerceMemoryEntryRow(e);
            if (row) {
                linesOut.push(formatMemoryEntryLine(row));
            }
        }
    };
    pushEntries(raw.recent);
    pushEntries(raw.current);

    const currentRounds: CurrentRoundFlat[] = [];
    if (linesOut.length > 0) {
        currentRounds.push({
            id: newRoundId(),
            createdAt: new Date().toISOString(),
            body: linesOut.join('\n'),
        });
    }
    return { version: 2, global, currentRounds };
}

export function loadActiveAndArchive(anchorUri: vscode.Uri): { active: ActiveMemoryV2; archive: ArchiveMemoryV2 } {
    const jsonPath = FilePathUtils.getEditorialMemoryPath(anchorUri);
    const archPath = FilePathUtils.getEditorialMemoryArchivePath(anchorUri);
    FilePathUtils.ensureDirExists(path.dirname(jsonPath));

    if (fs.existsSync(jsonPath)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as Record<string, unknown>;
            if (parsed.version === 2) {
                return { active: normalizeLoadedActive(parsed), archive: loadArchive(archPath) };
            }
        } catch {
            /* fall through */
        }
    }

    if (!fs.existsSync(jsonPath)) {
        fs.writeFileSync(jsonPath, JSON.stringify(createEmptyActiveV2(), null, 2), 'utf8');
    }

    let activeLoaded = createEmptyActiveV2();
    try {
        const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as Record<string, unknown>;
        activeLoaded = normalizeLoadedActive(parsed);
    } catch {
        activeLoaded = createEmptyActiveV2();
        fs.writeFileSync(jsonPath, JSON.stringify(createEmptyActiveV2(), null, 2), 'utf8');
    }

    if (!fs.existsSync(archPath)) {
        fs.writeFileSync(archPath, JSON.stringify(createEmptyArchiveV2(), null, 2), 'utf8');
    }
    const archLoaded = loadArchive(archPath);
    return { active: activeLoaded, archive: archLoaded };
}

export function saveActiveAndArchive(params: {
    anchorUri: vscode.Uri;
    active: ActiveMemoryV2;
    archive: ArchiveMemoryV2;
}): void {
    const jsonPath = FilePathUtils.getEditorialMemoryPath(params.anchorUri);
    const archPath = FilePathUtils.getEditorialMemoryArchivePath(params.anchorUri);
    const c = vscode.workspace.getConfiguration('ai-proofread');
    const backup = c.get<boolean>('editorialMemory.backupBeforeWrite', true);
    FilePathUtils.ensureDirExists(path.dirname(jsonPath));
    if (backup) {
        FilePathUtils.backupFileIfExists(jsonPath, false);
        FilePathUtils.backupFileIfExists(archPath, false);
    }
    fs.writeFileSync(jsonPath, JSON.stringify(params.active, null, 2), 'utf8');
    fs.writeFileSync(archPath, JSON.stringify(params.archive, null, 2), 'utf8');
}
