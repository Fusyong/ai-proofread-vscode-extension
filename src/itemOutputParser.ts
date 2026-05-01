/**
 * 条目式校对结果解析（仅 JSON）
 */

export interface ProofreadItem {
    original: string;
    corrected?: string;
    explanation?: string;
}

/** 整块字符串正好是单个围栏（兼容旧正则行为） */
const JSON_CODE_BLOCK_RE = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/;

/** 文中的 ``` / ```json 围栏，匹配多个块以便在说明文字后仍可提取 */
const FENCED_BLOCK_G_RE = /```(?:json)?\s*([\s\S]*?)```/gi;

function mapItemEntries(
    items: Array<{ original?: string; corrected?: string; explanation?: string } | null | undefined>
): ProofreadItem[] {
    return items
        .filter((x): x is { original: string; corrected?: string; explanation?: string } =>
            x != null && typeof x === 'object' && typeof x.original === 'string')
        .map((x) => ({
            original: String(x.original),
            corrected: x.corrected != null ? String(x.corrected) : undefined,
            explanation: x.explanation != null && x.explanation !== '' ? String(x.explanation) : undefined,
        }));
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
    return mapItemEntries(
        o.items as Array<{ original?: string; corrected?: string; explanation?: string } | null | undefined>
    );
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
