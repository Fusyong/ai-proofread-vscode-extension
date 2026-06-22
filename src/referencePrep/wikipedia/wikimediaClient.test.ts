import { describe, it, expect } from 'vitest';
import { entityCacheKey, pageCacheKey, searchCacheKey } from './cacheKeys';
import { summarizeWikidataClaims } from './wikidataClaims';
import { formatWikipediaReferenceBlock } from './formatReferenceBlock';

describe('wiki cache keys', () => {
    it('builds stable cache keys', () => {
        expect(searchCacheKey('zh', '李白')).toBe('search:zh:李白');
        expect(pageCacheKey('en', 'Li Bai')).toBe('page:en:Li Bai');
        expect(entityCacheKey('Q7073')).toBe('entity:Q7073');
    });
});

describe('summarizeWikidataClaims', () => {
    it('formats whitelisted properties', () => {
        const entities = {
            Q1: {
                claims: {
                    P569: [{ rank: 'normal', mainsnak: { datavalue: { type: 'time', value: { time: '+0701-00-00T00:00:00Z' } } } }],
                    P570: [{ rank: 'preferred', mainsnak: { datavalue: { type: 'time', value: { time: '+0762-00-00T00:00:00Z' } } } }],
                },
            },
        };
        const s = summarizeWikidataClaims(entities, 'Q1');
        expect(s).toContain('出生 0701');
        expect(s).toContain('死亡 0762');
    });
});

describe('formatWikipediaReferenceBlock', () => {
    it('includes tags and metadata', () => {
        const { block, digest } = formatWikipediaReferenceBlock({
            lang: 'zh',
            title: '李白',
            url: 'https://zh.wikipedia.org/wiki/李白',
            extract: '李白是唐代诗人。',
            wikidataId: 'Q7073',
            claimsSummary: '出生 701',
        });
        expect(block).toContain('ai-proofread:wikipediaHit begin');
        expect(block).toContain('【维基百科·zh】李白');
        expect(block).toContain('Wikidata: Q7073');
        expect(block).toContain('结构化：出生 701');
        expect(digest.length).toBeGreaterThan(8);
    });
});
