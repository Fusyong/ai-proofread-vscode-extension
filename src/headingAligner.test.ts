import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import {
    alignHeadings,
    diagnoseHeadingMismatch,
    extractLeadingSerial,
    extractMdHeadings,
    headingsEqual,
    isOnlyLeadingSerial,
    normalizeHeadingText,
    parseHeadingLevels,
} from './headingAligner';

describe('parseHeadingLevels', () => {
    it('parses half-width and full-width commas', () => {
        expect(parseHeadingLevels('1，2，4')).toEqual({ levels: [1, 2, 4] });
        expect(parseHeadingLevels('1,2,4')).toEqual({ levels: [1, 2, 4] });
        expect(parseHeadingLevels(' 2 ， 3, 5 ')).toEqual({ levels: [2, 3, 5] });
    });

    it('deduplicates while preserving order', () => {
        expect(parseHeadingLevels('2,1,2,4')).toEqual({ levels: [2, 1, 4] });
    });

    it('rejects empty or out-of-range input', () => {
        expect(parseHeadingLevels('')).toMatchObject({ error: expect.any(String) });
        expect(parseHeadingLevels('0')).toMatchObject({ error: expect.any(String) });
        expect(parseHeadingLevels('7')).toMatchObject({ error: expect.any(String) });
        expect(parseHeadingLevels('1,a')).toMatchObject({ error: expect.any(String) });
    });
});

describe('isOnlyLeadingSerial', () => {
    it('accepts titles that are only serial + matching markers', () => {
        expect(isOnlyLeadingSerial('1')).toBe(true);
        expect(isOnlyLeadingSerial('1.')).toBe(true);
        expect(isOnlyLeadingSerial('(1)')).toBe(true);
        expect(isOnlyLeadingSerial(' 10. ')).toBe(true);
        expect(isOnlyLeadingSerial('A.')).toBe(true);
        expect(isOnlyLeadingSerial('一、')).toBe(true);
        expect(isOnlyLeadingSerial('（一）')).toBe(true);
        expect(isOnlyLeadingSerial('(一)')).toBe(true);
        expect(isOnlyLeadingSerial('十、')).toBe(true);
    });

    it('rejects mismatched markers or body text', () => {
        expect(isOnlyLeadingSerial('1. 题干')).toBe(false);
        expect(isOnlyLeadingSerial('2. B')).toBe(false);
        expect(isOnlyLeadingSerial('任务一')).toBe(false);
        expect(isOnlyLeadingSerial('12.a)前言')).toBe(false);
        // 点号不是中文数字的配套标记
        expect(isOnlyLeadingSerial('十.')).toBe(false);
        // 顿号不是阿拉伯数字的配套标记
        expect(isOnlyLeadingSerial('1、')).toBe(false);
    });
});

describe('extractLeadingSerial', () => {
    it('extracts leading serial with type-specific markers', () => {
        expect(extractLeadingSerial('1 消息二则')).toBe('1');
        expect(extractLeadingSerial('1. 消息二则')).toBe('1');
        expect(extractLeadingSerial('(1)消息二则')).toBe('1');
        expect(extractLeadingSerial('12.a)前言')).toBe('12');
        expect(extractLeadingSerial('A.概述')).toBe('A');
        expect(extractLeadingSerial('一、引言')).toBe('一');
        expect(extractLeadingSerial('（二）小节')).toBe('二');
        expect(extractLeadingSerial('十、附录')).toBe('十');
        // 中文数字后误用点号：仍取出中文序号，点号起为正文
        expect(extractLeadingSerial('十.附录')).toBe('十');
        expect(extractLeadingSerial('1.')).toBe('1');
        expect(extractLeadingSerial('一、')).toBe('一');
        // 只取最左侧一组：后面的 A. / B. 不算进题号
        expect(
            extractLeadingSerial(
                '4. 下面是一位同学为《红星照耀中国》拟写的人物小记。请根据你的阅读体验，在后面横线处写下对应的人名。'
            )
        ).toBe('4');
        expect(extractLeadingSerial('4. A. 徐特立 B. 贺龙')).toBe('4');
    });

    it('does not swallow multiple-choice answer letters into the serial', () => {
        expect(extractLeadingSerial('2. B')).toBe('2');
        expect(extractLeadingSerial('4. D')).toBe('4');
        expect(extractLeadingSerial('7. B')).toBe('7');
    });

    it('returns null when there is no leading serial', () => {
        expect(extractLeadingSerial('任务一新闻阅读')).toBeNull();
        expect(extractLeadingSerial('第一单元活动·探究')).toBeNull();
        expect(extractLeadingSerial('...前言')).toBeNull();
    });
});

