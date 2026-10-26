import { describe, expect, it } from 'vitest';
import {
    buildClaimsForSegment,
    capClaimsForSegment,
    shouldSkipSegment,
} from './claimsFile';
import { parseFactCheckExtractOutput, sanitizeSearchQuery } from './extractPrompt';
import { appendHitsToReference, formatWebReferenceBlock, referenceAlreadyContains } from './formatWebReference';
import { buildAncientbooksSearchUrl, buildShidiangujiSearchUrl, buildZhWikiSearchUrl } from './manualSearchUrls';
import {
    claimsPathForSourceJson,
    defaultClaimSelected,
    scopeForCategory,
    type FactCheckClaim,
} from './schema';
import { applyHitsToParagraphs, claimsPendingSearch } from './searchSelected';
import { buildDeepSeekQuery, filterExcludedHits, isExcludedHost } from './searchQuery';
import { parseDeepSeekSearchResponse, parseIqsSearchResponse, resolveSearchProvider } from './webSearch';

describe('fact check schema', () => {
    it('maps categories to scope', () => {
        expect(scopeForCategory('measure')).toBe('key');
        expect(scopeForCategory('date')).toBe('key');
        expect(scopeForCategory('named_attribute')).toBe('key');
        expect(scopeForCategory('historical_judgment')).toBe('general');
        expect(scopeForCategory('institution')).toBe('general');
        expect(scopeForCategory('other')).toBe('general');
    });

    it('selects key facts at or above the urgency threshold', () => {
        expect(defaultClaimSelected({ scope: 'key', urgency: 0.6, status: 'pending' }, 0.6)).toBe(true);
        expect(defaultClaimSelected({ scope: 'key', urgency: 0.59, status: 'pending' }, 0.6)).toBe(false);
        expect(defaultClaimSelected({ scope: 'general', urgency: 0.9, status: 'pending' }, 0.6)).toBe(false);
        expect(defaultClaimSelected({ scope: 'key', urgency: 0.9, status: 'has_reference' }, 0.6)).toBe(false);
    });

    it('names the claims file beside the source json', () => {
        expect(claimsPathForSourceJson('d:/book/ch1.json').replace(/\\/g, '/')).toMatch(/ch1\.factcheck-claims\.json$/);
    });
});

describe('fact check extract', () => {
    it('parses claims and drops the suspicious number from the query', () => {
        const raw = JSON.stringify({
            claims: [
                {
                    span: '泉州大桥宽六十米',
                    category: 'measure',
                    urgency: 0.8,
                    urgencyReason: '宽度数字一旦有误会伤书',
                    query: '泉州大桥 宽六十米',
                },
                {
                    category: 'historical_judgment',
                    span: '该桥为当时福建最长',
                    urgency: 0.5,
                    urgencyReason: '宽泛',
                    query: '泉州大桥 是否最长',
                },
            ],
        });
        const keyOnly = parseFactCheckExtractOutput(raw, 'key');
        expect(keyOnly).toHaveLength(1);
        expect(keyOnly[0].query).toBe('泉州大桥 宽');
        expect(sanitizeSearchQuery('宽六十米', '泉州大桥 宽六十米')).not.toContain('六十');

        const both = parseFactCheckExtractOutput(raw, 'general');
        expect(both.map((c) => c.category)).toEqual(['measure', 'historical_judgment']);
    });

    it('caps key facts at 6 and general questions at 4', () => {
        const key = Array.from({ length: 8 }, (_, i) => ({
            span: `宽${i}米`,
            category: 'measure' as const,
            urgency: 0.7,
            urgencyReason: 'n',
            query: `桥宽 ${i}`,
        }));
        const general = Array.from({ length: 5 }, (_, i) => ({
            span: `说法${i}`,
            category: 'other' as const,
            urgency: 0.4,
            urgencyReason: 'n',
            query: `说法 ${i}`,
        }));
        expect(capClaimsForSegment([...key, ...general], 'key')).toHaveLength(6);
        expect(capClaimsForSegment([...key, ...general], 'general')).toHaveLength(10);
    });

    it('skips empty and blockquote segments, and does not select claims that already have reference', () => {
        expect(shouldSkipSegment('  ')).toBe('empty');
        expect(shouldSkipSegment('> 引文')).toBe('citation');
        expect(shouldSkipSegment('泉州大桥宽六十米')).toBeUndefined();
        const claims = buildClaimsForSegment({
            segmentIndex: 2,
            rawModelOutput: JSON.stringify({
                claims: [
                    {
                        span: '宽六十米',
                        category: 'measure',
                        urgency: 0.9,
                        urgencyReason: '数字',
                        query: '桥宽',
                    },
                ],
            }),
            scope: 'key',
            urgencyMin: 0.6,
            reference: '已有词典摘录',
        });
        expect(claims[0].status).toBe('has_reference');
        expect(claims[0].selected).toBe(false);
        expect(claims[0].id).toBe('2:0');
    });
});

