import * as vscode from 'vscode';
import type { ParseBitextResult } from './bitextCodec';
import { loadTranslationMemory, saveTranslationMemory } from './persist';
import {
    createEmptyActiveTm,
    createEmptyArchiveTm,
    evictTermsToArchive,
    formatExampleLine,
    formatRecentRounds,
    formatTermLine,
    newTmId,
    normalizeTmExample,
    normalizeTmTerm,
    type ActiveTranslationMemory,
    type TmTerm,
} from './schema';

const INJECT_TERMS_MAX = 4_000;
const INJECT_EXAMPLES_MAX = 6_000;

function clip(s: string, max: number): string {
    const t = s.trim();
    if (t.length <= max) {
        return t;
    }
    return t.slice(0, max) + '…';
}

function readTmConfig() {
    const c = vscode.workspace.getConfiguration('ai-proofread');
    return {
        termsActiveMax: c.get<number>('translationMemory.termsActiveMax', 80),
        recentRoundsMax: c.get<number>('translationMemory.recentRoundsMax', 3),
        termsTopN: c.get<number>('translationMemory.injectTermsTopN', 20),
    };
}

function termHitsUnit(term: TmTerm, unit: string): boolean {
    if (!unit.includes(term.source)) {
        return false;
    }
    return true;
}

/** 注入翻译记忆 XML（拼在 preText） */
export function buildTranslationMemoryXml(anchorUri: vscode.Uri, targetUnit: string): string {
    const { active } = loadTranslationMemory(anchorUri);
    const cfg = readTmConfig();
    const approved = active.terms.filter((t) => t.status === 'approved');
    const hit = approved.filter((t) => termHitsUnit(t, targetUnit));
    const rest = approved
        .filter((t) => !hit.includes(t))
        .sort((a, b) => b.weight - a.weight)
        .slice(0, Math.max(0, cfg.termsTopN - hit.length));
    const terms = [...hit, ...rest].slice(0, cfg.termsTopN);
    const termBlock = clip(terms.map(formatTermLine).join('\n'), INJECT_TERMS_MAX);

    const approvedEx = active.examples.filter((e) => e.status === 'approved').sort((a, b) => b.weight - a.weight);
    const recent = formatRecentRounds(active.recentRounds.slice(0, cfg.recentRoundsMax));
    const exLines = [...approvedEx.slice(0, 8).map(formatExampleLine), recent].filter(Boolean).join('\n');
    const exBlock = clip(exLines, INJECT_EXAMPLES_MAX);

    let out = '';
    if (termBlock) {
        out += `\n<translation_memory_terms>\n${termBlock}\n</translation_memory_terms>`;
    }
    if (exBlock.trim()) {
        out += `\n<translation_memory_examples>\n${exBlock.trim()}\n</translation_memory_examples>`;
    }
    return out;
}

export interface MergeTranslateMemoryArgs {
    documentUri: vscode.Uri;
    /** 接受后的最终译文（清理后） */
    finalTranslation: string;
    parsed: ParseBitextResult;
    /** 选段接受：术语/译例直接 approved；批译用 candidate */
    approve: boolean;
}

/** 从过程解析结果合并进翻译记忆 */
export function mergeTranslationMemoryFromParsed(args: MergeTranslateMemoryArgs): void {
    const { documentUri, parsed, approve } = args;
    const status = approve ? 'approved' : 'candidate';
    const cfg = readTmConfig();
    let { active, archive } = loadTranslationMemory(documentUri);
    const now = new Date().toISOString();

    for (const pair of parsed.terms) {
        const src = pair.source.trim();
        const tgt = pair.target.trim();
        if (!src || !tgt) {
            continue;
        }
        const existing = active.terms.find((t) => t.source === src && t.status !== 'deprecated');
        if (existing) {
            if (existing.target === tgt) {
                existing.weight = Math.min(1000, existing.weight + 3);
                existing.updatedAt = now;
                if (approve && existing.status === 'candidate') {
                    existing.status = 'approved';
                }
            } else if (approve) {
                existing.status = 'deprecated';
                existing.updatedAt = now;
                active.terms.push(
                    normalizeTmTerm({
                        source: src,
                        target: tgt,
                        status: 'approved',
                        weight: Math.max(5, existing.weight),
                        category: existing.category,
                    })
                );
            } else {
                active.terms.push(
                    normalizeTmTerm({
                        source: src,
                        target: tgt,
                        status: 'candidate',
                        weight: 1,
                        category: 'term',
                    })
                );
            }
        } else {
            active.terms.push(
                normalizeTmTerm({
                    source: src,
                    target: tgt,
                    status,
                    weight: 5,
                    category: 'term',
                })
            );
        }
    }

    for (const ex of parsed.keyExamples) {
        if (!ex.source.trim() || !ex.target.trim()) {
            continue;
        }
        const dup = active.examples.find(
            (e) => e.source === ex.source.trim() && e.target === ex.target.trim() && e.status !== 'deprecated'
        );
        if (dup) {
            dup.weight = Math.min(1000, dup.weight + 2);
            dup.updatedAt = now;
            if (approve && dup.status === 'candidate') {
                dup.status = 'approved';
            }
        } else {
            active.examples.push(
                normalizeTmExample({
                    source: ex.source.trim(),
                    target: ex.target.trim(),
                    note: ex.note,
                    status,
                    weight: 5,
                })
            );
        }
    }

    if (parsed.keyExamples.length > 0 || parsed.terms.length > 0) {
        const bodyLines = [
            ...parsed.terms.slice(0, 12).map((t) => `${t.source} → ${t.target}`),
            ...parsed.keyExamples.slice(0, 4).map((e) => `${e.source} ::: ${e.target}`),
        ];
        if (bodyLines.length > 0) {
            active.recentRounds.unshift({
                id: newTmId('round'),
                createdAt: now,
                body: bodyLines.join('\n'),
            });
            if (active.recentRounds.length > cfg.recentRoundsMax) {
                active.recentRounds = active.recentRounds.slice(0, cfg.recentRoundsMax);
            }
        }
    }

    evictTermsToArchive(active, archive, cfg.termsActiveMax);
    saveTranslationMemory(documentUri, active, archive);
}

export function clearTranslationMemory(anchorUri: vscode.Uri): void {
    saveTranslationMemory(anchorUri, createEmptyActiveTm(), createEmptyArchiveTm());
}

/** 批准全部 candidate 术语与关键译例 */
export function approveAllCandidates(anchorUri: vscode.Uri): number {
    const { active, archive } = loadTranslationMemory(anchorUri);
    let n = 0;
    const now = new Date().toISOString();
    for (const t of active.terms) {
        if (t.status === 'candidate') {
            t.status = 'approved';
            t.updatedAt = now;
            n++;
        }
    }
    for (const e of active.examples) {
        if (e.status === 'candidate') {
            e.status = 'approved';
            e.updatedAt = now;
            n++;
        }
    }
    saveTranslationMemory(anchorUri, active, archive);
    return n;
}

export type { ActiveTranslationMemory };
