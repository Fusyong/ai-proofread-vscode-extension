import type { ResolvedLocalDictConfigItem } from './dictConfig';
import type { LookupMode } from './mdictClient';

export interface DictPrepLookupPoint {
    pointId: string;
    dictId: string | null;
    candidates: string[];
    mode: LookupMode;
    why?: string;
}

export interface DictPrepPlan {
    lookups: DictPrepLookupPoint[];
}

export function buildDictPrepSystemPrompt(): string {
    return [
        '你是一位严谨的“本地词典检索规划器”。',
        '用户会提供一段目标文本（target）以及若干本本地词典清单（dicts）。',
        '你的任务是：从 target 中识别出“值得查询以便校对/理解/统一术语”的点，并为每个点选择要查询的词典与查询词候选。',
        '',
        '重要约束：',
        '1) 你必须只输出 JSON，不要输出任何解释、markdown 或其他文字。',
        '2) 输出 JSON 结构必须为：{"lookups":[...]}。',
        '3) lookups 中每个元素必须包含：pointId, dictId, candidates, mode。',
        '4) dictId 必须从给定 dicts 的 id 字段中选择；如果无法判断，dictId 填 null。',
        '5) candidates 必须是长度 2 到 3 的字符串数组，按优先级从高到低排序；第一个候选应尽量最可能命中词典词条。',
        '6) mode 必须为 "exact"（只做精确匹配，不做 prefix/fuzzy）。',
        '7) candidates 中不包含空字符串，不要包含引号包裹的多余符号。',
        '8) 只列出真正有价值的查询点，宁缺毋滥。',
        '',
        '建议：候选词可以给出简繁变体、常见异体/同形不同写法、去除括号/书名号/标点后的形式等。',
    ].join('\n');
}

export function buildDictPrepUserPrompt(params: {
    target: string;
    dicts: ResolvedLocalDictConfigItem[];
    maxPoints: number;
}): string {
    const { target, dicts, maxPoints } = params;
    const dictLines = dicts
        .map((d) => {
            const tags = (d.tags ?? []).slice(0, 6).join(', ');
            const whenToUse = (d.whenToUse ?? '').replace(/\s+/g, ' ').trim();
            return `- id=${d.id}; name=${d.name}; tags=[${tags}]; priority=${d.priority ?? 100}; whenToUse=${whenToUse}`;
        })
        .join('\n');

    return [
        `最大查询点数量（maxPoints）=${maxPoints}`,
        '',
        'dicts（词典清单）如下：',
        dictLines || '(空)',
        '',
        '<target>',
        target,
        '</target>',
    ].join('\n');
}

export function parseDictPrepPlan(raw: string): DictPrepPlan {
    const jsonText = extractJsonObject(raw);
    const obj = JSON.parse(jsonText);
    const lookupsRaw = Array.isArray(obj?.lookups) ? obj.lookups : [];
    const lookups: DictPrepLookupPoint[] = [];
    for (let i = 0; i < lookupsRaw.length; i++) {
        const x = lookupsRaw[i];
        const pointId = typeof x?.pointId === 'string' ? x.pointId : `p-${i + 1}`;
        const dictId = typeof x?.dictId === 'string' ? x.dictId : null;
        const mode: LookupMode = 'exact';
        const candidates: string[] = Array.isArray(x?.candidates)
            ? x.candidates.map((s: any) => (typeof s === 'string' ? s.trim() : '')).filter((s: string) => !!s)
            : [];
        const why = typeof x?.why === 'string' ? x.why : undefined;
        if (candidates.length === 0) continue;
        lookups.push({
            pointId,
            dictId,
            candidates: candidates.slice(0, 3),
            mode,
            why,
        });
    }
    return { lookups };
}

function extractJsonObject(raw: string): string {
    const s = (raw ?? '').trim();
    if (!s) throw new Error('LLM 返回为空');
    // 常见情况：LLM 输出前后夹杂文字，这里取第一个 {...} 大对象
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
        throw new Error('LLM 返回中未找到 JSON 对象');
    }
    return s.slice(start, end + 1);
}

