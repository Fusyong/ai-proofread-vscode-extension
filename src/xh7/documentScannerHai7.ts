/**
 * hai7.json：人名括注、年号与年份核对（自定义检查预置）。
 * 数据：data/hai7.json — person_birth_death、era_years。
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

/** 从 raw 字符串解析起止年（支持 1573—1620、前134—前129、910—？ 等） */
function parseRawSpan(raw: string): { start: number | null; end: number | null } {
    const n = normalizeRawDash(raw.trim());
    const parts = n.split(/—/);
    if (parts.length < 2) return { start: null, end: null };
    return {
        start: parseYearToken(parts[0]),
        end: parseYearToken(parts[1]),
    };
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
    if (t.length === 1) {
        const d = CJK_DIGIT[t];
        return d !== undefined && d > 0 ? d : null;
    }
    if (t === '十') return 10;
    if (t.startsWith('十')) {
        if (t.length === 1) return 10;
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

        let preferred: string;
        if (!mismatch && !ambiguous) preferred = HAI7_OK;
        else if (!mismatch && ambiguous) preferred = HAI7_ERR_MULTI;
        else if (mismatch && uncertain) preferred = HAI7_HINT;
        else if (mismatch && ambiguous) preferred = HAI7_ERR_BOTH;
        else preferred = HAI7_ERR_VERIFY;

        const rangeObj = new vscode.Range(document.positionAt(absStart), document.positionAt(absEnd));

        pushEntry(map, m[0], preferred, rangeObj, formatHai7RowsTooltip('人名', name, rows));
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
    const t = normalizeSpaces(inner);
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
 * 年号：括注核对、汉字年+范围、汉字年+括注阿拉伯一致、年号年提示。
 */
export function scanDocumentHai7Era(
    document: vscode.TextDocument,
    cancelToken?: vscode.CancellationToken,
    range?: vscode.Range
): WordCheckEntry[] {
    const data = getHai7Data();
    if (!data) return [];

    const era = data.era_years;
    const keys = Object.keys(era);
    if (keys.length === 0) return [];

    const scanRange = range ?? new vscode.Range(0, 0, document.lineCount, 0);
    const text = document.getText(scanRange);
    const rangeStartOffset = document.offsetAt(scanRange.start);
    const alt = buildFlexibleAlternation(keys);

    const map = new Map<string, WordCheckEntry>();
    /** 已覆盖区间 [start,end)：先长后短、先括注再裸形式，避免重复命中与无效扫描 */
    const consumed: [number, number][] = [];

    function markConsumed(a: number, b: number): void {
        consumed.push([a, b]);
    }

    const NUM_CHARS = '元一二三四五六七八九十百千〇零';

    let m: RegExpExecArray | null;

    // （3）年号 + 汉字年 + 年 + 括注 — 汉字数字间可插空白
    const re3 = new RegExp(
        `(${alt})((?:[${NUM_CHARS}]\\s*)+)年\\s*([（(])\\s*([^）)]*?)\\s*([）)])`,
        'gu'
    );
    re3.lastIndex = 0;
    while ((m = re3.exec(text)) !== null) {
        if (cancelToken?.isCancellationRequested) break;
        const eraName = canonicalTableKey(m[1]);
        const cjkNum = m[2].replace(/\s+/g, '');
        const inner = m[4];
        const absStart = rangeStartOffset + m.index;
        const absEnd = absStart + m[0].length;
        if (rangeOverlapsConsumed(absStart, absEnd, consumed)) continue;

        const rows = era[eraName];
        if (!rows?.length) continue;

        const yi = chineseEraYearToInt(cjkNum);
        const matches = yi !== null ? matchingRowsForYearIndex(rows, yi) : [];
        let mismatchArabic = false;
        if (yi !== null && inner.trim() !== '') {
            if (arabicInnerIsYearRange(inner)) {
                mismatchArabic = true;
            } else {
                const ok = matches.filter((hit) => arabicMatchesInnerSingleYear(inner, hit.absY));
                if (matches.length === 0) mismatchArabic = true;
                else if (ok.length === 0) mismatchArabic = true;
                else if (ok.length > 1) mismatchArabic = true;
            }
        }

        const uncertainRe3 = rowsHaveUncertainty(rows) || textHasUncertainty(inner);
        const rangeObj3 = new vscode.Range(document.positionAt(absStart), document.positionAt(absEnd));
        if (mismatchArabic) {
            pushEntry(
                map,
                m[0],
                uncertainRe3 ? HAI7_HINT : HAI7_ERR_VERIFY,
                rangeObj3,
                formatHai7RowsTooltip('年号', eraName, rows)
            );
        } else {
            pushEntry(map, m[0], HAI7_OK, rangeObj3, formatHai7RowsTooltip('年号', eraName, rows));
        }
        markConsumed(absStart, absEnd);
    }

    // （1）年号 + 可选「年」+ 括注
    const re1 = new RegExp(`(${alt})\\s*年?\\s*([（(])\\s*([^）)]*?)\\s*([）)])`, 'gu');
    re1.lastIndex = 0;
    while ((m = re1.exec(text)) !== null) {
        if (cancelToken?.isCancellationRequested) break;
        const absStart = rangeStartOffset + m.index;
        const absEnd = absStart + m[0].length;
        if (rangeOverlapsConsumed(absStart, absEnd, consumed)) continue;

        const eraName = canonicalTableKey(m[1]);
        const inner = m[3];
        const rows = era[eraName];
        if (!rows?.length) continue;

        const docParsed = parseBracketInner(inner);
        const matched = anyRowMatches(rows, docParsed);
        const ambiguous = rows.length > 1;
        const mismatch = !matched;
        const uncertain = rowsHaveUncertainty(rows) || docParsedHasUncertainty(docParsed);

        markConsumed(absStart, absEnd);

        let preferred1: string;
        if (!mismatch && !ambiguous) preferred1 = HAI7_OK;
        else if (!mismatch && ambiguous) preferred1 = HAI7_ERR_MULTI;
        else if (mismatch && uncertain) preferred1 = HAI7_HINT;
        else if (mismatch && ambiguous) preferred1 = HAI7_ERR_BOTH;
        else preferred1 = HAI7_ERR_VERIFY;

        const rangeObj = new vscode.Range(document.positionAt(absStart), document.positionAt(absEnd));
        pushEntry(map, m[0], preferred1, rangeObj, formatHai7RowsTooltip('年号', eraName, rows));
    }

    // （2）年号 + 汉字年 + 年（无括注）
    const re2 = new RegExp(`(${alt})((?:[${NUM_CHARS}]\\s*)+)年`, 'gu');
    re2.lastIndex = 0;
    while ((m = re2.exec(text)) !== null) {
        if (cancelToken?.isCancellationRequested) break;
        const absStart = rangeStartOffset + m.index;
        const absEnd = absStart + m[0].length;
        if (rangeOverlapsConsumed(absStart, absEnd, consumed)) continue;

        const eraName = canonicalTableKey(m[1]);
        const cjkNum = m[2].replace(/\s+/g, '');
        const rows = era[eraName];
        if (!rows?.length) continue;

        const yi = chineseEraYearToInt(cjkNum);
        if (yi === null) continue;
        const matches = matchingRowsForYearIndex(rows, yi);
        const multiMatch = matches.length > 1;
        const uncertainRe2 = rowsHaveUncertainty(rows);

        const rangeObj2 = new vscode.Range(document.positionAt(absStart), document.positionAt(absEnd));
        if (matches.length === 0) {
            pushEntry(map, m[0], uncertainRe2 ? HAI7_HINT : HAI7_ERR_VERIFY, rangeObj2, formatHai7RowsTooltip('年号', eraName, rows));
        } else if (multiMatch) {
            pushEntry(map, m[0], HAI7_ERR_MULTI, rangeObj2, formatHai7RowsTooltip('年号', eraName, rows));
        } else {
            pushEntry(map, m[0], HAI7_OK, rangeObj2, formatHai7RowsTooltip('年号', eraName, rows));
        }
        markConsumed(absStart, absEnd);
    }

    // （4）年号 + 年（信息提示，不标为错误）
    const re4 = new RegExp(`(${alt})\\s*年`, 'gu');
    re4.lastIndex = 0;
    while ((m = re4.exec(text)) !== null) {
        if (cancelToken?.isCancellationRequested) break;
        const absStart = rangeStartOffset + m.index;
        const absEnd = absStart + m[0].length;
        if (rangeOverlapsConsumed(absStart, absEnd, consumed)) continue;

        const eraName = canonicalTableKey(m[1]);
        // 完整匹配「年号\s*年」之后：如「万历年间」「万历 年间」在「年」后为「间」等，不能用「年号」截断后判断（会得到「年间」误判）
        const tail = text.slice(m.index + m[0].length);
        if (tail[0] && /[元一二三四五六七八九十百千〇零]/.test(tail[0])) continue;

        markConsumed(absStart, absEnd);
        const rangeObj = new vscode.Range(document.positionAt(absStart), document.positionAt(absEnd));
        pushEntry(map, m[0], HAI7_HINT, rangeObj, formatHai7RowsTooltip('年号', eraName, era[eraName] ?? []));
    }

    return Array.from(map.values());
}
