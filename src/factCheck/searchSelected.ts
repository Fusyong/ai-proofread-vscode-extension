/**
 * 只检索勾选且尚未检索的断言，并把【网页】摘录追加到切分 JSON 的 reference。
 */

import * as fs from 'fs';
import { appendHitsToReference } from './formatWebReference';
import type { FactCheckClaim, FactCheckClaimsFile, FactCheckHit } from './schema';
import { SEARCH_CONFIRM_THRESHOLD } from './schema';

export interface ParagraphRecord {
    target?: string;
    reference?: string;
    context?: string;
    [key: string]: unknown;
}

export function claimsPendingSearch(claims: FactCheckClaim[]): FactCheckClaim[] {
    return claims.filter((c) => c.selected && c.status === 'pending');
}

export function needsSearchConfirm(count: number): boolean {
    return count > SEARCH_CONFIRM_THRESHOLD;
}

export function applyHitsToParagraphs(
    paragraphs: ParagraphRecord[],
    claims: FactCheckClaim[]
): { paragraphs: ParagraphRecord[]; appendedBlocks: number; updatedClaims: FactCheckClaim[] } {
    const next = paragraphs.map((p) => ({ ...p }));
    let appendedBlocks = 0;
    const updatedClaims = claims.map((c) => ({ ...c, hits: c.hits ? [...c.hits] : undefined }));
    for (const claim of updatedClaims) {
        if (!claim.selected || claim.status !== 'pending' || !claim.hits) continue;
        const hits = claim.hits;
        const para = next[claim.segmentIndex];
        if (!para || typeof para !== 'object') {
            claim.status = 'searched';
            continue;
        }
        const current = typeof para.reference === 'string' ? para.reference : '';
        const applied = appendHitsToReference(current, claim.span, hits);
        para.reference = applied.reference;
        appendedBlocks += applied.added;
        claim.status = 'searched';
        claim.selected = false;
    }
    return { paragraphs: next, appendedBlocks, updatedClaims };
}

export function writeParagraphs(sourceJsonPath: string, paragraphs: ParagraphRecord[]): void {
    fs.writeFileSync(sourceJsonPath, JSON.stringify(paragraphs, null, 2), 'utf8');
}

export function readParagraphs(sourceJsonPath: string): ParagraphRecord[] {
    const parsed = JSON.parse(fs.readFileSync(sourceJsonPath, 'utf8'));
    if (!Array.isArray(parsed)) {
        throw new Error('切分 JSON 不是数组');
    }
    return parsed as ParagraphRecord[];
}

export function attachHits(file: FactCheckClaimsFile, hitsById: Map<string, FactCheckHit[]>): FactCheckClaimsFile {
    return {
        ...file,
        claims: file.claims.map((c) => {
            const hits = hitsById.get(c.id);
            if (!hits) return c;
            return { ...c, hits };
        }),
    };
}
