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
    variant_to_preferred?: Record<string, string>;
    single_char_traditional_to_standard?: Record<string, string>;
    single_char_yitihuabiao_to_standard?: Record<string, string>;
    single_char_yiti_other_to_standard?: Record<string, string>;
    raw_notes?: Record<string, string[]>;
    usage_notes?: Record<string, string[]>;
}

/** tgscc.json 结构：值为数组，首项为规范字或 null；notes 为 繁体/异体 → 注释字符串 */
interface TgsccJson {
    traditional_to_simplified?: Record<string, (string | null)[]>;
    variant_to_simplified?: Record<string, (string | null)[]>;
    notes?: Record<string, string>;
}

type Xh7DictKey = Extract<
    CheckType,
    | 'variant_to_standard'
    | 'variant_to_preferred'
    | 'single_char_traditional_to_standard'
    | 'single_char_yitihuabiao_to_standard'
    | 'single_char_yiti_other_to_standard'
>;
const XH7_KEYS: Xh7DictKey[] = [
    'variant_to_standard',
    'variant_to_preferred',
    'single_char_traditional_to_standard',
    'single_char_yitihuabiao_to_standard',
    'single_char_yiti_other_to_standard',
];

let cachedXh7: Xh7TablesJson | null = null;
let cachedTgscc: TgsccJson | null = null;
let contextForPath: ExtensionContext | null = null;

/**
 * 初始化加载器（在扩展 activate 时传入 context）
 */
export function initTableLoader(context: ExtensionContext): void {
    contextForPath = context;
    cachedXh7 = null;
    cachedTgscc = null;
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
    if (type === 'tgscc_traditional_to_simplified') return tgsccMapToDict(data.traditional_to_simplified);
    if (type === 'tgscc_variant_to_simplified') return tgsccMapToDict(data.variant_to_simplified);
    return {};
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
    }
    return { raw: raw.length ? raw : undefined, usage: usage.length ? usage : undefined };
}
