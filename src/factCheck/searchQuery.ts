/**
 * 搜索请求只带查询词和站点排除，不带自然语言信源偏好。
 */

import { DEEPSEEK_QUERY_MAX_CHARS } from './schema';

export function normalizeExcludeHosts(hosts: string[]): string[] {
    const out: string[] = [];
    for (const raw of hosts) {
        const h = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
        if (h && !out.includes(h)) out.push(h);
    }
    return out;
}

export function hostOfUrl(url: string): string {
    try {
        return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
        return '';
    }
}

export function isExcludedHost(url: string, excludeHosts: string[]): boolean {
    const host = hostOfUrl(url);
    if (!host) return false;
    const list = normalizeExcludeHosts(excludeHosts);
    return list.some((ex) => host === ex || host.endsWith('.' + ex));
}

export function filterExcludedHits<T extends { url: string }>(hits: T[], excludeHosts: string[]): T[] {
    return hits.filter((h) => !isExcludedHost(h.url, excludeHosts));
}

/**
 * DeepSeek query 最长 128 字。超长则截断且不再追加运算符。
 * 未超长时先加 lang:zh（中文），再逐个追加 -site:，放不下的运算符丢掉（返回后仍按主机名过滤）。
 */
export function buildDeepSeekQuery(
    rawQuery: string,
    excludeHosts: string[]
): { query: string; truncated: boolean } {
    let q = rawQuery.replace(/\s+/g, ' ').trim();
    if (!q) return { query: '', truncated: false };
    if (q.length > DEEPSEEK_QUERY_MAX_CHARS) {
        return { query: q.slice(0, DEEPSEEK_QUERY_MAX_CHARS).trim(), truncated: true };
    }
    const extras: string[] = [];
    if (/[\u4e00-\u9fff]/.test(q)) extras.push('lang:zh');
    for (const host of normalizeExcludeHosts(excludeHosts)) {
        extras.push(`-site:${host}`);
    }
    for (const extra of extras) {
        const next = `${q} ${extra}`;
        if (next.length <= DEEPSEEK_QUERY_MAX_CHARS) q = next;
    }
    return { query: q, truncated: false };
}

export function clipOriQuestion(text: string): string | undefined {
    const t = text.replace(/\s+/g, ' ').trim();
    if (!t) return undefined;
    return t.length <= DEEPSEEK_QUERY_MAX_CHARS ? t : t.slice(0, DEEPSEEK_QUERY_MAX_CHARS);
}
