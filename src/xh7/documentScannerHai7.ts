/**
 * hai7.json：人名括注、年号与年份核对（自定义检查预置）。
 * 数据：data/hai7.json — person_birth_death、era_years。
 *
 * 年号扫描类型与顺序（先表锚 E1–E4，再公历括注 G；全程 consumed 防重叠）：
 * - **E1**：T1/T2/T3 外层 + 汉字序 + `年` + 括注（阿拉伯单年）；例：明万历十五年（1587年）、嘉庆四年（1799）
 * - **E2**：同上外层 + 可选 `年` + 括注（label/raw 逗号规则）；例：万历（1573—1620）
 * - **E3**：同上外层 + 汉字序 + `年`（无括注）；例：明万历十年、万历十五年
 * - **E4**：同上外层 + `年`（弱提示，「年」后非汉字序则报）；例：万历年、明万历年
 * - **G1**：缀文 + 公历 + `年` + 括注 + 汉字纪年链（末 `年`）；例：1799年（清仁宗嘉庆四年）
 * - **G2**：同上 + 括注末 `…\\d+年?`；例：1799年（1799）；外为年号+汉字年+年时与 E1 共用推算
 *
 * **T1/T2/T3**（label 去尾「年号」得前缀 P；朝字正文连写如明朝，不用「明（朝）」）：
 * - T1：`P`+词头；可选插入 `朝`：`明`+`朝`+`神宗`+`万历` → 明朝神宗万历
 * - T2：`朝代首字`+可选`朝`+词头；例：明万历、明朝万历
 * - T3：仅词头
 * - **不核验**：「庙号 + 序 + 年」而无词头/T1/T2 外壳（如神宗十年）— 不在扫描范围内。
 *
 * 括注内年号表述合法集与 T1–T3 表面形式一致（由 `collectAllowedBracketEraPhrases` 生成）。
 * 「…年（…年）」「…年（…\\d+年?）」在 **G** 阶段报出；与 E1–E4 相交则跳过；无法核验 →「无数据」。
 */

import * as vscode from 'vscode';
import type { WordCheckEntry } from './types';
import { getHai7Data, type Hai7Row } from './tableLoader';

/** 树条目「更好的词」：错误类仅两种；提示类单独短标 */
const HAI7_ERR_VERIFY = '核验错误';
const HAI7_ERR_MULTI = '多项备核';
const HAI7_ERR_BOTH = '核验错误；多项备核';
const HAI7_HINT = '备核';
/** 与表一致且无多义项待决时，仍列出以便浏览 */
const HAI7_OK = '已核验';
/** 年号表无可用条目或无法建立核验关系 */
const HAI7_NO_DATA = '无数据';

