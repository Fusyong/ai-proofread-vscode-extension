import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FilePathUtils } from '../utils';
import {
    createEmptyActiveTm,
    createEmptyArchiveTm,
    normalizeTmExample,
    normalizeTmTerm,
    type ActiveTranslationMemory,
    type ArchiveTranslationMemory,
    type TmRecentRound,
} from './schema';

export function getTranslationMemoryPath(anchorUri: vscode.Uri): string {
    return path.join(FilePathUtils.getProofreadWorkspaceRoot(anchorUri), '.proofread', 'translation-memory.json');
}

export function getTranslationMemoryArchivePath(anchorUri: vscode.Uri): string {
    return path.join(
        FilePathUtils.getProofreadWorkspaceRoot(anchorUri),
        '.proofread',
        'translation-memory-archive.json'
    );
}

function coerceActive(raw: unknown): ActiveTranslationMemory {
    if (!raw || typeof raw !== 'object') {
        return createEmptyActiveTm();
    }
    const o = raw as Record<string, unknown>;
    if (o.version !== 1) {
        return createEmptyActiveTm();
    }
    const terms = Array.isArray(o.terms)
        ? o.terms
              .map((x) => {
                  if (!x || typeof x !== 'object') {
                      return null;
                  }
                  const t = x as { source?: string; target?: string };
                  if (!t.source || !t.target) {
                      return null;
                  }
                  return normalizeTmTerm(x as Parameters<typeof normalizeTmTerm>[0]);
              })
              .filter((x): x is NonNullable<typeof x> => x != null)
        : [];
    const examples = Array.isArray(o.examples)
        ? o.examples
              .map((x) => {
                  if (!x || typeof x !== 'object') {
                      return null;
                  }
                  const t = x as { source?: string; target?: string };
                  if (!t.source || !t.target) {
                      return null;
                  }
                  return normalizeTmExample(x as Parameters<typeof normalizeTmExample>[0]);
              })
              .filter((x): x is NonNullable<typeof x> => x != null)
        : [];
    const recentRounds: TmRecentRound[] = [];
    if (Array.isArray(o.recentRounds)) {
        for (const r of o.recentRounds) {
            if (!r || typeof r !== 'object') {
                continue;
            }
            const rr = r as TmRecentRound;
            if (typeof rr.body === 'string' && typeof rr.id === 'string') {
                recentRounds.push({
                    id: rr.id,
                    createdAt: typeof rr.createdAt === 'string' ? rr.createdAt : new Date().toISOString(),
                    body: rr.body,
                });
            }
        }
    }
    return { version: 1, terms, examples, recentRounds };
}

function coerceArchive(raw: unknown): ArchiveTranslationMemory {
    if (!raw || typeof raw !== 'object') {
        return createEmptyArchiveTm();
    }
    const o = raw as Record<string, unknown>;
    if (o.version !== 1) {
        return createEmptyArchiveTm();
    }
    const empty = createEmptyActiveTm();
    empty.terms = Array.isArray(o.terms) ? (coerceActive({ version: 1, terms: o.terms, examples: [], recentRounds: [] }).terms) : [];
    empty.examples = Array.isArray(o.examples)
        ? coerceActive({ version: 1, terms: [], examples: o.examples, recentRounds: [] }).examples
        : [];
    return { version: 1, terms: empty.terms, examples: empty.examples };
}

export function loadTranslationMemory(anchorUri: vscode.Uri): {
    active: ActiveTranslationMemory;
    archive: ArchiveTranslationMemory;
} {
    const activePath = getTranslationMemoryPath(anchorUri);
    const archPath = getTranslationMemoryArchivePath(anchorUri);
    let active = createEmptyActiveTm();
    let archive = createEmptyArchiveTm();
    try {
        if (fs.existsSync(activePath)) {
            active = coerceActive(JSON.parse(fs.readFileSync(activePath, 'utf8')));
        }
    } catch {
        /* empty */
    }
    try {
        if (fs.existsSync(archPath)) {
            archive = coerceArchive(JSON.parse(fs.readFileSync(archPath, 'utf8')));
        }
    } catch {
        /* empty */
    }
    return { active, archive };
}

export function saveTranslationMemory(
    anchorUri: vscode.Uri,
    active: ActiveTranslationMemory,
    archive: ArchiveTranslationMemory
): void {
    const activePath = getTranslationMemoryPath(anchorUri);
    const archPath = getTranslationMemoryArchivePath(anchorUri);
    const dir = path.dirname(activePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const backup = vscode.workspace
        .getConfiguration('ai-proofread')
        .get<boolean>('translationMemory.backupBeforeWrite', true);
    if (backup) {
        FilePathUtils.backupFileIfExists(activePath);
        FilePathUtils.backupFileIfExists(archPath);
    }
    fs.writeFileSync(activePath, JSON.stringify(active, null, 2), 'utf8');
    fs.writeFileSync(archPath, JSON.stringify(archive, null, 2), 'utf8');
}
