/**
 * 从整篇词流 jsdiff 反解句对：用 Myers 对齐把 A 的句界投影到 B。
 *
 * 流程：diffWordsWithSpace → 字符 opcodes → A 句映射到 B 区间 → 与 B 分句求交。
 * 低相似 match 拆成 delete+insert；可选检测整句调序后由调用方回退锚点。
 */

import * as Diff from 'diff';
import { splitChineseSentencesWithOffsets, type SentenceSpanInText } from './splitter';
import type { AlignmentItem, AlignmentOptions } from './sentenceAligner';
import {
    jaccardSimilarity,
    normalizeForSimilarity,
    type JaccardSimilarityOptions,
    type NormalizeForSimilarityOptions
} from './similarity';

export interface CharOpcode {
    tag: 'equal' | 'delete' | 'insert';
    a0: number;
    a1: number;
    b0: number;
    b1: number;
}

export interface SentenceSpan {
    text: string;
    start: number;
    end: number;
    index: number;
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

/** 将 jsdiff change 流转为字符级 opcodes（A/B 半开区间） */
export function wordDiffToOpcodes(textA: string, textB: string): CharOpcode[] {
    const segmenter = getSegmenter();
    const changes = segmenter
        ? Diff.diffWordsWithSpace(textA, textB, segmenter as never)
        : Diff.diffWordsWithSpace(textA, textB);

    const opcodes: CharOpcode[] = [];
    let a = 0;
    let b = 0;

    for (const part of changes) {
        const len = part.value.length;
        if (part.added) {
            opcodes.push({ tag: 'insert', a0: a, a1: a, b0: b, b1: b + len });
            b += len;
        } else if (part.removed) {
            opcodes.push({ tag: 'delete', a0: a, a1: a + len, b0: b, b1: b });
            a += len;
        } else {
            opcodes.push({ tag: 'equal', a0: a, a1: a + len, b0: b, b1: b + len });
            a += len;
            b += len;
        }
    }

    return opcodes;
}

/**
 * A 侧字符下标 → B 侧对齐位置。
 * delete 区映射到删除点处的 b；A 末尾映射到 B 末尾。
 */
export function buildAToBPositionMap(opcodes: CharOpcode[], lenA: number, lenB: number): number[] {
    const map = new Array<number>(lenA + 1);
    for (const op of opcodes) {
        if (op.tag === 'equal') {
            for (let i = 0; i < op.a1 - op.a0; i++) {
                map[op.a0 + i] = op.b0 + i;
            }
        } else if (op.tag === 'delete') {
            for (let i = op.a0; i < op.a1; i++) {
                map[i] = op.b0;
            }
        }
    }
    map[lenA] = lenB;

    let last = 0;
    for (let i = 0; i <= lenA; i++) {
        if (map[i] === undefined || Number.isNaN(map[i])) {
            map[i] = last;
        } else {
            last = map[i];
        }
    }
    return map;
}

function toSentenceSpans(raw: SentenceSpanInText[]): SentenceSpan[] {
    return raw.map((s, index) => ({
        text: s.sentence,
        start: s.startOffset,
        end: s.endOffset,
        index
    }));
}

/** 与勘误表分句一致（simple 分句 + 偏移） */
export function sentencesWithSpans(text: string): SentenceSpan[] {
    return toSentenceSpans(splitChineseSentencesWithOffsets(text, true));
}

function spansOverlapping(spans: SentenceSpan[], from: number, to: number): SentenceSpan[] {
    if (to < from) {
        [from, to] = [to, from];
    }
    if (from === to) {
        const at = spans.find(s => s.start >= from && s.text.trim());
        return at ? [at] : [];
    }
    return spans.filter(s => s.text.trim() && s.start < to && s.end > from);
}

function getNormalizeOpts(options: AlignmentOptions): NormalizeForSimilarityOptions {
    return {
        removeInnerWhitespace: options.removeInnerWhitespace !== false,
        removePunctuation: options.removePunctuation === true,
        removeDigits: options.removeDigits === true,
        removeLatin: options.removeLatin === true
    };
}

function getSimOpts(options: AlignmentOptions): JaccardSimilarityOptions {
    const n = Math.max(1, Math.floor(options.ngramSize ?? 1));
    const granularity = options.ngramGranularity ?? 'char';
    const jieba = options.jieba;
    return {
        n,
        granularity: granularity === 'word' && jieba ? 'word' : 'char',
        jieba: granularity === 'word' && jieba ? jieba : undefined,
        cutMode: options.cutMode ?? 'default'
    };
}

function pairSimilarity(a: string, b: string, options: AlignmentOptions): number {
    const norm = getNormalizeOpts(options);
    return jaccardSimilarity(
        normalizeForSimilarity(a, norm),
        normalizeForSimilarity(b, norm),
        getSimOpts(options)
    );
}

/**
 * 检测「整句调序」迹象，供 wordDiff 回退锚点：
 * 1) 同句（归一化后）既出现在 delete 又出现在 insert；
 * 2) 或两侧句子多重集合相同但顺序不同（纯调序，词流 LCS 易错位）。
 */
export function detectSentenceReorder(
    alignment: AlignmentItem[],
    options: AlignmentOptions = {},
    sentencesA?: string[],
    sentencesB?: string[]
): boolean {
    const norm = getNormalizeOpts(options);
    const keyOf = (t: string) => normalizeForSimilarity(t, norm);

    const deleted = new Set<string>();
    const inserted = new Set<string>();

    for (const item of alignment) {
        if (item.type === 'delete' && item.a) {
            const key = keyOf(item.a);
            if (key) {
                deleted.add(key);
            }
        } else if (item.type === 'insert' && item.b) {
            const key = keyOf(item.b);
            if (key) {
                inserted.add(key);
            }
        }
    }

    for (const key of deleted) {
        if (inserted.has(key)) {
            return true;
        }
    }

    if (sentencesA && sentencesB && sentencesA.length > 0 && sentencesA.length === sentencesB.length) {
        const bagA = new Map<string, number>();
        const bagB = new Map<string, number>();
        for (const s of sentencesA) {
            const k = keyOf(s);
            if (k) {
                bagA.set(k, (bagA.get(k) ?? 0) + 1);
            }
        }
        for (const s of sentencesB) {
            const k = keyOf(s);
            if (k) {
                bagB.set(k, (bagB.get(k) ?? 0) + 1);
            }
        }
        if (bagA.size === bagB.size) {
            let bagsEqual = true;
            for (const [k, n] of bagA) {
                if (bagB.get(k) !== n) {
                    bagsEqual = false;
                    break;
                }
            }
            if (bagsEqual) {
                const sameOrder = sentencesA.every((s, i) => keyOf(s) === keyOf(sentencesB[i]));
                if (!sameOrder) {
                    return true;
                }
            }
        }
    }

    return false;
}

/**
 * 词流反解句对（含相似门槛与 insert 按 B 序穿插）。
 * @param spansA 可选，与行号分句同源的偏移列表（保证 a_index 一致）
 * @param spansB 可选，同上
 */
export function projectSentencePairsFromWordDiff(
    textA: string,
    textB: string,
    options: AlignmentOptions = {},
    spansA?: SentenceSpanInText[],
    spansB?: SentenceSpanInText[]
): AlignmentItem[] {
    const threshold = options.similarityThreshold ?? 0.4;
    const opcodes = wordDiffToOpcodes(textA, textB);
    const a2b = buildAToBPositionMap(opcodes, textA.length, textB.length);
    const sentA = (spansA ? toSentenceSpans(spansA) : sentencesWithSpans(textA))
        .filter(s => s.text.trim());
    const sentB = (spansB ? toSentenceSpans(spansB) : sentencesWithSpans(textB))
        .filter(s => s.text.trim());
    const coveredB = new Set<number>();

    type ASide =
        | { kind: 'match'; item: AlignmentItem; bIndexes: number[] }
        | { kind: 'delete'; item: AlignmentItem; afterB: number };

    const aSide: ASide[] = [];

    for (const sa of sentA) {
        let bs = a2b[sa.start] ?? 0;
        let be = a2b[sa.end] ?? textB.length;
        if (be < bs) {
            [bs, be] = [be, bs];
        }

        const hits = spansOverlapping(sentB, bs, be);
        if (hits.length === 0) {
            const slice = textB.slice(bs, be).trim();
            if (!slice) {
                aSide.push({
                    kind: 'delete',
                    item: { type: 'delete', a: sa.text, a_index: sa.index },
                    afterB: bs
                });
                continue;
            }
            const sim = pairSimilarity(sa.text, slice, options);
            if (sim >= threshold) {
                aSide.push({
                    kind: 'match',
                    item: {
                        type: 'match',
                        a: sa.text,
                        b: slice,
                        a_index: sa.index,
                        similarity: sim
                    },
                    bIndexes: []
                });
            } else {
                aSide.push({
                    kind: 'delete',
                    item: { type: 'delete', a: sa.text, a_index: sa.index },
                    afterB: bs
                });
                // slice 不是完整 B 句，不标记 covered；若与某句重合由 overlap 处理
            }
            continue;
        }

        for (const h of hits) {
            coveredB.add(h.index);
        }

        const bText = hits.length === 1 ? hits[0].text : hits.map(h => h.text).join('');
        const sim = pairSimilarity(sa.text, bText, options);

        if (sim < threshold) {
            aSide.push({
                kind: 'delete',
                item: { type: 'delete', a: sa.text, a_index: sa.index },
                afterB: bs
            });
            for (const h of hits) {
                coveredB.delete(h.index);
            }
            continue;
        }

        const item: AlignmentItem = {
            type: 'match',
            a: sa.text,
            b: bText,
            a_index: sa.index,
            b_index: hits[0].index,
            similarity: sim
        };
        if (hits.length > 1) {
            item.b_indices = hits.map(h => h.index);
        }
        aSide.push({ kind: 'match', item, bIndexes: hits.map(h => h.index) });
    }

    const uncovered = sentB.filter(s => !coveredB.has(s.index));
    const result: AlignmentItem[] = [];
    let insertPtr = 0;

    const flushInsertsBefore = (bPos: number) => {
        while (insertPtr < uncovered.length && uncovered[insertPtr].start < bPos) {
            const sb = uncovered[insertPtr++];
            result.push({ type: 'insert', b: sb.text, b_index: sb.index });
        }
    };

    for (const side of aSide) {
        if (side.kind === 'match') {
            const firstB = side.bIndexes.length > 0
                ? sentB[side.bIndexes[0]]?.start ?? 0
                : 0;
            flushInsertsBefore(firstB);
            result.push(side.item);
        } else {
            flushInsertsBefore(side.afterB);
            result.push(side.item);
        }
    }

    while (insertPtr < uncovered.length) {
        const sb = uncovered[insertPtr++];
        result.push({ type: 'insert', b: sb.text, b_index: sb.index });
    }

    return result;
}