describe('normalizeHeadingText', () => {
    it('fullText mode only removes whitespace', () => {
        expect(normalizeHeadingText('1 消息二则', 'fullText')).toBe('1消息二则');
        expect(normalizeHeadingText('1. 消息二则', 'fullText')).toBe('1.消息二则');
    });

    it('serialOrFullText (default) shows leading serial when present', () => {
        expect(normalizeHeadingText('1. 题干')).toBe('1');
        expect(normalizeHeadingText('任务一')).toBe('任务一');
    });
});

describe('headingsEqual', () => {
    it('fullText: matches after whitespace strip only', () => {
        expect(headingsEqual('第一单元 活动·探究', '第一单元活动·探究', 'fullText')).toBe(true);
        expect(headingsEqual('1. 题干', '1. 答案', 'fullText')).toBe(false);
        expect(headingsEqual('1 消息', '1消息', 'fullText')).toBe(true);
    });

    it('serialOrFullText (default): when both have serial, only serials are compared', () => {
        expect(headingsEqual('1. 根据资料写汉字', '1.')).toBe(true);
        expect(headingsEqual('1. 根据资料写汉字', '1. ①溃 ②督')).toBe(true);
        expect(headingsEqual('4 “飞天”凌空', '4.答案标题')).toBe(true);
        expect(headingsEqual('2. 题干', '2. B')).toBe(true);
        expect(headingsEqual('A.概述', 'A. 其它')).toBe(true);
        expect(headingsEqual('一、完整标题', '一、')).toBe(true);
        expect(
            headingsEqual(
                '4. 下面是一位同学为《红星照耀中国》拟写的人物小记。请根据你的阅读体验，在后面横线处写下对应的人名。',
                '4. A. 徐特立 B. 贺龙'
            )
        ).toBe(true);
    });

    it('serialOrFullText: different serials do not match', () => {
        expect(headingsEqual('4 “飞天”', '6 国行公祭')).toBe(false);
        expect(headingsEqual('1.', '2. 题干')).toBe(false);
    });

    it('serialOrFullText: without serial on either side, compares full text', () => {
        expect(headingsEqual('任务一', '任务一')).toBe(true);
        expect(headingsEqual('任务一', '任务二')).toBe(false);
    });

    it('serialOrFullText: if only one side has serial, falls back to full text', () => {
        expect(headingsEqual('1 消息', '消息')).toBe(false);
        expect(headingsEqual('1 消息', '1消息')).toBe(true);
    });
});

describe('extractMdHeadings', () => {
    it('extracts only the requested level in order', () => {
        const md = [
            '# A',
            '## B1',
            '### C',
            '## B2',
            '# D',
        ].join('\n');
        expect(extractMdHeadings(md, 2).map((h) => h.text)).toEqual(['B1', 'B2']);
        expect(extractMdHeadings(md, 1).map((h) => ({ line: h.line, text: h.text }))).toEqual([
            { line: 1, text: 'A' },
            { line: 5, text: 'D' },
        ]);
    });

    it('extracts multiple levels in document position order', () => {
        const md = [
            '# A',
            '## B1',
            '### C',
            '## B2',
            '# D',
        ].join('\n');
        expect(extractMdHeadings(md, [1, 2]).map((h) => `${h.level}:${h.text}`)).toEqual([
            '1:A',
            '2:B1',
            '2:B2',
            '1:D',
        ]);
    });
});

