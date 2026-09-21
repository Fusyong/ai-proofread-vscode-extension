/**
 * 对比实验：锚点句子对齐 vs jsdiff（句级 / 段→句 / 整篇词流）
 *
 * 回答：
 * 1) 你感觉「长篇中文很好用」时，jsdiff 实际在做什么？
 * 2) 先对齐段落再拆句是否可行？
 * 3) 各算法在边界用例上的差异
 *
 * 运行：npx vitest run src/jsdiffAlignmentCompare.test.ts
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => ({
            get: (_key: string, defaultValue: unknown) => defaultValue
        })
    }
}));

import * as Diff from 'diff';

import { alignSentencesAnchor, getAlignmentStatistics, type AlignmentItem } from './sentenceAligner';
import { splitChineseSentencesSimple } from './splitter';
import { formatParagraphs } from './paragraphDetector';
import { jaccardSimilarity, normalizeForSimilarity } from './similarity';

type AlgoName =
    | 'anchor'
    | 'jsdiff-exact'
    | 'jsdiff-pair-adjacent'
    | 'jsdiff-pair-similar'
    | 'hierarchical-exact'
    | 'hierarchical-similar';

interface CaseResult {
    algo: AlgoName;
    stats: ReturnType<typeof getAlignmentStatistics>;
    /** adjacent remove+add 中相似度 < 0.4 的配对数（误配风险） */
    lowSimPairs: number;
    /** match 中相似度 < 1 的数量（改写仍配对） */
    fuzzyMatches: number;
    ms: number;
    sample: string[];
}

function splitParas(text: string): string[] {
    return text
        .split(/\n\s*\n/)
        .map(p => p.trim())
        .filter(p => p.length > 0);
}

function sentencesOf(text: string): string[] {
    return splitChineseSentencesSimple(text)
        .map(s => s.trim())
        .filter(s => s.length > 0);
}

function sim(a: string, b: string): number {
    return jaccardSimilarity(
        normalizeForSimilarity(a, { removeInnerWhitespace: true }),
        normalizeForSimilarity(b, { removeInnerWhitespace: true }),
        { n: 1, granularity: 'char' }
    );
}

/** Myers 精确句级：完全相同才 match；可选把相邻删+增配对 */
function alignJsdiffSentences(
    sentA: string[],
    sentB: string[],
    mode: 'exact' | 'pair-adjacent' | 'pair-similar',
    threshold = 0.6
): AlignmentItem[] {
    const changes = Diff.diffArrays(sentA, sentB);
    const out: AlignmentItem[] = [];
    let aIdx = 0;
    let bIdx = 0;

    for (let i = 0; i < changes.length; i++) {
        const cur = changes[i];
        const next = changes[i + 1];
        const vals = cur.value as string[];

        if (!cur.added && !cur.removed) {
            for (const v of vals) {
                out.push({ type: 'match', a: v, b: v, a_index: aIdx, b_index: bIdx, similarity: 1 });
                aIdx++;
                bIdx++;
            }
            continue;
        }

        if (cur.removed && next?.added && (mode === 'pair-adjacent' || mode === 'pair-similar')) {
            const rem = vals;
            const add = next.value as string[];
            const n = Math.min(rem.length, add.length);
            for (let k = 0; k < n; k++) {
                const s = sim(rem[k], add[k]);
                if (mode === 'pair-adjacent' || s >= threshold) {
                    out.push({
                        type: 'match',
                        a: rem[k],
                        b: add[k],
                        a_index: aIdx + k,
                        b_index: bIdx + k,
                        similarity: s
                    });
                } else {
                    out.push({ type: 'delete', a: rem[k], a_index: aIdx + k });
                    out.push({ type: 'insert', b: add[k], b_index: bIdx + k });
                }
            }
            for (let k = n; k < rem.length; k++) {
                out.push({ type: 'delete', a: rem[k], a_index: aIdx + k });
            }
            for (let k = n; k < add.length; k++) {
                out.push({ type: 'insert', b: add[k], b_index: bIdx + k });
            }
            aIdx += rem.length;
            bIdx += add.length;
            i++;
            continue;
        }

        if (cur.removed) {
            for (const v of vals) {
                out.push({ type: 'delete', a: v, a_index: aIdx++ });
            }
        } else if (cur.added) {
            for (const v of vals) {
                out.push({ type: 'insert', b: v, b_index: bIdx++ });
            }
        }
    }
    return out;
}

