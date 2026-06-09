import type { CorpusHit } from '../schema';

export function buildRerankSystemPrompt(includeReason: boolean): string {
    const reasonRule = includeReason
        ? '每项 decision 必须含 reason（简短中文）。'
        : 'reason 可省略。';
    return [
        '你是参考资料相关性精排助手。根据 target 与候选摘录，决定保留或丢弃。',
        '只输出 JSON：{"decisions":[{"refTag":string,"action":"keep"|"drop","score":0~1,"reason"?:string}],"mergeGroups":[{"keep":string,"drop":string[],"reason"?:string}]}',
        reasonRule,
        'navigation_hint（仅标题/目录）通常 drop；语义重复的在 mergeGroups 中合并。',
    ].join('\n');
}

export function buildRerankUserPrompt(target: string, hits: CorpusHit[]): string {
    const lines = hits.map((h) => {
        const tag = h.refTag ?? h.hitId;
        const meta = [
            `source=${h.source}`,
            `score=${(h.finalScore ?? h.aggregatedValue).toFixed(2)}`,
            h.headingPath ? `heading=${h.headingPath}` : '',
            h.kind ? `kind=${h.kind}` : '',
        ]
            .filter(Boolean)
            .join(' ');
        return `[${tag}] ${meta}\n${h.snippet.slice(0, 400)}`;
    });
    return ['<target>', target.slice(0, 1500), '</target>', '', 'candidates:', ...lines].join('\n');
}

export interface RerankDecision {
    refTag: string;
    action: 'keep' | 'drop';
    score?: number;
    reason?: string;
}

export interface RerankMergeGroup {
    keep: string;
    drop: string[];
    reason?: string;
}

export interface RerankResult {
    decisions: RerankDecision[];
    mergeGroups: RerankMergeGroup[];
}

export function parseRerankResult(raw: string): RerankResult {
    const s = raw.trim();
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start === -1 || end <= start) return { decisions: [], mergeGroups: [] };
    const obj = JSON.parse(s.slice(start, end + 1));
    const decisions = Array.isArray(obj.decisions)
        ? obj.decisions
              .filter((d: unknown) => d && typeof d === 'object')
              .map((d: { refTag?: string; action?: string; score?: number; reason?: string }) => ({
                  refTag: String(d.refTag ?? ''),
                  action: d.action === 'drop' ? 'drop' as const : 'keep' as const,
                  score: typeof d.score === 'number' ? d.score : undefined,
                  reason: typeof d.reason === 'string' ? d.reason : undefined,
              }))
              .filter((d: RerankDecision) => d.refTag)
        : [];
    const mergeGroups = Array.isArray(obj.mergeGroups)
        ? obj.mergeGroups
              .filter((g: unknown) => g && typeof g === 'object')
              .map((g: { keep?: string; drop?: string[]; reason?: string }) => ({
                  keep: String(g.keep ?? ''),
                  drop: Array.isArray(g.drop) ? g.drop.map(String) : [],
                  reason: typeof g.reason === 'string' ? g.reason : undefined,
              }))
              .filter((g: RerankMergeGroup) => g.keep)
        : [];
    return { decisions, mergeGroups };
}
