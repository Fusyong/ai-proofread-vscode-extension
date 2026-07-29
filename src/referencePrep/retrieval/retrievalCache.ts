/**
 * 项目级检索资料缓存：按通道查询指纹缓存 CorpusHit，避免重复检索。
 * 存储于工作区 `.proofread/retrieval-cache.json`。
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FilePathUtils } from '../../utils';
import type { CorpusHit, CorpusHitSource } from '../schema';

const CACHE_FILENAME = 'retrieval-cache.json';
const CACHE_VERSION = 1;

export interface RetrievalCacheEntry {
    fetchedAt: string;
    source: CorpusHitSource;
    scopeKey?: string;
    catalogSnapshotId?: string;
    hits: CorpusHit[];
}

export interface RetrievalCacheFile {
    version: number;
    entries: Record<string, RetrievalCacheEntry>;
}

export interface RetrievalCacheConfig {
    enabled: boolean;
    ttlHours: number;
    maxEntries: number;
}

const sessionMemory = new Map<string, RetrievalCacheEntry>();

let stats = { hits: 0, misses: 0 };

export function resetRetrievalCacheStats(): void {
    stats = { hits: 0, misses: 0 };
}

export function getRetrievalCacheStats(): { hits: number; misses: number } {
    return { ...stats };
}

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

function loadFile(): RetrievalCacheFile {
    const cachePath = getCachePath();
    if (!cachePath || !fs.existsSync(cachePath)) {
        return { version: CACHE_VERSION, entries: {} };
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as RetrievalCacheFile;
        if (parsed.version !== CACHE_VERSION || !parsed.entries || typeof parsed.entries !== 'object') {
            return { version: CACHE_VERSION, entries: {} };
        }
        return parsed;
    } catch {
        return { version: CACHE_VERSION, entries: {} };
    }
}

function saveFile(data: RetrievalCacheFile): void {
    const cachePath = getCachePath();
    if (!cachePath) return;
    FilePathUtils.ensureDirExists(path.dirname(cachePath));
    fs.writeFileSync(cachePath, JSON.stringify(data, null, 2), 'utf8');
}

function pruneOldest(entries: Record<string, RetrievalCacheEntry>, maxEntries: number): void {
    const keys = Object.keys(entries);
    if (keys.length <= maxEntries) return;
    const sorted = keys.sort(
        (a, b) => Date.parse(entries[a].fetchedAt) - Date.parse(entries[b].fetchedAt)
    );
    const remove = sorted.slice(0, keys.length - maxEntries);
    for (const k of remove) {
        delete entries[k];
        sessionMemory.delete(k);
    }
}

export function getRetrievalCacheConfig(): RetrievalCacheConfig {
    const config = vscode.workspace.getConfiguration('ai-proofread');
    return {
        enabled: config.get<boolean>('referencePrep.retrievalCache.enabled', true),
        ttlHours: config.get<number>('referencePrep.retrievalCache.ttlHours', 168),
        maxEntries: config.get<number>('referencePrep.retrievalCache.maxEntries', 800),
    };
}

/** 稳定短哈希，用作缓存键 */
export function fingerprintRetrievalKey(parts: unknown): string {
    const json = JSON.stringify(parts, (_k, v) => {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            const sorted: Record<string, unknown> = {};
            for (const key of Object.keys(v as object).sort()) {
                sorted[key] = (v as Record<string, unknown>)[key];
            }
            return sorted;
        }
        return v;
    });
    return createHash('sha1').update(json).digest('hex').slice(0, 24);
}

export function buildScopeCacheKey(params: {
    catalogSnapshotId?: string;
    dictIds?: string[];
    filePaths?: string[];
}): string {
    return fingerprintRetrievalKey({
        catalog: params.catalogSnapshotId ?? null,
        dicts: [...(params.dictIds ?? [])].sort(),
        /** 仅用路径列表指纹，避免把整表写入键 */
        files: fingerprintRetrievalKey([...(params.filePaths ?? [])].sort()),
    });
}

