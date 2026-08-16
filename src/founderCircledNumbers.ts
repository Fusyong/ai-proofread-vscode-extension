/**
 * 方正书版 PDF 导出后的带圈序号转换
 *
 * 1–10 常为 Unicode ①–⑩；大于 10 的阳圈码多为私用区（PUA）组合字：
 *   [前缀 U+*00CA] + 各位数字对应的 PUA 码点
 * 数字位编码（样例实测，Plane 15/16 偏移量相同）：
 *   n 位数时，第 p 位（从左、0 起）偏移 = 0x48 + (n-2)*0x46 + p*0x0A + 数字值
 *
 * 另：导出文本中常见版面杂质（软换行/分页残片），可一并清除。
 */

export type FounderCircledFormat = 'unicode' | 'bracket';

export interface ReplaceFounderCircledOptions {
    /** unicode：1–50 用带圈符号，更大用 [n]；bracket：方头扩注序号，一律 [n] */
    format: FounderCircledFormat;
    /** 清除分页/换行类 PUA 杂质，默认 true */
    stripLayoutArtifacts?: boolean;
}

export interface ReplaceFounderCircledResult {
    text: string;
    replacedCount: number;
    strippedArtifactCount: number;
}

const PREFIX_OFFSET = 0x0ca;
const DIGIT_BASE_2 = 0x48;
const DIGIT_STRIDE_LEN = 0x46;
const DIGIT_STRIDE_POS = 0x0a;
const MAX_DIGITS = 4;

/** 已知版面杂质：􀭤􀭥􀪁… / 􀭠􀭡􀪁… */
const LAYOUT_HEAD_PAIRS: ReadonlyArray<readonly [number, number]> = [
    [0xb64, 0xb65],
    [0xb60, 0xb61],
];
const LAYOUT_FILLER = 0xa81;
const LAYOUT_OFFSETS = new Set<number>([
    LAYOUT_FILLER,
    ...LAYOUT_HEAD_PAIRS.flatMap(([a, b]) => [a, b]),
]);

const CIRCLED_1_20 = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
const CIRCLED_21_50 = '㉑㉒㉓㉔㉕㉖㉗㉘㉙㉚㉛㉜㉝㉞㉟㊱㊲㊳㊴㊵㊶㊷㊸㊹㊺㊻㊼㊽㊾㊿';

function codePointLen(cp: number): number {
    return cp > 0xffff ? 2 : 1;
}

function supplementaryPuaOffset(cp: number): number | null {
    if (cp >= 0xf0000 && cp <= 0xffffd) {
        return cp - 0xf0000;
    }
    if (cp >= 0x100000 && cp <= 0x10fffd) {
        return cp - 0x100000;
    }
    return null;
}

function digitPositionBase(numDigits: number, pos: number): number {
    return DIGIT_BASE_2 + (numDigits - 2) * DIGIT_STRIDE_LEN + pos * DIGIT_STRIDE_POS;
}

/**
 * 将 PUA 数字位序列解码为整数；非法则返回 null
 */
export function decodeFounderDigitOffsets(digitOffsets: number[]): number | null {
    const n = digitOffsets.length;
    if (n < 1 || n > MAX_DIGITS) {
        return null;
    }
    let value = 0;
    for (let p = 0; p < n; p++) {
        const d = digitOffsets[p] - digitPositionBase(n, p);
        if (!Number.isInteger(d) || d < 0 || d > 9) {
            return null;
        }
        if (p === 0 && d === 0 && n > 1) {
            return null;
        }
        value = value * 10 + d;
    }
    return value > 0 ? value : null;
}

/**
 * 编码为方正 PUA 偏移序列（含前缀），便于测试与对照
 */
export function encodeFounderCircledOffsets(n: number): number[] | null {
    if (!Number.isInteger(n) || n < 1 || n > 9999) {
        return null;
    }
    const digits = String(n).split('').map((c) => Number(c));
    const numDigits = digits.length;
    const out = [PREFIX_OFFSET];
    for (let p = 0; p < numDigits; p++) {
        out.push(digitPositionBase(numDigits, p) + digits[p]);
    }
    return out;
}

/** 用 Plane 16 码点拼出方正带圈序号（测试/生成用） */
export function encodeFounderCircledString(n: number, planeBase = 0x100000): string | null {
    const offs = encodeFounderCircledOffsets(n);
    if (!offs) {
        return null;
    }
    return String.fromCodePoint(...offs.map((o) => planeBase + o));
}

