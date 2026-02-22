/**
 * 标题层级与连续性检查：预置序号匹配正则与数值转换
 * 规划见 docs/numbering-hierarchy-check-plan.md
 */

import type { HierarchyLevel, SequenceType } from './types';

/** 中文小写数字到数值的映射 */
const CHINESE_LOWER: Record<string, number> = {
    零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
    十: 10, 百: 100, 千: 1000, 万: 10000,
};

/** 中文大写数字到数值的映射 */
const CHINESE_UPPER: Record<string, number> = {
    零: 0, 壹: 1, 贰: 2, 叁: 3, 肆: 4, 伍: 5, 陆: 6, 柒: 7, 捌: 8, 玖: 9,
    拾: 10, 佰: 100, 仟: 1000, 萬: 10000,
};

/** 带圈数字 ①-⑳ 到数值 */
const CIRCLED_1_20 = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
/** 带圈数字 ㉑-㊿ */
const CIRCLED_21_50 = '㉑㉒㉓㉔㉕㉖㉗㉘㉙㉚㉛㉜㉝㉞㉟㊱㊲㊳㊴㊵㊶㊷㊸㊹㊺㊻㊼㊽㊾㊿';

/** 带括号数字 ⑴-⑳ */
const PAREN_1_20 = '⑴⑵⑶⑷⑸⑹⑺⑻⑼⑽⑾⑿⒀⒁⒂⒃⒄⒅⒆⒇';
/** 带点数字 ⒈-⒛ */
const DOT_1_20 = '⒈⒉⒊⒋⒌⒍⒎⒏⒐⒑⒒⒓⒔⒕⒖⒗⒘⒙⒚⒛';
/** 带括号中文 ㈠-㉟ */
const PAREN_CN = '㈠㈡㈢㈣㈤㈥㈦㈧㈨㈩㈪㈫㈬㈭㈮㈯㈰㈱㈲㈳㈴㈵㈶㈷㈸㈹㈺㈻㈼㈽㈾㈿㉀㉁㉂㉃㉄㉅㉆㉇㉈㉉㉊㉋㉌㉍㉎㉏㉐㉑㉒㉓㉔㉕㉖㉗㉘㉙㉚㉛㉜㉝㉞㉟';

/** 罗马数字字符到数值 */
const ROMAN_MAP: Record<string, number> = {
    I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000,
    ⅰ: 1, ⅴ: 5, ⅹ: 10, ⅼ: 50, ⅽ: 100, ⅾ: 500, ⅿ: 1000,
    Ⅰ: 1, Ⅴ: 5, Ⅹ: 10, Ⅼ: 50, Ⅽ: 100, Ⅾ: 500, Ⅿ: 1000,
};

/**
 * 将中文数字字符串转为数值（简化版，支持 一、二、十、十一、二十、二十一 等常见形式）
 */
export function chineseToNumber(s: string, upper = false): number {
    const map = upper ? CHINESE_UPPER : CHINESE_LOWER;
    if (!s || s === '零') return 0;
    let n = 0;
    let cur = 0;
    for (const c of s) {
        const v = map[c];
        if (v === undefined) continue;
        if (v >= 10) {
            cur = cur || 1;
            n += cur * v;
            cur = 0;
        } else {
            cur = cur * 10 + v;
        }
    }
    return n + cur;
}

/**
 * 罗马数字转数值
 */
export function romanToNumber(s: string): number {
    let n = 0;
    let prev = 0;
    for (let i = s.length - 1; i >= 0; i--) {
        const v = ROMAN_MAP[s[i]] ?? 0;
        n += v < prev ? -v : v;
        prev = v;
    }
    return n;
}

/**
 * 带圈/带括号数字转数值
 */
export function circledToNumber(c: string): number {
    let idx = CIRCLED_1_20.indexOf(c);
    if (idx >= 0) return idx + 1;
    idx = CIRCLED_21_50.indexOf(c);
    if (idx >= 0) return idx + 21;
    idx = PAREN_1_20.indexOf(c);
    if (idx >= 0) return idx + 1;
    idx = DOT_1_20.indexOf(c);
    if (idx >= 0) return idx + 1;
    idx = PAREN_CN.indexOf(c);
    if (idx >= 0) return idx + 1;
    return 0;
}

/**
 * 拉丁字母序号转数值（A=1, B=2, ..., Z=26, AA=27, ...）
 */
export function latinToNumber(s: string): number {
    let n = 0;
    const base = s === s.toUpperCase() ? 65 : 97;
    for (const c of s) {
        n = n * 26 + (c.charCodeAt(0) - base + 1);
    }
    return n;
}

