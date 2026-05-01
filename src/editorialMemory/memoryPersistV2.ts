import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FilePathUtils, normalizeLineEndings } from '../utils';
import { parseEditorialMemory } from './parser';
import type { ActiveMemoryV2, ArchiveMemoryV2, CurrentRoundFlat, MemoryEntry } from './schemaV2';
import {
    clipText,
    createEmptyActiveV2,
    createEmptyArchiveV2,
    formatMemoryEntryLine,
    newMemoryEntryId,
    newRoundId,
    normalizeMemoryEntry,
} from './schemaV2';

export function loadArchive(pathArch: string): ArchiveMemoryV2 {
    try {
        if (!fs.existsSync(pathArch)) {
            return createEmptyArchiveV2();
        }
        const j = JSON.parse(fs.readFileSync(pathArch, 'utf8')) as ArchiveMemoryV2;
        if (j && j.version === 2 && Array.isArray(j.entries)) {
            return j;
        }
    } catch {
        /* empty */
    }
    return createEmptyArchiveV2();
}

function parseBulletLines(sectionBody: string): string[] {
    const lines = normalizeLineEndings(sectionBody || '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    const out: string[] = [];
    for (const l of lines) {
        let s = l;
        if (/^-\s+/.test(s)) {
            s = s.replace(/^-\s+/, '').trim();
        }
        if (s) {
            out.push(s);
        }
    }
    return out;
}

function bulletsToEntries(lines: string[], max: number): MemoryEntry[] {
    const sliced = lines.slice(0, max);
    const now = new Date().toISOString();
    return sliced.map((line) =>
        normalizeMemoryEntry({
            id: newMemoryEntryId(),
            createdAt: now,
            original: '',
            changedTo: clipText(line, 900),
            repeated: 1,
            weight: 0,
        })
    );
}

/** 将磁盘上的 v2（含旧 recent/current 数组）规范为 global + currentRounds */
export function normalizeLoadedActive(raw: Record<string, unknown>): ActiveMemoryV2 {
    const empty = createEmptyActiveV2();
    if (!raw || raw.version !== 2) {
        return empty;
    }
    const global = Array.isArray(raw.global)
        ? (raw.global as MemoryEntry[]).filter((e) => e && typeof e === 'object' && typeof e.id === 'string')
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
            if (e && typeof e === 'object' && 'id' in e) {
                linesOut.push(formatMemoryEntryLine(e as MemoryEntry));
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

/**
 * v1 markdown → v2：全局条文化；原「近期」并入一条 currentRound
 */
export function migrateV1MarkdownToV2(rawMd: string, caps: { globalMax: number }): {
    active: ActiveMemoryV2;
    archive: ArchiveMemoryV2;
} {
    const parsed = parseEditorialMemory(rawMd);
    const active = createEmptyActiveV2();
    const archive = createEmptyArchiveV2();

    const gLines = parseBulletLines(parsed.globalBody);
    const rLines = parseBulletLines(parsed.recentSectionBody);
    active.global = bulletsToEntries(gLines, caps.globalMax);
    const now = new Date().toISOString();
    if (rLines.length > 0) {
        active.currentRounds = [
            {
                id: newRoundId(),
                createdAt: now,
                body: rLines.map((l) => `- ${l}`).join('\n'),
            },
        ];
    }

    archive.entries.push(
        normalizeMemoryEntry({
            id: newMemoryEntryId(),
            createdAt: now,
            original: '[migrated:v1-full]',
            changedTo: clipText(rawMd, 50_000),
            repeated: 1,
            weight: 0,
        })
    );

    const dumpStructure = [...parsed.structureBlocks, ...parsed.pendingBlocks]
        .map((b) => b.fullRaw.trim())
        .filter(Boolean)
        .join('\n---\n');
    if (dumpStructure.trim()) {
        archive.entries.unshift(
            normalizeMemoryEntry({
                id: newMemoryEntryId(),
                createdAt: now,
                original: '[migrated:v1-structure-path-blocks]',
                changedTo: clipText(dumpStructure, 120_000),
                repeated: 1,
                weight: 0,
            })
        );
    }

    return { active, archive };
}

export function loadActiveAndArchive(anchorUri: vscode.Uri): { active: ActiveMemoryV2; archive: ArchiveMemoryV2; migratedMd: boolean } {
    const jsonPath = FilePathUtils.getEditorialMemoryPath(anchorUri);
    const archPath = FilePathUtils.getEditorialMemoryArchivePath(anchorUri);
    const legacyMd = FilePathUtils.getEditorialMemoryLegacyMarkdownPath(anchorUri);
    FilePathUtils.ensureDirExists(path.dirname(jsonPath));

    const c = vscode.workspace.getConfiguration('ai-proofread');
    const globalMax = c.get<number>('editorialMemory.globalActiveMax', 30);

    if (fs.existsSync(jsonPath)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as Record<string, unknown>;
            if (parsed.version === 2) {
                return { active: normalizeLoadedActive(parsed), archive: loadArchive(archPath), migratedMd: false };
            }
        } catch {
            /* fall through */
        }
    }

    if (fs.existsSync(legacyMd)) {
        const raw = fs.readFileSync(legacyMd, 'utf8');
        const { active, archive: migArc } = migrateV1MarkdownToV2(raw, { globalMax });
        const mergedArch = createEmptyArchiveV2();
        mergedArch.entries = [...migArc.entries, ...loadArchive(archPath).entries];
        const backup = c.get<boolean>('editorialMemory.backupBeforeWrite', true);
        if (backup) {
            FilePathUtils.backupFileIfExists(legacyMd, false);
        }
        fs.writeFileSync(jsonPath, JSON.stringify(active, null, 2), 'utf8');
        fs.writeFileSync(archPath, JSON.stringify(mergedArch, null, 2), 'utf8');
        try {
            fs.unlinkSync(legacyMd);
        } catch {
            /* keep file if locked */
        }
        return { active, archive: mergedArch, migratedMd: true };
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
    return { active: activeLoaded, archive: archLoaded, migratedMd: false };
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
