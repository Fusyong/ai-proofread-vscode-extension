/**
 * 轻量 token 粗估与 JSON 条目字段体量汇总。
 * 不依赖 tiktoken 等完整分词器；仅用于确认框等量级提示，不可作计费依据。
 */

/** CJK（含常见全角标点）约每字 token 数；现代中文友好模型常近 1，GPT 系常约 1.5–2 */
const TOKENS_PER_CJK = 1.5;
/** 拉丁/数字等约每字符 token 数（≈ 4 字符/token） */
const TOKENS_PER_OTHER = 0.25;

function isCjkCodePoint(code: number): boolean {
    return (
        (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified
        (code >= 0x3400 && code <= 0x4dbf) || // Extension A
        (code >= 0x3000 && code <= 0x303f) || // CJK Symbols and Punctuation
        (code >= 0xff00 && code <= 0xffef) // Halfwidth and Fullwidth Forms
    );
}

/**
 * 按字符类别粗估 token 数（向上取整）。
 * 中英混排比「全文统一除以 N」更稳；误差通常可接受于体量提示。
 */
export function estimateTokenCount(text: string): number {
    if (!text) {
        return 0;
    }
    let tokens = 0;
    for (const ch of text) {
        const code = ch.codePointAt(0) ?? 0;
        if (isCjkCodePoint(code)) {
            tokens += TOKENS_PER_CJK;
        } else if (/\s/u.test(ch)) {
            tokens += 0.15;
        } else {
            tokens += TOKENS_PER_OTHER;
        }
    }
    return Math.ceil(tokens);
}

export type FieldCharTokenStats = {
    chars: number;
    tokens: number;
};

export type JsonBatchContentStats = {
    target: FieldCharTokenStats;
    reference: FieldCharTokenStats;
    context: FieldCharTokenStats;
    total: FieldCharTokenStats;
};

function fieldText(item: unknown, key: string): string {
    if (!item || typeof item !== 'object') {
        return '';
    }
    const v = (item as Record<string, unknown>)[key];
    return typeof v === 'string' ? v : '';
}

/** 汇总 JSON 数组中 target / reference / context 的字符数与粗估 token */
export function summarizeJsonBatchContentStats(items: unknown[]): JsonBatchContentStats {
    let targetChars = 0;
    let referenceChars = 0;
    let contextChars = 0;
    let targetTokens = 0;
    let referenceTokens = 0;
    let contextTokens = 0;

    for (const item of items) {
        const t = fieldText(item, 'target');
        const r = fieldText(item, 'reference');
        const c = fieldText(item, 'context');
        targetChars += t.length;
        referenceChars += r.length;
        contextChars += c.length;
        targetTokens += estimateTokenCount(t);
        referenceTokens += estimateTokenCount(r);
        contextTokens += estimateTokenCount(c);
    }

    return {
        target: { chars: targetChars, tokens: targetTokens },
        reference: { chars: referenceChars, tokens: referenceTokens },
        context: { chars: contextChars, tokens: contextTokens },
        total: {
            chars: targetChars + referenceChars + contextChars,
            tokens: targetTokens + referenceTokens + contextTokens
        }
    };
}

export type JsonBatchMaxItemStats = {
    /** 内容合计最大条目的 1-based 序号；无有效条目时为 0 */
    index1: number;
    targetChars: number;
    referenceChars: number;
    contextChars: number;
    /** target+reference+context */
    contentChars: number;
    /** target 最长条目的 1-based 序号 */
    maxTargetIndex1: number;
    /** 单条最大 target 字符数 */
    maxTargetChars: number;
};

/**
 * 找出内容体量最大的一条，并同时记录 target 最长的一条（仅统计有非空 target 的条目）。
 * 用于批量确认时警示「单次输入过长 / 单次 target 过长」。
 */
export function findMaxJsonBatchItemStats(items: unknown[]): JsonBatchMaxItemStats {
    let best: JsonBatchMaxItemStats = {
        index1: 0,
        targetChars: 0,
        referenceChars: 0,
        contextChars: 0,
        contentChars: 0,
        maxTargetIndex1: 0,
        maxTargetChars: 0
    };

    items.forEach((item, i) => {
        const t = fieldText(item, 'target');
        if (t.trim() === '') {
            return;
        }
        const r = fieldText(item, 'reference');
        const c = fieldText(item, 'context');
        const contentChars = t.length + r.length + c.length;
        const index1 = i + 1;
        if (contentChars > best.contentChars) {
            best = {
                ...best,
                index1,
                targetChars: t.length,
                referenceChars: r.length,
                contextChars: c.length,
                contentChars
            };
        }
        if (t.length > best.maxTargetChars) {
            best.maxTargetChars = t.length;
            best.maxTargetIndex1 = index1;
        }
    });

    return best;
}

/**
 * 粗估单次请求输入字符数（system prompt + 内容；按 repetition 近似加倍）。
 * 不含 XML 标签开销，仅作超限警示。
 */
export function estimateSingleRequestInputChars(
    contentChars: number,
    targetChars: number,
    promptChars: number,
    repetitionMode: string
): number {
    let content = Math.max(0, contentChars);
    if (repetitionMode === 'target') {
        content += Math.max(0, targetChars);
    } else if (repetitionMode === 'all') {
        content *= 2;
    }
    return Math.max(0, promptChars) + content;
}

export function formatCharTokenLine(label: string, stats: FieldCharTokenStats): string {
    const chars = stats.chars.toLocaleString('zh-CN');
    const tokens = stats.tokens.toLocaleString('zh-CN');
    return `   • ${label}: ${chars} 字符 ≈ ${tokens} token`;
}

/** 由文本得到字符/粗估 token */
export function statsFromText(text: string): FieldCharTokenStats {
    return { chars: text.length, tokens: estimateTokenCount(text) };
}

/** 将有非空 target 的条目数（与批量校对实际发起请求的条数一致） */
export function countRequestableItems(items: unknown[]): number {
    let n = 0;
    for (const item of items) {
        const t = fieldText(item, 'target');
        if (t.trim() !== '') {
            n++;
        }
    }
    return n;
}

/** 单次 prompt 按请求次数放大后的体量 */
export function scaleStats(stats: FieldCharTokenStats, times: number): FieldCharTokenStats {
    const t = Math.max(0, times);
    return { chars: stats.chars * t, tokens: stats.tokens * t };
}

export function addStats(a: FieldCharTokenStats, b: FieldCharTokenStats): FieldCharTokenStats {
    return { chars: a.chars + b.chars, tokens: a.tokens + b.tokens };
}

/** 由单条 target / reference / context 文本汇总字符与粗估 token */
export function summarizeProofreadFieldStats(
    target: string,
    reference: string = '',
    context: string = ''
): JsonBatchContentStats {
    const t = statsFromText(target || '');
    const r = statsFromText(reference || '');
    const c = statsFromText(context || '');
    return {
        target: t,
        reference: r,
        context: c,
        total: addStats(addStats(t, r), c)
    };
}
