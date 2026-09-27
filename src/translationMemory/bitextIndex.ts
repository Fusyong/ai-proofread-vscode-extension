/**
 * 句对侧车：`.proofread/translation-bitext-index.json`
 * 供相似句临时注入；不入翻译记忆精选库。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { jaccardSimilarity, normalizeForSimilarity } from '../similarity';
import { splitChineseSentencesSimple } from '../splitter';
import { FilePathUtils } from '../utils';
import { newTmId } from './schema';

export interface BitextPair {
    id: string;
    source: string;
    target: string;
    /** 单元级或句级 */
    granularity: 'unit' | 'sentence';
    createdAt: string;
    /** 来源文档相对路径（可选） */
    docHint?: string;
}

export interface BitextIndex {
    version: 1;
    pairs: BitextPair[];
}

const INDEX_NAME = 'translation-bitext-index.json';
const DEFAULT_MAX_PAIRS = 8_000;

export function getBitextIndexPath(anchorUri: vscode.Uri): string {
    return path.join(FilePathUtils.getProofreadWorkspaceRoot(anchorUri), '.proofread', INDEX_NAME);
}

export function createEmptyBitextIndex(): BitextIndex {
    return { version: 1, pairs: [] };
}

export function loadBitextIndex(anchorUri: vscode.Uri): BitextIndex {
    const p = getBitextIndexPath(anchorUri);
    try {
        if (!fs.existsSync(p)) {
            return createEmptyBitextIndex();
        }
        const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<BitextIndex>;
        if (raw?.version !== 1 || !Array.isArray(raw.pairs)) {
            return createEmptyBitextIndex();
        }
        const pairs: BitextPair[] = [];
        for (const x of raw.pairs) {
            if (!x || typeof x !== 'object') {
                continue;
            }
            const source = String((x as BitextPair).source ?? '').trim();
            const target = String((x as BitextPair).target ?? '').trim();
            if (!source || !target) {
                continue;
            }
            pairs.push({
                id: String((x as BitextPair).id || newTmId('bx')),
                source,
                target,
                granularity:
                    (x as BitextPair).granularity === 'unit' ? 'unit' : 'sentence',
                createdAt:
                    typeof (x as BitextPair).createdAt === 'string'
                        ? (x as BitextPair).createdAt
                        : new Date().toISOString(),
                docHint:
                    typeof (x as BitextPair).docHint === 'string'
                        ? (x as BitextPair).docHint
                        : undefined,
            });
        }
        return { version: 1, pairs };
    } catch {
        return createEmptyBitextIndex();
    }
}

export function saveBitextIndex(anchorUri: vscode.Uri, index: BitextIndex): void {
    const p = getBitextIndexPath(anchorUri);
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const backup = vscode.workspace
        .getConfiguration('ai-proofread')
        .get<boolean>('translationMemory.backupBeforeWrite', true);
    if (backup) {
        FilePathUtils.backupFileIfExists(p);
    }
    const maxPairs =
        vscode.workspace.getConfiguration('ai-proofread').get<number>(
            'translationMemory.bitextIndexMaxPairs',
            DEFAULT_MAX_PAIRS
        ) ?? DEFAULT_MAX_PAIRS;
    if (index.pairs.length > maxPairs) {
        index.pairs = index.pairs.slice(0, maxPairs);
    }
    fs.writeFileSync(p, JSON.stringify(index, null, 2), 'utf8');
}

export function clearBitextIndex(anchorUri: vscode.Uri): void {
    saveBitextIndex(anchorUri, createEmptyBitextIndex());
}

/** 将源/译文本切成句；去空白后过短的丢弃 */
export function splitBitextSentences(text: string): string[] {
    return splitChineseSentencesSimple(text, 6)
        .map((s) => s.trim())
        .filter((s) => s.replace(/\s/g, '').length >= 4);
}

/**
 * 从一对单元文本派生句对。句数相等则 zip；否则退化为整单元一对。
 */
export function deriveBitextPairsFromUnit(
    sourceUnit: string,
    targetUnit: string,
    opts?: { docHint?: string }
): BitextPair[] {
    const now = new Date().toISOString();
    const src = String(sourceUnit ?? '').trim();
    const tgt = String(targetUnit ?? '').trim();
    if (!src || !tgt) {
        return [];
    }
    const sSents = splitBitextSentences(src);
    const tSents = splitBitextSentences(tgt);
    const pairs: BitextPair[] = [];
    if (sSents.length >= 1 && sSents.length === tSents.length) {
        for (let i = 0; i < sSents.length; i++) {
            pairs.push({
                id: newTmId('bx'),
                source: sSents[i],
                target: tSents[i],
                granularity: 'sentence',
                createdAt: now,
                docHint: opts?.docHint,
            });
        }
    } else {
        pairs.push({
            id: newTmId('bx'),
            source: src,
            target: tgt,
            granularity: 'unit',
            createdAt: now,
            docHint: opts?.docHint,
        });
    }
    return pairs;
}