/** 先段对齐，再在配对段内做句对齐 */
function alignHierarchical(
    textA: string,
    textB: string,
    paraMode: 'exact' | 'similar',
    sentMode: 'exact' | 'pair-similar',
    paraThreshold = 0.5
): AlignmentItem[] {
    const parasA = splitParas(textA);
    const parasB = splitParas(textB);
    const changes = Diff.diffArrays(parasA, parasB);
    const out: AlignmentItem[] = [];

    const alignParaPair = (pa: string, pb: string) => {
        const sa = sentencesOf(pa);
        const sb = sentencesOf(pb);
        if (sentMode === 'exact') {
            out.push(...alignJsdiffSentences(sa, sb, 'exact'));
        } else {
            out.push(...alignJsdiffSentences(sa, sb, 'pair-similar'));
        }
    };

    for (let i = 0; i < changes.length; i++) {
        const cur = changes[i];
        const next = changes[i + 1];
        const vals = cur.value as string[];

        if (!cur.added && !cur.removed) {
            for (const p of vals) {
                alignParaPair(p, p);
            }
            continue;
        }

        if (cur.removed && next?.added) {
            const rem = vals;
            const add = next.value as string[];
            const n = Math.min(rem.length, add.length);
            for (let k = 0; k < n; k++) {
                const s = sim(rem[k], add[k]);
                if (paraMode === 'exact') {
                    // 段不完全相同：整段句级 exact（通常变成大量删增）
                    alignParaPair(rem[k], add[k]);
                } else if (s >= paraThreshold) {
                    alignParaPair(rem[k], add[k]);
                } else {
                    for (const sent of sentencesOf(rem[k])) {
                        out.push({ type: 'delete', a: sent });
                    }
                    for (const sent of sentencesOf(add[k])) {
                        out.push({ type: 'insert', b: sent });
                    }
                }
            }
            for (let k = n; k < rem.length; k++) {
                for (const sent of sentencesOf(rem[k])) {
                    out.push({ type: 'delete', a: sent });
                }
            }
            for (let k = n; k < add.length; k++) {
                for (const sent of sentencesOf(add[k])) {
                    out.push({ type: 'insert', b: sent });
                }
            }
            i++;
            continue;
        }

        if (cur.removed) {
            for (const p of vals) {
                for (const sent of sentencesOf(p)) {
                    out.push({ type: 'delete', a: sent });
                }
            }
        } else if (cur.added) {
            for (const p of vals) {
                for (const sent of sentencesOf(p)) {
                    out.push({ type: 'insert', b: sent });
                }
            }
        }
    }
    return out;
}

function analyze(algo: AlgoName, alignment: AlignmentItem[], ms: number): CaseResult {
    const stats = getAlignmentStatistics(alignment);
    let lowSimPairs = 0;
    let fuzzyMatches = 0;
    const sample: string[] = [];

    for (const item of alignment) {
        if (item.type === 'match' && item.a != null && item.b != null) {
            const s = item.similarity ?? sim(item.a, item.b);
            if (s < 1) {
                fuzzyMatches++;
            }
            if (s < 0.4) {
                lowSimPairs++;
            }
            if (sample.length < 3 && item.a !== item.b) {
                sample.push(`match~${s.toFixed(2)}: 「${item.a.slice(0, 24)}」↔「${item.b.slice(0, 24)}」`);
            }
        } else if (item.type === 'delete' && sample.length < 5) {
            sample.push(`DEL: 「${(item.a ?? '').slice(0, 28)}」`);
        } else if (item.type === 'insert' && sample.length < 5) {
            sample.push(`INS: 「${(item.b ?? '').slice(0, 28)}」`);
        } else if ((item.type === 'movein' || item.type === 'moveout') && sample.length < 5) {
            sample.push(`${item.type}: 「${(item.a ?? item.b ?? '').slice(0, 28)}」`);
        }
    }

    return { algo, stats, lowSimPairs, fuzzyMatches, ms, sample };
}

function runAll(textA: string, textB: string): CaseResult[] {
    const sa = sentencesOf(textA);
    const sb = sentencesOf(textB);
    const results: CaseResult[] = [];

    const timed = (algo: AlgoName, fn: () => AlignmentItem[]) => {
        const t0 = performance.now();
        const alignment = fn();
        results.push(analyze(algo, alignment, performance.now() - t0));
    };

    timed('anchor', () => alignSentencesAnchor(sa, sb, { similarityThreshold: 0.6, windowSize: 10 }));
    timed('jsdiff-exact', () => alignJsdiffSentences(sa, sb, 'exact'));
    timed('jsdiff-pair-adjacent', () => alignJsdiffSentences(sa, sb, 'pair-adjacent'));
    timed('jsdiff-pair-similar', () => alignJsdiffSentences(sa, sb, 'pair-similar', 0.6));
    timed('hierarchical-exact', () => alignHierarchical(textA, textB, 'exact', 'exact'));
    timed('hierarchical-similar', () => alignHierarchical(textA, textB, 'similar', 'pair-similar', 0.5));

    return results;
}

