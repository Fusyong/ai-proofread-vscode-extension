import { describe, expect, it } from 'vitest';
import { buildTermFrequency, normalizeBm25Token, scoreBm25, type Bm25Document } from './bm25Search';

function doc(id: number, tokens: string[]): Bm25Document {
    return { id, tokens, tf: buildTermFrequency(tokens) };
}

describe('bm25Search', () => {
    it('ranks document containing query terms higher', () => {
        const docs = [
            doc(1, ['莫高窟', '敦煌', '石窟']),
            doc(2, ['张大千', '大风堂', '内江', '书画']),
            doc(3, ['榆林窟', '安西']),
        ];
        const hits = scoreBm25(docs, ['张大千', '大风堂'], { topK: 3 });
        expect(hits[0]?.id).toBe(2);
        expect(hits[0]!.score).toBeGreaterThan(0);
    });

    it('returns empty when no overlap', () => {
        const docs = [doc(1, ['莫高窟', '敦煌'])];
        expect(scoreBm25(docs, ['李白'], { topK: 5 })).toEqual([]);
    });

    it('normalizeBm25Token drops punctuation and single han', () => {
        expect(normalizeBm25Token('，')).toBeNull();
        expect(normalizeBm25Token('张')).toBeNull();
        expect(normalizeBm25Token('张大千')).toBe('张大千');
        expect(normalizeBm25Token('OK')).toBe('ok');
    });
});
