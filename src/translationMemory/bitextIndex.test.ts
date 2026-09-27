import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => ({
            get: (_key: string, defaultValue: unknown) => defaultValue,
        }),
    },
    Uri: { file: (p: string) => ({ fsPath: p }) },
}));

import {
    deriveBitextPairsFromUnit,
    findSimilarBitext,
    formatSimilarBitextXml,
    upsertBitextPairs,
    type BitextIndex,
    type BitextPair,
} from './bitextIndex';
import { buildDirectionHintXml, clipInjectText, readTranslateInjectConfig } from './injectConfig';

describe('bitextIndex', () => {
    it('derives sentence pairs when counts match', () => {
        const pairs = deriveBitextPairsFromUnit(
            'Hello world. Second sentence.',
            '你好世界。第二句。'
        );
        expect(pairs.length).toBeGreaterThanOrEqual(2);
        expect(pairs.every((p) => p.granularity === 'sentence')).toBe(true);
    });

    it('falls back to unit pair when sentence counts differ', () => {
        const pairs = deriveBitextPairsFromUnit(
            'First long enough sentence here. Second long enough sentence here.',
            '只有一整段译文没有第二句'
        );
        expect(pairs).toHaveLength(1);
        expect(pairs[0].granularity).toBe('unit');
    });

    it('finds similar sentences by Jaccard', () => {
        const index: BitextIndex = { version: 1, pairs: [] };
        const seeded: BitextPair[] = [
            {
                id: '1',
                source: 'The quick brown fox jumps over the lazy dog.',
                target: '那只敏捷的棕色狐狸跳过懒狗。',
                granularity: 'sentence',
                createdAt: '2026-01-01',
            },
            {
                id: '2',
                source: 'Unrelated astronomy fact about Mars.',
                target: '与此无关的火星天文事实。',
                granularity: 'sentence',
                createdAt: '2026-01-01',
            },
        ];
        upsertBitextPairs(index, seeded);
        const hits = findSimilarBitext(
            index,
            'A quick brown fox jumps over a lazy dog today.',
            { topK: 2, threshold: 0.2 }
        );
        expect(hits.length).toBeGreaterThanOrEqual(1);
        expect(hits[0].pair.id).toBe('1');
        const xml = formatSimilarBitextXml(hits, 2000);
        expect(xml).toContain('<similar_bitext>');
        expect(xml).toContain('<s>');
        expect(xml).toContain('<t>');
    });

    it('excludes exact source matches', () => {
        const index: BitextIndex = {
            version: 1,
            pairs: [
                {
                    id: 'x',
                    source: 'Exact same sentence here.',
                    target: '完全相同的句子。',
                    granularity: 'sentence',
                    createdAt: '2026-01-01',
                },
            ],
        };
        const hits = findSimilarBitext(index, 'Exact same sentence here.', {
            topK: 3,
            threshold: 0.1,
            excludeExact: true,
        });
        expect(hits).toHaveLength(0);
    });
});

describe('injectConfig', () => {
    it('reads defaults from mock config', () => {
        const store: Record<string, unknown> = {};
        const cfg = readTranslateInjectConfig({
            get<T>(key: string, defaultValue?: T): T | undefined {
                return (store[key] as T | undefined) ?? defaultValue;
            },
        });
        expect(cfg.similarTopK).toBe(3);
        expect(cfg.targetLang).toBe('zh-Hans');
        expect(cfg.temperature).toBeUndefined();
        expect(cfg.warnIfNoStyleSample).toBe(true);
    });

    it('builds direction hint and clips text', () => {
        expect(
            buildDirectionHintXml({
                ...readTranslateInjectConfig({
                    get<T>(_k: string, d?: T): T | undefined {
                        return d;
                    },
                }),
                sourceLang: 'en',
                targetLang: 'zh-Hans',
            })
        ).toContain('source_lang: en');
        expect(clipInjectText('abcdef', 4)).toBe('abc…');
    });
});
