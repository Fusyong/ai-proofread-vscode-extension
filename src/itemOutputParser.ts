/**
 * 条目式校对结果解析（仅 JSON）
 */

export interface ProofreadItem {
    original: string;
    corrected?: string;
    explanation?: string;
}

const JSON_CODE_BLOCK_RE = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/;

/**
 * 解析 LLM 返回的条目式 JSON 输出
 * @param raw 原始字符串（可能被 markdown 代码块包裹）
 * @returns 条目数组，解析失败返回空数组
 */
export function parseItemOutput(raw: string): ProofreadItem[] {
    if (!raw || typeof raw !== 'string') return [];
    let str = raw.trim();
    const codeBlockMatch = str.match(JSON_CODE_BLOCK_RE);
    if (codeBlockMatch) {
        str = codeBlockMatch[1].trim();
    }
    try {
        const parsed = JSON.parse(str) as { items?: Array<{ original?: string; corrected?: string; explanation?: string }> };
        if (!parsed || !Array.isArray(parsed.items)) return [];
        return parsed.items
            .filter((x): x is { original: string; corrected?: string; explanation?: string } =>
                x != null && typeof x.original === 'string')
            .map((x) => ({
                original: String(x.original),
                corrected: x.corrected != null ? String(x.corrected) : undefined,
                explanation: x.explanation != null && x.explanation !== '' ? String(x.explanation) : undefined,
            }));
    } catch {
        return [];
    }
}
