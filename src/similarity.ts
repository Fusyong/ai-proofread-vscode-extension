/**
 * 相似度与归一化工具（对齐与引文核对共用）
 * 计划见 docs/citation-verification-plan.md 2.10.5
 */

import type { JiebaWasmModule } from './jiebaLoader';

/**
 * 归一化选项（用于相似度计算）
 */
export interface NormalizeForSimilarityOptions {
    /** 是否去掉句中空白/句内分行，默认 true（去掉） */
    removeInnerWhitespace?: boolean;
    /** 是否去掉标点，默认 false（保留） */
    removePunctuation?: boolean;
    /** 是否去掉阿拉伯数字（含带圈数字①②③等），默认 false（保留） */
    removeDigits?: boolean;
    /** 是否去掉拉丁字符，默认 false（保留） */
    removeLatin?: boolean;
    /** 是否去掉 Markdown 注码 [^1][^abc] 和上标注码 ^1^ ^abc^，默认 false（保留） */
    removeFootnoteMarkers?: boolean;
}

/** 标点字符正则（中英文常见标点，Unicode 标点类别） */
const PUNCTUATION_REGEX = /\p{P}/gu;

/** 阿拉伯数字：半角 0-9、全角 ０-９、带圈数字 ①②③ ⑴⑵ ㊀㊉ 等 */
const DIGITS_REGEX = /[\d０-９\u2460-\u2473\u2474-\u2487\u2488-\u249B\u24EA\u24F5-\u24FE\u3280-\u3289]/g;

/** 拉丁字符：半角 A-Za-z、全角 Ａ-Ｚａ-ｚ */
const LATIN_REGEX = /[A-Za-zＡ-Ｚａ-ｚ]/g;

/** Markdown 脚注 [^1] [^abc] */
const MARKDOWN_FOOTNOTE_RE = /\[\^[^\]]*\]/g;
/** 上标注码 ^1^ ^abc^ */
const SUPERSCRIPT_MARKER_RE = /\^[^^]+\^/g;

/**
 * 统一归一化（用于相似度与长度过滤）
 * 规则：前后空白去掉；句中空白/句内分行默认去掉（可配置保留）；标点/数字/拉丁/注码默认保留（均可配置去掉）。
 * 数字含带圈数字①②③；注码含 Markdown 脚注 [^1] 与上标 ^1^。
 *
 * @param text 原始句子
 * @param options 选项，未传则使用默认
 * @returns 归一化后的字符串
 */
export function normalizeForSimilarity(
    text: string,
    options: NormalizeForSimilarityOptions = {}
): string {
    const {
        removeInnerWhitespace = true,
        removePunctuation = false,
        removeDigits = false,
        removeLatin = false,
        removeFootnoteMarkers = false
    } = options;

    let s = text.trim();
    if (removeFootnoteMarkers) {
        s = s.replace(MARKDOWN_FOOTNOTE_RE, '').replace(SUPERSCRIPT_MARKER_RE, '');
    }
    if (removeInnerWhitespace) {
        s = s.replace(/\s/g, '');
    }
    if (removePunctuation) {
        s = s.replace(PUNCTUATION_REGEX, '');
    }
    if (removeDigits) {
        s = s.replace(DIGITS_REGEX, '');
    }
    if (removeLatin) {
        s = s.replace(LATIN_REGEX, '');
    }
    return s;
}

/**
 * 获取文本的字级 n-gram 集合（用于 Jaccard 相似度计算）
 */
export function getNgrams(text: string, n: number): Set<string> {
    if (text.length < n) {
        return new Set([text]);
    }
    const ngrams = new Set<string>();
    for (let i = 0; i <= text.length - n; i++) {
        ngrams.add(text.substring(i, i + n));
    }
    return ngrams;
}

/**
 * 获取文本的词级 n-gram 集合（先分词，再对词序列做 n-gram）
 * @param text 归一化后的文本
 * @param n n-gram 大小
 * @param jieba jieba-wasm 模块
 * @param cutMode default（精确）或 search（更细粒度）
 */
export function getWordNgrams(
    text: string,
    n: number,
    jieba: JiebaWasmModule,
    cutMode: 'default' | 'search' = 'default'
): Set<string> {
    const words =
        cutMode === 'search' && typeof jieba.cut_for_search === 'function'
            ? jieba.cut_for_search(text, true).filter((w) => !/^\s*$/.test(w))
            : jieba.cut(text, true).filter((w) => !/^\s*$/.test(w));
    if (words.length === 0) {
        return new Set(['']);
    }
    if (words.length < n) {
        return new Set([words.join('|')]);
    }
    const ngrams = new Set<string>();
    for (let i = 0; i <= words.length - n; i++) {
        ngrams.add(words.slice(i, i + n).join('|'));
    }
    return ngrams;
}

/** Jaccard 相似度计算选项 */
export interface JaccardSimilarityOptions {
    /** n-gram 大小，默认 1 */
    n?: number;
    /** 粒度：词级（默认）或字级 */
    granularity?: 'word' | 'char';
    /** 词级粒度时必填：jieba-wasm 模块 */
    jieba?: JiebaWasmModule;
    /** 词级粒度时的分词模式：default（精确）或 search（更细粒度） */
    cutMode?: 'default' | 'search';
}

/**
 * 计算两个文本的 Jaccard 相似度（基于 n-gram）
 * @param textA 文本 A（通常已归一化）
 * @param textB 文本 B（通常已归一化）
 * @param optionsOrN 选项对象，或兼容旧 API 的 n 值（字级）
 */
export function jaccardSimilarity(
    textA: string,
    textB: string,
    optionsOrN: JaccardSimilarityOptions | number = {}
): number {
    const opts: JaccardSimilarityOptions =
        typeof optionsOrN === 'number' ? { n: optionsOrN, granularity: 'char' } : optionsOrN;
    const n = Math.max(1, Math.floor(opts.n ?? 1));
    const granularity = opts.granularity ?? 'char';
    const jieba = opts.jieba;

    if (!textA || !textB) {
        return 0.0;
    }
    if (textA === textB) {
        return 1.0;
    }

    const cutMode = opts.cutMode ?? 'default';

    let ngramsA: Set<string>;
    let ngramsB: Set<string>;
    if (granularity === 'word' && jieba) {
        ngramsA = getWordNgrams(textA, n, jieba, cutMode);
        ngramsB = getWordNgrams(textB, n, jieba, cutMode);
    } else {
        ngramsA = getNgrams(textA, n);
        ngramsB = getNgrams(textB, n);
    }

    let intersection = 0;
    for (const ngram of ngramsA) {
        if (ngramsB.has(ngram)) {
            intersection++;
        }
    }
    const union = ngramsA.size + ngramsB.size - intersection;
    if (union === 0) {
        return 0.0;
    }
    return intersection / union;
}
