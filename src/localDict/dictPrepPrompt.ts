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
        '你是“本地词典检索规划器”。给定目标文本 target 和词典清单 dicts，请规划哪些点值得查词典，以辅助后续流程更准确地校对目标文本。',
        '',
        '输出要求（严格遵守）：',
        '1) 只输出 JSON（无解释、无 markdown、无多余文字）。',
        '2) 顶层结构固定为：{"lookups":[...]}。',
        '3) lookups 为数组，长度不超过用户给定的 maxPoints；可为空数组。',
        '4) lookups 每个元素包含：pointId, dictId, candidates；可选 why。',
        '',
        '字段约束：',
        '- pointId: 字符串；同一输出内尽量唯一。',
        '- dictId: 必须从 dicts 的 id 中选择；无法判断时用 null。',
        '- candidates: 字符串数组，长度 1~3，按优先级从高到低；每个词条应尽量可直接命中词典条目。',
        '- why: （可选）不超过 30 字，说明“为何值得查”。',
        '',
        '选择哪些点：',
        '- 只选**当前无法确定正误，但查词典很可能带来明确校对收益**的信息群组，这样的信息群组通常与特定的重要的人名、地名、机构名、术语、作品名等专名相关联。',
        '- 不要为常识性、语法性、纯风格性问题创建查询点；宁缺毋滥。',
        '',
        '候选词生成规则：',
        '- 候选词不要带书名号、引号等包裹符号；汉字之间不要留空格；两侧不要有多余标点。',
        '- 优先给出**最常见、最高频**的核心词（例如“李白”），再给 1~2 个作为后补的变体（如“李太白”）。',
        '- 不要在候选词里写解释或括注；同名多义的词语也不用额外处理，后续检索会返回全部匹配。',
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