/** 转义为 RegExp 字面量 */
function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 统一用于比较的 dash、空白、逗号 */
function normalizeSpaces(s: string): string {
    return s.replace(/\u3000/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeRawDash(s: string): string {
    // 严格要求年份区间使用的连接号仅为全角破折号「—」。
    // 因此不再把「- / – / −」等替换为「—」；避免把非目标写法误判为相符。
    return s;
}

/** 「前」与阿拉伯数字之间排版空格不影响核验（前 99 → 前99） */
function normalizeQianBeforeArabicDigits(s: string): string {
    return s.replace(/前\s+(\d+)/g, '前$1');
}

/** 括注内 raw 与表中 raw 比对 */
function normalizeRawForCompare(s: string): string {
    return normalizeQianBeforeArabicDigits(normalizeSpaces(normalizeRawDash(s)));
}

function normalizeLabelForCompare(s: string): string {
    return normalizeSpaces(s.normalize('NFKC'));
}

/** 解析括注内「label, raw」或仅 raw / 仅 label（先 label 后 raw，分隔符 , ，）；忽略多余空白 */
function parseBracketInner(inner: string): { label?: string; raw: string } {
    const t = normalizeSpaces(inner);
    const m = t.match(/^([^,，]+)[,，]([\s\S]+)$/);
    if (m) {
        return { label: m[1].trim(), raw: normalizeSpaces(m[2]) };
    }
    return { raw: t };
}

/** 解析年份 token：前134 / 前 134 → -134；134 → 134；？ → null */
function parseYearToken(tok: string): number | null {
    const t = tok.trim();
    if (t === '？' || t === '?') return null;
    // 允许「130？/前130？」：视为未知端点，返回 null
    if (/^前(\d+)[？\?]$/.test(t) || /^(\d+)[？\?]$/.test(t)) return null;
    const pre = t.match(/^前(\d+)$/);
    if (pre) return -parseInt(pre[1], 10);
    const m = t.match(/^(\d+)$/);
    if (m) return parseInt(m[1], 10);
    return null;
}

/**
 * 从 raw 字符串解析起止年（支持 1573—1620、前134—前129、910—？ 等）。
 * **无 `—` 且仅为一个可解析年份**（如 `710`）时视为**仅一年**：`start === end === 该年`。
 */
function parseRawSpan(raw: string): { start: number | null; end: number | null } {
    const n = normalizeRawDash(raw.trim());
    const parts = n.split(/—/);
    if (parts.length >= 2) {
        return {
            start: parseYearToken(parts[0]),
            end: parseYearToken(parts[1]),
        };
    }
    if (parts.length === 1) {
        const t = parts[0].trim();
        if (t !== '') {
            const y = parseYearToken(t);
            if (y !== null) return { start: y, end: y };
        }
    }
    return { start: null, end: null };
}

/** absYear 是否在 raw 许可区间内 */
function yearInSpan(absYear: number, row: Hai7Row): boolean {
    const { start, end } = parseRawSpan(row.raw);
    if (start === null && end === null) return true;
    if (start !== null && end !== null) {
        const lo = Math.min(start, end);
        const hi = Math.max(start, end);
        return absYear >= lo && absYear <= hi;
    }
    if (start !== null) return absYear >= start;
    if (end !== null) return absYear <= end;
    return true;
}

/** 文档中的 label+raw 是否与表中某行一致（无逗号时：可与 raw 或仅与 label 一致） */
function rowMatchesDoc(row: Hai7Row, doc: { label?: string; raw: string }): boolean {
    if (doc.label !== undefined && doc.label !== '' && doc.raw !== '') {
        const rDoc = normalizeRawForCompare(doc.raw);
        const rRow = normalizeRawForCompare(row.raw);
        if (rDoc !== rRow) return false;
        if (!row.label) return false;
        return normalizeLabelForCompare(doc.label) === normalizeLabelForCompare(row.label);
    }
    if (doc.raw === '') return false;
    if (normalizeRawForCompare(doc.raw) === normalizeRawForCompare(row.raw)) return true;
    if (row.label && normalizeLabelForCompare(doc.raw) === normalizeLabelForCompare(row.label)) return true;
    return false;
}

function anyRowMatches(rows: Hai7Row[], doc: { label?: string; raw: string }): boolean {
    return rows.some((row) => rowMatchesDoc(row, doc));
}

/** 约、或、？：不自动判「核验错误」——与表完全一致则为已核验，否则一律备核 */
const UNCERTAINTY_RE = /[约或？?]/;

function textHasUncertainty(s: string | undefined): boolean {
    if (!s) return false;
    return UNCERTAINTY_RE.test(s);
}

function rowsHaveUncertainty(rows: Hai7Row[]): boolean {
    return rows.some((r) => textHasUncertainty(r.raw) || textHasUncertainty(r.label));
}

function docParsedHasUncertainty(doc: { label?: string; raw: string }): boolean {
    if (doc.label && textHasUncertainty(doc.label)) return true;
    return textHasUncertainty(doc.raw);
}

/** 悬浮/说明：仅列出表中全部条目（先 label 后 raw，与括注约定一致），供人工核对 */
function formatHai7RowLine(r: Hai7Row): string {
    if (r.label && r.label.trim()) return `${r.label.trim()}，${r.raw}`;
    return r.raw;
}

function formatHai7RowsTooltip(kind: '人名' | '年号', key: string, rows: Hai7Row[]): string {
    const body = rows.map((r, i) => `${i + 1}. ${formatHai7RowLine(r)}`).join('\n');
    return `${kind}「${key}」\n${body}`;
}

/** 中文纪年数字 → 整数（元=1，支持十一、二十、二十三、百以内） */
const CJK_DIGIT: Record<string, number> = {
    〇: 0,
    零: 0,
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
};

export function chineseEraYearToInt(s: string): number | null {
    if (!s) return null;
    const t = s.trim();
    if (t === '元') return 1;
    /** 「十」单字须在 length===1 的 CJK_DIGIT 分支之前处理（十 不在 CJK_DIGIT 表内） */
    if (t === '十') return 10;
    if (t.length === 1) {
        const d = CJK_DIGIT[t];
        return d !== undefined && d > 0 ? d : null;
    }
    if (t.startsWith('十')) {
        const u = CJK_DIGIT[t[1]];
        return u !== undefined ? 10 + u : null;
    }
    const i = t.indexOf('十');
    if (i !== -1) {
        const tensPart = t.slice(0, i);
        const onesPart = t.slice(i + 1);
        const tens = tensPart === '' ? 1 : CJK_DIGIT[tensPart];
        if (tens === undefined) return null;
        if (onesPart === '') return tens * 10;
        if (onesPart.length !== 1) return null;
        const ones = CJK_DIGIT[onesPart];
        return ones !== undefined ? tens * 10 + ones : null;
    }
    if (/^[一二三四五六七八九]$/.test(t)) return CJK_DIGIT[t] ?? null;
    return null;
}

/** 括注外「公历」年份：逐位中文数字串 → 非负整数（至少两位） */
function cjkDigitRunToGregorianYear(s: string): number | null {
    const t = s.replace(/\s+/g, '');
    if (t.length < 2) return null;
    let n = 0;
    for (const ch of t) {
        const d = CJK_DIGIT[ch];
        if (d === undefined || d > 9) return null;
        n = n * 10 + d;
    }
    if (n === 0) return null;
    return n;
}

/** 年号在括注内的「第几年」：与 re2/re3 一致 */
const ERA_ORDINAL_CHARS = '元一二三四五六七八九十百千〇零';

/**
 * 括注「年号表述+汉字年次+年」：如 清仁宗嘉庆四年 → phrase=清仁宗嘉庆, yi=4
 */
function splitGregorianEraBracketInner(inner: string): { eraPhrase: string; yi: number } | null {
    const t = inner.trim();
    const rm = t.match(new RegExp(`((?:[${ERA_ORDINAL_CHARS}]\\s*)+)年\\s*$`));
    if (!rm) return null;
    const yi = chineseEraYearToInt(rm[1].replace(/\s+/g, ''));
    if (yi === null) return null;
    const eraPhrase = t.slice(0, t.length - rm[0].length).trim();
    if (!eraPhrase) return null;
    return { eraPhrase, yi };
}

/**
 * label「清仁宗年号」→ 前缀「清仁宗」；与词头拼成「清仁宗嘉庆」。
 * 无 label 或格式不符时退化为仅词头。
 */
function buildFullEraExpressionFromRow(eraKey: string, row: Hai7Row): string {
    const L = row.label?.trim() ?? '';
    if (!L) return eraKey;
    if (L.endsWith('年号')) {
        const prefix = L.slice(0, -2).trim();
        return prefix ? prefix + eraKey : eraKey;
    }
    return L + eraKey;
}

function normalizeEraPhraseToken(s: string): string {
    return normalizeLabelForCompare(s).replace(/\s/g, '');
}

/** 由 label+词头生成正文/括注可出现的外层串（万历、明万历、明朝万历、明神宗万历、明朝神宗万历…） */
function addEraTextSurfaceStringsToSet(variants: Set<string>, eraKey: string, row: Hai7Row): void {
    variants.add(eraKey);
    const L = row.label?.trim() ?? '';
    if (!L.endsWith('年号')) return;
    const P = L.slice(0, -2).trim();
    if (!P) return;
    const units = [...P];
    const d0 = units[0];
    const rest = units.slice(1).join('');
    variants.add(P + eraKey);
    variants.add(d0 + eraKey);
    variants.add(d0 + '朝' + eraKey);
    if (rest.length > 0) {
        variants.add(d0 + '朝' + rest + eraKey);
    }
}

/** 表中该行允许的括注「年号表述」：词头、全称、省一字头、及 T1/T2 外壳变体 */
function collectAllowedBracketEraPhrases(eraKey: string, row: Hai7Row): Set<string> {
    const full = normalizeEraPhraseToken(buildFullEraExpressionFromRow(eraKey, row));
    const k = normalizeEraPhraseToken(eraKey);
    const out = new Set<string>();
    out.add(k);
    out.add(full);
    if (full.length > k.length + 1) {
        const shortened = full.slice(1);
        if (shortened.length >= k.length) out.add(shortened);
    }
    const surf = new Set<string>();
    addEraTextSurfaceStringsToSet(surf, eraKey, row);
    for (const s of surf) out.add(normalizeEraPhraseToken(s));
    return out;
}

function eraBracketPhraseMatchesRow(eraPhrase: string, eraKey: string, row: Hai7Row): boolean {
    const s = normalizeEraPhraseToken(eraPhrase);
    return collectAllowedBracketEraPhrases(eraKey, row).has(s);
}

/** 按词头长度降序，使「开元」优先于「元」 */
function pickEraKeyFromBracketPhrase(eraPhrase: string, keysLongestFirst: string[]): string | null {
    const n = normalizeEraPhraseToken(eraPhrase);
    for (const k of keysLongestFirst) {
        const kk = normalizeEraPhraseToken(k);
        if (n === kk || n.endsWith(kk)) return k;
    }
    return null;
}

/** 紧邻「年（」之前的片段**整段**仅为公历：前99 / 99 / 前中文逐位 / 中文逐位 */
function parseOuterGregorianYearOnly(outerPrefix: string): number | null {
    const t = normalizeSpaces(outerPrefix).replace(/\s+/g, '');
    if (!t) return null;
    const pa = t.match(/^前(\d+)$/);
    if (pa) return -parseInt(pa[1], 10);
    const ma = t.match(/^(\d+)$/);
    if (ma) return parseInt(ma[1], 10);
    const pCjk = t.match(/^前((?:[〇零一二三四五六七八九]){2,})$/);
    if (pCjk) {
        const n = cjkDigitRunToGregorianYear(pCjk[1]);
        return n !== null ? -n : null;
    }
    const cjk = t.match(/^((?:[〇零一二三四五六七八九]){2,})$/);
    if (cjk) return cjkDigitRunToGregorianYear(cjk[1]);
    return null;
}

/**
 * 同上，但允许前缀另有正文：先尝试整段为年；再取**末尾**「前?+阿拉伯（至多六位）/逐位中文（至少两位）」。
 */
function parseGregorianYearSuffixFromOuterPrefix(outerPrefix: string): number | null {
    const whole = parseOuterGregorianYearOnly(outerPrefix);
    if (whole !== null) return whole;
    const t = normalizeSpaces(outerPrefix).replace(/\s+/g, '');
    if (!t) return null;
    const pa = t.match(/前(\d{1,6})$/);
    if (pa) return -parseInt(pa[1], 10);
    const pCjk = t.match(/前((?:[〇零一二三四五六七八九]){2,})$/);
    if (pCjk) {
        const n = cjkDigitRunToGregorianYear(pCjk[1]);
        return n !== null ? -n : null;
    }
    const ma = t.match(/(\d{1,6})$/);
    if (ma) return parseInt(ma[1], 10);
    const cjk = t.match(/((?:[〇零一二三四五六七八九]){2,})$/);
    if (cjk) return cjkDigitRunToGregorianYear(cjk[1]);
    return null;
}

/** outerCompact 可为「缀文+合成锚+汉字年次+年」，自左向右找首个使剩余串匹配「锚+序次+年」的后缀 */
function parseEraCjkOuterSuffix(
    outerCompact: string,
    eraCompositeAlt: string,
    numChars: string,
    eraKeysLongestFirst: string[]
): { eraName: string; yi: number } | null {
    if (!eraCompositeAlt) return null;
    const reEo = new RegExp(`^(${eraCompositeAlt})((?:[${numChars}]\\s*)+)年$`, 'u');
    for (let i = 0; i < outerCompact.length; i++) {
        const sub = outerCompact.slice(i);
        const om = sub.match(reEo);
        if (om) {
            const yi = chineseEraYearToInt(om[2].replace(/\s+/g, ''));
            if (yi === null) continue;
            const eraName = resolveEraKeyFromCompositeMatch(om[1], eraKeysLongestFirst);
            if (eraName) return { eraName, yi };
        }
    }
    return null;
}

/** Form A：…年（…年）；Form B：…年（…\\d+年?）合并为一条（同 span） */
interface MandatoryBracketHit {
    relStart: number;
    relEnd: number;
    full: string;
    outerPrefix: string;
    /** Form A 括注内、末位「年」之前的文字（不含「年」） */
    innerHanCore: string | null;
    /** Form B 括注内末组阿拉伯数字 */
    digitYear: number | null;
}

function collectMandatoryYearBracketHits(text: string): MandatoryBracketHit[] {
    const map = new Map<string, MandatoryBracketHit>();
    let m: RegExpExecArray | null;

    const reA = /([^（(\n]+?)年\s*([（(])([\s\S]+?)年\s*([）)])/gu;
    reA.lastIndex = 0;
    while ((m = reA.exec(text)) !== null) {
        const relStart = m.index;
        const relEnd = m.index + m[0].length;
        const k = `${relStart},${relEnd}`;
        const prev = map.get(k);
        map.set(k, {
            relStart,
            relEnd,
            full: m[0],
            outerPrefix: m[1],
            innerHanCore: m[3],
            digitYear: prev?.digitYear ?? null,
        });
    }

    const reB = /([^（(\n]+?)年\s*([（(])([\s\S]*?)(\d+)(年?)\s*([）)])/gu;
    reB.lastIndex = 0;
    while ((m = reB.exec(text)) !== null) {
        const relStart = m.index;
        const relEnd = m.index + m[0].length;
        const k = `${relStart},${relEnd}`;
        const prev = map.get(k);
        map.set(k, {
            relStart,
            relEnd,
            full: m[0],
            outerPrefix: m[1],
            innerHanCore: prev?.innerHanCore ?? null,
            digitYear: parseInt(m[4], 10),
        });
    }

    return [...map.values()];
}

/** 解析结果可含多条 preferred（同名多项且有一条通过时同时报「已核验」与「多项备核」） */
function resolveMandatoryYearBracketPreferred(
    hit: MandatoryBracketHit,
    era: Record<string, Hai7Row[]>,
    eraKeysLongestFirst: string[],
    eraCompositeAlt: string,
    numChars: string
): { preferred: string | string[]; rawComment?: string } {
    const outerAbs = parseGregorianYearSuffixFromOuterPrefix(hit.outerPrefix);
    const parenIdx = hit.full.search(/[（(]/);
    const innerForUnc = parenIdx >= 0 ? hit.full.slice(parenIdx) : hit.full;

    if (outerAbs !== null && hit.innerHanCore !== null) {
        const innerWith年 = hit.innerHanCore + '年';
        const split = splitGregorianEraBracketInner(innerWith年);
        if (split) {
            const eraKey = pickEraKeyFromBracketPhrase(split.eraPhrase, eraKeysLongestFirst);
            if (eraKey && era[eraKey]?.length) {
                const rows = era[eraKey];
                const rowsPhrase = rows.filter((row) => eraBracketPhraseMatchesRow(split.eraPhrase, eraKey, row));
                const uncertainGr = rowsHaveUncertainty(rows) || textHasUncertainty(innerWith年);
                const tt = formatHai7RowsTooltip('年号', eraKey, rows);
                if (rowsPhrase.length === 0) {
                    return { preferred: uncertainGr ? HAI7_HINT : HAI7_ERR_VERIFY, rawComment: tt };
                }
                const matches = matchingRowsForYearIndex(rowsPhrase, split.yi);
                const hitsY = matches.filter((h) => h.absY === outerAbs);
                if (hitsY.length === 1) return { preferred: HAI7_OK, rawComment: tt };
                if (hitsY.length === 0) return { preferred: uncertainGr ? HAI7_HINT : HAI7_ERR_VERIFY, rawComment: tt };
                return { preferred: [HAI7_OK, HAI7_ERR_MULTI], rawComment: tt };
            }
        }
    }

    if (outerAbs !== null && hit.digitYear !== null) {
        const unc = textHasUncertainty(innerForUnc);
        if (outerAbs === hit.digitYear) return { preferred: HAI7_OK };
        return { preferred: unc ? HAI7_HINT : HAI7_ERR_VERIFY };
    }

    if (eraCompositeAlt && hit.digitYear !== null) {
        const outerCompact = hit.outerPrefix.replace(/\s+/g, '') + '年';
        const parsedEo = parseEraCjkOuterSuffix(outerCompact, eraCompositeAlt, numChars, eraKeysLongestFirst);
        if (parsedEo && !arabicInnerIsYearRange(String(hit.digitYear))) {
            const { eraName, yi } = parsedEo;
            const rows = era[eraName];
            if (rows?.length) {
                const innerTok = String(hit.digitYear);
                const tt = formatHai7RowsTooltip('年号', eraName, rows);
                const prefs = preferredLabelsForEraCjkArabicBracket(rows, yi, innerTok);
                return {
                    preferred: prefs.length === 1 ? prefs[0]! : prefs,
                    rawComment: tt,
                };
            }
        }
    }

    const nodataUnc = textHasUncertainty(hit.full);
    return {
        preferred: nodataUnc ? HAI7_HINT : HAI7_NO_DATA,
        rawComment: '括注纪年：年号表无匹配或无法核验，请人工核对',
    };
}

/** 每条 raw 上推算第 yearIndex 年对应的公历年份，若落在该条 span 内则记入 */
function matchingRowsForYearIndex(rows: Hai7Row[], yearIndex: number): { row: Hai7Row; absY: number }[] {
    const out: { row: Hai7Row; absY: number }[] = [];
    for (const row of rows) {
        const { start } = parseRawSpan(row.raw);
        if (start === null) continue;
        const absY = start + (yearIndex - 1);
        if (yearInSpan(absY, row)) out.push({ row, absY });
    }
    return out;
}

function pushEntry(
    map: Map<string, WordCheckEntry>,
    variant: string,
    preferred: string,
    range: vscode.Range,
    rawComment?: string
): void {
    const key = `${variant}|${preferred}`;
    const existing = map.get(key);
    if (existing) {
        existing.ranges.push(range);
    } else {
        map.set(key, { variant, preferred, ranges: [range], rawComment });
    }
}

/** 表键各字之间允许任意空白，避免「丁 伯根」类无法匹配 */
function keyToFlexiblePattern(key: string): string {
    const chars = [...key];
    if (chars.length === 0) return '';
    return chars.map(escapeRegExp).join('\\s*');
}

function buildFlexibleAlternation(keys: string[]): string {
    const sorted = [...keys].sort((a, b) => b.length - a.length);
    return sorted.map(keyToFlexiblePattern).join('|');
}

/** 年号正则 alternation：词头 + label 派生的 T1/T2 合成串，最长优先 */
function buildEraCompositeAlternation(era: Record<string, Hai7Row[]>): string {
    const variants = new Set<string>();
    for (const [k, rows] of Object.entries(era)) {
        for (const row of rows) {
            addEraTextSurfaceStringsToSet(variants, k, row);
        }
    }
    const sorted = [...variants].sort((a, b) => b.length - a.length);
    return sorted.map(keyToFlexiblePattern).join('|');
}

/** 捕获组匹配到的外层串 → JSON 词头（按词头长度降序取后缀命中） */
function resolveEraKeyFromCompositeMatch(matchedEraPart: string, keysLongestFirst: string[]): string | null {
    const c = normalizeEraPhraseToken(matchedEraPart);
    for (const k of keysLongestFirst) {
        const kk = normalizeEraPhraseToken(k);
        if (c === kk || c.endsWith(kk)) return k;
    }
    return null;
}

/** 匹配到的文本去掉空白后用于查表（与 JSON 键一致） */
function canonicalTableKey(matched: string): string {
    return matched.replace(/\s+/g, '');
}

/** 区间 [a,b) 与任一 [s,e) 相交 */
function rangeOverlapsConsumed(a: number, b: number, consumed: [number, number][]): boolean {
    for (const [s, e] of consumed) {
        if (a < e && b > s) return true;
    }
    return false;
}

/**
 * 人名：（1）Name（括注）核对；（2）无括注的纯人名信息提示。
 * 顺序：先括注（并占用区间），再裸名，避免重叠与重复扫描。
 */
export function scanDocumentHai7Person(
    document: vscode.TextDocument,
    cancelToken?: vscode.CancellationToken,
    range?: vscode.Range
): WordCheckEntry[] {
    const data = getHai7Data();
    if (!data) return [];

    const person = data.person_birth_death;
    const keys = Object.keys(person);
    if (keys.length === 0) return [];

    const scanRange = range ?? new vscode.Range(0, 0, document.lineCount, 0);
    const text = document.getText(scanRange);
    const rangeStartOffset = document.offsetAt(scanRange.start);

    const alt = buildFlexibleAlternation(keys);
    const reParen = new RegExp(`(${alt})\\s*([（(])\\s*([^）)]*?)\\s*([）)])`, 'gu');

    const map = new Map<string, WordCheckEntry>();
    const consumed: [number, number][] = [];

    let m: RegExpExecArray | null;
    reParen.lastIndex = 0;
    while ((m = reParen.exec(text)) !== null) {
        if (cancelToken?.isCancellationRequested) break;
        const name = canonicalTableKey(m[1]);
        const inner = m[3];
        const rows = person[name];
        if (!rows?.length) continue;

        const absStart = rangeStartOffset + m.index;
        const absEnd = absStart + m[0].length;
        consumed.push([absStart, absEnd]);

        const docParsed = parseBracketInner(inner);
        const matched = anyRowMatches(rows, docParsed);
        const ambiguous = rows.length > 1;
        const mismatch = !matched;
        const uncertain = rowsHaveUncertainty(rows) || docParsedHasUncertainty(docParsed);

        const rangeObj = new vscode.Range(document.positionAt(absStart), document.positionAt(absEnd));
        const ttPerson = formatHai7RowsTooltip('人名', name, rows);
        if (!mismatch && !ambiguous) {
            pushEntry(map, m[0], HAI7_OK, rangeObj, ttPerson);
        } else if (!mismatch && ambiguous) {
            pushEntry(map, m[0], HAI7_OK, rangeObj, ttPerson);
            pushEntry(map, m[0], HAI7_ERR_MULTI, rangeObj, ttPerson);
        } else if (mismatch && uncertain) {
            pushEntry(map, m[0], HAI7_HINT, rangeObj, ttPerson);
        } else if (mismatch && ambiguous) {
            pushEntry(map, m[0], HAI7_ERR_BOTH, rangeObj, ttPerson);
        } else {
            pushEntry(map, m[0], HAI7_ERR_VERIFY, rangeObj, ttPerson);
        }
    }

    // 纯人名（后接非括注）：与年号「年号年」提示类似，不标错误
    const reBare = new RegExp(`(${alt})(?!\\s*[（(])`, 'gu');
    reBare.lastIndex = 0;
    while ((m = reBare.exec(text)) !== null) {
        if (cancelToken?.isCancellationRequested) break;
        const name = canonicalTableKey(m[1]);
        const rows = person[name];
        if (!rows?.length) continue;

        const absStart = rangeStartOffset + m.index;
        const absEnd = absStart + m[0].length;
        if (rangeOverlapsConsumed(absStart, absEnd, consumed)) continue;

        const rangeObj = new vscode.Range(document.positionAt(absStart), document.positionAt(absEnd));
        pushEntry(map, m[0], HAI7_HINT, rangeObj, formatHai7RowsTooltip('人名', name, rows));
    }

    return Array.from(map.values());
}

/**
 * 括注中的“单年”年份：
 * - 允许：`130`、`前130`
 * - 允许尾缀问好：`130？/前130？`（视为未知端点，返回 null）
 * - 禁止：`130年`、`前130年`、`前130年后头` 等带「年」或多余文字的写法
 */
function extractYearTokenFromInner(inner: string): number | null {
    const t = normalizeSpaces(inner).replace(/年\s*$/, '').trim();
    if (t === '？' || t === '?') return null;
    // 允许「130？/前130？」：未知端点
    if (/^前(\d+)[？\?]$/.test(t) || /^(\d+)[？\?]$/.test(t)) return null;
    const pre = t.match(/^前(\d+)$/);
    if (pre) return -parseInt(pre[1], 10);
    const m = t.match(/^(\d+)$/);
    if (!m) return null;
    return parseInt(m[1], 10);
}

/** 「年号+汉字第几年+年+括注」：汉字年指具体一年，括注阿拉伯只能是单年，不得为区间 */
function arabicInnerIsYearRange(inner: string): boolean {
    const t = normalizeSpaces(inner);
    const spanM = t.match(/^([^—]+?)\s*—\s*(.+)$/);
    if (!spanM) return false;
    const a = parseYearToken(spanM[1].trim());
    const b = parseYearToken(spanM[2].trim());
    return a !== null && b !== null;
}

/** 括注阿拉伯数字与推算的绝对年份一致（仅单年；区间由调用方先拒绝） */
function arabicMatchesInnerSingleYear(inner: string, absYear: number): boolean {
    const single = extractYearTokenFromInner(inner);
    return single !== null && single === absYear;
}

/**
 * E1 与 G2 共用：汉字序次 yi + 括注阿拉伯单年 vs 各行推算 absY。
 * 表内多条且至少一行与括注阿拉伯一致时返回「已核验」「多项备核」两条。
 */
function preferredLabelsForEraCjkArabicBracket(rows: Hai7Row[], yi: number | null, inner: string): string[] {
    const uncertain = rowsHaveUncertainty(rows) || textHasUncertainty(inner);
    const ambiguous = rows.length > 1;
    const matches = yi !== null ? matchingRowsForYearIndex(rows, yi) : [];

    if (yi !== null && inner.trim() !== '') {
        if (arabicInnerIsYearRange(inner)) {
            return [uncertain ? HAI7_HINT : HAI7_ERR_VERIFY];
        }
        const ok = matches.filter((hit) => arabicMatchesInnerSingleYear(inner, hit.absY));
        if (matches.length === 0) return [uncertain ? HAI7_HINT : HAI7_ERR_VERIFY];
        if (ok.length === 0) return [uncertain ? HAI7_HINT : HAI7_ERR_VERIFY];
        if (ambiguous) return [HAI7_OK, HAI7_ERR_MULTI];
        return [HAI7_OK];
    }

    if (ambiguous && yi !== null) {
        const mm = matchingRowsForYearIndex(rows, yi);
        if (mm.length > 1) return [HAI7_OK, HAI7_ERR_MULTI];
    }
    return [HAI7_OK];
}

/**
 * 年号：E1–E4 表锚，G1/G2 公历括注；见文件头类型表。
 */
export function scanDocumentHai7Era(
    document: vscode.TextDocument,
    cancelToken?: vscode.CancellationToken,
    range?: vscode.Range
): WordCheckEntry[] {
    const data = getHai7Data();
    const era = data?.era_years ?? {};
    const keys = Object.keys(era);
    const eraCompositeAlt = keys.length > 0 ? buildEraCompositeAlternation(era) : '';
    const eraKeysLongestFirst = [...keys].sort((a, b) => b.length - a.length);

    const scanRange = range ?? new vscode.Range(0, 0, document.lineCount, 0);
    const text = document.getText(scanRange);
    const rangeStartOffset = document.offsetAt(scanRange.start);

    const map = new Map<string, WordCheckEntry>();
    /** 已覆盖区间 [start,end)：E1→E4 先于 G，同段内长模式优先 */
    const consumed: [number, number][] = [];

    function markConsumed(a: number, b: number): void {
        consumed.push([a, b]);
    }

    const NUM_CHARS = '元一二三四五六七八九十百千〇零';

    let m: RegExpExecArray | null;

    if (eraCompositeAlt) {
        // E1：T1/T2/T3 + 汉字序 + 年 + 括注（阿拉伯单年）
        const reE1 = new RegExp(
            `(${eraCompositeAlt})((?:[${NUM_CHARS}]\\s*)+)年\\s*([（(])\\s*([^）)]*?)\\s*([）)])`,
            'gu'
        );
        reE1.lastIndex = 0;
        while ((m = reE1.exec(text)) !== null) {
            if (cancelToken?.isCancellationRequested) break;
            const absStart = rangeStartOffset + m.index;
            const absEnd = absStart + m[0].length;
            if (rangeOverlapsConsumed(absStart, absEnd, consumed)) continue;

            const eraName = resolveEraKeyFromCompositeMatch(m[1], eraKeysLongestFirst);
            if (!eraName) continue;
            const rows = era[eraName];
            if (!rows?.length) continue;

            const cjkNum = m[2].replace(/\s+/g, '');
            const inner = m[4];
            const yi = chineseEraYearToInt(cjkNum);
            const labelsE1 = preferredLabelsForEraCjkArabicBracket(rows, yi, inner);
            const rangeObj = new vscode.Range(document.positionAt(absStart), document.positionAt(absEnd));
            const ttE1 = formatHai7RowsTooltip('年号', eraName, rows);
            for (const p of labelsE1) {
                pushEntry(map, m[0], p, rangeObj, ttE1);
            }
            markConsumed(absStart, absEnd);
        }

        // E2：同上 + 可选「年」+ 括注（label/raw）
        const reE2 = new RegExp(`(${eraCompositeAlt})\\s*年?\\s*([（(])\\s*([^）)]*?)\\s*([）)])`, 'gu');
        reE2.lastIndex = 0;
        while ((m = reE2.exec(text)) !== null) {
            if (cancelToken?.isCancellationRequested) break;
            const absStart = rangeStartOffset + m.index;
            const absEnd = absStart + m[0].length;
            if (rangeOverlapsConsumed(absStart, absEnd, consumed)) continue;

            const eraName = resolveEraKeyFromCompositeMatch(m[1], eraKeysLongestFirst);
            if (!eraName) continue;
            const rows = era[eraName];
            if (!rows?.length) continue;

            const inner = m[3];
            const docParsed = parseBracketInner(inner);
            const matched = anyRowMatches(rows, docParsed);
            const ambiguous = rows.length > 1;
            const mismatch = !matched;
            const uncertain = rowsHaveUncertainty(rows) || docParsedHasUncertainty(docParsed);

            markConsumed(absStart, absEnd);

            const rangeObjE2 = new vscode.Range(document.positionAt(absStart), document.positionAt(absEnd));
            const ttE2 = formatHai7RowsTooltip('年号', eraName, rows);
            if (!mismatch && !ambiguous) {
                pushEntry(map, m[0], HAI7_OK, rangeObjE2, ttE2);
            } else if (!mismatch && ambiguous) {
                pushEntry(map, m[0], HAI7_OK, rangeObjE2, ttE2);
                pushEntry(map, m[0], HAI7_ERR_MULTI, rangeObjE2, ttE2);
            } else if (mismatch && uncertain) {
                pushEntry(map, m[0], HAI7_HINT, rangeObjE2, ttE2);
            } else if (mismatch && ambiguous) {
                pushEntry(map, m[0], HAI7_ERR_BOTH, rangeObjE2, ttE2);
            } else {
                pushEntry(map, m[0], HAI7_ERR_VERIFY, rangeObjE2, ttE2);
            }
        }

        // E3：同上 + 汉字序 + 年（无括注）
        const reE3 = new RegExp(`(${eraCompositeAlt})((?:[${NUM_CHARS}]\\s*)+)年`, 'gu');
        reE3.lastIndex = 0;
        while ((m = reE3.exec(text)) !== null) {
            if (cancelToken?.isCancellationRequested) break;
            const absStart = rangeStartOffset + m.index;
            const absEnd = absStart + m[0].length;
            if (rangeOverlapsConsumed(absStart, absEnd, consumed)) continue;

            const eraName = resolveEraKeyFromCompositeMatch(m[1], eraKeysLongestFirst);
            if (!eraName) continue;
            const rows = era[eraName];
            if (!rows?.length) continue;

            const cjkNum = m[2].replace(/\s+/g, '');
            const yi = chineseEraYearToInt(cjkNum);
            if (yi === null) continue;
            const matches = matchingRowsForYearIndex(rows, yi);
            const multiMatch = matches.length > 1;
            const uncertainE3 = rowsHaveUncertainty(rows);

            const rangeObjE3 = new vscode.Range(document.positionAt(absStart), document.positionAt(absEnd));
            const ttE3 = formatHai7RowsTooltip('年号', eraName, rows);
            if (matches.length === 0) {
                pushEntry(map, m[0], uncertainE3 ? HAI7_HINT : HAI7_ERR_VERIFY, rangeObjE3, ttE3);
            } else if (multiMatch) {
                pushEntry(map, m[0], HAI7_OK, rangeObjE3, ttE3);
                pushEntry(map, m[0], HAI7_ERR_MULTI, rangeObjE3, ttE3);
            } else {
                pushEntry(map, m[0], HAI7_OK, rangeObjE3, ttE3);
            }
            markConsumed(absStart, absEnd);
        }

        // E4：同上 + 「年」（弱提示；「年」后为汉字序则跳过）
        const reE4 = new RegExp(`(${eraCompositeAlt})\\s*年`, 'gu');
        reE4.lastIndex = 0;
        while ((m = reE4.exec(text)) !== null) {
            if (cancelToken?.isCancellationRequested) break;
            const absStart = rangeStartOffset + m.index;
            const absEnd = absStart + m[0].length;
            if (rangeOverlapsConsumed(absStart, absEnd, consumed)) continue;

            const eraName = resolveEraKeyFromCompositeMatch(m[1], eraKeysLongestFirst);
            if (!eraName) continue;

            const tail = text.slice(m.index + m[0].length);
            if (tail[0] && /[元一二三四五六七八九十百千〇零]/.test(tail[0])) continue;

            markConsumed(absStart, absEnd);
            const rangeObjE4 = new vscode.Range(document.positionAt(absStart), document.positionAt(absEnd));
            pushEntry(map, m[0], HAI7_HINT, rangeObjE4, formatHai7RowsTooltip('年号', eraName, era[eraName] ?? []));
        }
    }

    // G1/G2：「…年（…年）」「…年（…\\d+年?）」；与 E1–E4 相交则跳过
    const mandatoryHits = collectMandatoryYearBracketHits(text);
    for (const h of mandatoryHits) {
        if (cancelToken?.isCancellationRequested) break;
        const absStart = rangeStartOffset + h.relStart;
        const absEnd = rangeStartOffset + h.relEnd;
        if (rangeOverlapsConsumed(absStart, absEnd, consumed)) continue;
        const resolved = resolveMandatoryYearBracketPreferred(h, era, eraKeysLongestFirst, eraCompositeAlt, NUM_CHARS);
        const rangeObjG = new vscode.Range(document.positionAt(absStart), document.positionAt(absEnd));
        const prefsG = Array.isArray(resolved.preferred) ? resolved.preferred : [resolved.preferred];
        for (const p of prefsG) {
            pushEntry(map, h.full, p, rangeObjG, resolved.rawComment);
        }
        markConsumed(absStart, absEnd);
    }

    return Array.from(map.values());
}
