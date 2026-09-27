/**
 * 翻译记忆 schema（术语 + 句级关键译例 + recentRounds）
 */

export type TmStatus = 'candidate' | 'approved' | 'deprecated';
export type TmTermCategory = 'person' | 'place' | 'org' | 'term' | 'other';

export interface TmTerm {
    id: string;
    source: string;
    target: string;
    aliases: string[];
    avoid: string[];
    category: TmTermCategory;
    status: TmStatus;
    weight: number;
    exampleSource?: string;
    exampleTarget?: string;
    note?: string;
    createdAt: string;
    updatedAt: string;
}

export interface TmExample {
    id: string;
    source: string;
    target: string;
    status: TmStatus;
    weight: number;
    note?: string;
    createdAt: string;
    updatedAt: string;
}

export interface TmRecentRound {
    id: string;
    createdAt: string;
    body: string;
}

export interface ActiveTranslationMemory {
    version: 1;
    terms: TmTerm[];
    examples: TmExample[];
    recentRounds: TmRecentRound[];
}

export interface ArchiveTranslationMemory {
    version: 1;
    terms: TmTerm[];
    examples: TmExample[];
}

export function createEmptyActiveTm(): ActiveTranslationMemory {
    return { version: 1, terms: [], examples: [], recentRounds: [] };
}

export function createEmptyArchiveTm(): ArchiveTranslationMemory {
    return { version: 1, terms: [], examples: [] };
}

export function newTmId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function clampWeight(w: number): number {
    return Math.max(0, Math.min(1000, Math.floor(Number(w) || 0)));
}

export function normalizeTmTerm(partial: Partial<TmTerm> & Pick<TmTerm, 'source' | 'target'>): TmTerm {
    const now = new Date().toISOString();
    const cat = partial.category;
    const category: TmTermCategory =
        cat === 'person' || cat === 'place' || cat === 'org' || cat === 'term' || cat === 'other' ? cat : 'term';
    const st = partial.status;
    const status: TmStatus =
        st === 'candidate' || st === 'approved' || st === 'deprecated' ? st : 'candidate';
    return {
        id: partial.id?.trim() ? partial.id.trim() : newTmId('tm_term'),
        source: String(partial.source ?? '').trim(),
        target: String(partial.target ?? '').trim(),
        aliases: Array.isArray(partial.aliases) ? partial.aliases.map(String) : [],
        avoid: Array.isArray(partial.avoid) ? partial.avoid.map(String) : [],
        category,
        status,
        weight: clampWeight(partial.weight ?? 0),
        exampleSource: partial.exampleSource?.trim() || undefined,
        exampleTarget: partial.exampleTarget?.trim() || undefined,
        note: partial.note?.trim() || undefined,
        createdAt: partial.createdAt?.trim() || now,
        updatedAt: partial.updatedAt?.trim() || now,
    };
}

export function normalizeTmExample(partial: Partial<TmExample> & Pick<TmExample, 'source' | 'target'>): TmExample {
    const now = new Date().toISOString();
    const st = partial.status;
    const status: TmStatus =
        st === 'candidate' || st === 'approved' || st === 'deprecated' ? st : 'candidate';
    return {
        id: partial.id?.trim() ? partial.id.trim() : newTmId('tm_ex'),
        source: String(partial.source ?? '').trim(),
        target: String(partial.target ?? '').trim(),
        status,
        weight: clampWeight(partial.weight ?? 0),
        note: partial.note?.trim() || undefined,
        createdAt: partial.createdAt?.trim() || now,
        updatedAt: partial.updatedAt?.trim() || now,
    };
}

export function formatTermLine(t: TmTerm): string {
    const bits = [`${t.source} → ${t.target}`, `w=${t.weight}`, t.category];
    if (t.aliases.length) {
        bits.push(`aliases=${t.aliases.join('|')}`);
    }
    if (t.avoid.length) {
        bits.push(`avoid=${t.avoid.join('|')}`);
    }
    if (t.note) {
        bits.push(t.note);
    }
    return bits.join(' · ');
}

export function formatExampleLine(e: TmExample): string {
    let line = `${e.source} ::: ${e.target}`;
    if (e.note) {
        line += ` · ${e.note}`;
    }
    return line;
}

export function formatRecentRounds(rounds: TmRecentRound[]): string {
    return rounds.map((r, i) => `[#${i + 1} ${r.createdAt}]\n${r.body}`).join('\n\n');
}

/** 超员时低 weight 术语移入 archive */
export function evictTermsToArchive(
    active: ActiveTranslationMemory,
    archive: ArchiveTranslationMemory,
    cap: number
): void {
    if (active.terms.length <= cap) {
        return;
    }
    const indexed = active.terms.map((e, i) => ({ e, i }));
    indexed.sort((a, b) => {
        if (a.e.weight !== b.e.weight) {
            return a.e.weight - b.e.weight;
        }
        return a.i - b.i;
    });
    const keep = new Set(
        indexed
            .slice(indexed.length - cap)
            .map((x) => x.e.id)
    );
    const next: TmTerm[] = [];
    for (const t of active.terms) {
        if (keep.has(t.id)) {
            next.push(t);
        } else {
            archive.terms.unshift({ ...t, id: newTmId('tm_arch_term') });
        }
    }
    active.terms = next;
}
