import type { ResolvedLocalDictConfigItem } from '../localDict/dictConfig';
import type { ReferencePrepIntent, ReferencePrepPlan, ReferenceSourceId } from './schema';
import type { CorpusHit } from './schema';

export function buildReferencePrepSystemPrompt(params: {
    enabledSources: ReferenceSourceId[];
    disabledSources: ReferenceSourceId[];
    maxQueries: number;
    intents: ReferencePrepIntent[];
}): string {
    const srcLines = params.enabledSources.map((s) => '- enabled: ' + s).join('\n');
    const disLines = params.disabledSources.map((s) => '- disabled: ' + s).join('\n');
    const intentList = params.intents.join(', ');
    return [
        '你是一位资深的文字编辑，负责为书稿核查准备参考资料。用户给出 target 文本、已检索到的 corpus 摘要，以及可用/禁用的资料来源。',
        '',
        '输出要求（严格遵守）：',
        '1) 只输出 JSON，无 markdown、无解释。',
        '2) 顶层：{"sufficient":boolean,"queries":[...],"prune":[...]}',
        '3) queries 长度不超过 ' + params.maxQueries + '；sufficient 为 true 时表示资料已够，本轮 queries 可为空数组。',
        '4) 每个 query 含：queryId, intent, priority(0~1), 以及按来源填写的 dict 或 grep 块（勿写 source 字段）。',
        '5) intent 必须是以下之一：' + intentList,
        '6) dict 块：dictId（从 dicts 选，不确定用 null）, candidates(1~3 个词条), 可选 why。',
        '7) grep 块：patterns(1~4 个关键词/短语), 可选 contextLines(默认 2)。',
        '8) prune：列出应丢弃的 hitId（与 corpus 摘要对应）。',
        '',
        '规则：',
        '- 只为当前无法确定、查资料可能有明确收益的信息建 query；宁缺毋滥。',
        '- disabled 来源禁止为其生成 query。',
        '- enabled 含 dict 时可为专名/术语填 dict；含 grep_md 时可填文献检索 patterns。',
        '- 词条不要带书名号；patterns 宜短、可命中参考文献。',
    ].join('\n');
}

export function buildReferencePrepUserPrompt(params: {
    target: string;
    dicts: ResolvedLocalDictConfigItem[];
    corpusSummary: string;
    roundIndex: number;
    maxRounds: number;
}): string {
    const dictLines = params.dicts
        .map((d) => {
            const tags = (d.tags ?? []).slice(0, 6).join(', ');
            const whenToUse = (d.whenToUse ?? '').replace(/\s+/g, ' ').trim();
            return '- id=' + d.id + '; name=' + d.name + '; tags=[' + tags + ']; whenToUse=' + whenToUse;
        })
        .join('\n');

    return [
        'round=' + (params.roundIndex + 1) + '/' + params.maxRounds,
        '',
        'dicts:',
        dictLines || '(空)',
        '',
        'corpus_summary:',
        params.corpusSummary || '(尚无)',
        '',
        '<target>',
        params.target,
        '</target>',
    ].join('\n');
}

export function buildCorpusSummary(corpus: CorpusHit[], maxItems = 24): string {
    const active = corpus.filter((h) => h.status === 'active').slice(0, maxItems);
    if (active.length === 0) return '';
    return active
        .map(
            (h) =>
                'hitId=' +
                    h.hitId +
                    ' source=' +
                    h.source +
                    ' value=' +
                    h.aggregatedValue.toFixed(2) +
                    ' digest=' +
                    h.digest +
                    ' snippet=' +
                    h.snippet.slice(0, 120).replace(/\s+/g, ' ')
        )
        .join('\n');
}

function extractJsonObject(raw: string): string {
    const s = (raw ?? '').trim();
    if (!s) throw new Error('LLM 返回为空');
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
        throw new Error('LLM 返回中未找到 JSON 对象');
    }
    return s.slice(start, end + 1);
}

const INTENTS: ReferencePrepIntent[] = [
    'entity_name',
    'term_norm',
    'citation',
    'general_fact',
    'word_usage',
];

export function parseReferencePrepPlan(raw: string, allowedIntents: ReferencePrepIntent[]): ReferencePrepPlan {
    const obj = JSON.parse(extractJsonObject(raw));
    const sufficient = obj?.sufficient === true;
    const queriesRaw = Array.isArray(obj?.queries) ? obj.queries : [];
    const queries = [];
    for (let i = 0; i < queriesRaw.length; i++) {
        const x = queriesRaw[i];
        const intentRaw = typeof x?.intent === 'string' ? x.intent : 'general_fact';
        const intent = allowedIntents.includes(intentRaw as ReferencePrepIntent)
            ? (intentRaw as ReferencePrepIntent)
            : 'general_fact';
        const priority =
            typeof x?.priority === 'number' && Number.isFinite(x.priority)
                ? Math.min(1, Math.max(0, x.priority))
                : 0.7;
        const queryId = typeof x?.queryId === 'string' ? x.queryId : 'q-' + (i + 1);
        const q: (typeof queries)[0] = { queryId, intent, priority };
        if (x?.dict && typeof x.dict === 'object') {
            const candidates = Array.isArray(x.dict.candidates)
                ? x.dict.candidates.map((s: unknown) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean)
                : [];
            if (candidates.length > 0) {
                q.dict = {
                    dictId: typeof x.dict.dictId === 'string' ? x.dict.dictId : null,
                    candidates: candidates.slice(0, 3),
                    why: typeof x.dict.why === 'string' ? x.dict.why : undefined,
                };
            }
        }
        if (x?.grep && typeof x.grep === 'object') {
            const patterns = Array.isArray(x.grep.patterns)
                ? x.grep.patterns.map((s: unknown) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean)
                : [];
            if (patterns.length > 0) {
                q.grep = {
                    patterns: patterns.slice(0, 4),
                    contextLines:
                        typeof x.grep.contextLines === 'number' ? Math.max(0, Math.min(10, x.grep.contextLines)) : 2,
                };
            }
        }
        if (q.dict || q.grep) {
            queries.push(q);
        }
    }
    const pruneRaw = Array.isArray(obj?.prune) ? obj.prune : [];
    const prune = pruneRaw
        .filter((p: unknown) => p && typeof p === 'object' && typeof (p as { hitId?: string }).hitId === 'string')
        .map((p: { hitId: string; reason?: string }) => ({
            hitId: p.hitId,
            reason: typeof p.reason === 'string' ? p.reason : undefined,
        }));
    return { sufficient, queries, prune };
}

/** 从 target 兜底提取 grep pattern 候选 */
export function extractFallbackGrepPatterns(target: string): string[] {
    const out: string[] = [];
    const push = (s: string) => {
        const t = s.trim();
        if (t.length < 2 || t.length > 40 || out.includes(t)) return;
        out.push(t);
    };
    const quoteRe = /[「『]([^」』]{2,40})[」』]|[“‘]([^"']{2,40})[”’]/g;
    let m: RegExpExecArray | null;
    while ((m = quoteRe.exec(target)) !== null) {
        push(m[1] || m[2] || '');
    }
    const bookRe = /《([^》]{2,30})》/g;
    while ((m = bookRe.exec(target)) !== null) {
        push(m[1]);
    }
    return out.slice(0, 4);
}
