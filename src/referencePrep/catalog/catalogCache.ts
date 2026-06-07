import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FilePathUtils } from '../../utils';
import { buildReferenceCatalog, type ReferenceCatalog } from './catalogBuilder';

const CACHE_FILENAME = 'reference-catalog.json';

function getCachePath(): string | null {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) return null;
    return path.join(ws, '.proofread', CACHE_FILENAME);
}

export function loadCachedCatalog(referencesRoot: string): ReferenceCatalog | null {
    const cachePath = getCachePath();
    if (!cachePath || !fs.existsSync(cachePath)) return null;
    try {
        const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as ReferenceCatalog;
        if (path.normalize(parsed.referencesRoot) === path.normalize(referencesRoot)) {
            return parsed;
        }
    } catch {
        return null;
    }
    return null;
}

export function saveCachedCatalog(catalog: ReferenceCatalog): void {
    const cachePath = getCachePath();
    if (!cachePath) return;
    FilePathUtils.ensureDirExists(path.dirname(cachePath));
    fs.writeFileSync(cachePath, JSON.stringify(catalog, null, 2), 'utf8');
}

export function getOrBuildCatalog(referencesRoot: string, forceRebuild = false): ReferenceCatalog {
    if (!forceRebuild) {
        const cached = loadCachedCatalog(referencesRoot);
        if (cached) return cached;
    }
    const catalog = buildReferenceCatalog(referencesRoot, { countHeadings: true });
    saveCachedCatalog(catalog);
    return catalog;
}
