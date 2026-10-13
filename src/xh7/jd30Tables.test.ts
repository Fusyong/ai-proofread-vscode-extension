import path from 'path';
import { describe, expect, it } from 'vitest';
import { findLiteralMatches, type LiteralMatch } from './literalScan';
import {
    CUSTOM_PRESET_IDS,
    getCustomPresetDict,
    getCustomPresetLabel,
    initTableLoader,
    isPresetJd30,
    isPresetRequiringSegmentation,
    JD30_PRESET_IDS,
} from './tableLoader';

function naiveLiteral(text: string, dict: Record<string, string>): LiteralMatch[] {
    const keys = Object.keys(dict).filter((k) => k && dict[k]);
    const ranked = keys.map((k, i) => ({ k, i })).sort((a, b) => b.k.length - a.k.length || a.i - b.i);
    const covered = new Uint8Array(text.length);
    const accepted: LiteralMatch[] = [];
    for (const { k } of ranked) {
        let from = 0;
        while (from <= text.length - k.length) {
            const i = text.indexOf(k, from);
            if (i < 0) break;
            const end = i + k.length;
            let overlap = false;
            for (let p = i; p < end; p++) {
                if (covered[p]) {
                    overlap = true;
                    break;
                }
            }
            if (!overlap) {
                for (let p = i; p < end; p++) covered[p] = 1;
                accepted.push({ start: i, end, variant: k, preferred: dict[k] });
            }
            from = i + 1;
        }
    }
    accepted.sort((a, b) => a.start - b.start || a.end - b.end);
    return accepted;
}

describe('jd30 校对词表', () => {
    const root = path.join(__dirname, '..', '..');

    it('四张表都在自定义检查预置里，且匹配前不分词', () => {
        for (const id of JD30_PRESET_IDS) {
            expect(CUSTOM_PRESET_IDS).toContain(id);
            expect(isPresetJd30(id)).toBe(true);
            expect(isPresetRequiringSegmentation(id)).toBe(false);
            expect(getCustomPresetLabel(id).startsWith('校对词·')).toBe(true);
        }
        expect(isPresetRequiringSegmentation('preset_fswv')).toBe(true);
    });

    it('从 data/jd30 载入词条', () => {
        initTableLoader({
            asAbsolutePath: (rel: string) => path.join(root, rel),
        } as never);
        expect(Object.keys(getCustomPresetDict('preset_jd30_window_both'))).toHaveLength(633);
        expect(Object.keys(getCustomPresetDict('preset_jd30_window_prefix'))).toHaveLength(5595);
        expect(Object.keys(getCustomPresetDict('preset_jd30_window_suffix'))).toHaveLength(5573);
        expect(Object.keys(getCustomPresetDict('preset_jd30_dominant'))).toHaveLength(23972);
        expect(getCustomPresetDict('preset_jd30_window_both')['都呆在']).toBe('都待在');
        expect(getCustomPresetDict('preset_jd30_window_prefix')['不断的']).toBe('不断地');
        expect(getCustomPresetDict('preset_jd30_window_suffix')['的在']).toBe('地在');
        expect(getCustomPresetDict('preset_jd30_dominant')['才才']).toBe('刚才');

        const insideWord = findLiteralMatches('目的在于', getCustomPresetDict('preset_jd30_window_suffix'));
        expect(insideWord).toContainEqual({ start: 1, end: 3, variant: '的在', preferred: '地在' });
    });

    it('先长后短，且正文中的查找串不必单独成词', () => {
        const longer = findLiteralMatches('说的很', { 说的很: '说得很', 的很: '得很' });
        expect(longer).toEqual([{ start: 0, end: 3, variant: '说的很', preferred: '说得很' }]);

        const inside = findLiteralMatches('目的在于', { 的在: '地在' });
        expect(inside).toEqual([{ start: 1, end: 3, variant: '的在', preferred: '地在' }]);

        const both = findLiteralMatches('xaaa', { xa: '1', aa: '2' });
        expect(both).toEqual([
            { start: 0, end: 2, variant: 'xa', preferred: '1' },
            { start: 2, end: 4, variant: 'aa', preferred: '2' },
        ]);
    });

    it('与逐条 indexOf 的先长后短结果一致', () => {
        const dict: Record<string, string> = {
            abcd: 'L',
            xab: 'S',
            aa: '2',
            xa: '1',
            说的很: '说得很',
            的很: '得很',
            的在: '地在',
        };
        const text = 'xabcd说的很目的在于aaaa';
        expect(findLiteralMatches(text, dict)).toEqual(naiveLiteral(text, dict));
    });
});