function normKey(s: string): string {
    return normalizeForSimilarity(s, { removeInnerWhitespace: true });
}

/** 追加句对；同源句更新译文；新条目插到前面（近因优先） */
export function upsertBitextPairs(index: BitextIndex, incoming: BitextPair[]): number {
    let added = 0;
    for (const p of incoming) {
        const key = normKey(p.source);
        if (!key) {
            continue;
        }
        const existing = index.pairs.find((x) => normKey(x.source) === key);
        if (existing) {
            if (existing.target !== p.target) {
                existing.target = p.target;
                existing.createdAt = p.createdAt;
                existing.granularity = p.granularity;
            }
            continue;
        }
        index.pairs.unshift(p);
        added++;
    }
    return added;
}

export function appendUnitToBitextIndex(
    anchorUri: vscode.Uri,
    sourceUnit: string,
    targetUnit: string,
    opts?: { docHint?: string }
): number {
    const index = loadBitextIndex(anchorUri);
    const pairs = deriveBitextPairsFromUnit(sourceUnit, targetUnit, opts);
    const n = upsertBitextPairs(index, pairs);
    if (n > 0 || pairs.length > 0) {
        saveBitextIndex(anchorUri, index);
    }
    return n;
}

export type SimilarHit = {
    pair: BitextPair;
    score: number;
    querySentence: string;
};

/**
 * 在句对侧车上对查询单元做单语模糊 Top-K（字级 Jaccard）。
 * 以查询句为粒度；结果去重。
 */
export function findSimilarBitext(
    index: BitextIndex,
    queryUnit: string,
    opts: { topK?: number; threshold?: number; excludeExact?: boolean } = {}
): SimilarHit[] {
    const topK = Math.max(1, Math.floor(opts.topK ?? 3));
    const threshold = opts.threshold ?? 0.45;
    const excludeExact = opts.excludeExact !== false;
    const querySents = splitBitextSentences(queryUnit);
    if (querySents.length === 0 || index.pairs.length === 0) {
        return [];
    }

    const hits: SimilarHit[] = [];
    const seenPairIds = new Set<string>();

    for (const qs of querySents) {
        const nq = normKey(qs);
        if (!nq) {
            continue;
        }
        let best: SimilarHit | undefined;
        for (const pair of index.pairs) {
            if (pair.granularity === 'unit' && pair.source.length > qs.length * 3) {
                // 过长单元对句查询噪声大，跳过
                continue;
            }
            const np = normKey(pair.source);
            if (!np) {
                continue;
            }
            if (excludeExact && np === nq) {
                continue;
            }
            const score = jaccardSimilarity(nq, np, { n: 2, granularity: 'char' });
            if (score < threshold) {
                continue;
            }
            if (!best || score > best.score) {
                best = { pair, score, querySentence: qs };
            }
        }
        if (best && !seenPairIds.has(best.pair.id)) {
            seenPairIds.add(best.pair.id);
            hits.push(best);
        }
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, topK);
}

/** 格式化为请求侧 `<similar_bitext>`（不出现在模型过程输出契约中） */
export function formatSimilarBitextXml(hits: SimilarHit[], maxChars: number): string {
    if (!hits.length || maxChars <= 0) {
        return '';
    }
    const blocks: string[] = [];
    let used = 0;
    for (const h of hits) {
        const block =
            `<pair score="${h.score.toFixed(2)}">\n` +
            `<s>${h.pair.source}</s>\n` +
            `<t>${h.pair.target}</t>\n` +
            `</pair>`;
        if (used + block.length > maxChars && blocks.length > 0) {
            break;
        }
        blocks.push(block);
        used += block.length + 1;
    }
    if (!blocks.length) {
        return '';
    }
    return `\n<similar_bitext>\n${blocks.join('\n')}\n</similar_bitext>`;
}

export function buildSimilarBitextXml(
    anchorUri: vscode.Uri,
    queryUnit: string,
    opts?: { topK?: number; threshold?: number; maxChars?: number }
): string {
    const c = vscode.workspace.getConfiguration('ai-proofread');
    const topK = opts?.topK ?? c.get<number>('translationMemory.similarTopK', 3) ?? 3;
    const threshold =
        opts?.threshold ?? c.get<number>('translationMemory.similarThreshold', 0.45) ?? 0.45;
    const maxChars =
        opts?.maxChars ?? c.get<number>('translationMemory.injectSimilarMaxChars', 3000) ?? 3000;
    const index = loadBitextIndex(anchorUri);
    const hits = findSimilarBitext(index, queryUnit, { topK, threshold });
    return formatSimilarBitextXml(hits, maxChars);
}