describe('web reference and search query', () => {
    it('formats a web block and skips duplicates', () => {
        const block = formatWebReferenceBlock({
            title: '泉州大桥',
            url: 'https://example.test/bridge',
            summary: '桥宽约 27 米',
            span: '泉州大桥宽六十米',
            authority: 3,
        });
        expect(block).toContain('【网页】泉州大桥');
        expect(block).toContain('权威度：3');
        expect(block).toContain('对应断言：泉州大桥宽六十米');
        const once = appendHitsToReference('', '泉州大桥宽六十米', [
            { title: '泉州大桥', url: 'https://example.test/bridge', summary: '桥宽约 27 米', authority: 1 },
            { title: '泉州大桥', url: 'https://example.test/bridge', summary: '又一条', authority: 3 },
        ]);
        expect(once.added).toBe(1);
        expect(referenceAlreadyContains(once.reference, 'https://example.test/bridge', '泉州大桥宽六十米')).toBe(true);
        const again = appendHitsToReference(once.reference, '泉州大桥宽六十米', [
            { title: '泉州大桥', url: 'https://example.test/bridge', summary: '重复', authority: 3 },
        ]);
        expect(again.added).toBe(0);
    });

    it('appends -site only when the DeepSeek query still fits in 128 characters', () => {
        const short = buildDeepSeekQuery('泉州大桥 桥宽', ['baike.baidu.com']);
        expect(short.truncated).toBe(false);
        expect(short.query).toContain('lang:zh');
        expect(short.query).toContain('-site:baike.baidu.com');
        expect(short.query).not.toContain('优先');

        const tight = buildDeepSeekQuery('中'.repeat(120), ['baike.baidu.com']);
        expect(tight.truncated).toBe(false);
        expect(tight.query.startsWith('中'.repeat(120))).toBe(true);
        expect(tight.query).toContain('lang:zh');
        expect(tight.query).not.toContain('-site:');

        const over = buildDeepSeekQuery('桥'.repeat(130), ['baike.baidu.com']);
        expect(over.truncated).toBe(true);
        expect(over.query).toHaveLength(128);
        expect(over.query).not.toContain('-site:');
    });

    it('drops excluded hosts after the response comes back', () => {
        expect(isExcludedHost('https://baike.baidu.com/item/x', ['baike.baidu.com'])).toBe(true);
        expect(isExcludedHost('https://m.baike.baidu.com/item/x', ['baike.baidu.com'])).toBe(true);
        expect(isExcludedHost('https://zh.wikipedia.org/wiki/x', ['baike.baidu.com'])).toBe(false);
        const kept = filterExcludedHits(
            [
                { url: 'https://baike.baidu.com/item/a' },
                { url: 'https://www.gov.cn/a' },
            ],
            ['baike.baidu.com']
        );
        expect(kept.map((h) => h.url)).toEqual(['https://www.gov.cn/a']);
    });

    it('parses DeepSeek and IQS payloads', () => {
        const ds = parseDeepSeekSearchResponse({
            results: [
                { title: '桥', url: 'https://a.test/b', summary: '二十七米', authority: 3, snippet: '短' },
                { title: '无链接', summary: 'x' },
            ],
        });
        expect(ds).toEqual([{ title: '桥', url: 'https://a.test/b', summary: '二十七米', authority: 3 }]);
        const iqs = parseIqsSearchResponse({
            pageItems: [{ title: '桥', link: 'https://b.test/c', snippet: '摘要' }],
        });
        expect(iqs[0].url).toBe('https://b.test/c');
        expect(iqs[0].summary).toBe('摘要');
    });

    it('follows the proofread platform when choosing a provider', () => {
        expect(
            resolveSearchProvider({
                setting: 'auto',
                proofreadPlatform: 'deepseek',
                deepseekKey: 'sk',
                iqsKey: 'ik',
            })
        ).toBe('deepseek');
        expect(
            resolveSearchProvider({
                setting: 'auto',
                proofreadPlatform: 'aliyun',
                deepseekKey: 'sk',
                iqsKey: '',
            })
        ).toBeUndefined();
        expect(
            resolveSearchProvider({
                setting: 'auto',
                proofreadPlatform: 'google',
                deepseekKey: 'sk',
                iqsKey: 'ik',
            })
        ).toBeUndefined();
        expect(
            resolveSearchProvider({
                setting: 'iqs',
                proofreadPlatform: 'deepseek',
                deepseekKey: 'sk',
                iqsKey: 'ik',
            })
        ).toBe('iqs');
    });
});

