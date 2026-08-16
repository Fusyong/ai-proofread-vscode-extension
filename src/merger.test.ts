import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { mergeTwoFiles, mergeMarkdownIntoJson, unitStartsWithHeadingLevels } from './merger';

function writeTempJson(name: string, data: unknown): string {
    const filePath = path.join(os.tmpdir(), `ai-proofread-merger-${name}-${Date.now()}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return filePath;
}

function writeTempText(name: string, content: string): string {
    const filePath = path.join(os.tmpdir(), `ai-proofread-merger-${name}-${Date.now()}.md`);
    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
}

describe('unitStartsWithHeadingLevels', () => {
    it('detects ATX heading at start of target', () => {
        expect(unitStartsWithHeadingLevels({ target: '# 章名\n正文' }, [1])).toBe(true);
        expect(unitStartsWithHeadingLevels({ target: '## 节名\n正文' }, [1, 2])).toBe(true);
        expect(unitStartsWithHeadingLevels({ target: '### 小节' }, [1, 2])).toBe(false);
    });

    it('skips leading blank lines', () => {
        expect(unitStartsWithHeadingLevels({ target: '\n\n## 标题\n正文' }, [2])).toBe(true);
    });

    it('returns false when levels empty or target missing', () => {
        expect(unitStartsWithHeadingLevels({ target: '# 章' }, [])).toBe(false);
        expect(unitStartsWithHeadingLevels({ reference: '# 章' }, [1])).toBe(false);
        expect(unitStartsWithHeadingLevels(null, [1])).toBe(false);
    });
});

describe('mergeTwoFiles with ignoreHeadingLevels', () => {
    it('skips ignored heading units and maps remaining by order', async () => {
        const currentPath = writeTempJson('current', [
            { target: '# 第一章' },
            { target: '题目甲' },
            { target: '## 第二节' },
            { target: '题目乙' },
        ]);
        const sourcePath = writeTempJson('source', [
            { target: '答案甲' },
            { target: '答案乙' },
        ]);

        try {
            const result = await mergeTwoFiles(
                currentPath,
                sourcePath,
                'target',
                'target',
                'concat',
                [1, 2]
            );
            expect(result).toEqual({ updated: 2, total: 2, skipped: 2 });

            const merged = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
            expect(merged[0].target).toBe('# 第一章');
            expect(merged[1].target).toBe('题目甲\n\n答案甲');
            expect(merged[2].target).toBe('## 第二节');
            expect(merged[3].target).toBe('题目乙\n\n答案乙');
        } finally {
            fs.unlinkSync(currentPath);
            fs.unlinkSync(sourcePath);
        }
    });

    it('requires equal effective counts after ignore', async () => {
        const currentPath = writeTempJson('current-bad', [
            { target: '# 章' },
            { target: '题1' },
            { target: '题2' },
        ]);
        const sourcePath = writeTempJson('source-bad', [{ target: '答1' }]);

        try {
            await expect(
                mergeTwoFiles(currentPath, sourcePath, 'target', 'target', 'update', [1])
            ).rejects.toThrow(/有效单元数须相同/);
        } finally {
            fs.unlinkSync(currentPath);
            fs.unlinkSync(sourcePath);
        }
    });

    it('keeps index pairing when ignore list is empty', async () => {
        const currentPath = writeTempJson('current-plain', [
            { target: 'a' },
            { target: 'b' },
        ]);
        const sourcePath = writeTempJson('source-plain', [
            { target: 'A' },
            { target: 'B' },
        ]);

        try {
            const result = await mergeTwoFiles(
                currentPath,
                sourcePath,
                'reference',
                'target',
                'update',
                []
            );
            expect(result.skipped).toBe(0);
            const merged = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
            expect(merged[0].reference).toBe('A');
            expect(merged[1].reference).toBe('B');
        } finally {
            fs.unlinkSync(currentPath);
            fs.unlinkSync(sourcePath);
        }
    });
});

describe('mergeMarkdownIntoJson with ignoreHeadingLevels', () => {
    it('skips ignored heading units and writes the same markdown into the rest', async () => {
        const currentPath = writeTempJson('md-current', [
            { target: '# 第一章' },
            { target: '题目甲' },
            { target: '## 第二节' },
            { target: '题目乙' },
        ]);
        const mdPath = writeTempText('md-source', '统一规范说明');

        try {
            const result = await mergeMarkdownIntoJson(
                currentPath,
                mdPath,
                'reference',
                'update',
                [1, 2]
            );
            expect(result).toEqual({ updated: 2, total: 2, skipped: 2 });

            const merged = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
            expect(merged[0].reference).toBeUndefined();
            expect(merged[1].reference).toBe('统一规范说明');
            expect(merged[2].reference).toBeUndefined();
            expect(merged[3].reference).toBe('统一规范说明');
        } finally {
            fs.unlinkSync(currentPath);
            fs.unlinkSync(mdPath);
        }
    });
});