/** 整篇词流 diff：你在 HTML 里「感觉对齐很好」的指标（不是句对） */
function wordStreamStats(textA: string, textB: string) {
    const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
    // 与 differ.ts / alignmentReportGenerator 一致：第三参直接传 Segmenter
    const changes = Diff.diffWordsWithSpace(textA, textB, segmenter as never);
    let unchanged = 0;
    let removed = 0;
    let added = 0;
    for (const p of changes) {
        const n = p.value.length;
        if (p.added) {
            added += n;
        } else if (p.removed) {
            removed += n;
        } else {
            unchanged += n;
        }
    }
    const total = unchanged + removed + added;
    return {
        unchangedRatio: total ? unchanged / total : 1,
        changeHunks: changes.filter(c => c.added || c.removed).length,
        parts: changes.length
    };
}

function printCase(name: string, textA: string, textB: string) {
    const rows = runAll(textA, textB);
    const ws = wordStreamStats(textA, textB);
    // eslint-disable-next-line no-console
    console.log(`\n======== ${name} ========`);
    // eslint-disable-next-line no-console
    console.log(
        `词流(diffWords+Segmenter): unchanged≈${(ws.unchangedRatio * 100).toFixed(1)}% hunks=${ws.changeHunks}`
    );
    for (const r of rows) {
        const s = r.stats;
        // eslint-disable-next-line no-console
        console.log(
            `${r.algo.padEnd(24)} match=${s.match} del=${s.delete} ins=${s.insert} ` +
                `move=${s.movein + s.moveout} fuzzy=${r.fuzzyMatches} lowSim=${r.lowSimPairs} ` +
                `${r.ms.toFixed(1)}ms`
        );
        if (r.sample.length) {
            // eslint-disable-next-line no-console
            console.log(`  e.g. ${r.sample.slice(0, 2).join(' | ')}`);
        }
    }
    return { rows, ws };
}

// ---------- 边界用例 ----------

const CASE_MINOR = {
    a: '这是第一句话。这里有一处修改！Hello world, this is a test. 这一句在V2中会被完全删掉。第三句话保持原样……',
    b: '这是第一句话。这里做了一点点修改！Hello world, this is a modified test. 第三句话保持原样……这是全新加入的句子。'
};

const CASE_WHITESPACE = {
    a: '社  址在北京。渊源关 系十分密切。',
    b: '社址在北京。渊源关系十分密切。'
};

const CASE_REWRITE = {
    a: '他昨天去了北京出差。会议于上午九点开始。',
    b: '他昨日赴首都公干。会议于上午九点开始。'
};

const CASE_REORDER = {
    a: '第一句在原位。第二句稍后会被挪走。第三句末尾。',
    b: '第一句在原位。第三句末尾。第二句稍后会被挪走。'
};

const CASE_INSERT_MIDDLE = {
    a: '开篇总述。结束陈词。',
    b: '开篇总述。中间插入的全新段落内容，很长很长。结束陈词。'
};

const CASE_FALSE_PAIR = {
    a: '苹果是一种水果。天空是蓝色的。',
    b: '量子计算正在发展。天空是蓝色的。'
};

const CASE_PARA_SPLIT = {
    a: '第一段只有一句。\n\n第二段包含两句。这是第二段的第二句。',
    b: '第一段只有一句。\n\n第二段包含两句。\n\n这是第二段的第二句被拆成独立段。'
};

/** PDF 硬换行碎片：整理前 vs formatParagraphs 后 */
const CASE_PDF_FRAG = {
    a: [
        '中国古代史学源远流长，',
        '司马迁撰《史记》开纪传体',
        '通史之先河。其后班固作',
        '《汉书》，断代为史。',
        '',
        '近代以来，新史学思潮兴起，',
        '史料范围不断扩大。'
    ].join('\n'),
    b: [
        '中国古代史学源远流长，司马迁撰《史记》开纪传体通史之先河。其后班固作《汉书》，断代为史。',
        '',
        '近代以来，新史学思潮兴起，史料范围不断扩大。考证方法日益精密。'
    ].join('\n')
};

