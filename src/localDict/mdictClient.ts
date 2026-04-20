import * as vscode from 'vscode';
import { createHash } from 'crypto';
import Mdict from 'mdict-js';
import { Logger } from '../utils';
import type { ResolvedLocalDictConfigItem } from './dictConfig';

export type LookupMode = 'exact' | 'prefix';

export interface DictLookupHit {
    dictId: string;
    dictName: string;
    queryTerm: string;
    matchedKey: string;
    mode: LookupMode;
    definition: string;
}

type CacheValue = { v: string; ts: number; matchedKey: string; mode: LookupMode };

export class MdictClient {
    private static instance: MdictClient | undefined;
    private dictInstances = new Map<string, any>(); // mdxPathResolved -> instance
    private cache = new Map<string, CacheValue>(); // key -> value (in-memory)
    private logger = Logger.getInstance();

    private constructor(private context: vscode.ExtensionContext) {}

    public static getInstance(context: vscode.ExtensionContext): MdictClient {
        if (!this.instance) {
            this.instance = new MdictClient(context);
        }
        return this.instance;
    }

    public async lookup(
        dict: ResolvedLocalDictConfigItem,
        term: string,
        mode: LookupMode,
        options: {
            prefixMaxCandidates: number;
            minPrefixLength: number;
            maxDefinitionChars: number;
            cacheEnabled: boolean;
            cacheTtlHours: number;
        }
    ): Promise<DictLookupHit | null> {
        const queryTerm = term;
        const normalized = normalizeTerm(term);
        if (!normalized) return null;

        const dictKey = dict.mdxPathResolved;
        const cacheKey = buildCacheKey(dictKey, mode, normalized);
        const now = Date.now();

        if (options.cacheEnabled) {
            const cached = await this.getCached(cacheKey, options.cacheTtlHours);
            if (cached) {
                return {
                    dictId: dict.id,
                    dictName: dict.name,
                    queryTerm,
                    matchedKey: cached.matchedKey,
                    mode: cached.mode,
                    definition: cached.v,
                };
            }
        }

        const mdict = this.getOrCreateDict(dictKey);
        const hit = (() => {
            if (mode === 'exact') return this.lookupExact(mdict, normalized);
            return this.lookupPrefix(mdict, normalized, options.prefixMaxCandidates, options.minPrefixLength);
        })();

        if (!hit) return null;

        const definition = limitText(hit.definition, options.maxDefinitionChars);
        if (options.cacheEnabled) {
            this.cache.set(cacheKey, { v: definition, ts: now, matchedKey: hit.matchedKey, mode });
            // best-effort persist: avoid frequent IO by buffering in globalState only (memento)
            try {
                void this.context.globalState.update(cacheKey, { v: definition, ts: now, matchedKey: hit.matchedKey, mode });
            } catch (e) {
                this.logger.warn(`[MdictClient] 缓存写入失败: ${String(e)}`);
            }
        }

        return {
            dictId: dict.id,
            dictName: dict.name,
            queryTerm,
            matchedKey: hit.matchedKey,
            mode,
            definition,
        };
    }

    private getOrCreateDict(mdxPathResolved: string): any {
        const existing = this.dictInstances.get(mdxPathResolved);
        if (existing) return existing;
        const inst = new (Mdict as any)(mdxPathResolved);
        this.dictInstances.set(mdxPathResolved, inst);
        return inst;
    }

    private lookupExact(mdict: any, term: string): { matchedKey: string; definition: string } | null {
        try {
            const res = mdict.lookup(term);
            if (!res) return null;
            if (Array.isArray(res)) {
                // mixed mode: array of { keyText, definition }
                const exact = res.find((x) => x?.keyText === term && typeof x?.definition === 'string');
                if (exact) return { matchedKey: exact.keyText, definition: exact.definition };
                const first = res.find((x) => typeof x?.definition === 'string' && typeof x?.keyText === 'string');
                return first ? { matchedKey: first.keyText, definition: first.definition } : null;
            }
            if (typeof res.definition === 'string' && typeof res.keyText === 'string') {
                // exact match expected
                if (res.keyText === term) return { matchedKey: res.keyText, definition: res.definition };
                // 有些词典会返回最接近项；这里严格一些：不算命中
                return null;
            }
            return null;
        } catch (e) {
            this.logger.warn(`[MdictClient] exact 查询失败: ${String(e)}`);
            return null;
        }
    }

    private lookupPrefix(
        mdict: any,
        term: string,
        maxCandidates: number,
        minPrefixLength: number
    ): { matchedKey: string; definition: string } | null {
        if (term.length < minPrefixLength) return null;
        try {
            const list = mdict.prefix(term);
            if (!Array.isArray(list) || list.length === 0) return null;
            const candidates = list.slice(0, Math.max(1, maxCandidates));
            const exact = candidates.find((x: any) => x?.keyText === term);
            const picked = exact ?? candidates[0];
            if (!picked?.keyText) return null;

            if (typeof picked.definition === 'string') {
                return { matchedKey: picked.keyText, definition: picked.definition };
            }
            const rofset = picked.rofset ?? picked.recordStartOffset;
            if (typeof rofset === 'number') {
                const def = mdict.parse_defination(picked.keyText, rofset);
                if (typeof def === 'string' && def) return { matchedKey: picked.keyText, definition: def };
            }
            // fallback: try lookup on picked key
            const res = mdict.lookup(picked.keyText);
            if (res && typeof res.definition === 'string') {
                return { matchedKey: res.keyText ?? picked.keyText, definition: res.definition };
            }
            return null;
        } catch (e) {
            this.logger.warn(`[MdictClient] prefix 查询失败: ${String(e)}`);
            return null;
        }
    }

    private async getCached(cacheKey: string, ttlHours: number): Promise<CacheValue | null> {
        const now = Date.now();
        const ttlMs = ttlHours > 0 ? ttlHours * 3600_000 : 0;
        const mem = this.cache.get(cacheKey);
        if (mem) {
            if (!ttlMs || now - mem.ts <= ttlMs) return mem;
            this.cache.delete(cacheKey);
        }
        try {
            const persisted = this.context.globalState.get<any>(cacheKey);
            if (persisted?.v && typeof persisted.v === 'string' && typeof persisted.ts === 'number') {
                const val: CacheValue = {
                    v: persisted.v,
                    ts: persisted.ts,
                    matchedKey: typeof persisted.matchedKey === 'string' ? persisted.matchedKey : '',
                    mode: persisted.mode === 'prefix' ? 'prefix' : 'exact',
                };
                if (!ttlMs || now - val.ts <= ttlMs) {
                    this.cache.set(cacheKey, val);
                    return val;
                }
            }
        } catch (e) {
            // ignore
        }
        return null;
    }
}

function normalizeTerm(s: string): string {
    return (s ?? '').trim();
}

function limitText(s: string, maxChars: number): string {
    if (!s) return s;
    if (!maxChars || maxChars <= 0) return s;
    if (s.length <= maxChars) return s;
    return s.slice(0, maxChars) + '\n\n[...已截断...]';
}

function buildCacheKey(dictPath: string, mode: LookupMode, termNormalized: string): string {
    const h = createHash('sha1').update(dictPath).update('|').update(mode).update('|').update(termNormalized).digest('hex');
    return `dictprep.cache.${h}`;
}