export function getCachedRetrievalHits(
    key: string,
    ttlHours: number,
    enabled: boolean,
    catalogSnapshotId?: string
): CorpusHit[] | null {
    if (!enabled) return null;

    const useEntry = (entry: RetrievalCacheEntry): CorpusHit[] | null => {
        if (isExpired(entry.fetchedAt, ttlHours)) return null;
        // 文献类：目录快照变化则失效
        if (
            catalogSnapshotId &&
            entry.catalogSnapshotId &&
            entry.catalogSnapshotId !== catalogSnapshotId &&
            (entry.source === 'grep_md' || entry.source === 'bm25' || entry.source === 'vector')
        ) {
            return null;
        }
        return cloneHits(entry.hits);
    };

    const mem = sessionMemory.get(key);
    if (mem) {
        const hits = useEntry(mem);
        if (hits) {
            stats.hits++;
            return hits;
        }
    }

    const file = loadFile();
    const entry = file.entries[key];
    if (!entry) {
        stats.misses++;
        return null;
    }
    const hits = useEntry(entry);
    if (!hits) {
        stats.misses++;
        return null;
    }
    sessionMemory.set(key, entry);
    stats.hits++;
    return hits;
}

export function setCachedRetrievalHits(params: {
    key: string;
    source: CorpusHitSource;
    hits: CorpusHit[];
    scopeKey?: string;
    catalogSnapshotId?: string;
    maxEntries: number;
}): void {
    const entry: RetrievalCacheEntry = {
        fetchedAt: new Date().toISOString(),
        source: params.source,
        scopeKey: params.scopeKey,
        catalogSnapshotId: params.catalogSnapshotId,
        hits: cloneHits(params.hits),
    };
    sessionMemory.set(params.key, entry);
    const file = loadFile();
    file.entries[params.key] = entry;
    pruneOldest(file.entries, Math.max(50, params.maxEntries));
    saveFile(file);
}

export function clearRetrievalCache(): boolean {
    sessionMemory.clear();
    const cachePath = getCachePath();
    if (!cachePath) return false;
    if (fs.existsSync(cachePath)) {
        fs.unlinkSync(cachePath);
    }
    return true;
}

function cloneHits(hits: CorpusHit[]): CorpusHit[] {
    return hits.map((h) => ({ ...h, channelScores: h.channelScores ? { ...h.channelScores } : undefined }));
}

/** 缓存命中后刷新本轮元数据 */
export function reviveCachedHits(
    hits: CorpusHit[],
    opts: { roundId?: string; priority?: number }
): CorpusHit[] {
    return hits.map((h) => ({
        ...h,
        roundId: opts.roundId ?? h.roundId,
        llmPriority: opts.priority ?? h.llmPriority,
        channelScores: h.channelScores ? { ...h.channelScores } : undefined,
    }));
}

/**
 * 查缓存；未命中则执行 producer 并写入。
 */
export async function withRetrievalCache(params: {
    source: CorpusHitSource;
    keyParts: unknown;
    scopeKey?: string;
    catalogSnapshotId?: string;
    roundId?: string;
    priority?: number;
    produce: () => Promise<CorpusHit[]> | CorpusHit[];
}): Promise<{ hits: CorpusHit[]; fromCache: boolean }> {
    const cfg = getRetrievalCacheConfig();
    const key = fingerprintRetrievalKey({
        source: params.source,
        scopeKey: params.scopeKey ?? null,
        q: params.keyParts,
    });

    if (cfg.enabled) {
        const cached = getCachedRetrievalHits(key, cfg.ttlHours, true, params.catalogSnapshotId);
        if (cached) {
            return {
                hits: reviveCachedHits(cached, {
                    roundId: params.roundId,
                    priority: params.priority,
                }),
                fromCache: true,
            };
        }
    }

    const produced = await params.produce();
    if (cfg.enabled) {
        setCachedRetrievalHits({
            key,
            source: params.source,
            hits: produced,
            scopeKey: params.scopeKey,
            catalogSnapshotId: params.catalogSnapshotId,
            maxEntries: cfg.maxEntries,
        });
    }
    return { hits: produced, fromCache: false };
}