describe('jsdiff vs anchor alignment compare', () => {
    it('explains: word-stream feels good but is not sentence alignment', () => {
        const { ws, rows } = printCase('微调（演示用例）', CASE_MINOR.a, CASE_MINOR.b);
        // 整篇词流：大部分字符未变 → 观感「对齐很好」
        expect(ws.unchangedRatio).toBeGreaterThan(0.5);
        const exact = rows.find(r => r.algo === 'jsdiff-exact')!;
        const anchor = rows.find(r => r.algo === 'anchor')!;
        // 精确句 diff：改写句会变成 del+ins，match 更少
        expect(exact.stats.match).toBeLessThan(anchor.stats.match);
    });

    it('whitespace-only: anchor can match, exact jsdiff often fails', () => {
        const { rows, ws } = printCase('仅空白差异', CASE_WHITESPACE.a, CASE_WHITESPACE.b);
        expect(ws.unchangedRatio).toBeGreaterThan(0.7);
        const anchor = rows.find(r => r.algo === 'anchor')!;
        const exact = rows.find(r => r.algo === 'jsdiff-exact')!;
        expect(anchor.stats.match).toBeGreaterThanOrEqual(exact.stats.match);
    });

    it('heavy rewrite: anchor may still pair; exact cannot; adjacent-pair risks false match', () => {
        const { rows } = printCase('同义改写', CASE_REWRITE.a, CASE_REWRITE.b);
        const adjacent = rows.find(r => r.algo === 'jsdiff-pair-adjacent')!;
        // 「他昨天…」vs「他昨日…」可能被相邻硬配；看 lowSim 或 fuzzy
        expect(adjacent.stats.match + adjacent.stats.delete).toBeGreaterThan(0);
        printCase('无关句相邻替换（误配陷阱）', CASE_FALSE_PAIR.a, CASE_FALSE_PAIR.b);
        const falseRows = runAll(CASE_FALSE_PAIR.a, CASE_FALSE_PAIR.b);
        const adj = falseRows.find(r => r.algo === 'jsdiff-pair-adjacent')!;
        const simGate = falseRows.find(r => r.algo === 'jsdiff-pair-similar')!;
        // 硬配会把「苹果…」和「量子…」配成 match（低相似）
        expect(adj.lowSimPairs).toBeGreaterThanOrEqual(1);
        expect(simGate.lowSimPairs).toBe(0);
    });

    it('reorder: word-stream still shares tokens; sentence jsdiff becomes del+ins; anchor may detect move', () => {
        const { rows, ws } = printCase('句子调序', CASE_REORDER.a, CASE_REORDER.b);
        // 短文调序时，被挪动的句在词流里会整段记为删+增，unchanged 未必很高；
        // 长文中局部调序则 unchanged 通常仍很高（观感「还行」）。
        expect(ws.unchangedRatio).toBeGreaterThan(0.4);
        const exact = rows.find(r => r.algo === 'jsdiff-exact')!;
        const anchor = rows.find(r => r.algo === 'anchor')!;
        expect(exact.stats.delete + exact.stats.insert).toBeGreaterThan(0);
        expect(anchor.stats.movein + anchor.stats.moveout).toBeGreaterThan(0);
    });

    it('middle insert + para hierarchy', () => {
        printCase('段中插入', CASE_INSERT_MIDDLE.a, CASE_INSERT_MIDDLE.b);
        printCase('段落拆分', CASE_PARA_SPLIT.a, CASE_PARA_SPLIT.b);

        const fragA = CASE_PDF_FRAG.a;
        const fragB = CASE_PDF_FRAG.b;
        printCase('PDF碎片（未整理）', fragA, fragB);

        const mergedA = formatParagraphs(fragA, fragA, { addBlankLines: true, removeLineBreaks: true });
        printCase('PDF碎片（formatParagraphs 后再比）', mergedA, fragB);

        // 合并段落后，句级应对齐显著好于碎行状态
        const before = runAll(fragA, fragB);
        const after = runAll(mergedA, fragB);
        const beforeExact = before.find(r => r.algo === 'jsdiff-exact')!.stats.match;
        const afterExact = after.find(r => r.algo === 'jsdiff-exact')!.stats.match;
        expect(afterExact).toBeGreaterThanOrEqual(beforeExact);
    });

    it('summary table for docs', () => {
        const names: [string, string, string][] = [
            ['微调', CASE_MINOR.a, CASE_MINOR.b],
            ['空白', CASE_WHITESPACE.a, CASE_WHITESPACE.b],
            ['改写', CASE_REWRITE.a, CASE_REWRITE.b],
            ['调序', CASE_REORDER.a, CASE_REORDER.b],
            ['误配', CASE_FALSE_PAIR.a, CASE_FALSE_PAIR.b],
            ['插入', CASE_INSERT_MIDDLE.a, CASE_INSERT_MIDDLE.b]
        ];
        // eslint-disable-next-line no-console
        console.log('\n======== 汇总（match / del+ins / lowSim）========');
        for (const [name, a, b] of names) {
            const rows = runAll(a, b);
            const ws = wordStreamStats(a, b);
            const line = rows
                .map(r => `${r.algo}:{m${r.stats.match}/d${r.stats.delete + r.stats.insert}/ls${r.lowSimPairs}}`)
                .join(' ');
            // eslint-disable-next-line no-console
            console.log(`${name} word=${(ws.unchangedRatio * 100).toFixed(0)}% | ${line}`);
        }
        expect(true).toBe(true);
    });
});
