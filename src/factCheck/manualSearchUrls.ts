/**
 * 人工核查用的外部检索 URL。不调用付费搜索 API。
 */

const MAX_QUERY_CHARS = 2000;

export function normalizeManualQuery(raw: string): string {
    return raw.replace(/\s+/g, ' ').trim();
}

export function clipManualQuery(raw: string): { query: string; truncated: boolean } {
    const query = normalizeManualQuery(raw);
    if (query.length <= MAX_QUERY_CHARS) return { query, truncated: false };
    return { query: query.slice(0, MAX_QUERY_CHARS), truncated: true };
}

export function buildShidiangujiSearchUrl(raw: string): string {
    const { query } = clipManualQuery(raw);
    return 'https://www.shidianguji.com/zh/search/' + encodeURIComponent(query);
}

export function buildAncientbooksSearchUrl(raw: string): string {
    const { query } = clipManualQuery(raw);
    return 'https://jingdian.ancientbooks.cn/6/search?txt=' + encodeURIComponent(query) + '&useSynonyms=';
}

export function buildZhWikiSearchUrl(raw: string): string {
    const { query } = clipManualQuery(raw);
    return 'https://zh.wikipedia.org/w/index.php?search=' + encodeURIComponent(query);
}
