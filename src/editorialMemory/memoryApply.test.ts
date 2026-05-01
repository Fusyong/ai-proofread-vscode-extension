import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => ({
            get: (_k: string, def: unknown) => def,
        }),
    },
}));

import { applyGlobalOpsAndPushCurrentRound } from './applyMemoryPatch';
import { migrateV1MarkdownToV2 } from './memoryPersistV2';
import { createEmptyActiveV2, createEmptyArchiveV2, normalizeFlatBody, normalizeMemoryEntry } from './schemaV2';

describe('applyGlobalOpsAndPushCurrentRound', () => {
    it('evicts lowest weight global when over cap', () => {
        const active = createEmptyActiveV2();
        active.global = [
            normalizeMemoryEntry({ id: 'a', original: 'x', changedTo: 'y', weight: 1, repeated: 1 }),
            normalizeMemoryEntry({ id: 'b', original: 'p', changedTo: 'q', weight: 9, repeated: 1 }),
        ];
        const archive = createEmptyArchiveV2();
        const { active: out, archive: ar } = applyGlobalOpsAndPushCurrentRound({
            active,
            archive,
            globalOps: [],
            currentRoundFlat: undefined,
            globalMax: 1,
            maxProofreadRounds: 3,
        });
        expect(out.global.length).toBe(1);
        expect(out.global[0].id).toBe('b');
        expect(ar.entries.length).toBe(1);
    });

    it('pushes deduplicated flat rounds with FIFO depth d', () => {
        const active = createEmptyActiveV2();
        const archive = createEmptyArchiveV2();
        const r1 = applyGlobalOpsAndPushCurrentRound({
            active,
            archive,
            globalOps: [],
            currentRoundFlat: '本轮 A',
            globalMax: 50,
            maxProofreadRounds: 2,
        });
        const r2 = applyGlobalOpsAndPushCurrentRound({
            active: r1.active,
            archive: r1.archive,
            globalOps: [],
            currentRoundFlat: '本轮 B',
            globalMax: 50,
            maxProofreadRounds: 2,
        });
        const r3 = applyGlobalOpsAndPushCurrentRound({
            active: r2.active,
            archive: r2.archive,
            globalOps: [],
            currentRoundFlat: '本轮 C',
            globalMax: 50,
            maxProofreadRounds: 2,
        });
        expect(r3.active.currentRounds.length).toBe(2);
        expect(r3.active.currentRounds[0].body).toContain('本轮 C');
        expect(r3.active.currentRounds[1].body).toContain('本轮 B');

        const rDup = applyGlobalOpsAndPushCurrentRound({
            active: r3.active,
            archive: r3.archive,
            globalOps: [],
            currentRoundFlat: '本轮 C',
            globalMax: 50,
            maxProofreadRounds: 2,
        });
        expect(rDup.active.currentRounds.length).toBe(2);
        expect(normalizeFlatBody(rDup.active.currentRounds[0].body)).toBe(normalizeFlatBody('本轮 C'));
    });
});

describe('migrateV1MarkdownToV2', () => {
    it('imports global bullets and merges v1 recent into one current round', () => {
        const md = `<!-- ai-proofread:editorial-memory v1 -->

## 全局

- 全局一条

## 按文档结构

### path: 章 > 节
- 节内

## 近期记忆

- 近期一条

## 结构已变更待核对

`;
        const { active, archive } = migrateV1MarkdownToV2(md, { globalMax: 10 });
        expect(active.global.length).toBeGreaterThanOrEqual(1);
        expect(active.currentRounds.length).toBe(1);
        expect(active.currentRounds[0].body).toContain('近期一条');
        expect(archive.entries.some((e) => e.original === '[migrated:v1-structure-path-blocks]')).toBe(true);
    });
});
