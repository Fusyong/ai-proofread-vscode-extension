import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FilePathUtils } from '../../utils';

export { searchCacheKey, pageCacheKey, entityCacheKey } from './cacheKeys';

const CACHE_FILENAME = 'wiki-cache.json';
const CACHE_VERSION = 1;

export interface WikiSearchCacheEntry {
    fetchedAt: string;
    titles: string[];
    pageIds?: number[];
}

export interface WikiPageCacheEntry {
    fetchedAt: string;
    title: string;
    extract: string;
    url: string;
    wikidataId?: string;
    disambiguation?: boolean;
}

export interface WikiEntityCacheEntry {
    fetchedAt: string;
    claimsSummary: string;
}

export interface WikiCacheFile {
    version: number;
    entries: Record<string, WikiSearchCacheEntry | WikiPageCacheEntry | WikiEntityCacheEntry>;
}

const sessionMemory = new Map<string, WikiSearchCacheEntry | WikiPageCacheEntry | WikiEntityCacheEntry>();

function getCachePath(): string | null {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) return null;
    return path.join(ws, '.proofread', CACHE_FILENAME);
}

function isExpired(fetchedAt: string, ttlHours: number): boolean {
    if (ttlHours <= 0) return false;
    const t = Date.parse(fetchedAt);
    if (Number.isNaN(t)) return true;
    return Date.now() - t > ttlHours * 3600_000;
}

function loadFile(): WikiCacheFile {
    const cachePath = getCachePath();
    if (!cachePath || !fs.existsSync(cachePath)) {
        return { version: CACHE_VERSION, entries: {} };
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as WikiCacheFile;
        if (parsed.version !== CACHE_VERSION || !parsed.entries) {
            return { version: CACHE_VERSION, entries: {} };
        }
        return parsed;
    } catch {
        return { version: CACHE_VERSION, entries: {} };
    }
}

function saveFile(data: WikiCacheFile): void {
    const cachePath = getCachePath();
    if (!cachePath) return;
    FilePathUtils.ensureDirExists(path.dirname(cachePath));
    fs.writeFileSync(cachePath, JSON.stringify(data, null, 2), 'utf8');
}

export function getWikiCacheEntry<T extends WikiSearchCacheEntry | WikiPageCacheEntry | WikiEntityCacheEntry>(
    key: string,
    ttlHours: number,
    enabled: boolean
): T | null {
    if (!enabled) return null;
    const mem = sessionMemory.get(key);
    if (mem && !isExpired(mem.fetchedAt, ttlHours)) {
        return mem as T;
    }
    const file = loadFile();
    const entry = file.entries[key];
    if (!entry || isExpired(entry.fetchedAt, ttlHours)) {
        return null;
    }
    sessionMemory.set(key, entry);
    return entry as T;
}

export function setWikiCacheEntry(
    key: string,
    entry: WikiSearchCacheEntry | WikiPageCacheEntry | WikiEntityCacheEntry
): void {
    sessionMemory.set(key, entry);
    const file = loadFile();
    file.entries[key] = entry;
    saveFile(file);
}

export function clearWikiCache(): boolean {
    sessionMemory.clear();
    const cachePath = getCachePath();
    if (!cachePath) return false;
    if (fs.existsSync(cachePath)) {
        fs.unlinkSync(cachePath);
    }
    return true;
}

export type WikiCacheStats = { hits: number; misses: number };

let stats: WikiCacheStats = { hits: 0, misses: 0 };

export function resetWikiCacheStats(): void {
    stats = { hits: 0, misses: 0 };
}

export function getWikiCacheStats(): WikiCacheStats {
    return { ...stats };
}

export function recordCacheHit(): void {
    stats.hits++;
}

export function recordCacheMiss(): void {
    stats.misses++;
}
