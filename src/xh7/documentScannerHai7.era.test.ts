import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
    class Position {
        constructor(
            public line: number,
            public character: number
        ) {}
    }
    class Range {
        start: Position;
        end: Position;
        constructor(a: Position | number, b?: Position | number, c?: number, d?: number) {
            if (typeof a === 'object' && typeof b === 'object') {
                this.start = a as Position;
                this.end = b as Position;
            } else {
                this.start = new Position(a as number, b as number);
                this.end = new Position(c as number, d as number);
            }
        }
    }
    return { Range, Position };
});

const TEST_ERA = {
    万历: [{ raw: '1573—1620', label: '明神宗年号' }],
    嘉庆: [
        { raw: '1387—1389', label: '日本北朝后小松天皇年号' },
        { raw: '1796—1820', label: '清仁宗年号' },
    ],
    /** raw 无 —：单年，与「710—710」等价（见 parseRawSpan） */
    试: [{ raw: '710', label: '测试单年' }],
};

vi.mock('./tableLoader', () => ({
    getHai7Data: () => ({
        person_birth_death: {},
        era_years: TEST_ERA,
    }),
}));

import * as vscode from 'vscode';
import { scanDocumentHai7Era } from './documentScannerHai7';
import { getHai7Data } from './tableLoader';

function mockDoc(text: string): vscode.TextDocument {
    return {
        lineCount: 1,
        getText: () => text,
        offsetAt: (p: vscode.Position) => (p.line <= 0 ? Math.min(p.character, text.length) : text.length),
        positionAt: (off: number) => new vscode.Position(0, Math.min(off, text.length)),
    } as vscode.TextDocument;
}

function scan(text: string) {
    return scanDocumentHai7Era(mockDoc(text));
}

describe('scanDocumentHai7Era (subset table)', () => {
    it('mock：年号子集含 万历', () => {
        expect(getHai7Data()?.era_years?.万历?.[0]?.raw).toBe('1573—1620');
    });

    it('E1: 明万历十五年（1587年）→ 已核验', () => {
        const r = scan('明万历十五年（1587年）');
        expect(r.some((e) => e.variant.includes('明万历十五年') && e.preferred === '已核验')).toBe(true);
    });

    it('E1: 明万历十五年（1600年）→ 核验错误', () => {
        const r = scan('明万历十五年（1600年）');
        expect(r.some((e) => e.preferred === '核验错误')).toBe(true);
    });

    it('E1: raw 仅为单年数字（710）时元年+括注 710 已核验', () => {
        const r = scan('试元年（710年）');
        expect(r.some((e) => e.preferred === '已核验')).toBe(true);
    });

    it('E1: raw 单年时次年超出区间 → 核验错误', () => {
        const r = scan('试二年（711年）');
        expect(r.some((e) => e.preferred === '核验错误')).toBe(true);
    });

    it('E2: 万历（1573—1620）→ 已核验', () => {
        const r = scan('万历（1573—1620）');
        expect(r.some((e) => e.preferred === '已核验')).toBe(true);
    });

    it('E3: 明万历十五年无括注 → 已核验', () => {
        const r = scan('明万历十五年');
        expect(r.some((e) => e.preferred === '已核验')).toBe(true);
    });

    it('E3: 万历十年（T3）→ 已核验', () => {
        const r = scan('万历十年');
        expect(r.some((e) => e.variant.includes('万历十年') && e.preferred === '已核验')).toBe(true);
    });

    it('E3: 万历十一年（T3，双字序次）→ 已核验', () => {
        const r = scan('万历十一年');
        expect(r.some((e) => e.variant.includes('万历十一年') && e.preferred === '已核验')).toBe(true);
    });

    it('E3: 明万历十年（T2）→ 已核验', () => {
        const r = scan('明万历十年');
        expect(r.some((e) => e.preferred === '已核验' && e.variant.replace(/\s+/g, '').includes('明万历十年'))).toBe(true);
    });

    it('E4: 万历年 → 备核', () => {
        const r = scan('万历年');
        expect(r.some((e) => e.preferred === '备核')).toBe(true);
    });

    it('G1: 1799年（清仁宗嘉庆四年）→ 已核验', () => {
        const r = scan('1799年（清仁宗嘉庆四年）');
        expect(r.some((e) => e.preferred === '已核验')).toBe(true);
    });

    it('G2: 1799年（1799）→ 已核验', () => {
        const r = scan('1799年（1799）');
        expect(r.some((e) => e.preferred === '已核验')).toBe(true);
    });

    it('E1 先于 G：嘉庆四年（1799年）已核验 + 多项备核（不重复 G）', () => {
        const r = scan('嘉庆四年（1799年）');
        expect(r.some((e) => e.preferred === '已核验' && e.variant.includes('嘉庆四年'))).toBe(true);
        expect(r.some((e) => e.preferred === '多项备核')).toBe(true);
        expect(r.filter((e) => e.variant.includes('嘉庆四年') && e.preferred === '无数据')).toHaveLength(0);
    });
});
