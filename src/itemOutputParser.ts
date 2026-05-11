/**
 * 条目式校对结果解析（仅 JSON）
 */

export interface ProofreadItem {
    original: string;
    corrected?: string;
    explanation?: string;
    /** 模型给出的置信度，0–1；缺省表示未标注（兼容旧输出） */
    confidence?: number;
    /** 本条 original 在对应切分段 target 内的 UTF-16 区间（程序写入，供 TreeView 定位 .json.md） */
    anchor?: { start: number; end: number };
}

/** 将 JSON 中的 confidence 字段规范为 0–1；无法识别时返回 undefined */
export function normalizeItemConfidence(raw: unknown): number | undefined {
    if (raw === null || raw === undefined) {
        return undefined;
    }
    if (typeof raw === 'number') {
        if (!Number.isFinite(raw)) {
            return undefined;
        }
        if (raw >= 0 && raw <= 1) {
            return raw;
        }
        if (raw > 1 && raw <= 100) {
            return Math.min(1, Math.max(0, raw / 100));
        }
        if (raw < 0) {
            return 0;
        }
        if (raw > 100) {
            return 1;
        }
        return undefined;
    }
    if (typeof raw === 'string') {
        const t = raw.trim();
        if (t === '') {
            return undefined;
        }
        const numPart = t.endsWith('%') ? t.slice(0, -1).trim() : t;
        const n = Number(numPart);
        if (!Number.isFinite(n)) {
            return undefined;
        }
        if (t.endsWith('%')) {
            return Math.min(1, Math.max(0, n / 100));
        }
        return normalizeItemConfidence(n);
    }
    return undefined;
}

/** 树视图等界面展示用（百分数） */
export function formatConfidencePercent(confidence: number | undefined): string | undefined {
    if (confidence === undefined || !Number.isFinite(confidence)) {
        return undefined;
    }
    const pct = Math.round(confidence * 100);
    return `${pct}%`;
}

/** 整块字符串正好是单个围栏（兼容旧正则行为） */
const JSON_CODE_BLOCK_RE = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/;

/** 文中的 ``` / ```json 围栏，匹配多个块以便在说明文字后仍可提取 */
const FENCED_BLOCK_G_RE = /```(?:json)?\s*([\s\S]*?)```/gi;

type RawProofreadItem = {
    original?: string;
    corrected?: string;
    explanation?: string;
    confidence?: unknown;
    anchor?: unknown;
};

function normalizeItemAnchor(raw: unknown): { start: number; end: number } | undefined {
    if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
        return undefined;
    }
    const o = raw as Record<string, unknown>;
    const start = o.start;
    const end = o.end;
    if (typeof start !== 'number' || typeof end !== 'number') {
        return undefined;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
        return undefined;
    }
    return { start, end };
}

function mapItemEntries(items: Array<RawProofreadItem | null | undefined>): ProofreadItem[] {
    return items
        .filter((x): x is RawProofreadItem => x != null && typeof x === 'object' && typeof x.original === 'string')
        .map((x) => {
            const confidence = normalizeItemConfidence(x.confidence);
            const anchor = normalizeItemAnchor(x.anchor);
            return {
                original: String(x.original),
                corrected: x.corrected != null ? String(x.corrected) : undefined,
                explanation: x.explanation != null && x.explanation !== '' ? String(x.explanation) : undefined,
                ...(confidence !== undefined ? { confidence } : {}),
                ...(anchor !== undefined ? { anchor } : {}),
            };
        });
}

/** 仅从合法 JSON 对象中读取 `items` 数组（必须存在且为数组） */
function itemsFromParsed(parsed: unknown): ProofreadItem[] | null {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
    }
    const o = parsed as Record<string, unknown>;
    if (!Array.isArray(o.items)) {
        return null;
    }
    return mapItemEntries(o.items as Array<RawProofreadItem | null | undefined>);
}

/**
 * 从首个 `{` 起截取匹配的 JSON 对象（字符串内括号不计入深度）
 */
function extractFirstBalancedJsonObject(s: string): string | null {
    const start = s.indexOf('{');
    if (start < 0) {
        return null;
    }
    let depth = 0;
    let inStr = false;
    let escape = false;
    for (let i = start; i < s.length; i++) {
        const c = s[i];
        if (inStr) {
            if (escape) {
                escape = false;
                continue;
            }
            if (c === '\\') {
                escape = true;
                continue;
            }
            if (c === '"') {
                inStr = false;
            }
            continue;
        }
        if (c === '"') {
            inStr = true;
            continue;
        }
        if (c === '{') {
            depth++;
        } else if (c === '}') {
            depth--;
            if (depth === 0) {
                return s.slice(start, i + 1);
            }
        }
    }
    return null;
}

function collectFenceInners(raw: string): string[] {
    const out: string[] = [];
    FENCED_BLOCK_G_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FENCED_BLOCK_G_RE.exec(raw)) !== null) {
        const inner = m[1].trim();
        if (inner.length > 0) {
            out.push(inner);
        }
    }
    return out;
}

function tryParseItemJson(str: string): ProofreadItem[] | null {
    const t = str.trim().replace(/^\uFEFF/, '');
    if (!t) {
        return null;
    }
    try {
        const parsed = JSON.parse(t) as unknown;
        return itemsFromParsed(parsed);
    } catch {
        return null;
    }
}

/**
 * 解析 LLM 返回的条目式 JSON 输出
 * @param raw 原始字符串（可能被 markdown 代码块包裹、前后可带说明）
 * @returns 条目数组，解析失败返回空数组
 */
export function parseItemOutput(raw: string): ProofreadItem[] {
    if (!raw || typeof raw !== 'string') {
        return [];
    }
    const str = raw.trim().replace(/^\uFEFF/, '');
    if (!str) {
        return [];
    }

    const candidates: string[] = [];
    const pushed = new Set<string>();
    const push = (s: string) => {
        const t = s.trim().replace(/^\uFEFF/, '');
        if (t.length === 0 || pushed.has(t)) {
            return;
        }
        pushed.add(t);
        candidates.push(t);
    };

    for (const inner of collectFenceInners(str)) {
        push(inner);
    }
    const wholeFence = str.match(JSON_CODE_BLOCK_RE);
    if (wholeFence) {
        push(wholeFence[1]);
    }
    push(str);
    const bald = extractFirstBalancedJsonObject(str);
    if (bald) {
        push(bald);
    }

    for (const c of candidates) {
        const parsed = tryParseItemJson(c);
        if (parsed !== null) {
            return parsed;
        }
        const sub = extractFirstBalancedJsonObject(c);
        if (sub && sub !== c) {
            const p2 = tryParseItemJson(sub);
            if (p2 !== null) {
                return p2;
            }
        }
    }

    return [];
}