describe('alignHeadings', () => {
    it('aligns when one side omits body and keeps only serial', () => {
        const left = '## 1 消息\n## 2 题干很长\n';
        const right = '## 1.\n## 2)\n';
        const r = alignHeadings(left, right, 2, 'serialOrFullText');
        expect(r.mismatch).toBeUndefined();
    });

    it('serialOrFullText aligns same serials even when bodies differ', () => {
        const left = '## 1 消息\n## 2 题干很长\n';
        const right = '## 1.答案短\n## 2)另一答案\n';
        const r = alignHeadings(left, right, 2, 'serialOrFullText');
        expect(r.mismatch).toBeUndefined();
    });

    it('fullText does not align when only serials match', () => {
        const left = '## 1 消息\n## 2 题干很长\n';
        const right = '## 1.答案短\n## 2)另一答案\n';
        const r = alignHeadings(left, right, 2, 'fullText');
        expect(r.mismatch?.reason).toBe('content');
        expect(r.mismatch?.index).toBe(0);
    });

    it('compares mixed levels by document position, not grouped by level', () => {
        const left = '# 单元\n## 1 课\n# 第二单元\n';
        const right = '# 单元\n## 1.\n# 第二单元\n';
        const r = alignHeadings(left, right, [1, 2]);
        expect(r.mismatch).toBeUndefined();
        expect(r.left.map((h) => h.level)).toEqual([1, 2, 1]);
        // 全文模式则第二项不对齐
        expect(alignHeadings(left, right, [1, 2], 'fullText').mismatch?.reason).toBe('content');
    });

    it('reports level mismatch at the same position', () => {
        const left = '# 单元\n## 1 课\n';
        const right = '# 单元\n# 1 课\n';
        const r = alignHeadings(left, right, [1, 2]);
        expect(r.mismatch?.reason).toBe('level');
        expect(r.mismatch?.index).toBe(1);
        expect(r.mismatch?.left?.level).toBe(2);
        expect(r.mismatch?.right?.level).toBe(1);
    });

    it('still requires exact text match when there is no leading serial', () => {
        const left = '## 任务一新闻阅读\n## 任务二\n';
        const right = '## 任务一新闻阅读\n## 任务二采访\n';
        const r = alignHeadings(left, right, 2);
        expect(r.mismatch?.reason).toBe('content');
        expect(r.mismatch?.index).toBe(1);
    });

    it('reports missingRight / missingLeft', () => {
        expect(alignHeadings('## A\n## B\n', '## A\n', 2).mismatch?.reason).toBe('missingRight');
        expect(alignHeadings('## A\n', '## A\n## B\n', 2).mismatch?.reason).toBe('missingLeft');
    });

    it('aligns H1 of the workbook test pair (exact text after whitespace)', () => {
        const body = fs.readFileSync(
            path.join(__dirname, '../test/对齐标题-正文.md'),
            'utf8'
        );
        const answer = fs.readFileSync(
            path.join(__dirname, '../test/对齐标题-答案.md'),
            'utf8'
        );
        const r = alignHeadings(body, answer, 1);
        expect(r.mismatch).toBeUndefined();
        expect(r.left).toHaveLength(7);
        expect(r.right).toHaveLength(7);
    });

    it('finds first H2 mismatch in the workbook test pair', () => {
        const body = fs.readFileSync(
            path.join(__dirname, '../test/对齐标题-正文.md'),
            'utf8'
        );
        const answer = fs.readFileSync(
            path.join(__dirname, '../test/对齐标题-答案.md'),
            'utf8'
        );
        const r = alignHeadings(body, answer, 2);
        expect(r.mismatch).toBeDefined();
        expect(r.mismatch?.reason).toBe('content');
        expect(r.mismatch!.index).toBeGreaterThanOrEqual(0);
        const hint = diagnoseHeadingMismatch(r.left, r.right, r.mismatch!);
        expect(['left', 'right', 'both']).toContain(hint.preferSide);
        expect(['here', 'up', 'down']).toContain(hint.direction);
    });

    it('matches 题干与选项答案 when only leftmost serial is compared', () => {
        const left =
            '#### 4. 下面是一位同学为《红星照耀中国》拟写的人物小记。请根据你的阅读体验，在后面横线处写下对应的人名。\n';
        const right = '#### 4. A. 徐特立 B. 贺龙\n';
        const r = alignHeadings(left, right, 4);
        expect(r.mismatch).toBeUndefined();
    });
});

describe('diagnoseHeadingMismatch', () => {
    it('detects extra item on the right when next right matches current left', () => {
        const left = '# A\n## 1 课\n## 2 课\n';
        const right = '# A\n## 多余\n## 1.\n## 2.\n';
        const r = alignHeadings(left, right, [1, 2]);
        expect(r.mismatch?.index).toBe(1);
        const hint = diagnoseHeadingMismatch(r.left, r.right, r.mismatch!);
        expect(hint.preferSide).toBe('right');
        expect(hint.direction).toBe('here');
    });

    it('detects gap on the right with look-ahead', () => {
        const left = '## 1\n## 2\n## 3\n';
        const right = '## 1.\n## x\n## y\n## 2.\n## 3.\n';
        const r = alignHeadings(left, right, 2);
        const hint = diagnoseHeadingMismatch(r.left, r.right, r.mismatch!);
        expect(hint.preferSide).toBe('right');
        expect(hint.direction).toBe('up');
    });
});
