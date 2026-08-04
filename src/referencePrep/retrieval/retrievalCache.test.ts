import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
    workspace: {
        workspaceFolders: undefined,
        getConfiguration: () => ({ get: (_k: string, d: unknown) => d }),
    },
}));

import {
    filterHitsAgainstExistingReference,
    fingerprintRetrievalKey,
    hitStoreKey,
    packRetrievalCacheForDisk,
    unpackRetrievalCacheFromDisk,
} from './retrievalCache';
import type { CorpusHit } from '../schema';
import type { RetrievalCacheEntry } from './retrievalCache';

function hit(partial: Partial<CorpusHit> & Pick<CorpusHit, 'hitId' | 'digest'>): CorpusHit {
    return {
        source: 'dict',
        queryId: 'q1',
        baseValue: 1,
        aggregatedValue: 1,
        snippet: 's',
        referenceBlock: `<!-- ai-proofread:localDictEntry begin sha1=${partial.digest} -->\nbody-${partial.digest}`,
        status: 'active',
        ...partial,
    };
}

describe('retrievalCache fingerprint & dedupe', () => {
    it('fingerprint is stable under object key and string-array reorder', () => {
        const a = fingerprintRetrievalKey({
            source: 'dict',
            q: { candidates: ['乙', '甲'], intent: 'entity_name' },
        });
        const b = fingerprintRetrievalKey({
            q: { intent: 'entity_name', candidates: ['甲', '乙'] },
            source: 'dict',
        });
        expect(a).toBe(b);
    });

    it('filters hits already present in existingReference by digest tag', () => {
        const existing = '<!-- ai-proofread:localDictEntry begin sha1=abc123 -->\nold';
        const kept = filterHitsAgainstExistingReference(
            [hit({ hitId: 'h1', digest: 'abc123' }), hit({ hitId: 'h2', digest: 'def456' })],
            existing
        );
        expect(kept.map((h) => h.digest)).toEqual(['def456']);
    });

    it('pack shares one hitStore slot for identical digests across entries', () => {
        const shared = hit({
            hitId: 'h-dict-1',
            digest: 'c0e887076ffe',
            matchedKey: '龍睛魚',
            referenceBlock: '龙睛鱼释义很长很长\u0000',
            snippet: '龙睛鱼\u0000',
        });
        const entries: Record<string, RetrievalCacheEntry> = {
            keyA: {
                fetchedAt: '2026-01-01T00:00:00.000Z',
                source: 'dict',
                hits: [shared],
            },
            keyB: {
                fetchedAt: '2026-01-02T00:00:00.000Z',
                source: 'dict',
                hits: [{ ...shared, hitId: 'h-dict-9', roundId: 'r-other' }],
            },
        };
        const packed = packRetrievalCacheForDisk(entries);
        expect(packed.version).toBe(2);
        expect(Object.keys(packed.hitStore)).toEqual(['c0e887076ffe']);
        expect(packed.entries.keyA.digests).toEqual(['c0e887076ffe']);
        expect(packed.entries.keyB.digests).toEqual(['c0e887076ffe']);
        expect(packed.hitStore['c0e887076ffe'].snippet.includes('\0')).toBe(false);
        expect(packed.hitStore['c0e887076ffe'].roundId).toBeUndefined();

        const unpacked = unpackRetrievalCacheFromDisk(packed);
        expect(unpacked.keyA.hits).toHaveLength(1);
        expect(unpacked.keyB.hits).toHaveLength(1);
        expect(unpacked.keyA.hits[0].digest).toBe('c0e887076ffe');
        expect(unpacked.keyB.hits[0].referenceBlock).toContain('龙睛鱼释义');
    });

    it('unpack migrates v1 inline hits', () => {
        const v1 = {
            version: 1,
            entries: {
                k1: {
                    fetchedAt: '2026-01-01T00:00:00.000Z',
                    source: 'bm25' as const,
                    hits: [hit({ hitId: 'h1', digest: 'aaaa' })],
                },
            },
        };
        const unpacked = unpackRetrievalCacheFromDisk(v1);
        expect(unpacked.k1.hits[0].digest).toBe('aaaa');
        const packed = packRetrievalCacheForDisk(unpacked);
        expect(Object.keys(packed.hitStore)).toHaveLength(1);
    });

    it('hitStoreKey falls back when digest missing', () => {
        const a = hitStoreKey(hit({ hitId: 'h1', digest: '', referenceBlock: 'same-body' }));
        const b = hitStoreKey(hit({ hitId: 'h2', digest: '', referenceBlock: 'same-body' }));
        expect(a).toBe(b);
        expect(a.startsWith('h:')).toBe(true);
    });
});
