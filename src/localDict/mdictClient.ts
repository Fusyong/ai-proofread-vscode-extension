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

    /**
     * 返回同名多条的全部命中（目前仅 exact 支持多条；prefix 仍只返回 1 条）。
     * 注意：为避免 globalState 过大，这里不做持久化缓存；如有需要可后续改为按条缓存。
     */
    public async lookupMany(
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
    ): Promise<DictLookupHit[]> {
        const queryTerm = term;
        const normalized = normalizeTerm(term);
        if (!normalized) return [];

        const mdict = this.getOrCreateDict(dict.mdxPathResolved);
        const hits = (() => {
            if (mode === 'exact') return this.lookupExactMany(mdict, normalized);
            const one = this.lookupPrefix(mdict, normalized, options.prefixMaxCandidates, options.minPrefixLength);
            return one ? [one] : [];
        })();

        return hits.map((h) => ({
            dictId: dict.id,
            dictName: dict.name,
            queryTerm,
            matchedKey: h.matchedKey,
            mode,
            // 不在此处截断：词典释义往往是 HTML，后续会先清理 HTML 再按“净文本长度”截断
            definition: h.definition,
        }));
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
                const exact = res.find((x) => (x?.keyText ?? x?.key) === term && typeof x?.definition === 'string');
                if (exact) return { matchedKey: exact.keyText ?? exact.key, definition: exact.definition };
                const first = res.find(
                    (x) => typeof x?.definition === 'string' && (typeof x?.keyText === 'string' || typeof x?.key === 'string')
                );
                return first ? { matchedKey: first.keyText ?? first.key, definition: first.definition } : null;
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

    private lookupExactMany(mdict: any, term: string): Array<{ matchedKey: string; definition: string }> {
        try {
            const res = mdict.lookup(term);
            if (!res) return [];
            if (Array.isArray(res)) {
                const out: Array<{ matchedKey: string; definition: string }> = [];
                const termCmp = normalizeForCompare(term);
                for (const x of res) {
                    const keyText = typeof x?.keyText === 'string' ? x.keyText : typeof x?.key === 'string' ? x.key : '';
                    if (!keyText) continue;
                    // 有些词典同一“显示词条”可能在底层 keyText 含不可见字符/空白差异（如 NBSP/零宽空格）
                    // 这里用更宽松的比较，以便返回同名多条
                    if (normalizeForCompare(keyText) !== termCmp) continue;
                    const defDirect = typeof x?.definition === 'string' ? x.definition : '';
                    if (defDirect) {
                        out.push({ matchedKey: keyText, definition: defDirect });
                        continue;
                    }
                    // 有些词典返回的是索引项，需要用 offset 解析 definition
                    const rofset = x?.rofset ?? x?.recordStartOffset;
                    if (typeof rofset === 'number') {
                        const data = mdict.parse_defination(keyText, rofset);
                        const def = extractDefinition(data);
                        if (def) out.push({ matchedKey: keyText, definition: def });
                    }
                }
                return out;
            }
            if (typeof res?.definition === 'string' && typeof res?.keyText === 'string') {
                // mdict-js 在某些词典（如辞海7）会对重复 key 只返回第一条。
                // 若底层已缓存 keyList，可尝试枚举同 key 的多条记录并按 offset 解码。
                const keyList: any[] | undefined = Array.isArray((mdict as any)?.keyList) ? (mdict as any).keyList : undefined;
                if (keyList && keyList.length > 0) {
                    const termCmp = normalizeForCompare(term);
                    const dups = keyList.filter((k) => normalizeForCompare(k?.keyText) === termCmp);
                    if (dups.length > 1) {
                        const out: Array<{ matchedKey: string; definition: string }> = [];
                        for (const k of dups) {
                            const keyText = String(k?.keyText ?? '');
                            const startoffset = k?.recordStartOffset;
                            const nextStart = k?.nextRecordStartOffset;
                            if (typeof startoffset !== 'number' || typeof nextStart !== 'number') continue;

                            // parse_defination 在重复 key 的“后续条目”上会因为 nextStart 计算方式导致返回空串；
                            // 这里直接调用内部解码函数，并显式传入 nextStart。
                            try {
                                const rid = typeof (mdict as any)._reduceRecordBlock === 'function' ? (mdict as any)._reduceRecordBlock(startoffset) : null;
                                const data =
                                    rid != null && typeof (mdict as any)._decodeRecordBlockByRBID === 'function'
                                        ? (mdict as any)._decodeRecordBlockByRBID(rid, keyText, startoffset, nextStart)
                                        : mdict.parse_defination(keyText, startoffset);
                                const def = extractDefinition(data);
                                if (def) out.push({ matchedKey: keyText, definition: def });
                            } catch {
                                // ignore single entry failures
                            }
                        }
                        if (out.length > 0) return out;
                    }
                }

                return res.keyText === term ? [{ matchedKey: res.keyText, definition: res.definition }] : [];
            }
            return [];
        } catch (e) {
            this.logger.warn(`[MdictClient] exactMany 查询失败: ${String(e)}`);
            return [];
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
            const getKey = (x: any): string => (typeof x?.keyText === 'string' ? x.keyText : typeof x?.key === 'string' ? x.key : '');
            const exact = candidates.find((x: any) => getKey(x) === term);
            const picked = exact ?? candidates[0];
            const pickedKey = getKey(picked);
            if (!pickedKey) return null;

            if (typeof picked?.definition === 'string') {
                return { matchedKey: pickedKey, definition: picked.definition };
            }
            const rofset = picked?.rofset ?? picked?.recordStartOffset;
            if (typeof rofset === 'number') {
                const data = mdict.parse_defination(pickedKey, rofset);
                const def = extractDefinition(data);
                if (def) return { matchedKey: pickedKey, definition: def };
            }
            // fallback: try lookup on picked key
            const res = mdict.lookup(pickedKey);
            if (res && typeof res.definition === 'string') {
                return { matchedKey: res.keyText ?? pickedKey, definition: res.definition };
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

function extractDefinition(data: any): string {
    if (!data) return '';
    if (typeof data === 'string') return data;
    if (typeof data?.definition === 'string') return data.definition;
    return '';
}

function normalizeForCompare(s: string): string {
    const raw = String(s ?? '');
    // 去掉常见“看不见/不稳定”的空白字符，并做 Unicode 兼容归一化，提升同名多条命中率
    const noSpace = raw
        .replace(/\s+/g, '')
        .replace(/\u00A0/g, '') // NBSP
        .replace(/\u200B/g, '') // zero-width space
        .replace(/\u200C/g, '') // zero-width non-joiner
        .replace(/\u200D/g, '') // zero-width joiner
        .replace(/\uFEFF/g, ''); // zero-width no-break space (BOM)
    try {
        return noSpace.normalize('NFKC');
    } catch {
        return noSpace;
    }
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

