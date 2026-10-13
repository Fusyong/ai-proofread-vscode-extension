import path from 'path';
import { describe, expect, it } from 'vitest';
import {
    CUSTOM_PRESET_IDS,
    getCustomPresetDict,
    getCustomPresetLabel,
    initTableLoader,
    isPresetJd30,
    isPresetRequiringSegmentation,
    JD30_PRESET_IDS,
} from './tableLoader';

describe('jd30 校对词表', () => {
    const root = path.join(__dirname, '..', '..');

    it('只保留绝对优势-不成词，匹配前先分词', () => {
        expect(JD30_PRESET_IDS).toEqual(['preset_jd30_dominant']);
        expect(CUSTOM_PRESET_IDS).toContain('preset_jd30_dominant');
        expect(isPresetJd30('preset_jd30_dominant')).toBe(true);
        expect(isPresetRequiringSegmentation('preset_jd30_dominant')).toBe(true);
        expect(getCustomPresetLabel('preset_jd30_dominant')).toBe('校对词·绝对优势-不成词');
        expect(isPresetRequiringSegmentation('preset_fswv')).toBe(true);
        expect(isPresetRequiringSegmentation('preset_traditional')).toBe(false);
    });

    it('从 data 载入词条', () => {
        initTableLoader({
            asAbsolutePath: (rel: string) => path.join(root, rel),
        } as never);
        const dict = getCustomPresetDict('preset_jd30_dominant');
        expect(Object.keys(dict)).toHaveLength(16515);
        expect(dict['显的']).toBe('显得');
    });
});
