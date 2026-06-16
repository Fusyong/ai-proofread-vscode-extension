import type { CorpusHit } from '../schema';
import { getScoringWeights } from '../config';
import { unitKey } from '../grep/unitExpander';

function tokenizeForMatch(text: string): string[] {
    const t = text.toLowerCase();
    const words: string[] = [];
    const cn = t.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
    words.push(...cn);
    const en = t.match(/[a-z]{3,}/g) ?? [];
    words.push(...en);
    return [...new Set(words)];
}

function scopeMatchScore(target: string, hit: CorpusHit): number {
    const tokens = tokenizeForMatch(target);
    if (tokens.length === 0) return 0;
    const hay = `${hit.relPath ?? ''} ${hit.headingPath ?? ''} ${hit.pageTitle ?? ''} ${hit.snippet}`.toLowerCase();
    let matched = 0;
    for (const tok of tokens) {
        if (hay.includes(tok)) matched++;
    }
    return matched / tokens.length;
}

function hitGroupKey(h: CorpusHit): string {
    if (h.source === 'wikipedia') {
        return h.pageUrl ?? h.digest;
    }
    return h.relPath ?? h.file ?? '';
}

function normalizeChannelScore(hit: CorpusHit): number {
    if (hit.bm25Score != null) return Math.min(1, hit.bm25Score / 10);
    if (hit.vectorScore != null) return Math.min(1, hit.vectorScore);
    if (hit.source === 'grep_md') return hit.baseValue;
    if (hit.source === 'wikipedia') return hit.baseValue;
    return hit.baseValue;
}

export function computeFinalScore(hit: CorpusHit, target: string, patternCount = 1, fileHitCount = 1): number {
    const w = getScoringWeights();
    const llm = hit.llmPriority ?? hit.baseValue;
    const channel = normalizeChannelScore(hit);
    const cooc = Math.min(1, patternCount / 4);
    const scope = scopeMatchScore(target, hit);
    const cluster = Math.min(0.3, (fileHitCount - 1) * 0.05);
    let penalty = 0;
    if (hit.kind === 'navigation_hint') penalty += 0.4;
    if (hit.snippet.trim().length < 20) penalty += 0.15;
    const raw =
        w.llmPriority * llm +
        w.channelScore * channel +
        w.cooccurrence * cooc +
        w.scopeMatch * scope +
        w.clusterBoost * cluster -
        penalty;
    return Math.max(0, Math.min(1, raw));
}

export function scoreAndSortHits(hits: CorpusHit[], target: string): CorpusHit[] {
    const unitPatterns = new Map<string, number>();
    const fileCounts = new Map<string, number>();
    for (const h of hits) {
        const key =
            h.source === 'wikipedia'
                ? `wiki:${h.pageUrl ?? h.digest}`
                : unitKey(h.relPath ?? h.file ?? '', h.startLine ?? h.line ?? 0, h.endLine ?? h.line ?? 0);
        unitPatterns.set(key, (unitPatterns.get(key) ?? 0) + (h.grepPatterns?.length ?? 1));
        const f = hitGroupKey(h);
        fileCounts.set(f, (fileCounts.get(f) ?? 0) + 1);
    }
    for (const h of hits) {
        const key =
            h.source === 'wikipedia'
                ? `wiki:${h.pageUrl ?? h.digest}`
                : unitKey(h.relPath ?? h.file ?? '', h.startLine ?? h.line ?? 0, h.endLine ?? h.line ?? 0);
        h.finalScore = computeFinalScore(
            h,
            target,
            unitPatterns.get(key) ?? 1,
            fileCounts.get(hitGroupKey(h)) ?? 1
        );
        h.aggregatedValue = h.finalScore;
    }
    return [...hits].sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0));
}

export function textOverlapRatio(a: string, b: string): number {
    const sa = new Set(a.replace(/\s+/g, ''));
    const sb = new Set(b.replace(/\s+/g, ''));
    if (sa.size === 0 || sb.size === 0) return 0;
    let inter = 0;
    for (const c of sa) {
        if (sb.has(c)) inter++;
    }
    return inter / Math.max(sa.size, sb.size);
}

export function dedupeHitsByOverlap(hits: CorpusHit[], threshold = 0.85): CorpusHit[] {
    const kept: CorpusHit[] = [];
    for (const h of hits) {
        const dup = kept.find(
            (k) =>
                k.digest === h.digest ||
                (k.source === 'wikipedia' && h.source === 'wikipedia' && k.pageUrl === h.pageUrl) ||
                ((k.relPath ?? k.file) === (h.relPath ?? h.file) &&
                    (k.relPath ?? k.file) !== '' &&
                    textOverlapRatio(k.snippet, h.snippet) >= threshold)
        );
        if (!dup) {
            kept.push(h);
        } else if ((h.finalScore ?? 0) > (dup.finalScore ?? 0)) {
            const idx = kept.indexOf(dup);
            kept[idx] = h;
        }
    }
    return kept;
}

export function capHitsPerFile(hits: CorpusHit[], maxPerFile = 5): CorpusHit[] {
    const counts = new Map<string, number>();
    const out: CorpusHit[] = [];
    for (const h of hits) {
        const f = hitGroupKey(h);
        const n = counts.get(f) ?? 0;
        if (f && n >= maxPerFile) continue;
        counts.set(f, n + 1);
        out.push(h);
    }
    return out;
}