export function numberToUnicodeCircled(n: number): string {
    if (n >= 1 && n <= 20) {
        return CIRCLED_1_20[n - 1];
    }
    if (n >= 21 && n <= 50) {
        return CIRCLED_21_50[n - 21];
    }
    return `[${n}]`;
}

export function numberToFounderReplacement(n: number, format: FounderCircledFormat): string {
    if (format === 'bracket') {
        return `[${n}]`;
    }
    return numberToUnicodeCircled(n);
}

function unicodeCircledToNumber(ch: string): number | null {
    const i20 = CIRCLED_1_20.indexOf(ch);
    if (i20 >= 0) {
        return i20 + 1;
    }
    const i50 = CIRCLED_21_50.indexOf(ch);
    if (i50 >= 0) {
        return i50 + 21;
    }
    return null;
}

function tryDecodeFounderMarker(
    text: string,
    start: number
): { end: number; value: number } | null {
    const prefixCp = text.codePointAt(start);
    if (prefixCp === undefined) {
        return null;
    }
    if (supplementaryPuaOffset(prefixCp) !== PREFIX_OFFSET) {
        return null;
    }

    const digitOffsets: number[] = [];
    const afterDigitEnds: number[] = [];
    let i = start + codePointLen(prefixCp);

    while (digitOffsets.length < MAX_DIGITS && i < text.length) {
        const cp = text.codePointAt(i)!;
        const off = supplementaryPuaOffset(cp);
        if (off === null || off === PREFIX_OFFSET || LAYOUT_OFFSETS.has(off)) {
            break;
        }
        digitOffsets.push(off);
        i += codePointLen(cp);
        afterDigitEnds.push(i);
    }

    for (let len = digitOffsets.length; len >= 1; len--) {
        const value = decodeFounderDigitOffsets(digitOffsets.slice(0, len));
        if (value !== null) {
            return { end: afterDigitEnds[len - 1], value };
        }
    }
    return null;
}

function tryMatchLayoutArtifact(text: string, start: number): number | null {
    const cp0 = text.codePointAt(start);
    if (cp0 === undefined) {
        return null;
    }
    const off0 = supplementaryPuaOffset(cp0);
    if (off0 === null) {
        return null;
    }

    for (const [a, b] of LAYOUT_HEAD_PAIRS) {
        if (off0 !== a) {
            continue;
        }
        let i = start;
        const nextOff = (): number | null => {
            if (i >= text.length) {
                return null;
            }
            const cp = text.codePointAt(i)!;
            const off = supplementaryPuaOffset(cp);
            if (off === null) {
                return null;
            }
            i += codePointLen(cp);
            return off;
        };

        if (nextOff() !== a) {
            continue;
        }
        if (nextOff() !== b) {
            continue;
        }
        let fillers = 0;
        while (true) {
            const before = i;
            const o = nextOff();
            if (o !== LAYOUT_FILLER) {
                i = before;
                break;
            }
            fillers++;
        }
        if (fillers >= 1) {
            return i;
        }
    }
    return null;
}

/**
 * 替换方正书版带圈序号（PUA 组合字及可选的 Unicode 带圈符）
 */
export function replaceFounderCircledNumbers(
    text: string,
    options: ReplaceFounderCircledOptions
): ReplaceFounderCircledResult {
    const stripLayout = options.stripLayoutArtifacts !== false;
    let replacedCount = 0;
    let strippedArtifactCount = 0;
    let out = '';
    let i = 0;

    while (i < text.length) {
        if (stripLayout) {
            const artEnd = tryMatchLayoutArtifact(text, i);
            if (artEnd !== null) {
                strippedArtifactCount++;
                i = artEnd;
                continue;
            }
        }

        const founder = tryDecodeFounderMarker(text, i);
        if (founder) {
            out += numberToFounderReplacement(founder.value, options.format);
            replacedCount++;
            i = founder.end;
            continue;
        }

        const cp = text.codePointAt(i)!;
        const ch = String.fromCodePoint(cp);
        if (options.format === 'bracket') {
            const n = unicodeCircledToNumber(ch);
            if (n !== null) {
                out += `[${n}]`;
                replacedCount++;
                i += codePointLen(cp);
                continue;
            }
        }

        out += ch;
        i += codePointLen(cp);
    }

    return { text: out, replacedCount, strippedArtifactCount };
}
