/**
 * 术语冲突审计：同 source 多 target、candidate 与 approved 冲突、avoid 命中等。
 */

import type { ActiveTranslationMemory, ArchiveTranslationMemory, TmTerm } from './schema';
import { parseTranslateProcessOutput } from './bitextCodec';

export type TermConflictKind =
    | 'multi_target'
    | 'candidate_vs_approved'
    | 'avoid_hit'
    | 'process_vs_memory';

export type TermConflict = {
    kind: TermConflictKind;
    source: string;
    targets: string[];
    detail: string;
    statuses?: string[];
};

export type TermAuditReport = {
    generatedAt: string;
    conflictCount: number;
    conflicts: TermConflict[];
    termCount: number;
    candidateCount: number;
    approvedCount: number;
    /** avoid→target 辅助替换表行 */
    avoidReplaceLines: string[];
};

function groupActiveTerms(terms: TmTerm[]): Map<string, TmTerm[]> {
    const map = new Map<string, TmTerm[]>();
    for (const t of terms) {
        if (t.status === 'deprecated') {
            continue;
        }
        const key = t.source.trim();
        if (!key) {
            continue;
        }
        const list = map.get(key) ?? [];
        list.push(t);
        map.set(key, list);
    }
    return map;
}

/** 从活跃翻译记忆审计冲突 */
export function auditTranslationMemoryTerms(
    active: ActiveTranslationMemory,
    _archive?: ArchiveTranslationMemory
): TermConflict[] {
    const conflicts: TermConflict[] = [];
    const bySource = groupActiveTerms(active.terms);

    for (const [source, list] of bySource) {
        const targets = [...new Set(list.map((t) => t.target.trim()).filter(Boolean))];
        if (targets.length > 1) {
            conflicts.push({
                kind: 'multi_target',
                source,
                targets,
                statuses: list.map((t) => t.status),
                detail: `同一源语「${source}」对应 ${targets.length} 个译名：${targets.join(' / ')}`,
            });
        }
        const approved = list.filter((t) => t.status === 'approved');
        const candidates = list.filter((t) => t.status === 'candidate');
        if (approved.length && candidates.length) {
            const aTargets = [...new Set(approved.map((t) => t.target))];
            const cTargets = [...new Set(candidates.map((t) => t.target))];
            const diverge = cTargets.some((c) => !aTargets.includes(c));
            if (diverge) {
                conflicts.push({
                    kind: 'candidate_vs_approved',
                    source,
                    targets: [...aTargets, ...cTargets],
                    detail: `「${source}」已有 approved「${aTargets.join('/')}」，另有 candidate「${cTargets.join('/')}」`,
                });
            }
        }
        for (const t of list) {
            if (!t.avoid?.length) {
                continue;
            }
            for (const bad of t.avoid) {
                const b = bad.trim();
                if (!b) {
                    continue;
                }
                // 若其他条目把 avoid 词当作 target，标出
                const hitAsTarget = active.terms.filter(
                    (x) =>
                        x.status !== 'deprecated' &&
                        x.source === source &&
                        x.target.trim() === b
                );
                if (hitAsTarget.length || t.target.trim() === b) {
                    conflicts.push({
                        kind: 'avoid_hit',
                        source,
                        targets: [t.target, b],
                        detail: `「${source}」忌译「${b}」却出现在译名或同源条目中`,
                    });
                }
            }
        }
    }
    return conflicts;
}

/** 扫描过程输出中的术语，与记忆 approved 对照 */
export function auditProcessTermsAgainstMemory(
    processRawItems: (string | null)[],
    active: ActiveTranslationMemory
): TermConflict[] {
    const approvedMap = new Map<string, string>();
    for (const t of active.terms) {
        if (t.status === 'approved') {
            approvedMap.set(t.source.trim(), t.target.trim());
        }
    }
    const seen = new Map<string, Set<string>>();
    const conflicts: TermConflict[] = [];

    for (let i = 0; i < processRawItems.length; i++) {
        const raw = processRawItems[i];
        if (raw == null || typeof raw !== 'string' || !raw.trim()) {
            continue;
        }
        const parsed = parseTranslateProcessOutput(raw);
        for (const pair of parsed.terms) {
            const src = pair.source.trim();
            const tgt = pair.target.trim();
            if (!src || !tgt) {
                continue;
            }
            const set = seen.get(src) ?? new Set();
            set.add(tgt);
            seen.set(src, set);
            const mem = approvedMap.get(src);
            if (mem && mem !== tgt) {
                conflicts.push({
                    kind: 'process_vs_memory',
                    source: src,
                    targets: [mem, tgt],
                    detail: `单元 ${i + 1}：过程标「${src}→${tgt}」，记忆 approved 为「${mem}」`,
                });
            }
        }
    }

    for (const [source, set] of seen) {
        if (set.size > 1) {
            conflicts.push({
                kind: 'multi_target',
                source,
                targets: [...set],
                detail: `过程输出中「${source}」出现多种译法：${[...set].join(' / ')}`,
            });
        }
    }
    return conflicts;
}

