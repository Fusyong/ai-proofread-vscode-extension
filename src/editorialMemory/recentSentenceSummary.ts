/**
 * 「近期记忆」与时间线摘要：按句对齐筛出有实质改动的句式，避免整块原文/终稿堆砌。
 */

import type { AlignmentItem } from '../sentenceAligner';
import { alignSentencesAnchor } from '../sentenceAligner';
import { normalizeForSimilarity } from '../similarity';
import { splitChineseSentences } from '../splitter';
import { normalizeLineEndings } from '../utils';

const NORM: Parameters<typeof normalizeForSimilarity>[1] = { removeInnerWhitespace: true };

/** 选段校对场景：仅用字级二元组，无需 jieba */
const MEMORY_ALIGN_OPTS = {
    windowSize: 10,
    similarityThreshold: 0.55,
    ngramSize: 2,
    ngramGranularity: 'char' as const,
    removeInnerWhitespace: true,
};

/** 每条句式摘要最大字符（单边） */
const MAX_SENT_CLIP = 70;
/** 至多展开几条句式对（其余用「共 N 处」概括） */
const MAX_PAIRS_IN_SUMMARY = 4;
/** 整条摘要正文上限（与 roundMaxChars 取较小值） */
const SUMMARY_HARD_CAP = 900;

function oneLine(text: string): string {
    return normalizeLineEndings(text).trim().replace(/\s+/g, ' ');
}

function clipSent(text: string, maxLen: number): string {
    const s = oneLine(text);
    if (s.length <= maxLen) {
        return s;
    }
    return s.slice(0, maxLen) + '…';
}

function substantiveChanged(beforeRaw: string, afterRaw: string): boolean {
    const a = normalizeForSimilarity(beforeRaw ?? '', NORM);
    const b = normalizeForSimilarity(afterRaw ?? '', NORM);
    if (!a.trim() && !b.trim()) {
        return false;
    }
    return a !== b;
}

/** 从对齐结果中收集实质性改动句对（跳过仅空白差异；move 类去重） */
function extractSubstantivePairs(alignment: AlignmentItem[]): Array<{ before: string; after: string }> {
    const seen = new Set<string>();
    const out: Array<{ before: string; after: string }> = [];

    const pushUnique = (before: string, after: string, label?: string): void => {
        if (!substantiveChanged(before, after)) {
            return;
        }
        const key =
            normalizeForSimilarity(before, NORM) +
            '\x00' +
            normalizeForSimilarity(after, NORM) +
            (label ?? '');
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        out.push({ before, after });
    };

    for (const it of alignment) {
        switch (it.type) {
            case 'match':
                pushUnique(it.a ?? '', it.b ?? '', 'm');
                break;
            case 'delete':
                pushUnique(it.a ?? '', '（删除）', 'd');
                break;
            case 'insert':
                pushUnique('（增补）', it.b ?? '', 'i');
                break;
            case 'movein':
            case 'moveout':
                pushUnique(it.a ?? '', it.b ?? '', it.type);
                break;
            default:
                break;
        }
    }
    return out;
}

function fallbackTruncatedArrow(original: string, final: string, maxBody: number): string {
    const msg = `「${clipSent(original, 90)}」→「${clipSent(final, 90)}」（句粒度未分项）`;
    return msg.length <= maxBody ? msg : msg.slice(0, maxBody) + '…';
}

/**
 * 生成本轮校对的一句摘要（句式级「忌→宜」，忽略归一化后相同的纯空白改动）
 */
export function summarizeRoundSentenceAligned(original: string, finalSelected: string, roundMaxChars: number): string {
    const rawA = normalizeLineEndings(original);
    const rawB = normalizeLineEndings(finalSelected);
    const naTrim = normalizeForSimilarity(rawA, NORM);
    const nbTrim = normalizeForSimilarity(rawB, NORM);
    if (!rawA.trim() && !rawB.trim()) {
        return '空选区，无校对内容。';
    }
    if (rawA === rawB) {
        return '无文本差异。';
    }
    if (naTrim === nbTrim) {
        return '无实质改动（仅空白、转行等忽略不计）。';
    }

    const maxBody = Math.max(120, Math.min(roundMaxChars, SUMMARY_HARD_CAP));
    const sentsA = splitChineseSentences(rawA).filter((s) => s.trim().length > 0);
    const sentsB = splitChineseSentences(rawB).filter((s) => s.trim().length > 0);

    if (sentsA.length === 0 && sentsB.length === 0) {
        return fallbackTruncatedArrow(rawA, rawB, maxBody);
    }

    const alignment = alignSentencesAnchor(sentsA, sentsB, MEMORY_ALIGN_OPTS);
    const pairs = extractSubstantivePairs(alignment);

    if (pairs.length === 0) {
        return fallbackTruncatedArrow(rawA, rawB, maxBody);
    }

    const shown = pairs.slice(0, MAX_PAIRS_IN_SUMMARY);
    const parts: string[] = [];
    for (const { before, after } of shown) {
        parts.push(`「${clipSent(before, MAX_SENT_CLIP)}」→「${clipSent(after, MAX_SENT_CLIP)}」`);
    }
    let body = `句式要点：${parts.join('；')}`;
    if (pairs.length > shown.length) {
        body += `；共 ${pairs.length} 处句式级改动`;
    }
    if (body.length > maxBody) {
        body = body.slice(0, maxBody) + '…';
    }
    return body;
}
