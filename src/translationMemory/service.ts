import * as vscode from 'vscode';
import type { ParseBitextResult } from './bitextCodec';
import { appendUnitToBitextIndex, buildSimilarBitextXml, clearBitextIndex } from './bitextIndex';
import {
    clipInjectText,
    buildDirectionHintXml,
    readTranslateInjectConfig,
} from './injectConfig';
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

function termHitsUnit(term: TmTerm, unit: string): boolean {
    if (!unit.includes(term.source)) {
        return false;
    }
    return true;
}

/** 注入翻译记忆 XML（拼在 preText）；含可选相似句侧车 */
export function buildTranslationMemoryXml(anchorUri: vscode.Uri, targetUnit: string): string {
    const cfg = readTranslateInjectConfig();
    const { active } = loadTranslationMemory(anchorUri);
    const approved = active.terms.filter((t) => t.status === 'approved');
    const hit = approved.filter((t) => termHitsUnit(t, targetUnit));
    const rest = approved
        .filter((t) => !hit.includes(t))
        .sort((a, b) => b.weight - a.weight)
        .slice(0, Math.max(0, cfg.termsTopN - hit.length));
    const terms = [...hit, ...rest].slice(0, cfg.termsTopN);
    const termBlock = clipInjectText(terms.map(formatTermLine).join('\n'), cfg.injectTermsMaxChars);

    const approvedEx = active.examples.filter((e) => e.status === 'approved').sort((a, b) => b.weight - a.weight);
    const recent = formatRecentRounds(active.recentRounds.slice(0, cfg.recentRoundsMax));
    const exLines = [...approvedEx.slice(0, 8).map(formatExampleLine), recent].filter(Boolean).join('\n');
    const exBlock = clipInjectText(exLines, cfg.injectExamplesMaxChars);

    let out = buildDirectionHintXml(cfg);
    if (termBlock) {
        out += `\n<translation_memory_terms>\n${termBlock}\n</translation_memory_terms>`;
    }
    if (exBlock.trim()) {
        out += `\n<translation_memory_examples>\n${exBlock.trim()}\n</translation_memory_examples>`;
    }
    const similar = buildSimilarBitextXml(anchorUri, targetUnit, {
        topK: cfg.similarTopK,
        threshold: cfg.similarThreshold,
        maxChars: cfg.injectSimilarMaxChars,
    });
    if (similar) {
        out += similar;
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
    /** 写入句对侧车用的源单元；默认用 parsed.sourcePlain */
    sourceUnit?: string;
}

/** 从过程解析结果合并进翻译记忆，并派生句对侧车 */
export function mergeTranslationMemoryFromParsed(args: MergeTranslateMemoryArgs): void {
    const { documentUri, parsed, approve, finalTranslation } = args;
    const status = approve ? 'approved' : 'candidate';
    const cfg = readTranslateInjectConfig();
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

    const sourceUnit = (args.sourceUnit ?? parsed.sourcePlain ?? '').trim();
    const targetUnit = (finalTranslation || parsed.targetPlain || '').trim();
    if (sourceUnit && targetUnit) {
        try {
            appendUnitToBitextIndex(documentUri, sourceUnit, targetUnit);
        } catch {
            /* 侧车失败不影响记忆 */
        }
    }
}

export function clearTranslationMemory(anchorUri: vscode.Uri): void {
    saveTranslationMemory(anchorUri, createEmptyActiveTm(), createEmptyArchiveTm());
    try {
        clearBitextIndex(anchorUri);
    } catch {
        /* ignore */
    }
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
