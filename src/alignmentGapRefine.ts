/**
 * 对齐缺口精炼：把相邻 delete/insert（及可疑的长短假 MATCH）拼成两段，
 * 用词流 diff 判断能否收成一条 match。
 */

import * as Diff from 'diff';
import type { AlignmentItem } from './sentenceAligner';
import { alignmentSimilarity, jaccardSimilarity, normalizeForSimilarity } from './similarity';

export interface GapRefineOptions {
    /** 未改字符占比达到此值才收成 match，默认 0.55 */
    gapEqualRatio?: number;
    /** 假 MATCH：两侧长度比 ≥ 此值且 Jaccard 明显偏低时降级，默认 1.6 */
    falseMatchLengthRatio?: number;
    removeInnerWhitespace?: boolean;
}

function getSegmenter(): Intl.Segmenter | null {
    try {
        if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
            return new Intl.Segmenter('zh', { granularity: 'word' });
        }
    } catch {
        /* ignore */
    }
    return null;
}

/** 词流未改字符占比 */
export function wordDiffEqualRatio(textA: string, textB: string): number {
    if (!textA && !textB) {
        return 1;
    }
    if (!textA || !textB) {
        return 0;
    }
    const segmenter = getSegmenter();
    const changes = segmenter
        ? Diff.diffWordsWithSpace(textA, textB, segmenter as never)
        : Diff.diffWordsWithSpace(textA, textB);
    let equal = 0;
    let total = 0;
    for (const part of changes) {
        const n = part.value.length;
        total += n;
        if (!part.added && !part.removed) {
            equal += n;
        }
    }
    return total === 0 ? 1 : equal / total;
}

function collectIndices(item: AlignmentItem, side: 'a' | 'b'): number[] {
    if (side === 'a') {
        if (item.a_indices && item.a_indices.length > 0) {
            return [...item.a_indices];
        }
        if (item.a_index !== undefined && item.a_index !== null) {
            return [item.a_index];
        }
    } else {
        if (item.b_indices && item.b_indices.length > 0) {
            return [...item.b_indices];
        }
        if (item.b_index !== undefined && item.b_index !== null) {
            return [item.b_index];
        }
    }
    return [];
}

function compactLen(s: string): number {
    return s.replace(/\s/g, '').length;
}

/**
 * 将可疑的长短假 MATCH 降级为 delete+insert，便于与邻接缺口一并精炼。
 */
export function demoteFalseLengthMatches(
    alignment: AlignmentItem[],
    options: GapRefineOptions = {}
): AlignmentItem[] {
    const ratioGate = options.falseMatchLengthRatio ?? 1.6;
    const normalizeOpts = {
        removeInnerWhitespace: options.removeInnerWhitespace !== false
    };
    const out: AlignmentItem[] = [];

    for (let i = 0; i < alignment.length; i++) {
        const item = alignment[i];
        const next = alignment[i + 1];
        const prev = i > 0 ? alignment[i - 1] : undefined;

        if (
            item.type === 'match' &&
            item.a &&
            item.b &&
            ((next && next.type === 'insert') || (prev && prev.type === 'delete'))
        ) {
            const la = compactLen(item.a);
            const lb = compactLen(item.b);
            const longer = Math.max(la, lb);
            const shorter = Math.min(la, lb);
            if (shorter > 0 && longer / shorter >= ratioGate) {
                const na = normalizeForSimilarity(item.a, normalizeOpts);
                const nb = normalizeForSimilarity(item.b, normalizeOpts);
                const j = jaccardSimilarity(na, nb, { n: 2, granularity: 'char' });
                const layered = alignmentSimilarity(na, nb, { n: 2, granularity: 'char' });
                // 头尾抬高、字面 Jaccard 偏低 → 假 MATCH
                if (j < 0.35 && layered - j >= 0.1) {
                    out.push({
                        type: 'delete',
                        a: item.a,
                        a_index: item.a_index ?? item.a_indices?.[0],
                        a_indices: item.a_indices
                    });
                    out.push({
                        type: 'insert',
                        b: item.b,
                        b_index: item.b_index ?? item.b_indices?.[0],
                        b_indices: item.b_indices
                    });
                    continue;
                }
            }
        }
        out.push(item);
    }
    return out;
}

function refineOneGap(
    deletes: AlignmentItem[],
    inserts: AlignmentItem[],
    gapEqualRatio: number
): AlignmentItem[] {
    if (deletes.length === 0 || inserts.length === 0) {
        return [...deletes, ...inserts];
    }

    const textA = deletes.map(d => d.a ?? '').join('');
    const textB = inserts.map(d => d.b ?? '').join('');
    const equalRatio = wordDiffEqualRatio(textA, textB);

    if (equalRatio < gapEqualRatio) {
        return [...deletes, ...inserts];
    }

    const aIndices = deletes.flatMap(d => collectIndices(d, 'a'));
    const bIndices = inserts.flatMap(d => collectIndices(d, 'b'));
    const match: AlignmentItem = {
        type: 'match',
        a: textA,
        b: textB,
        similarity: equalRatio,
        a_indices: aIndices.length > 0 ? aIndices : undefined,
        b_indices: bIndices.length > 0 ? bIndices : undefined,
        a_index: aIndices.length === 1 ? aIndices[0] : undefined,
        b_index: bIndices.length === 1 ? bIndices[0] : undefined
    };
    return [match];
}

/**
 * 扫描连续 delete/insert 缺口；双侧都有内容且词流 equalRatio 足够时收成一条 match。
 */
export function refineAlignmentGaps(
    alignment: AlignmentItem[],
    options: GapRefineOptions = {}
): AlignmentItem[] {
    const gapEqualRatio = options.gapEqualRatio ?? 0.55;
    const demoted = demoteFalseLengthMatches(alignment, options);
    const result: AlignmentItem[] = [];
    let i = 0;

    while (i < demoted.length) {
        const cur = demoted[i];
        if (cur.type !== 'delete' && cur.type !== 'insert') {
            result.push(cur);
            i++;
            continue;
        }

        const deletes: AlignmentItem[] = [];
        const inserts: AlignmentItem[] = [];
        while (i < demoted.length && (demoted[i].type === 'delete' || demoted[i].type === 'insert')) {
            if (demoted[i].type === 'delete') {
                deletes.push(demoted[i]);
            } else {
                inserts.push(demoted[i]);
            }
            i++;
        }
        result.push(...refineOneGap(deletes, inserts, gapEqualRatio));
    }

    return result;
}
