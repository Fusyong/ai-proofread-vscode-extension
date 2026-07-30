/**
 * 应用层 BM25（jieba 分词）。
 * sql.js 默认未启用 FTS5，且 unicode 分词对中文几乎无效，故用已有 jieba-wasm。
 */

export interface Bm25Document {
    id: number;
    tokens: string[];
    /** term -> tf */
    tf: Map<string, number>;
}

export interface Bm25HitScore {
    id: number;
    score: number;
}

const DEFAULT_K1 = 1.5;
const DEFAULT_B = 0.75;

/** 过滤过短/纯空白 token；保留数字与拉丁词 */
export function normalizeBm25Token(raw: string): string | null {
    const t = raw.trim().toLowerCase();
    if (!t) return null;
    if (/^[\s\p{P}\p{S}]+$/u.test(t)) return null;
    if (t.length === 1 && !/[a-z0-9]/i.test(t)) return null;
    return t;
}

export function buildTermFrequency(tokens: string[]): Map<string, number> {
    const tf = new Map<string, number>();
    for (const tok of tokens) {
        tf.set(tok, (tf.get(tok) ?? 0) + 1);
    }
    return tf;
}

export function tokenizeWithJieba(
    text: string,
    cut: (text: string, hmm?: boolean) => string[]
): string[] {
    const raw = cut(text, true);
    const out: string[] = [];
    for (const w of raw) {
        const n = normalizeBm25Token(w);
        if (n) out.push(n);
    }
    return out;
}

/**
 * 经典 BM25。queryTerms 已规范化；docs 需含 tokens/tf。
 */
export function scoreBm25(
    docs: Bm25Document[],
    queryTerms: string[],
    opts?: { k1?: number; b?: number; topK?: number }
): Bm25HitScore[] {
    const k1 = opts?.k1 ?? DEFAULT_K1;
    const b = opts?.b ?? DEFAULT_B;
    const topK = opts?.topK ?? 25;
    const terms = [...new Set(queryTerms.map((t) => t.trim().toLowerCase()).filter(Boolean))];
    if (!docs.length || !terms.length) return [];

    const N = docs.length;
    let totalLen = 0;
    const df = new Map<string, number>();
    for (const d of docs) {
        totalLen += d.tokens.length;
        const seen = new Set(d.tf.keys());
        for (const t of seen) {
            df.set(t, (df.get(t) ?? 0) + 1);
        }
    }
    const avgdl = totalLen / N || 1;

    const idf = new Map<string, number>();
    for (const t of terms) {
        const n = df.get(t) ?? 0;
        idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
    }

    const scored: Bm25HitScore[] = [];
    for (const d of docs) {
        const dl = d.tokens.length || 1;
        let score = 0;
        for (const t of terms) {
            const f = d.tf.get(t) ?? 0;
            if (f === 0) continue;
            const idfT = idf.get(t) ?? 0;
            const denom = f + k1 * (1 - b + b * (dl / avgdl));
            score += idfT * ((f * (k1 + 1)) / denom);
        }
        if (score > 0) scored.push({ id: d.id, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(1, topK));
}
