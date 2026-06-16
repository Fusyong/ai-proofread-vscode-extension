import type { WikipediaLang } from '../schema';

export function searchCacheKey(lang: WikipediaLang, term: string): string {
    return `search:${lang}:${term.trim()}`;
}

export function pageCacheKey(lang: WikipediaLang, title: string): string {
    return `page:${lang}:${title.trim()}`;
}

export function entityCacheKey(qid: string): string {
    return `entity:${qid.trim()}`;
}
