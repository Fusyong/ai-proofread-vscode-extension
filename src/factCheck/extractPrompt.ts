/**
 * 待核断言抽取：只出 JSON，不联网，不改稿。
 */

import {
    CATEGORY_LABEL,
    type FactCheckCategory,
    type FactCheckScope,
    isFactCheckCategory,
    scopeForCategory,
} from './schema';

const CATEGORY_LINES = (Object.keys(CATEGORY_LABEL) as FactCheckCategory[])
    .map((id) => `- ${id}：${CATEGORY_LABEL[id]}（${scopeForCategory(id) === 'key' ? '关键事实' : '一般问题'}）`)
    .join('\n');

export function buildFactCheckExtractSystemPrompt(scope: FactCheckScope): string {
    const scopeRule =
        scope === 'key'
            ? '本次只要关键事实：measure、date、named_attribute。不要输出史实判断、制度名物或其他宽泛问题。'
            : '本次先列关键事实（measure、date、named_attribute），再列一般问题（historical_judgment、institution、other）。';
    return `你是图书编辑的事实核查助手。只从给定段落中抽出值得人工或联网核对的断言，不要修改原文，不要回答段落里的问题，不要编造原文没有的事实。

分类：
${CATEGORY_LINES}

范围：
${scopeRule}

紧迫程度 urgency 为 0 到 1，表示「像是有错，或漏核会伤书」的把握，不是修改有多正确：
- 高（≥0.7）：数字或专名与常见说法冲突、同段自相矛盾、量级明显异常。
- 中（0.4–0.7）：看不出对错，但一旦错了后果大（宽度、年代、人数、专名属性）。
- 低（<0.4）：表述宽、很难有唯一答案。

query 是检索词：问属性（如「泉州大桥 桥宽」），不要把原文里可疑的数字、年份原样写进 query。
urgencyReason 用一句话说明为何要核，给人看。

只输出 JSON，不要 Markdown 围栏以外的说明：
{"claims":[{"span":"原文中的连续片段","category":"measure","urgency":0.8,"urgencyReason":"…","query":"…"}]}
没有可核断言时输出 {"claims":[]}。`;
}

export function buildFactCheckExtractUserPrompt(target: string, context: string): string {
    const ctx = context.trim();
    const parts = ['<target>', target, '</target>'];
    if (ctx && ctx !== target.trim()) {
        parts.unshift('<context>', ctx, '</context>', '');
    }
    return parts.join('\n');
}

export interface ParsedExtractClaim {
    span: string;
    category: FactCheckCategory;
    urgency: number;
    urgencyReason: string;
    query: string;
}

function clampUrgency(raw: unknown): number | undefined {
    if (typeof raw === 'number' && Number.isFinite(raw)) {
        if (raw >= 0 && raw <= 1) return raw;
        if (raw > 1 && raw <= 100) return Math.min(1, raw / 100);
        return undefined;
    }
    if (typeof raw === 'string' && raw.trim()) {
        const t = raw.trim();
        const n = Number(t.endsWith('%') ? t.slice(0, -1) : t);
        if (!Number.isFinite(n)) return undefined;
        return clampUrgency(t.endsWith('%') ? n / 100 : n);
    }
    return undefined;
}

/** 去掉 query 里复述的、且出现在 span 中的数字（含中文数字及紧随的常见单位） */
export function sanitizeSearchQuery(span: string, query: string): string {
    const numeral = /[0-9]+|[零〇一二三四五六七八九十百千万亿两]{2,}/g;
    const found = new Set<string>();
    let m: RegExpExecArray | null;
    const re = new RegExp(numeral.source, 'g');
    while ((m = re.exec(span)) !== null) {
        if (m[0]) found.add(m[0]);
    }
    if (/[0-9]/.test(span)) {
        const digits = span.match(/[0-9]+/g) ?? [];
        for (const d of digits) found.add(d);
    }
    let q = query.replace(/\s+/g, ' ').trim();
    const unit = '(?:米|公里|千米|厘米|毫米|里|丈|尺|寸|年|月|日|人|吨|斤|亩|度)?';
    for (const token of found) {
        const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        q = q.replace(new RegExp(escaped + unit, 'g'), ' ');
    }
    return q.replace(/\s+/g, ' ').trim();
}

export function parseFactCheckExtractOutput(raw: string, scope: FactCheckScope): ParsedExtractClaim[] {
    const text = unwrapJson(raw);
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return [];
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return [];
    }
    const claims = (parsed as { claims?: unknown }).claims;
    if (!Array.isArray(claims)) {
        return [];
    }
    const out: ParsedExtractClaim[] = [];
    for (const item of claims) {
        if (!item || typeof item !== 'object') continue;
        const o = item as Record<string, unknown>;
        const span = typeof o.span === 'string' ? o.span.trim() : '';
        const categoryRaw = typeof o.category === 'string' ? o.category.trim() : '';
        const urgency = clampUrgency(o.urgency);
        const urgencyReason = typeof o.urgencyReason === 'string' ? o.urgencyReason.trim() : '';
        const queryRaw = typeof o.query === 'string' ? o.query.trim() : '';
        if (!span || !isFactCheckCategory(categoryRaw) || urgency === undefined || !queryRaw) {
            continue;
        }
        const claimScope = scopeForCategory(categoryRaw);
        if (scope === 'key' && claimScope !== 'key') {
            continue;
        }
        const query = sanitizeSearchQuery(span, queryRaw);
        if (!query) continue;
        out.push({
            span,
            category: categoryRaw,
            urgency,
            urgencyReason,
            query,
        });
    }
    return out;
}

function unwrapJson(raw: string): string {
    const t = raw.trim();
    const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return fenced[1].trim();
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) return t.slice(start, end + 1);
    return t;
}
