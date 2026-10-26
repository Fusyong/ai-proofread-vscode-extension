/**
 * DeepSeek Search 与阿里云 IQS LiteAdvanced。
 * 调用方注入 post，测试不打真实网络。
 */

import axios from 'axios';
import {
    buildDeepSeekQuery,
    clipOriQuestion,
    filterExcludedHits,
    normalizeExcludeHosts,
} from './searchQuery';
import { DEEPSEEK_QUERY_MAX_CHARS, type FactCheckHit } from './schema';

export type SearchProviderId = 'deepseek' | 'iqs';

export interface WebSearchRequest {
    provider: SearchProviderId;
    apiKey: string;
    query: string;
    /** 帮助理解原句，最长 128；不放编辑政策 */
    oriQuestion?: string;
    count: number;
    excludeHosts: string[];
    timeoutMs?: number;
}

export type HttpPost = (url: string, body: unknown, headers: Record<string, string>, timeoutMs: number) => Promise<unknown>;

const DEEPSEEK_SEARCH_URL = 'https://api.deepseek.com/v1/tools/search';
const IQS_SEARCH_URL = 'https://cloud-iqs.aliyuncs.com/search/unified';

export async function defaultHttpPost(
    url: string,
    body: unknown,
    headers: Record<string, string>,
    timeoutMs: number
): Promise<unknown> {
    const res = await axios.post(url, body, {
        headers,
        timeout: timeoutMs,
        validateStatus: () => true,
    });
    if (res.status >= 400) {
        const detail = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '');
        throw new Error(`HTTP ${res.status} ${detail.slice(0, 300)}`);
    }
    return res.data;
}

export function resolveSearchProvider(params: {
    setting: string;
    proofreadPlatform: string;
    deepseekKey: string;
    iqsKey: string;
}): SearchProviderId | undefined {
    const setting = (params.setting || 'auto').trim();
    if (setting === 'deepseek') return params.deepseekKey.trim() ? 'deepseek' : undefined;
    if (setting === 'iqs') return params.iqsKey.trim() ? 'iqs' : undefined;
    if (params.proofreadPlatform === 'deepseek') return params.deepseekKey.trim() ? 'deepseek' : undefined;
    if (params.proofreadPlatform === 'aliyun') return params.iqsKey.trim() ? 'iqs' : undefined;
    return undefined;
}

/** 资料准备 Web 来源：auto 解析失败时，有哪把 Key 就用哪把 */
export function resolveSearchProviderForReferencePrep(params: {
    setting: string;
    proofreadPlatform: string;
    deepseekKey: string;
    iqsKey: string;
}): SearchProviderId | undefined {
    return (
        resolveSearchProvider(params) ??
        (params.deepseekKey.trim() ? 'deepseek' : undefined) ??
        (params.iqsKey.trim() ? 'iqs' : undefined)
    );
}

export function isAnySearchKeyConfigured(deepseekKey: string, iqsKey: string): boolean {
    return Boolean(deepseekKey.trim() || iqsKey.trim());
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return value as Record<string, unknown>;
}

function str(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function authorityOf(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
    return value;
}

export function parseDeepSeekSearchResponse(data: unknown): FactCheckHit[] {
    const root = asRecord(data);
    const results = root?.results;
    if (!Array.isArray(results)) return [];
    const hits: FactCheckHit[] = [];
    for (const item of results) {
        const o = asRecord(item);
        if (!o) continue;
        const url = str(o.url);
        if (!url) continue;
        const summary = str(o.summary) || str(o.snippet);
        const authority = authorityOf(o.authority);
        hits.push({
            title: str(o.title) || url,
            url,
            summary,
            ...(authority !== undefined ? { authority } : {}),
        });
    }
    return hits;
}

export function parseIqsSearchResponse(data: unknown): FactCheckHit[] {
    const root = asRecord(data);
    const items = root?.pageItems ?? root?.data;
    const list = Array.isArray(items) ? items : Array.isArray(asRecord(items)?.pageItems) ? (asRecord(items)?.pageItems as unknown[]) : [];
    const hits: FactCheckHit[] = [];
    for (const item of list) {
        const o = asRecord(item);
        if (!o) continue;
        const url = str(o.link) || str(o.url);
        if (!url) continue;
        const summary = str(o.summary) || str(o.snippet) || str(o.mainText);
        hits.push({
            title: str(o.title) || url,
            url,
            summary: summary.slice(0, 800),
        });
    }
    return hits;
}

export async function searchWeb(req: WebSearchRequest, post: HttpPost = defaultHttpPost): Promise<FactCheckHit[]> {
    const timeoutMs = req.timeoutMs ?? 30000;
    const excludeHosts = normalizeExcludeHosts(req.excludeHosts);
    const count = Math.min(50, Math.max(1, Math.round(req.count)));
    let data: unknown;
    if (req.provider === 'deepseek') {
        const built = buildDeepSeekQuery(req.query, excludeHosts);
        if (!built.query) return [];
        if (built.truncated) {
            console.warn(
                `[factCheck] DeepSeek 查询超过 ${DEEPSEEK_QUERY_MAX_CHARS} 字，已截断，且不再追加 -site`
            );
        }
        const body: Record<string, unknown> = {
            query: built.query,
            count,
            need_content: false,
        };
        const ori = clipOriQuestion(req.oriQuestion ?? '');
        if (ori) body.ori_question = ori;
        data = await post(
            DEEPSEEK_SEARCH_URL,
            body,
            {
                Authorization: `Bearer ${req.apiKey}`,
                'Content-Type': 'application/json',
            },
            timeoutMs
        );
        return filterExcludedHits(parseDeepSeekSearchResponse(data), excludeHosts);
    }
    const query = req.query.replace(/\s+/g, ' ').trim();
    if (!query) return [];
    const advanced: Record<string, string> = { numResults: String(count) };
    if (excludeHosts.length > 0) advanced.excludeSites = excludeHosts.join(',');
    data = await post(
        IQS_SEARCH_URL,
        {
            query,
            engineType: 'LiteAdvanced',
            contents: {
                mainText: false,
                markdownText: false,
                summary: false,
                rerankScore: true,
            },
            advancedParams: advanced,
        },
        {
            Authorization: `Bearer ${req.apiKey}`,
            'Content-Type': 'application/json',
        },
        timeoutMs
    );
    return filterExcludedHits(parseIqsSearchResponse(data), excludeHosts);
}
