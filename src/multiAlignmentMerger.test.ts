import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AlignmentReportJson } from './alignmentReportGenerator';
import type { AlignmentItem } from './sentenceAligner';
import {
    addAlignmentReport,
    classifyRow,
    mergeAlignmentReports,
    reclassifyTable,
    tableFromReport,
    type MultiAlignmentSource,
} from './multiAlignmentMerger';
import {
    formatMultiAlignmentCsv,
    generateMultiAlignmentReport,
} from './multiAlignmentReportGenerator';

const tempDirs: string[] = [];

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

function reportOf(items: AlignmentItem[], title = 't'): AlignmentReportJson {
    return {
        version: 1,
        titleA: `${title}.md`,
        titleB: `${title}.proofread.md`,
        runtime: 0,
        options: {},
        statistics: {
            total: items.length,
            match: items.filter(i => i.type === 'match').length,
            delete: items.filter(i => i.type === 'delete').length,
            insert: items.filter(i => i.type === 'insert').length,
            movein: 0,
            moveout: 0,
        },
        items,
    };
}

function source(id: string, label: string): MultiAlignmentSource {
    return {
        id,
        label,
        path: `${label}.alignment.json`,
        titleA: 'a.md',
        titleB: 'b.md',
    };
}

describe('classifyRow', () => {
    it('detects all_identical, runs_consensus, divergent, structural', () => {
        const ids = ['r0', 'r1'];
        expect(
            classifyRow(
                {
                    a: '你好。',
                    cells: [
                        { sourceId: 'r0', b: '你好。' },
                        { sourceId: 'r1', b: '你好。' },
                    ],
                },
                ids
            ).class
        ).toBe('all_identical');

        expect(
            classifyRow(
                {
                    a: '你好。',
                    cells: [
                        { sourceId: 'r0', b: '您好。' },
                        { sourceId: 'r1', b: '您好。' },
                    ],
                },
                ids
            ).class
        ).toBe('runs_consensus');

        expect(
            classifyRow(
                {
                    a: '你好。',
                    cells: [
                        { sourceId: 'r0', b: '您好。' },
                        { sourceId: 'r1', b: '嗨。' },
                    ],
                },
                ids
            ).class
        ).toBe('divergent');

        expect(
            classifyRow(
                {
                    a: '你好。',
                    cells: [{ sourceId: 'r0', b: '您好。' }],
                },
                ids
            ).class
        ).toBe('structural');
    });

    it('detects majority with three runs', () => {
        const ids = ['a', 'b', 'c'];
        const r = classifyRow(
            {
                a: '原文。',
                cells: [
                    { sourceId: 'a', b: '改A。' },
                    { sourceId: 'b', b: '改A。' },
                    { sourceId: 'c', b: '改B。' },
                ],
            },
            ids
        );
        expect(r.class).toBe('majority');
    });

    it('recomputes when hiding a run', () => {
        const table = {
            sources: [source('a', 'A'), source('b', 'B'), source('c', 'C')],
            rows: [
                {
                    a: '原文。',
                    cells: [
                        { sourceId: 'a', b: '改A。' },
                        { sourceId: 'b', b: '改A。' },
                        { sourceId: 'c', b: '改B。' },
                    ],
                    class: 'majority' as const,
                    sourceChange: 0.5,
                    runAgreement: 0.5,
                },
            ],
        };
        const onlyAB = reclassifyTable(table, ['a', 'b']);
        expect(onlyAB.rows[0].class).toBe('runs_consensus');
    });
});

describe('mergeAlignmentReports', () => {
    it('merges 1:1 matching a sequences', () => {
        const r0 = reportOf([
            { type: 'match', a: '第一句。', b: '第一句改。', similarity: 0.9 },
            { type: 'match', a: '第二句。', b: '第二句。', similarity: 1 },
        ]);
        const r1 = reportOf([
            { type: 'match', a: '第一句。', b: '第一句另改。', similarity: 0.85 },
            { type: 'match', a: '第二句。', b: '第二句。', similarity: 1 },
        ]);
        const table = mergeAlignmentReports(
            [
                { report: r0, source: source('r0', 'run0') },
                { report: r1, source: source('r1', 'run1') },
            ],
            { similarityThreshold: 0.4, ngramSize: 2, ngramGranularity: 'char' }
        );
        expect(table.sources).toHaveLength(2);
        expect(table.rows.length).toBeGreaterThanOrEqual(2);
        const row0 = table.rows.find(r => r.a.includes('第一句'));
        expect(row0).toBeTruthy();
        expect(row0!.cells.find(c => c.sourceId === 'r0')?.b).toContain('第一句改');
        expect(row0!.cells.find(c => c.sourceId === 'r1')?.b).toContain('第一句另改');
    });

    it('handles merge/split on a side (n:1 and 1:n)', () => {
        const r0 = reportOf([
            {
                type: 'match',
                a: '上半句，下半句。',
                b: '合并校对甲。',
                a_indices: [0, 1],
                similarity: 0.8,
            },
            { type: 'match', a: '第三句。', b: '第三句甲。', similarity: 0.9 },
        ]);
        const r1 = reportOf([
            { type: 'match', a: '上半句，', b: '上半乙。', similarity: 0.7 },
            { type: 'match', a: '下半句。', b: '下半乙。', similarity: 0.7 },
            { type: 'match', a: '第三句。', b: '第三句乙。', similarity: 0.9 },
        ]);
        const table = mergeAlignmentReports(
            [
                { report: r0, source: source('r0', 'merged') },
                { report: r1, source: source('r1', 'split') },
            ],
            { similarityThreshold: 0.35, ngramSize: 2, ngramGranularity: 'char' }
        );
        expect(table.rows.length).toBeGreaterThanOrEqual(2);
        const third = table.rows.find(r => (r.a || '').includes('第三句'));
        expect(third).toBeTruthy();
        expect(third!.cells.find(c => c.sourceId === 'r0')?.b).toContain('第三句甲');
        expect(third!.cells.find(c => c.sourceId === 'r1')?.b).toContain('第三句乙');
    });

    it('keeps insert-only rows and marks structural when a column is missing', () => {
        const r0 = reportOf([
            { type: 'match', a: '有原文。', b: '有原文甲。' },
            { type: 'insert', b: '仅甲新增。' },
        ]);
        const r1 = reportOf([{ type: 'match', a: '有原文。', b: '有原文乙。' }]);
        const table = mergeAlignmentReports(
            [
                { report: r0, source: source('r0', 'withInsert') },
                { report: r1, source: source('r1', 'plain') },
            ],
            { similarityThreshold: 0.4, ngramSize: 2, ngramGranularity: 'char' }
        );
        const insertRow = table.rows.find(r =>
            r.cells.some(c => c.sourceId === 'r0' && (c.b || '').includes('仅甲新增'))
        );
        expect(insertRow).toBeTruthy();
        expect(insertRow!.class).toBe('structural');
    });

    it('addAlignmentReport is progressive', () => {
        const r0 = reportOf([{ type: 'match', a: '一句。', b: '一句甲。' }]);
        const r1 = reportOf([{ type: 'match', a: '一句。', b: '一句乙。' }]);
        const r2 = reportOf([{ type: 'match', a: '一句。', b: '一句丙。' }]);
        let table = tableFromReport(r0, source('r0', 'A'));
        table = addAlignmentReport(table, r1, source('r1', 'B'), {
            similarityThreshold: 0.4,
            ngramGranularity: 'char',
        });
        table = addAlignmentReport(table, r2, source('r2', 'C'), {
            similarityThreshold: 0.4,
            ngramGranularity: 'char',
        });
        expect(table.sources).toHaveLength(3);
        expect(table.rows[0].cells).toHaveLength(3);
        expect(table.rows[0].cells.map(c => c.b)).toEqual(['一句甲。', '一句乙。', '一句丙。']);
        expect(table.rows[0].class).toBe('divergent');
    });
});