/** 由 avoid[] → target 生成辅助替换表（旧忌译 → 规范译名） */
export function buildAvoidReplaceLines(active: ActiveTranslationMemory): string[] {
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const t of active.terms) {
        if (t.status !== 'approved' || !t.avoid?.length) {
            continue;
        }
        for (const bad of t.avoid) {
            const b = bad.trim();
            if (!b || b === t.target) {
                continue;
            }
            const key = `${b}=>${t.target}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            lines.push(`${b}\t${t.target}`);
        }
    }
    return lines.sort();
}

export function buildTermAuditReport(
    active: ActiveTranslationMemory,
    options?: {
        archive?: ArchiveTranslationMemory;
        processRawItems?: (string | null)[];
    }
): TermAuditReport {
    const memConflicts = auditTranslationMemoryTerms(active, options?.archive);
    const processConflicts = options?.processRawItems
        ? auditProcessTermsAgainstMemory(options.processRawItems, active)
        : [];
    // 去重 detail
    const all = [...memConflicts, ...processConflicts];
    const uniq: TermConflict[] = [];
    const seen = new Set<string>();
    for (const c of all) {
        const k = `${c.kind}|${c.source}|${c.targets.join('|')}|${c.detail}`;
        if (seen.has(k)) {
            continue;
        }
        seen.add(k);
        uniq.push(c);
    }
    const terms = active.terms.filter((t) => t.status !== 'deprecated');
    return {
        generatedAt: new Date().toISOString(),
        conflictCount: uniq.length,
        conflicts: uniq,
        termCount: terms.length,
        candidateCount: terms.filter((t) => t.status === 'candidate').length,
        approvedCount: terms.filter((t) => t.status === 'approved').length,
        avoidReplaceLines: buildAvoidReplaceLines(active),
    };
}

export function formatTermAuditMarkdown(report: TermAuditReport): string {
    const lines: string[] = [
        '# 翻译术语审计报告',
        '',
        `生成时间：${report.generatedAt}`,
        '',
        `- 术语条数（非 deprecated）：${report.termCount}`,
        `- approved：${report.approvedCount}`,
        `- candidate：${report.candidateCount}`,
        `- 冲突条数：${report.conflictCount}`,
        '',
    ];
    if (report.conflicts.length === 0) {
        lines.push('## 冲突', '', '未发现冲突。', '');
    } else {
        lines.push('## 冲突', '');
        const byKind = new Map<TermConflictKind, TermConflict[]>();
        for (const c of report.conflicts) {
            const list = byKind.get(c.kind) ?? [];
            list.push(c);
            byKind.set(c.kind, list);
        }
        const titles: Record<TermConflictKind, string> = {
            multi_target: '同源多译名',
            candidate_vs_approved: 'candidate 与 approved 不一致',
            avoid_hit: '忌译命中',
            process_vs_memory: '过程输出与记忆不一致',
        };
        for (const kind of Object.keys(titles) as TermConflictKind[]) {
            const list = byKind.get(kind);
            if (!list?.length) {
                continue;
            }
            lines.push(`### ${titles[kind]}`, '');
            for (const c of list) {
                lines.push(`- ${c.detail}`);
            }
            lines.push('');
        }
    }
    if (report.avoidReplaceLines.length) {
        lines.push('## 辅助替换表（忌译 → 规范译名）', '');
        lines.push('可导入自定义替换表（制表符分隔：查找\\t替换）：', '');
        lines.push('```');
        lines.push(...report.avoidReplaceLines);
        lines.push('```', '');
    }
    return lines.join('\n');
}
