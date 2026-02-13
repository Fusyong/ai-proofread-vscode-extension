/**
 * 检查字词：懒加载 dict7.json / xh7_tables.json 与 tgscc.json，按表名取字典、按「更好的字词」或 variant 取注释
 * 规划见 docs/xh7-word-check-plan.md；tgscc 为通用规范汉字表数据。
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ExtensionContext } from 'vscode';
import type { CheckType } from './types';
import type { WordCheckNotes } from './types';

/** dict7 / xh7_tables 结构 */
interface Xh7TablesJson {
    variant_to_standard?: Record<string, string>;
    variant_to_preferred_single?: Record<string, string>;
    variant_to_preferred_multi?: Record<string, string>;
    single_char_traditional_to_standard?: Record<string, string>;
    single_char_yitihuabiao_to_standard?: Record<string, string>;
    single_char_yiti_other_to_standard?: Record<string, string>;
    raw_notes?: Record<string, string[]>;
    usage_notes?: Record<string, string[]>;
}

/** fswv.json 结构：第一批异形词整理表，variant_to_standard 为异形词→推荐；notes 为异形词→说明 */
interface FswvJson {
    variant_to_standard?: Record<string, string>;
    notes?: Record<string, string>;
}

/** tgscc.json 结构：值为数组，首项为规范字或 null；notes 键为繁体/异体；tgscc_list 为通用规范字有序表；simplified_to_* 为规范字→繁体/异体数组 */
interface TgsccJson {
    traditional_to_simplified?: Record<string, (string | null)[]>;
    variant_to_simplified?: Record<string, (string | null)[]>;
    notes?: Record<string, string>;
    tgscc_list?: string[];
    simplified_to_traditional?: Record<string, string[]>;
    simplified_to_variants?: Record<string, string[]>;
}

type Xh7DictKey = Extract<
    CheckType,
    | 'variant_to_standard'
    | 'variant_to_preferred_single'
    | 'variant_to_preferred_multi'
    | 'single_char_traditional_to_standard'
    | 'single_char_yitihuabiao_to_standard'
    | 'single_char_yiti_other_to_standard'
>;
const XH7_KEYS: Xh7DictKey[] = [
    'variant_to_standard',
    'variant_to_preferred_single',
    'variant_to_preferred_multi',
    'single_char_traditional_to_standard',
    'single_char_yitihuabiao_to_standard',
    'single_char_yiti_other_to_standard',
];

let cachedXh7: Xh7TablesJson | null = null;
let cachedTgscc: TgsccJson | null = null;
let cachedFswv: FswvJson | null = null;
let contextForPath: ExtensionContext | null = null;

/**
 * 初始化加载器（在扩展 activate 时传入 context）
 */
export function initTableLoader(context: ExtensionContext): void {
    contextForPath = context;
    cachedXh7 = null;
    cachedTgscc = null;
    cachedFswv = null;
}

function getXh7Path(): string {
    if (!contextForPath) throw new Error('字词检查：未初始化 tableLoader');
    const base = contextForPath.asAbsolutePath(path.join('data'));
    if (fs.existsSync(path.join(base, 'xh7_tables.json'))) return path.join(base, 'xh7_tables.json');
    return path.join(base, 'dict7.json');
}

function ensureXh7Loaded(): Xh7TablesJson {
    if (cachedXh7) return cachedXh7;
    const jsonPath = getXh7Path();
    if (!fs.existsSync(jsonPath)) throw new Error(`字词检查：数据文件不存在: ${jsonPath}`);
    cachedXh7 = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as Xh7TablesJson;
    return cachedXh7;
}

function ensureTgsccLoaded(): TgsccJson {
    if (cachedTgscc) return cachedTgscc;
    if (!contextForPath) throw new Error('字词检查：未初始化 tableLoader');
    const jsonPath = contextForPath.asAbsolutePath(path.join('data', 'tgscc.json'));
    if (!fs.existsSync(jsonPath)) throw new Error(`字词检查：tgscc 数据文件不存在: ${jsonPath}`);
    cachedTgscc = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as TgsccJson;
    return cachedTgscc;
}

function ensureFswvLoaded(): FswvJson {
    if (cachedFswv) return cachedFswv;
    if (!contextForPath) throw new Error('字词检查：未初始化 tableLoader');
    const jsonPath = contextForPath.asAbsolutePath(path.join('data', 'fswv.json'));
    if (!fs.existsSync(jsonPath)) throw new Error(`字词检查：fswv 数据文件不存在: ${jsonPath}`);
    cachedFswv = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as FswvJson;
    return cachedFswv;
}

/** 将 tgscc 的 键→(string|null)[] 转为 键→string（仅取首项且非 null） */
function tgsccMapToDict(map: Record<string, (string | null)[]> | undefined): Record<string, string> {
    if (!map) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(map)) {
        if (v && v.length > 0 && typeof v[0] === 'string') out[k] = v[0];
    }
    return out;
}

/**
 * 获取指定检查类型的字典（需要提示的词 → 更好的词）
 */
