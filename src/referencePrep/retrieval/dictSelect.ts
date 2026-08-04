import type { ReferencePrepRunControls } from '../runControls';

export type DictEntryPick = {
    dictId: string;
    dictName: string;
    matchedKey: string;
    cleaned: string;
    digest: string;
    block: string;
    relevance: number;
};

/** 首选词典配额 + 后备相关性加选 + 后备长度加选 */
export function selectDictEntries(
    entries: DictEntryPick[],
    preferredDictId: string | null,
    controls: Pick<
        ReferencePrepRunControls,
        'maxEntriesPrimary' | 'maxEntriesRelevance' | 'maxEntriesLength'
    >
): DictEntryPick[] {
    if (entries.length === 0) return [];
    const selected: DictEntryPick[] = [];
    const used = new Set<string>();

    const primary = entries
        .filter((e) => preferredDictId && e.dictId === preferredDictId)
        .sort((a, b) => b.cleaned.length - a.cleaned.length);
    for (const e of primary.slice(0, controls.maxEntriesPrimary)) {
        used.add(e.digest);
        selected.push(e);
    }

    const rest = entries.filter((e) => !used.has(e.digest));
    const byRel = [...rest].sort((a, b) => b.relevance - a.relevance || b.cleaned.length - a.cleaned.length);
    let added = 0;
    for (const e of byRel) {
        if (added >= controls.maxEntriesRelevance) break;
        used.add(e.digest);
        selected.push(e);
        added++;
    }

    const rest2 = entries.filter((e) => !used.has(e.digest));
    const byLen = [...rest2].sort((a, b) => b.cleaned.length - a.cleaned.length);
    added = 0;
    for (const e of byLen) {
        if (added >= controls.maxEntriesLength) break;
        used.add(e.digest);
        selected.push(e);
        added++;
    }

    return selected;
}

export function relevanceToTarget(
    target: string,
    matchedKey: string,
    cleaned: string,
    candidates: string[]
): number {
    const hay = `${matchedKey}\n${cleaned.slice(0, 800)}`.toLowerCase();
    const tokens = new Set<string>();
    for (const c of candidates) {
        const t = c.trim().toLowerCase();
        if (t.length >= 1) tokens.add(t);
    }
    const tgt = target.toLowerCase();
    const cn = tgt.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
    for (const w of cn.slice(0, 12)) tokens.add(w);
    const en = tgt.match(/[a-z]{3,}/g) ?? [];
    for (const w of en.slice(0, 8)) tokens.add(w);
    if (tokens.size === 0) return 0;
    let matched = 0;
    for (const tok of tokens) {
        if (hay.includes(tok)) matched++;
    }
    const keyBonus = candidates.some((c) => matchedKey.includes(c) || c.includes(matchedKey)) ? 0.25 : 0;
    return Math.min(1, matched / tokens.size + keyBonus);
}
