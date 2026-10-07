import { describe, expect, it } from 'vitest';
import { clusterMemoryHistory } from './clusterConsistency';
import type { MemoryHistoryRecord } from './types';

function rec(
    partial: Partial<MemoryHistoryRecord> & Pick<MemoryHistoryRecord, 'source' | 'target'>
): MemoryHistoryRecord {
    return {
        id: partial.id ?? `id_${Math.random().toString(36).slice(2, 8)}`,
        createdAt: partial.createdAt ?? new Date().toISOString(),
        kind: partial.kind ?? 'edit',
        source: partial.source,
        target: partial.target,
        origin: partial.origin ?? 'selection_accept',
        markers: partial.markers,
    };
}

describe('clusterMemoryHistory', () => {
    it('flags conflicting edit targets for similar sources', () => {
        const records = [
            rec({ source: '他走了过来', target: '他走了过去', origin: 'parallel_apply' }),
            rec({ source: '他走了过来', target: '他走过来了', origin: 'serial_segment' }),
            rec({ source: '完全无关的一句', target: '完全无关的一句改', origin: 'selection_accept' }),
        ];
        const report = clusterMemoryHistory('edit', records, { similarityThreshold: 0.5 });
        expect(report.conflictCount).toBeGreaterThanOrEqual(1);
        const hit = report.conflicts.find((c) => c.sources.some((s) => s.includes('走了过来')));
        expect(hit).toBeTruthy();
        expect(hit!.targets.length).toBeGreaterThanOrEqual(2);
    });

    it('flags convert marker multi-target', () => {
        const records = [
            rec({
                kind: 'convert',
                source: 'Alice went home.',
                target: '爱丽丝回家了。',
                origin: 'tm_merge',
                markers: [{ source: 'Alice', target: '爱丽丝' }],
            }),
            rec({
                kind: 'convert',
                source: 'Alice smiled.',
                target: '艾丽斯笑了。',
                origin: 'serial_segment',
                markers: [{ source: 'Alice', target: '艾丽斯' }],
            }),
        ];
        const report = clusterMemoryHistory('convert', records);
        expect(report.conflictCount).toBeGreaterThanOrEqual(1);
        expect(report.conflicts[0]!.targets).toEqual(expect.arrayContaining(['爱丽丝', '艾丽斯']));
    });
});