describe('merge hits into paragraphs', () => {
    it('writes reference only for selected pending claims that have hits', () => {
        const claim = (over: Partial<FactCheckClaim>): FactCheckClaim => ({
            id: '0:0',
            segmentIndex: 0,
            span: '宽六十米',
            category: 'measure',
            scope: 'key',
            urgency: 0.8,
            urgencyReason: '数字',
            query: '桥宽',
            selected: true,
            status: 'pending',
            ...over,
        });
        const pending = claimsPendingSearch([
            claim({}),
            claim({ id: '0:1', selected: false }),
            claim({ id: '1:0', segmentIndex: 1, status: 'searched' }),
        ]);
        expect(pending.map((c) => c.id)).toEqual(['0:0']);

        const applied = applyHitsToParagraphs(
            [{ target: '泉州大桥宽六十米', reference: '' }, { target: '另一段', reference: '旧' }],
            [
                claim({
                    hits: [{ title: '桥', url: 'https://example.test/q', summary: '二十七米', authority: 2 }],
                }),
                claim({ id: '0:1', selected: false, hits: [{ title: '不写', url: 'https://no.test', summary: 'x' }] }),
                claim({ id: '1:0', segmentIndex: 1, selected: true, status: 'pending' }),
            ]
        );
        expect(applied.appendedBlocks).toBe(1);
        expect(applied.paragraphs[0].reference).toContain('https://example.test/q');
        expect(applied.paragraphs[1].reference).toBe('旧');
        expect(applied.updatedClaims[0].status).toBe('searched');
        expect(applied.updatedClaims[0].selected).toBe(false);
        expect(applied.updatedClaims[2].status).toBe('pending');
    });
});

describe('manual check urls', () => {
    it('builds external urls from the query, not the suspicious sentence', () => {
        const q = '泉州大桥 桥宽';
        expect(buildShidiangujiSearchUrl(q)).toBe('https://www.shidianguji.com/zh/search/' + encodeURIComponent(q));
        expect(buildAncientbooksSearchUrl(q)).toContain(encodeURIComponent(q));
        expect(buildAncientbooksSearchUrl(q)).toContain('jingdian.ancientbooks.cn');
        expect(buildZhWikiSearchUrl(q)).toBe('https://zh.wikipedia.org/w/index.php?search=' + encodeURIComponent(q));
    });
});
