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
        '你将充当为文稿校对流程服务的严谨的“本地词典检索规划器”。',
        '用户会提供一段需要校对的目标文本（target）以及若干本地mdx电子词典的清单（dicts）。',
        '你的任务是：从 target 中识别出“无法确定正误、有必要且有可能查询词典后进行更准确校对”的信息群组（如与特定人名、地名、机构名、术语等专有名词相关的信息），并为每一组这样的信息选择一组要查询的候选词语（candidates）。',
        '',
        '重要约束：',
        '1) 你必须只输出 JSON，不要输出任何解释、markdown 或其他文字。',
        '2) 输出 JSON 结构必须为：{"lookups":[...]}。',
        '3) lookups 中每个元素必须包含：pointId, dictId, candidates。',
        '4) dictId 必须从给定 dicts 的 id 字段中选择；如果无法判断，dictId 填 null。',
        '5) 一个 candidates 必须是长度 1 到 3 的字符串数组（对应一个信息群组，如关于李白的生平信息），按优先级从高到低排序；第一个候选词语应尽量是最高频、常见的词语（如“李白”），附加修饰限定成分的长词语可能无法命中词条（如“诗仙李白”），过短则可能不准确（如“白”），要长、短词语搭配（如"李白","李太白","诗仙"）；指向多个实体的同名词语无须担心，无须括注任何内容，后续会查出所有同名条目。',
        '6) candidates 中的词语，不要包含引号包裹的多余符号；汉字词语中间不要包含空格；词语两侧不要包含书名号、引号。',
        '7) 只关注那些确确实实“无法确定正误、有必要且有可能查询词典后进行更准确校对”的信息群组，**宁缺毋滥！**',
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

