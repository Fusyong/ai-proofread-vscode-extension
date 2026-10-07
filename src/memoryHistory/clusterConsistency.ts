/**
 * 记忆历史聚类一致性：相似 source 成簇，簇内多个不同 target → 冲突。
 * 并行与串行共用同一套算法（不按 origin 分叉；可过滤）。
 */

import { jaccardSimilarity, normalizeForSimilarity } from '../similarity';
import type { AlignmentKind } from '../promptAlignment';
import type { MemoryHistoryOrigin, MemoryHistoryRecord } from './types';

const NORM = { removeInnerWhitespace: true as const };

export type ClusterConflict = {
    kind: AlignmentKind;
    clusterKey: string;
    sources: string[];
    targets: string[];
    recordIds: string[];
    origins: MemoryHistoryOrigin[];
    detail: string;
};

export type ClusterConsistencyReport = {
    generatedAt: string;
    kind: AlignmentKind | 'both';
    recordCount: number;
    conflictCount: number;
    conflicts: ClusterConflict[];
};

export type ClusterOptions = {
    /** Jaccard 阈值：source 两两相似度 ≥ 此值则并入同簇 */
    similarityThreshold?: number;
    origins?: MemoryHistoryOrigin[];
    documentId?: string;
};

function normKey(text: string): string {
    return normalizeForSimilarity(text, NORM);
}

function filterRecords(records: MemoryHistoryRecord[], options?: ClusterOptions): MemoryHistoryRecord[] {
    let list = records;
    if (options?.origins?.length) {
        const set = new Set(options.origins);
        list = list.filter((r) => set.has(r.origin));
    }
    if (options?.documentId) {
        list = list.filter((r) => r.documentId === options.documentId);
    }
    return list;
}

/** 并查集聚类：精确归一化相等或 Jaccard ≥ 阈值 */
function clusterBySource(
    records: MemoryHistoryRecord[],
    threshold: number
): Map<number, MemoryHistoryRecord[]> {
    const n = records.length;
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (i: number): number => {
        if (parent[i] !== i) {
            parent[i] = find(parent[i]!);
        }
        return parent[i]!;
    };
    const union = (a: number, b: number): void => {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) {
            parent[rb] = ra;
        }
    };

    const keys = records.map((r) => normKey(r.source));
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            if (!keys[i] || !keys[j]) {
                continue;
            }
            if (keys[i] === keys[j]) {
                union(i, j);
                continue;
            }
            const sim = jaccardSimilarity(
                normalizeForSimilarity(records[i]!.source, NORM),
                normalizeForSimilarity(records[j]!.source, NORM)
            );
            if (sim >= threshold) {
                union(i, j);
            }
        }
    }

    const groups = new Map<number, MemoryHistoryRecord[]>();
    for (let i = 0; i < n; i++) {
        const root = find(i);
        const list = groups.get(root) ?? [];
        list.push(records[i]!);
        groups.set(root, list);
    }
    return groups;
}

function conflictsFromGroups(
    kind: AlignmentKind,
    groups: Map<number, MemoryHistoryRecord[]>
): ClusterConflict[] {
    const conflicts: ClusterConflict[] = [];
    for (const [, list] of groups) {
        const targets = [
            ...new Set(list.map((r) => normKey(r.target)).filter(Boolean)),
        ];
        if (targets.length <= 1) {
            continue;
        }
        const sources = [...new Set(list.map((r) => r.source.trim()).filter(Boolean))];
        const rawTargets = [...new Set(list.map((r) => r.target.trim()).filter(Boolean))];
        conflicts.push({
            kind,
            clusterKey: sources[0]?.slice(0, 40) ?? '',
            sources,
            targets: rawTargets,
            recordIds: list.map((r) => r.id),
            origins: [...new Set(list.map((r) => r.origin))],
            detail: `相似原文成簇后出现 ${rawTargets.length} 种不同结果`,
        });
    }
    return conflicts;
}

/** 优先按术语标记 source 精确成簇 */
function conflictsFromMarkers(kind: AlignmentKind, records: MemoryHistoryRecord[]): ClusterConflict[] {
    const byMarker = new Map<string, { targets: Set<string>; ids: string[]; origins: Set<MemoryHistoryOrigin>; sources: Set<string> }>();
    for (const r of records) {
        if (!r.markers?.length) {
            continue;
        }
        for (const m of r.markers) {
            const key = normKey(m.source);
            if (!key) {
                continue;
            }
            let g = byMarker.get(key);
            if (!g) {
                g = { targets: new Set(), ids: [], origins: new Set(), sources: new Set() };
                byMarker.set(key, g);
            }
            g.targets.add(m.target.trim());
            g.ids.push(r.id);
            g.origins.add(r.origin);
            g.sources.add(m.source.trim());
        }
    }
    const conflicts: ClusterConflict[] = [];
    for (const [, g] of byMarker) {
        if (g.targets.size <= 1) {
            continue;
        }
        conflicts.push({
            kind,
            clusterKey: [...g.sources][0]?.slice(0, 40) ?? '',
            sources: [...g.sources],
            targets: [...g.targets],
            recordIds: [...new Set(g.ids)],
            origins: [...g.origins],
            detail: `术语标记同源出现 ${g.targets.size} 种译法/改法`,
        });
    }
    return conflicts;
}

export function clusterMemoryHistory(
    kind: AlignmentKind,
    records: MemoryHistoryRecord[],
    options?: ClusterOptions
): ClusterConsistencyReport {
    const threshold = options?.similarityThreshold ?? 0.72;
    const filtered = filterRecords(records, options);
    const markerConflicts = kind === 'convert' ? conflictsFromMarkers(kind, filtered) : [];
    const groups = clusterBySource(filtered, threshold);
    const pairConflicts = conflictsFromGroups(kind, groups);
    // 合并：标记冲突优先展示，句对冲突去重粗略按 clusterKey
    const seen = new Set(markerConflicts.map((c) => c.clusterKey));
    const merged = [
        ...markerConflicts,
        ...pairConflicts.filter((c) => !seen.has(c.clusterKey)),
    ];
    return {
        generatedAt: new Date().toISOString(),
        kind,
        recordCount: filtered.length,
        conflictCount: merged.length,
        conflicts: merged,
    };
}

export function formatClusterReportMarkdown(report: ClusterConsistencyReport): string {
    const lines: string[] = [
        `# 记忆历史一致性报告`,
        ``,
        `- 生成时间：${report.generatedAt}`,
        `- 范围：${report.kind}`,
        `- 记录数：${report.recordCount}`,
        `- 冲突簇：${report.conflictCount}`,
        ``,
    ];
    if (!report.conflicts.length) {
        lines.push('未发现冲突。');
        return lines.join('\n');
    }
    let i = 1;
    for (const c of report.conflicts) {
        lines.push(`## ${i}. ${c.detail}`);
        lines.push(`- 对齐类：${c.kind}`);
        lines.push(`- 原文样例：${c.sources.slice(0, 3).join(' | ')}`);
        lines.push(`- 不同结果：`);
        for (const t of c.targets) {
            lines.push(`  - ${t}`);
        }
        lines.push(`- origin：${c.origins.join(', ')}`);
        lines.push('');
        i++;
    }
    return lines.join('\n');
}