export function getDict(type: CheckType): Record<string, string> {
    if (XH7_KEYS.includes(type as Xh7DictKey)) {
        const data = ensureXh7Loaded();
        return (data[type as Xh7DictKey] as Record<string, string> | undefined) ?? {};
    }
    const data = ensureTgsccLoaded();
    if (type === 'tgscc_traditional_to_simplified') {
        const dict = tgsccMapToDict(data.traditional_to_simplified);
        return filterDictKeyNotEqualValue(dict);
    }
    if (type === 'tgscc_variant_to_simplified') return tgsccMapToDict(data.variant_to_simplified);
    if (type === 'tgscc_traditional_equals_standard') {
        const dict = tgsccMapToDict(data.traditional_to_simplified);
        return filterDictKeyEqualValue(dict);
    }
    const list = data.tgscc_list;
    if (type === 'tgscc_table1' && list) return sliceToDict(list, 0, 3501, '表一字');
    if (type === 'tgscc_table2' && list) return sliceToDict(list, 3501, list.length, '表二字');
    return {};
}

function filterDictKeyNotEqualValue(dict: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(dict)) if (k !== v) out[k] = v;
    return out;
}

function filterDictKeyEqualValue(dict: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(dict)) if (k === v) out[k] = v;
    return out;
}

function sliceToDict(arr: string[], start: number, end: number, value: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (let i = start; i < end && i < arr.length; i++) out[arr[i]] = value;
    return out;
}

/** 自定义替换表检查：预置「表」id（使用 tgscc / fswv 数据与逻辑） */
export type CustomPresetId = 'preset_traditional' | 'preset_variant' | 'preset_simplified_to_tv' | 'preset_fswv';

const CUSTOM_PRESET_LABELS: Record<CustomPresetId, string> = {
    preset_traditional: '通规繁体字→规范字',
    preset_variant: '通规异体字→规范字',
    preset_simplified_to_tv: '通规规范字→繁体字异体字',
    preset_fswv: '一异表异形词→推荐',
};

export function getCustomPresetLabel(id: CustomPresetId): string {
    return CUSTOM_PRESET_LABELS[id];
}

export const CUSTOM_PRESET_IDS: CustomPresetId[] = ['preset_traditional', 'preset_variant', 'preset_simplified_to_tv', 'preset_fswv'];

/** 是否需要分词后再匹配（多字词表） */
export function isPresetRequiringSegmentation(presetId: CustomPresetId): boolean {
    return presetId === 'preset_fswv';
}

/**
 * 获取自定义检查预置「表」的字典（用于扫描）；无数据时返回空对象。
 */
export function getCustomPresetDict(presetId: CustomPresetId): Record<string, string> {
    try {
        const data = ensureTgsccLoaded();
        if (presetId === 'preset_traditional') {
            return filterDictKeyNotEqualValue(tgsccMapToDict(data.traditional_to_simplified));
        }
        if (presetId === 'preset_variant') {
            return tgsccMapToDict(data.variant_to_simplified);
        }
        if (presetId === 'preset_simplified_to_tv') {
            const trad = data.simplified_to_traditional ?? {};
            const vari = data.simplified_to_variants ?? {};
            const keys = new Set([...Object.keys(trad), ...Object.keys(vari)]);
            const out: Record<string, string> = {};
            for (const k of keys) {
                const t = (trad[k] ?? []).join('');
                const v = (vari[k] ?? []).join('');
                const val = t + v;
                if (val) out[k] = val;
            }
            return out;
        }
    } catch {
        // tgscc 未加载时忽略
    }
    if (presetId === 'preset_fswv') {
        try {
            const fswv = ensureFswvLoaded();
            return fswv.variant_to_standard ?? {};
        } catch {
            // fswv 未加载时忽略
        }
    }
    return {};
}

/** 供 tgscc 特殊扫描（非通规字、未界定字）使用 */
export function getTgsccData(): {
    listSet: Set<string>;
    traditionalKeys: Set<string>;
    variantKeys: Set<string>;
} | null {
    try {
        const data = ensureTgsccLoaded();
        const list = data.tgscc_list ?? [];
        const listSet = new Set(list);
        const traditionalKeys = new Set(Object.keys(data.traditional_to_simplified ?? {}));
        const variantKeys = new Set(Object.keys(data.variant_to_simplified ?? {}));
        return { listSet, traditionalKeys, variantKeys };
    } catch {
        return null;
    }
}

/**
 * 根据「更好的字词」及可选的「需要提示的词」获取注释（xh7：按 preferred，仅用已缓存；tgscc：按 variant）
 */
export function getNotes(preferred: string, variant?: string): WordCheckNotes {
    const raw: string[] = [];
    let usage: string[] = [];
    if (cachedXh7) {
        if (cachedXh7.raw_notes?.[preferred]) raw.push(...cachedXh7.raw_notes[preferred]);
        if (cachedXh7.usage_notes?.[preferred]) usage = cachedXh7.usage_notes[preferred];
    }
    if (variant) {
        try {
            const tgscc = ensureTgsccLoaded();
            const note = tgscc.notes?.[variant];
            if (typeof note === 'string') raw.push(note);
        } catch {
            // tgscc 未配置或文件缺失时忽略
        }
        try {
            const fswv = ensureFswvLoaded();
            const note = fswv.notes?.[variant];
            if (typeof note === 'string') raw.push(note);
        } catch {
            // fswv 未配置或文件缺失时忽略
        }
    }
    return { raw: raw.length ? raw : undefined, usage: usage.length ? usage : undefined };
}
