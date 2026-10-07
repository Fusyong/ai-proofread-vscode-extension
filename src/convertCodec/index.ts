/**
 * 转换过程输出门面：复用翻译 bitext 编解码；支持程序回填原文。
 * 对齐语义为 convert 时使用；edit 走全文/item 路径，不经此模块强制 bitext。
 */

import type { ConvertAlignPolicy } from '../promptAlignment';
import { alignmentSimilarity } from '../similarity';
import {
    cleanTranslateDelivery,
    parseTranslateProcessOutput,
    type ParseBitextResult,
    type TermPair,
} from '../translationMemory/bitextCodec';

export type ConvertParseResult = ParseBitextResult & {
    /** 是否用输入回填了 sourcePlain */
    sourceBackfilled: boolean;
    /** 源/目标相似度（内省；不阻断） */
    similarity?: number;
};

export type ParseConvertArgs = {
    raw: string;
    inputSource: string;
    policy: ConvertAlignPolicy;
};

/**
 * 解析转换过程输出。
 * - 有 &lt;bitext&gt; 时走 bitext 解析；
 * - 无原文且允许回填时，用 inputSource 填 sourcePlain；
 * - emitSource 且模型输出了 s 时做源侧全等校验（与图书翻译一致）。
 */
export function parseConvertProcessOutput(args: ParseConvertArgs): ConvertParseResult {
    const { raw, inputSource, policy } = args;
    const parsed = parseTranslateProcessOutput(raw, inputSource);
    let sourceBackfilled = false;
    let sourcePlain = parsed.sourcePlain;
    let sourceRaw = parsed.sourceRaw;
    let sourceMatchesInput = parsed.sourceMatchesInput;

    const missingSource = !String(sourcePlain ?? '').trim();
    if (missingSource && policy.programBackfillSource) {
        sourcePlain = inputSource;
        sourceRaw = inputSource;
        sourceBackfilled = true;
        sourceMatchesInput = true;
    } else if (!policy.emitSource && policy.programBackfillSource && !parsed.ok) {
        // 非 bitext 纯交付：整段视为译文，原文回填
        const delivery = cleanTranslateDelivery(raw);
        if (delivery.trim()) {
            return {
                ok: true,
                sourceRaw: inputSource,
                targetRaw: delivery,
                sourcePlain: inputSource,
                targetPlain: delivery,
                terms: [] as TermPair[],
                keyExamples: [],
                warnings: ['convert: treated as plain delivery with program-backfilled source'],
                sourceMatchesInput: true,
                sourceBackfilled: true,
                similarity: alignmentSimilarity(inputSource, delivery),
            };
        }
    }

    const targetPlain = parsed.targetPlain || cleanTranslateDelivery(raw);
    const similarity =
        sourcePlain.trim() && targetPlain.trim()
            ? alignmentSimilarity(sourcePlain, targetPlain)
            : undefined;

    // 要求模型输出原文时：保留 sourceMatchesInput；回填时视为匹配
    if (policy.emitSource && !sourceBackfilled && parsed.ok && sourceMatchesInput === false) {
        return {
            ...parsed,
            sourcePlain,
            sourceRaw,
            sourceBackfilled,
            similarity,
            warnings: [...parsed.warnings, 'convert: source side does not match input'],
        };
    }

    return {
        ...parsed,
        ok: parsed.ok || sourceBackfilled,
        sourcePlain,
        sourceRaw,
        sourceMatchesInput: sourceBackfilled ? true : sourceMatchesInput,
        targetPlain: targetPlain || parsed.targetPlain,
        sourceBackfilled,
        similarity,
    };
}

export { cleanTranslateDelivery, type TermPair };
