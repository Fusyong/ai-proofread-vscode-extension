import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    alignmentJsonPath,
    generateHtmlReport,
    type AlignmentReportJson,
} from './alignmentReportGenerator';
import type { AlignmentItem } from './sentenceAligner';

const tempDirs: string[] = [];

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

function tempHtmlPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alignment-report-'));
    tempDirs.push(dir);
    return path.join(dir, '范蠡祠.alignment.html');
}

describe('alignment report json', () => {
    it('writes a sibling json and omits non-serializable options', () => {
        const htmlPath = tempHtmlPath();
        const items: AlignmentItem[] = [
            {
                type: 'match',
                a: '神精都会为之牵动。',
                b: '神经都会为之牵动。',
                a_index: 0,
                b_index: 0,
                similarity: 0.8,
                a_line_number: 2,
                b_line_number: 2,
            },
            { type: 'delete', a: '删掉的句子。', a_index: 1 },
        ];

        generateHtmlReport(items, htmlPath, '原文.md', '校对稿.md', {
            similarityThreshold: 0.6,
            windowSize: 10,
            jieba: { cut: () => [] } as never,
        }, 1.25);

        expect(fs.existsSync(htmlPath)).toBe(true);
        const jsonPath = alignmentJsonPath(htmlPath);
        expect(jsonPath).toBe(htmlPath.replace(/\.html$/i, '.json'));

        const report = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as AlignmentReportJson;
        expect(report.version).toBe(1);
        expect(report.titleA).toBe('原文.md');
        expect(report.titleB).toBe('校对稿.md');
        expect(report.runtime).toBe(1.25);
        expect(report.options).toEqual({ similarityThreshold: 0.6, windowSize: 10 });
        expect(report.options).not.toHaveProperty('jieba');
        expect(report.statistics).toEqual({
            total: 2,
            match: 1,
            delete: 1,
            insert: 0,
            movein: 0,
            moveout: 0,
        });
        expect(report.items).toEqual(items);
    });
});
