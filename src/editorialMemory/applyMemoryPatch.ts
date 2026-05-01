import type { ActiveMemoryV2, ArchiveMemoryV2, CurrentRoundFlat, GlobalMemoryPatchOp, MemoryEntry } from './schemaV2';
import { newRoundId, normalizeFlatBody, normalizeMemoryEntry } from './schemaV2';

function clampWeight(w: number): number {
    return Math.max(0, Math.min(1000, Math.floor(w)));
}

function findGlobalId(active: ActiveMemoryV2, id: string): number {
    return active.global.findIndex((e) => e.id === id);
}

function newMemoryIdForArchive(oldId: string): string {
    return `${oldId}_arc_${Date.now()}`;
}

/** 移出 global：权重升序，同权 createdAt 升序（越早越先挤出） */
function evictGlobalToArchive(active: ActiveMemoryV2, archive: ArchiveMemoryV2, cap: number): void {
    let arr = active.global;
    if (arr.length <= cap) {
        return;
    }
    const excess = arr.length - cap;
    const scored = arr.map((e) => ({
        e,
        t: new Date(e.createdAt).getTime(),
    }));
    scored.sort((a, b) => {
        if (a.e.weight !== b.e.weight) {
            return a.e.weight - b.e.weight;
        }
        return a.t - b.t;
    });
    const victims = scored.slice(0, excess);
    const victimIds = new Set(victims.map((v) => v.e.id));
    for (const v of victims) {
        archive.entries.unshift({ ...v.e, id: newMemoryIdForArchive(v.e.id) });
    }
    arr = arr.filter((e) => !victimIds.has(e.id));
    active.global = arr;
}

export function applyGlobalOpsAndPushCurrentRound(params: {
    active: ActiveMemoryV2;
    archive: ArchiveMemoryV2;
    globalOps: GlobalMemoryPatchOp[] | undefined;
    currentRoundFlat: string | undefined;
    globalMax: number;
    maxProofreadRounds: number;
}): { active: ActiveMemoryV2; archive: ArchiveMemoryV2 } {
    const active: ActiveMemoryV2 = {
        version: 2,
        global: [...params.active.global],
        currentRounds: [...params.active.currentRounds],
    };
    const archive: ArchiveMemoryV2 = {
        version: 2,
        entries: [...params.archive.entries],
    };

    const ops = Array.isArray(params.globalOps) ? params.globalOps : [];

    for (const op of ops) {
        if (!op || typeof op !== 'object') {
            continue;
        }
        switch (op.op) {
            case 'add': {
                if (!op.entry || typeof op.entry.original !== 'string' || typeof op.entry.changedTo !== 'string') {
                    break;
                }
                const e = normalizeMemoryEntry(op.entry as MemoryEntry);
                if (findGlobalId(active, e.id) >= 0) {
                    break;
                }
                active.global.unshift(e);
                break;
            }
            case 'remove': {
                const j = findGlobalId(active, op.id);
                if (j >= 0) {
                    const [rm] = active.global.splice(j, 1);
                    archive.entries.unshift({ ...rm, id: newMemoryIdForArchive(rm.id) });
                }
                break;
            }
            case 'set_weight': {
                const e = active.global.find((x) => x.id === op.id);
                if (e) {
                    e.weight = clampWeight(op.weight);
                }
                break;
            }
            case 'bump_weight': {
                const e = active.global.find((x) => x.id === op.id);
                if (e) {
                    e.weight = clampWeight(e.weight + op.delta);
                }
                break;
            }
            default:
                break;
        }
    }

    const trimmedFlat = typeof params.currentRoundFlat === 'string' ? params.currentRoundFlat.trim() : '';
    if (trimmedFlat.length > 0) {
        const normNew = normalizeFlatBody(trimmedFlat);
        const dup = active.currentRounds.some((r) => normalizeFlatBody(r.body) === normNew);
        if (!dup) {
            const round: CurrentRoundFlat = {
                id: newRoundId(),
                createdAt: new Date().toISOString(),
                body: trimmedFlat,
            };
            active.currentRounds.unshift(round);
            const d = Math.max(1, params.maxProofreadRounds);
            if (active.currentRounds.length > d) {
                active.currentRounds = active.currentRounds.slice(0, d);
            }
        }
    }

    evictGlobalToArchive(active, archive, params.globalMax);

    return { active, archive };
}
