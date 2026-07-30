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
} from './retrievalCache';
import type { CorpusHit } from '../schema';

function hit(partial: Partial<CorpusHit> & Pick<CorpusHit, 'hitId' | 'digest'>): CorpusHit {
    return {
        source: 'dict',
        queryId: 'q1',
        baseValue: 1,
        aggregatedValue: 1,
        snippet: 's',
        referenceBlock: `<!-- ai-proofread:localDictEntry begin sha1=${partial.digest} -->\nbody`,
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
});