/**
 * 多级阿拉伯数字（如 1.2.3）转可比较的数值
 * 1.2.3 -> 1002003，便于同级比较
 */
export function multiLevelArabicToValue(parts: number[]): number {
    let v = 0;
    for (const p of parts) {
        v = v * 10000 + p;
    }
    return v;
}

/** 预置层级：阿拉伯数字 + 点号（如 1. 1.1 1.1.1） */
export const LEVEL_ARABIC_DOT: HierarchyLevel = {
    level: 0,
    name: 'arabic-dot',
    pattern: /^\s*(#{1,6}\s+)?(\d+)([.．]\d+)*[.．]?\s*(.*)$/,
    sequenceType: 'arabic',
};

/** 预置层级：中文数字 + 顿号（一、二、三、） */
export const LEVEL_CHINESE_DUN: HierarchyLevel = {
    level: 0,
    name: 'chinese-dun',
    pattern: /^\s*(#{1,6}\s+)?([一二三四五六七八九十百千]+)、\s*(.*)$/,
    sequenceType: 'chinese-lower',
};

/** 预置层级：第 X 章/节 */
export const LEVEL_CHAPTER: HierarchyLevel = {
    level: 0,
    name: 'chapter',
    pattern: /^\s*(#{1,6}\s+)?第([一二三四五六七八九十百千\d]+)[章节条款项]\s*(.*)$/,
    sequenceType: 'chinese-lower',
};

/** 预置层级：带圈数字 ①②③ */
export const LEVEL_CIRCLED: HierarchyLevel = {
    level: 0,
    name: 'circled',
    pattern: /^\s*(#{1,6}\s+)?([①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳㉑㉒㉓㉔㉕㉖㉗㉘㉙㉚㉛㉜㉝㉞㉟㊱㊲㊳㊴㊵㊶㊷㊸㊹㊺㊻㊼㊽㊾㊿])\s*(.*)$/,
    sequenceType: 'circled',
};

/** 预置层级：括号数字 (1) (一) （1） */
export const LEVEL_PAREN: HierarchyLevel = {
    level: 0,
    name: 'paren',
    pattern: /^\s*(#{1,6}\s+)?[(\（]([一二三四五六七八九十\d]+)[)\）]\s*(.*)$/,
    sequenceType: 'chinese-lower',
};

/** 预置层级：§ 符号 */
export const LEVEL_SECTION: HierarchyLevel = {
    level: 0,
    name: 'section',
    pattern: /^\s*(#{1,6}\s+)?§\s*(\d+)([.．]\d+)*\s*(.*)$/,
    sequenceType: 'arabic',
};

/** 所有预置层级（按优先级，先匹配的生效） */
export const BUILTIN_LEVELS: HierarchyLevel[] = [
    LEVEL_CHAPTER,      // 第一章、第一节 等
    LEVEL_SECTION,      // §1、§1.2
    LEVEL_ARABIC_DOT,   // 1. 1.1 1.1.1
    LEVEL_CHINESE_DUN,  // 一、二、三、
    LEVEL_PAREN,        // (1) (一)
    LEVEL_CIRCLED,      // ①②③
];

/**
 * 从匹配结果提取 numberingValue
 */
export function extractNumberingValue(
    match: RegExpMatchArray,
    sequenceType: SequenceType,
    fullNumberingText: string
): number {
    const numPart = (match[2] ?? match[1] ?? '').trim();
    switch (sequenceType) {
        case 'arabic': {
            const parts = fullNumberingText.match(/\d+/g);
            if (!parts?.length) return parseInt(numPart, 10) || 0;
            return multiLevelArabicToValue(parts.map(Number));
        }
        case 'chinese-lower':
            return /^\d+$/.test(numPart) ? parseInt(numPart, 10) : chineseToNumber(numPart, false);
        case 'chinese-upper':
            return /^\d+$/.test(numPart) ? parseInt(numPart, 10) : chineseToNumber(numPart, true);
        case 'roman-upper':
        case 'roman-lower':
            return romanToNumber(numPart);
        case 'latin-upper':
        case 'latin-lower': {
            const parts = fullNumberingText.match(/[A-Za-z]+|\d+/g);
            if (parts && parts.length > 1) {
                const nums = parts.map((p) => /^\d+$/.test(p) ? parseInt(p, 10) : latinToNumber(p));
                return multiLevelArabicToValue(nums);
            }
            return latinToNumber(numPart);
        }
        case 'circled':
            return circledToNumber(numPart);
        default:
            return parseInt(numPart, 10) || 0;
    }
}