describe('multiAlignmentReportGenerator', () => {
    it('writes html, json and csv', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-align-'));
        tempDirs.push(dir);
        const table = mergeAlignmentReports(
            [
                {
                    report: reportOf([{ type: 'match', a: '甲。', b: '甲改。' }]),
                    source: source('r0', 'run0'),
                },
                {
                    report: reportOf([{ type: 'match', a: '甲。', b: '甲改。' }]),
                    source: source('r1', 'run1'),
                },
            ],
            { similarityThreshold: 0.4, ngramGranularity: 'char' }
        );
        const htmlPath = path.join(dir, 'multi-alignment.html');
        const out = generateMultiAlignmentReport(table, htmlPath, 0.5);
        expect(fs.existsSync(out.htmlPath)).toBe(true);
        expect(fs.existsSync(out.jsonPath)).toBe(true);
        expect(fs.existsSync(out.csvPath)).toBe(true);
        const html = fs.readFileSync(out.htmlPath, 'utf8');
        expect(html).toContain('vsSource');
        expect(html).toContain('vsAdjacent');
        expect(html).toContain('>相邻<');
        expect(html).toContain('indexFilter');
        expect(html).toContain('all_identical: false');
        expect(html).not.toContain('hideIdentical');
        expect(html).toContain('run-visible');
        const csv = formatMultiAlignmentCsv(table);
        expect(csv.split('\n')[0]).toContain('b_run0');
        expect(csv).toContain('甲');
    });
});

describe('smoke: test/align-JSON', () => {
    const root = path.join(__dirname, '..', 'test', 'align-JSON');

    it('merges four real alignment json files when present', () => {
        if (!fs.existsSync(root)) {
            return;
        }
        const files: string[] = [];
        for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
            if (!ent.isDirectory()) {
                continue;
            }
            const dir = path.join(root, ent.name);
            for (const name of fs.readdirSync(dir)) {
                if (/\.alignment\.json$/i.test(name)) {
                    files.push(path.join(dir, name));
                }
            }
        }
        if (files.length < 2) {
            return;
        }
        files.sort((a, b) => a.localeCompare(b, 'zh'));
        const take = files.slice(0, Math.min(4, files.length));
        const bundles = take.map((p, i) => {
            const report = JSON.parse(fs.readFileSync(p, 'utf8')) as AlignmentReportJson;
            return {
                report,
                source: source(`run${i}`, path.basename(path.dirname(p))),
            };
        });
        const itemCounts = bundles.map(b => b.report.items.length);
        const table = mergeAlignmentReports(bundles, {
            similarityThreshold: 0.4,
            ngramSize: 2,
            ngramGranularity: 'char',
            removeInnerWhitespace: true,
        });
        const minItems = Math.min(...itemCounts);
        const maxItems = Math.max(...itemCounts);
        expect(table.sources).toHaveLength(take.length);
        expect(table.rows.length).toBeGreaterThanOrEqual(Math.floor(minItems * 0.5));
        expect(table.rows.length).toBeLessThanOrEqual(maxItems * 2 + 50);

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-align-smoke-'));
        tempDirs.push(dir);
        const { htmlPath, jsonPath } = generateMultiAlignmentReport(
            table,
            path.join(dir, 'multi-alignment.html'),
            1
        );
        const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        expect(parsed.version).toBe(1);
        expect(parsed.rows).toHaveLength(table.rows.length);
        expect(fs.readFileSync(htmlPath, 'utf8').length).toBeGreaterThan(1000);
    }, 120_000);
});
