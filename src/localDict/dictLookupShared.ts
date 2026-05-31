import { createHash } from 'crypto';
import { convertOpencc } from '../opencc';
import type { ResolvedLocalDictConfigItem } from './dictConfig';
import type { LookupMode } from './mdictClient';

/** 超过此长度视为长选区：不宜整段 exact 查词（与知识核查中 LLM 规划词条一致） */
export const MAX_DIRECT_DICT_LOOKUP_CHARS = 32;

export function sanitizeLookupTerm(term: string): string {
    const s = String(term ?? '').trim();
    if (!s) return s;
    return s
        .replace(/([\p{Script=Han}])\s+/gu, '$1')
        .replace(/\s+([\p{Script=Han}])/gu, '$1');
}

/** 短选区直接查；长选区抽取 2–8 字中文词供用户选择 */
export function extractLookupCandidates(raw: string): string[] {
    const sanitized = sanitizeLookupTerm(raw);
    if (!sanitized) return [];
    if (sanitized.length <= MAX_DIRECT_DICT_LOOKUP_CHARS) {
        return [sanitized];
    }
    const seen = new Set<string>();
    const out: string[] = [];
    const re = /\p{Script=Han}{2,8}/gu;
    for (const m of raw.matchAll(re)) {
        const w = sanitizeLookupTerm(m[0]);
        if (!w || w.length < 2 || seen.has(w)) continue;
        seen.add(w);
        out.push(w);
    }
    return out;
}

export function buildOpenccAltTerms(term: string): string[] {
    const base = sanitizeLookupTerm(term);
    if (!base) return [];
    const t2cn = convertOpencc(base, 't', 'cn');
    const cn2t = convertOpencc(base, 'cn', 't');
    const out: string[] = [];
    const push = (x: string) => {
        const s = sanitizeLookupTerm(x);
        if (!s || s === base || out.includes(s)) return;
        out.push(s);
    };
    push(t2cn);
    push(cn2t);
    return out;
}

export function limitCleanText(s: string, maxChars: number): string {
    const text = String(s ?? '');
    if (!text || !maxChars || maxChars <= 0 || text.length <= maxChars) return text;
    return text.slice(0, maxChars) + '\n\n[...已截断...]';
}

export function digestSha1(text: string): string {
    return createHash('sha1').update(text).digest('hex').slice(0, 12);
}

export function buildLocalDictEntryBeginTag(sha1Digest: string): string {
    return `<!-- ai-proofread:localDictEntry begin sha1=${sha1Digest} -->`;
}

export function buildLocalDictEntryEndTag(): string {
    return `<!-- ai-proofread:localDictEntry end -->`;
}

function escapeAttr(s: string): string {
    return s.replace(/-->/g, '--\\>');
}

export function buildDedupKeyLegacy(dictId: string, term: string, mode: LookupMode): string {
    const t = (term ?? '').trim().replace(/\s+/g, ' ');
    return `<!-- ai-proofread:dictref dictId=${dictId} mode=${mode} term=${escapeAttr(t)} -->`;
}

export function formatDictReferenceBlock(hit: {
    dictName: string;
    matchedKey: string;
    definition: string;
    digest: string;
}): string {
    const begin = buildLocalDictEntryBeginTag(hit.digest);
    const header = `【本地词典】${hit.dictName}｜${hit.matchedKey}`;
    return [begin, header, '', hit.definition, buildLocalDictEntryEndTag()].join('\n');
}

export function formatGrepReferenceBlock(hit: {
    file: string;
    line: number;
    snippet: string;
    digest: string;
}): string {
    const begin = `<!-- ai-proofread:grepHit begin sha1=${hit.digest} -->`;
    const header = `【文献摘录】${hit.file}:${hit.line}`;
    return [begin, header, '', hit.snippet, '<!-- ai-proofread:grepHit end -->'].join('\n');
}

export function buildDictTryList(
    dicts: ResolvedLocalDictConfigItem[],
    preferredDictId: string | null,
    defaultDictId?: string
): ResolvedLocalDictConfigItem[] {
    if (dicts.length === 0) return [];
    const byPriority = [...dicts].sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    const picked: ResolvedLocalDictConfigItem[] = [];
    const seen = new Set<string>();
    const pushById = (id?: string | null) => {
        if (!id) return;
        const d = dicts.find((x) => x.id === id);
        if (!d || seen.has(d.id)) return;
        picked.push(d);
        seen.add(d.id);
    };
    pushById(preferredDictId);
    pushById(defaultDictId ?? null);
    for (const d of byPriority) {
        if (!seen.has(d.id)) {
            picked.push(d);
            seen.add(d.id);
        }
    }
    return picked;
}
