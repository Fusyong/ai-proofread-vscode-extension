import axios, { type AxiosResponse } from 'axios';
import { getWikipediaConfig } from '../config';
import type { WikipediaLang } from '../schema';
import { WikiRateLimiter } from './rateLimiter';
import { summarizeWikidataClaims } from './wikidataClaims';
import { entityCacheKey, pageCacheKey, searchCacheKey } from './cacheKeys';
import {
    getWikiCacheEntry,
    recordCacheHit,
    recordCacheMiss,
    setWikiCacheEntry,
    type WikiEntityCacheEntry,
    type WikiPageCacheEntry,
    type WikiSearchCacheEntry,
} from './wikiCache';

const EXTENSION_VERSION = '1.11.2';

export interface WikipediaPageResult {
    title: string;
    extract: string;
    url: string;
    wikidataId?: string;
    disambiguation?: boolean;
    lang: WikipediaLang;
}

export interface WikimediaClientOptions {
    userAgentContactUrl?: string;
    requestsPerMinute?: number;
    minIntervalMs?: number;
    cacheEnabled?: boolean;
    cacheTtlHoursPage?: number;
    cacheTtlHoursSearch?: number;
    cacheTtlHoursEntity?: number;
}

function buildUserAgent(contactUrl: string): string {
    return `AI-Proofread-Extension/${EXTENSION_VERSION} (${contactUrl}) referencePrep-wikipedia-bot`;
}

function wikiApiBase(lang: WikipediaLang): string {
    return `https://${lang}.wikipedia.org/w/api.php`;
}

function parseRetryAfter(headers: AxiosResponse['headers']): number | undefined {
    const raw = headers['retry-after'];
    if (raw == null) return undefined;
    const n = parseInt(String(raw), 10);
    return Number.isFinite(n) ? n : undefined;
}

function isDisambiguationTitle(title: string): boolean {
    return /消歧义|disambiguation/i.test(title);
}

function pickBestSearchTitle(titles: string[]): string | null {
    for (const t of titles) {
        if (!isDisambiguationTitle(t)) return t;
    }
    return titles[0] ?? null;
}

export class WikimediaClient {
    private limiter: WikiRateLimiter;
    private config: ReturnType<typeof getWikipediaConfig>;
    private userAgent: string;

    constructor(options?: WikimediaClientOptions) {
        this.config = getWikipediaConfig();
        this.userAgent = buildUserAgent(options?.userAgentContactUrl ?? this.config.userAgentContactUrl);
        this.limiter = WikiRateLimiter.getInstance({
            requestsPerMinute: options?.requestsPerMinute ?? this.config.requestsPerMinute,
            minIntervalMs: options?.minIntervalMs ?? this.config.minIntervalMs,
        });
    }

    resetSessionBudget(max: number): void {
        this.limiter.resetSessionBudget(max);
    }

    getRequestsUsed(): number {
        return this.limiter.getBudget().used;
    }

    isPaused(): boolean {
        return this.limiter.isPaused();
    }

    isBudgetExhausted(): boolean {
        return this.limiter.isBudgetExhausted();
    }

    async searchTitle(lang: WikipediaLang, term: string): Promise<string | null> {
        const cacheKey = searchCacheKey(lang, term);
        const cached = getWikiCacheEntry<WikiSearchCacheEntry>(
            cacheKey,
            this.config.cacheTtlHoursSearch,
            this.config.cacheEnabled
        );
        if (cached) {
            recordCacheHit();
            return pickBestSearchTitle(cached.titles);
        }
        recordCacheMiss();

        const result = await this.limiter.schedule(async () => {
            const started = Date.now();
            const res = await axios.get(wikiApiBase(lang), {
                params: {
                    action: 'query',
                    list: 'search',
                    srsearch: term,
                    srlimit: 3,
                    format: 'json',
                    maxlag: 1,
                    redirects: 1,
                },
                headers: {
                    'User-Agent': this.userAgent,
                    'Accept-Encoding': 'gzip, deflate',
                },
                validateStatus: () => true,
                timeout: 30000,
            });
            const durationMs = Date.now() - started;
            const titles: string[] = [];
            const pageIds: number[] = [];
            const search = (res.data as { query?: { search?: Array<{ title?: string; pageid?: number }> } })?.query
                ?.search;
            if (Array.isArray(search)) {
                for (const row of search) {
                    if (row.title) titles.push(row.title);
                    if (row.pageid) pageIds.push(row.pageid);
                }
            }
            if (titles.length > 0) {
                setWikiCacheEntry(cacheKey, {
                    fetchedAt: new Date().toISOString(),
                    titles,
                    pageIds,
                });
            }
            return {
                result: pickBestSearchTitle(titles),
                status: res.status,
                retryAfterSec: parseRetryAfter(res.headers),
                durationMs,
            };
        });

        return result ?? null;
    }

