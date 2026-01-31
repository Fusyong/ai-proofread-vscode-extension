/**
 * 相似度与归一化工具（对齐与引文核对共用）
 * 计划见 docs/citation-verification-plan.md 2.10.5
 */

/**
 * 归一化选项（用于相似度计算）
 */
export interface NormalizeForSimilarityOptions {
    /** 是否去掉句中空白/句内分行，默认 true（去掉） */
    removeInnerWhitespace?: boolean;
    /** 是否去掉标点，默认 false（保留） */
    removePunctuation?: boolean;
    /** 是否去掉阿拉伯数字，默认 false（保留） */
    removeDigits?: boolean;
    /** 是否去掉拉丁字符，默认 false（保留） */
    removeLatin?: boolean;
}

/** 标点字符正则（中英文常见标点，Unicode 标点类别） */
const PUNCTUATION_REGEX = /\p{P}/gu;

/** 阿拉伯数字：半角 0-9、全角 ０-９ */
const DIGITS_REGEX = /[\d０-９]/g;

/** 拉丁字符：半角 A-Za-z、全角 Ａ-Ｚａ-ｚ */
const LATIN_REGEX = /[A-Za-zＡ-Ｚａ-ｚ]/g;

/**
 * 统一归一化（用于相似度与长度过滤）
 * 规则：前后空白去掉；句中空白/句内分行默认去掉（可配置保留）；标点/数字/拉丁字符默认保留（均可配置去掉）。
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
        removeLatin = false
    } = options;

    let s = text.trim();
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
 * 获取文本的 n-gram 集合（用于 Jaccard 相似度计算）
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
 * 计算两个文本的 Jaccard 相似度（基于 n-gram）
 */
export function jaccardSimilarity(textA: string, textB: string, n: number = 2): number {
    if (!textA || !textB) {
        return 0.0;
    }
    if (textA === textB) {
        return 1.0;
    }
    const ngramsA = getNgrams(textA, n);
    const ngramsB = getNgrams(textB, n);
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
