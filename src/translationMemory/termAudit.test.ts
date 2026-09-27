import { describe, expect, it } from 'vitest';
import {
    auditTranslationMemoryTerms,
    buildAvoidReplaceLines,
    buildTermAuditReport,
    formatTermAuditMarkdown,
} from './termAudit';
import { createEmptyActiveTm, normalizeTmTerm } from './schema';

describe('termAudit', () => {
    it('detects multi-target for same source', () => {
        const active = createEmptyActiveTm();
        active.terms.push(
            normalizeTmTerm({ source: 'Alice', target: '爱丽丝', status: 'approved', weight: 5 }),
            normalizeTmTerm({ source: 'Alice', target: '艾莉丝', status: 'candidate', weight: 1 })
        );
        const conflicts = auditTranslationMemoryTerms(active);
        expect(conflicts.some((c) => c.kind === 'multi_target')).toBe(true);
        expect(conflicts.some((c) => c.kind === 'candidate_vs_approved')).toBe(true);
    });

    it('builds avoid replace lines and markdown report', () => {
        const active = createEmptyActiveTm();
        active.terms.push(
            normalizeTmTerm({
                source: 'Cambridge',
                target: '剑桥',
                status: 'approved',
                avoid: ['坎布里奇'],
                weight: 10,
            })
        );
        expect(buildAvoidReplaceLines(active)).toEqual(['坎布里奇\t剑桥']);
        const report = buildTermAuditReport(active);
        const md = formatTermAuditMarkdown(report);
        expect(md).toContain('翻译术语审计报告');
        expect(md).toContain('辅助替换表');
    });
});