    async fetchPages(lang: WikipediaLang, titles: string[]): Promise<WikipediaPageResult[]> {
        const unique = [...new Set(titles.map((t) => t.trim()).filter(Boolean))].slice(0, 10);
        if (unique.length === 0) return [];

        const results: WikipediaPageResult[] = [];
        const toFetch: string[] = [];

        for (const title of unique) {
            const cacheKey = pageCacheKey(lang, title);
            const cached = getWikiCacheEntry<WikiPageCacheEntry>(
                cacheKey,
                this.config.cacheTtlHoursPage,
                this.config.cacheEnabled
            );
            if (cached) {
                recordCacheHit();
                results.push({
                    title: cached.title,
                    extract: cached.extract,
                    url: cached.url,
                    wikidataId: cached.wikidataId,
                    disambiguation: cached.disambiguation,
                    lang,
                });
            } else {
                recordCacheMiss();
                toFetch.push(title);
            }
        }

        if (toFetch.length === 0) return results;
        if (this.limiter.isBudgetExhausted() || this.limiter.isPaused()) {
            return results;
        }

        const batchSize = 10;
        for (let i = 0; i < toFetch.length; i += batchSize) {
            const batch = toFetch.slice(i, i + batchSize);
            const fetched = await this.limiter.schedule(async () => {
                const started = Date.now();
                const res = await axios.get(wikiApiBase(lang), {
                    params: {
                        action: 'query',
                        titles: batch.join('|'),
                        prop: 'extracts|info|pageprops',
                        exintro: 1,
                        explaintext: 1,
                        inprop: 'url',
                        ppprop: 'wikibase_item|disambiguation',
                        format: 'json',
                        maxlag: 1,
                        redirects: 1,
                    },
                    headers: {
                        'User-Agent': this.userAgent,
                        'Accept-Encoding': 'gzip, deflate',
                    },
                    validateStatus: () => true,
                    timeout: 30000,
                });
                const durationMs = Date.now() - started;
                const pages = (res.data as { query?: { pages?: Record<string, unknown> } })?.query?.pages ?? {};
                const out: WikipediaPageResult[] = [];
                for (const page of Object.values(pages)) {
                    const p = page as {
                        title?: string;
                        extract?: string;
                        fullurl?: string;
                        missing?: boolean;
                        pageprops?: { wikibase_item?: string; disambiguation?: string };
                    };
                    if (p.missing || !p.title) continue;
                    const disambiguation =
                        Boolean(p.pageprops?.disambiguation) || isDisambiguationTitle(p.title);
                    const url =
                        p.fullurl ??
                        `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, '_'))}`;
                    const row: WikipediaPageResult = {
                        title: p.title,
                        extract: (p.extract ?? '').trim(),
                        url,
                        wikidataId: p.pageprops?.wikibase_item,
                        disambiguation,
                        lang,
                    };
                    out.push(row);
                    setWikiCacheEntry(pageCacheKey(lang, p.title), {
                        fetchedAt: new Date().toISOString(),
                        title: p.title,
                        extract: row.extract,
                        url: row.url,
                        wikidataId: row.wikidataId,
                        disambiguation,
                    });
                }
                return {
                    result: out,
                    status: res.status,
                    retryAfterSec: parseRetryAfter(res.headers),
                    durationMs,
                };
            });
            if (fetched) results.push(...fetched);
        }

        return results;
    }

    async fetchWikidataSummary(qid: string): Promise<string> {
        const cacheKey = entityCacheKey(qid);
        const cached = getWikiCacheEntry<WikiEntityCacheEntry>(
            cacheKey,
            this.config.cacheTtlHoursEntity,
            this.config.cacheEnabled
        );
        if (cached) {
            recordCacheHit();
            return cached.claimsSummary;
        }
        recordCacheMiss();
        if (this.limiter.isBudgetExhausted() || this.limiter.isPaused()) {
            return '';
        }

        const summary = await this.limiter.schedule(async () => {
            const started = Date.now();
            const res = await axios.get('https://www.wikidata.org/w/api.php', {
                params: {
                    action: 'wbgetentities',
                    ids: qid,
                    props: 'claims|labels',
                    languages: 'zh|en',
                    format: 'json',
                    maxlag: 1,
                },
                headers: {
                    'User-Agent': this.userAgent,
                    'Accept-Encoding': 'gzip, deflate',
                },
                validateStatus: () => true,
                timeout: 30000,
            });
            const durationMs = Date.now() - started;
            const entities = (res.data as { entities?: Record<string, unknown> })?.entities ?? {};
            const claimsSummary = summarizeWikidataClaims(entities, qid);
            if (claimsSummary) {
                setWikiCacheEntry(cacheKey, {
                    fetchedAt: new Date().toISOString(),
                    claimsSummary,
                });
            }
            return {
                result: claimsSummary,
                status: res.status,
                retryAfterSec: parseRetryAfter(res.headers),
                durationMs,
            };
        });

        return summary ?? '';
    }
}

let sharedClient: WikimediaClient | null = null;

export function getWikimediaClient(): WikimediaClient {
    if (!sharedClient) {
        sharedClient = new WikimediaClient();
    }
    return sharedClient;
}

export function resetWikimediaClientForTests(): void {
    sharedClient = null;
    WikiRateLimiter.resetForTests();
}
