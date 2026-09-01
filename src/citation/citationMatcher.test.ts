import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => ({
            get: (_key: string, defaultValue: unknown) => defaultValue
        })
    }
}));

import { jaccardSimilarity, normalizeForSimilarity, type NormalizeForSimilarityOptions } from '../similarity';
import type { RefSentenceRow } from './referenceStore';
import {
    alignWithNeighborMerge,
    matchBlockBySlidingWindow,
    tryBlockWindowOnFile,
    tryNeighborMergeOnFile,
    type CitationMatchCoreOptions
} from './citationMatcher';

const normalizeOpts: NormalizeForSimilarityOptions = {
    removeInnerWhitespace: true,
    removePunctuation: false,
    removeDigits: true,
    removeLatin: true,
    removeFootnoteMarkers: true
};

const simOpts = { n: 1, granularity: 'char' as const };

function makeRef(id: number, content: string, file = '旧家的火葬.md'): RefSentenceRow {
    const normalized = normalizeForSimilarity(content, normalizeOpts);
    return {
        id,
        file_path: file,
        paragraph_idx: 0,
        sentence_idx: id,
        content,
        normalized,
        len_norm: normalized.length
    };
}

/** 书稿：句号拆开 + 除屋子 / 妻在后 */
const CIT_TEXTS = [
    '半个月前，接到妻从上海寄来的信，说六月一日游击队打到杭州近郊，把我们的旧家放火烧了。',
    '因为那屋子被敌伪占领了之后，开了一所很大的茧厂，所以除屋子全烧之外，还烧毁了敌人已经收买了的几十万元的茧子。',
    '妻在后附加着说：“我们觉得很痛快，这最少对于你们沈家的那些不肖子弟，给了一个不小的教训。”',
    '所谓不肖子弟，是指我的侄辈，他们一度逃出了之后又回到故居，将祖传的屋子租给敌伪，过着准汉奸的日子。'
];

/** 文献：逗号连贯 + 除出 / 妻在后面 */
const REF_TEXTS = [
    '半个月前，接到妻从上海寄来的信，说六月一日游击队打到杭州近郊，把我们的旧家放火烧了，因为那屋子被敌伪占领了之后，开了一所很大的茧厂，所以除出屋子全烧之外，还烧毁了敌人已经收买了的几十万元的茧子。',
    '妻在后面附加着说：“我们觉得很痛快，这最少对于你们沈家的那些不肖子弟，给了一个不小的教训。”',
    '所谓不肖子弟，是指我的侄辈，他们一度逃出了之后又回到故居，将祖传的屋子租给敌伪，过着准汉奸的日子。'
];

function coreOpts(over: Partial<CitationMatchCoreOptions> = {}): CitationMatchCoreOptions {
    return {
        lenDeltaRatio: 0.25,
        similarityThreshold: 0.4,
        maxMerge: 3,
        enableBlockWindowFallback: true,
        normalizeOpts,
        simOpts,
        ...over
    };
}

describe('alignWithNeighborMerge (A)', () => {
    it('maps two citation sentences onto one reference sentence', () => {
        const citNorms = CIT_TEXTS.map((t) => normalizeForSimilarity(t, normalizeOpts));
        const refNorms = REF_TEXTS.map((t) => normalizeForSimilarity(t, normalizeOpts));
        const aligned = alignWithNeighborMerge(citNorms, refNorms, 1, 3, simOpts);
        expect(aligned).not.toBeNull();
        expect(aligned!.firstRefIdx).toBe(0);
        expect(aligned!.lastRefIdx).toBe(2);
        expect(aligned!.avgScore).toBeGreaterThanOrEqual(0.4);
    });

    it('tryNeighborMergeOnFile accepts the cremation paragraph case', () => {
        const refs = REF_TEXTS.map((t, i) => makeRef(i + 1, t));
        const citNorms = CIT_TEXTS.map((t) => normalizeForSimilarity(t, normalizeOpts));
        const hit = tryNeighborMergeOnFile(CIT_TEXTS, citNorms, refs, 1, coreOpts());
        expect(hit).not.toBeNull();
        expect(hit!.strategy).toBe('neighbor-merge');
        expect(hit!.refFragment).toHaveLength(3);
        expect(hit!.score).toBeGreaterThanOrEqual(0.4);
    });
});

describe('matchBlockBySlidingWindow (B)', () => {
    it('finds the block when sentence boundaries differ', () => {
        const refs = REF_TEXTS.map((t, i) => makeRef(i + 1, t));
        const noPunct = { ...normalizeOpts, removePunctuation: true };
        const citNorm = normalizeForSimilarity(CIT_TEXTS.join(''), noPunct);
        const refNorms = refs.map((r) => normalizeForSimilarity(r.content, noPunct));
        const hit = matchBlockBySlidingWindow(citNorm, refs, refNorms, 0.25, 0.4, simOpts);
        expect(hit).not.toBeNull();
        expect(hit!.firstRefIdx).toBe(0);
        expect(hit!.lastRefIdx).toBe(2);
        expect(hit!.score).toBeGreaterThanOrEqual(0.7);
    });

    it('tryBlockWindowOnFile works as fallback API', () => {
        const refs = REF_TEXTS.map((t, i) => makeRef(i + 1, t));
        const hit = tryBlockWindowOnFile(CIT_TEXTS, refs, coreOpts());
        expect(hit).not.toBeNull();
        expect(hit!.strategy).toBe('block-window');
        expect(hit!.refFragment.map((r) => r.content)).toEqual(REF_TEXTS);
    });
});

describe('strict 1:1 would fail on this case', () => {
    it('merged half-sentences score much higher than a single half-sentence', () => {
        const a = normalizeForSimilarity(CIT_TEXTS[0], normalizeOpts);
        const b = normalizeForSimilarity(REF_TEXTS[0], normalizeOpts);
        const score = jaccardSimilarity(a, b, simOpts);
        const merged = normalizeForSimilarity(CIT_TEXTS[0] + CIT_TEXTS[1], normalizeOpts);
        const mergedScore = jaccardSimilarity(merged, b, simOpts);
        expect(mergedScore).toBeGreaterThan(score);
        expect(mergedScore).toBeGreaterThanOrEqual(0.85);
    });
});
