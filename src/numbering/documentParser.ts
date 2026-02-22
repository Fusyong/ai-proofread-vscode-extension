/**
 * 标题层级与连续性检查：文档解析（解析→简化→排定层级→构建树）
 * 规划见 docs/numbering-hierarchy-check-plan.md 2.4
 */

import * as vscode from 'vscode';
import { normalizeLineEndings } from '../utils';
import { SLOT_TABLE, getSlotById, type SlotDef } from './slotTable';
import { getEffectiveSlotById, getCustomSlotsFromConfig, getCustomInlinePatternsFromConfig } from './slotResolver';
import { extractNumberingValue } from './numberPatterns';
import type { SequenceType } from './types';
import type { NumberingNode, NumberingCategory, ParseOptions, SegmentNode } from './types';

/** 单行原始匹配结果 */
interface RawMatch {
    slotId: number;
    subLevel: number;
    numberingText: string;
    numberingValue: number;
    headingPrefix?: string;
}

const DEFAULT_OPTIONS: Required<Omit<ParseOptions, 'lineOffset'>> & { lineOffset?: number } = {
    ignoreMarkdownPrefix: true,
    checkScope: 'both',
    headingMaxIndent: 4,
    lineOffset: 0,
};

/** 从匹配的 numPart 推断 sequenceType（用于第章/第节等混合 slot） */
function inferSequenceType(numPart: string): SequenceType {
    if (/^[壹贰叁肆伍陆柒捌玖拾佰仟]+$/.test(numPart)) return 'chinese-upper';
    if (/^[一二三四五六七八九十百千]+$/.test(numPart)) return 'chinese-lower';
    if (/^[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫ]+$/i.test(numPart)) return 'roman-upper';
    if (/^\d+$/.test(numPart)) return 'arabic';
    return 'chinese-lower';
}

/** 匹配时忽略原文中的空白字符（用于自定义层级） */
function normalizeForMatch(line: string): string {
    return line.replace(/\s+/g, '');
}

/** 一行内可多次匹配的序号模式（无 ^$ 锚定，用于段内多序号） */
const INLINE_PATTERNS: { slotId: number; pattern: RegExp; sequenceType: SequenceType }[] = [
    { slotId: 4, pattern: /(?<![\u4e00-\u9fa5])([一二三四五六七八九十百千]+)、/g, sequenceType: 'chinese-lower' },
    { slotId: 15, pattern: /(?<![\u4e00-\u9fa5])第([一二三四五六七八九十百千]+)[，,]/g, sequenceType: 'chinese-lower' },
    { slotId: 16, pattern: /(?<![\u4e00-\u9fa5])其([一二三四五六七八九十百千]+)[，,]/g, sequenceType: 'chinese-lower' },
    { slotId: 13, pattern: /(?<![0-9])(\d+)\.(?![0-9])/g, sequenceType: 'arabic' },
    { slotId: 14, pattern: /(?<![A-Z])([A-Z])\.(?![A-Z])/g, sequenceType: 'latin-upper' },
    { slotId: 5, pattern: /[(\（﹙]([一二三四五六七八九十百千]+)[)\）﹚]/g, sequenceType: 'chinese-lower' },
    { slotId: 6, pattern: /([㈠㈡㈢㈣㈤㈥㈦㈧㈨㈩㈪㈫㈬㈭㈮㈯㈰㈱㈲㈳㈴㈵㈶㈷㈸㈹㈺㈻㈼㈽㈾㈿㉀㉁㉂㉃㉄㉅㉆㉇㉈㉉㉊㉋㉌㉍㉎㉏㉐㉑㉒㉓㉔㉕㉖㉗㉘㉙㉚㉛㉜㉝㉞㉟])/g, sequenceType: 'circled' },
    { slotId: 9, pattern: /[(\（﹙](\d+)[)\）﹚]/g, sequenceType: 'arabic' },
    { slotId: 10, pattern: /([⑴⑵⑶⑷⑸⑹⑺⑻⑼⑽⑾⑿⒀⒁⒂⒃⒄⒅⒆⒇])/g, sequenceType: 'circled' },
    { slotId: 11, pattern: /([①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳㉑㉒㉓㉔㉕㉖㉗㉘㉙㉚㉛㉜㉝㉞㉟㊱㊲㊳㊴㊵㊶㊷㊸㊹㊺㊻㊼㊽㊾㊿])/g, sequenceType: 'circled' },
];

/** 一行内查找所有序号匹配（用于段内多序号）：预置 + 用户自定义 customInlinePatterns */
function tryMatchAllInLine(line: string): { match: RawMatch; startIndex: number }[] {
    const results: { match: RawMatch; startIndex: number }[] = [];
    const allPatterns = [
        ...INLINE_PATTERNS.map((p) => ({ slotId: p.slotId, pattern: p.pattern, sequenceType: p.sequenceType })),
        ...getCustomInlinePatternsFromConfig().map((c) => ({ slotId: c.slotId, pattern: c.pattern, sequenceType: c.sequenceType })),
    ];
    for (const { slotId, pattern, sequenceType } of allPatterns) {
        const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
        const re = new RegExp(pattern.source, flags);
        let m: RegExpExecArray | null;
        while ((m = re.exec(line)) !== null) {
            const numPart = (m[2] ?? m[1] ?? m[0] ?? '').trim();
            const numberingText = m[0];
            const value = extractNumberingValue(m, sequenceType, numberingText);
            results.push({
                startIndex: m.index,
                match: {
                    slotId,
                    subLevel: 0,
                    numberingText,
                    numberingValue: value,
                    headingPrefix: undefined,
                },
            });
        }
    }
    results.sort((a, b) => a.startIndex - b.startIndex);
    return results;
}

/**
 * 尝试用 slot 表匹配一行，返回第一个匹配
 * 预置 slot 按原文匹配；自定义 slot 匹配时忽略空白
 */
function tryMatchLine(line: string): RawMatch | null {
    for (const slot of SLOT_TABLE) {
        const m = line.match(slot.pattern);
        if (!m) continue;

        let numberingText = '';
        const numPart = (m[2] ?? m[1] ?? '').trim();
        if (slot.sequenceType === 'arabic' && slot.multiLevel) {
            const numMatch = line.match(/\d+([.．]\d+)*[.．]?/);
            numberingText = numMatch?.[0] ?? numPart;
        } else if (slot.marker === '点' && slot.sequenceType === 'latin-upper') {
            const dotMatch = line.match(/[A-Z]+[.．]?/);
            numberingText = dotMatch?.[0] ?? numPart;
        } else if (slot.sequenceType === 'arabic' && slot.marker === '§') {
            const secMatch = line.match(/§\s*\d+([.．]\d+)*/);
            numberingText = secMatch?.[0] ?? numPart;
        } else if (slot.marker === '第章') {
            numberingText = `第${numPart}章`;
        } else if (slot.marker === '第节') {
            numberingText = `第${numPart}节`;
        } else if (slot.marker === '括' && slot.sequenceType) {
            const parenMatch = line.match(/[(\（﹙][^)\）﹚]*[)\）﹚]/);
            numberingText = parenMatch?.[0] ?? `(${numPart})`;
        } else if (slot.slotId === 13 || slot.slotId === 14) {
            numberingText = numPart + '.';
        } else if (slot.slotId === 15) {
            numberingText = `第${numPart}${m[3] ?? '，'}`;
        } else if (slot.slotId === 16) {
            numberingText = `其${numPart}${m[3] ?? '，'}`;
        } else {
            numberingText = numPart;
        }

        const seqType = (slot.sequenceType ?? (slot.marker === '第章' || slot.marker === '第节' ? inferSequenceType(numPart) : 'circled')) as SequenceType;
        const value = extractNumberingValue(m, seqType, numberingText);

        let subLevel = 0;
        if (slot.multiLevel) {
            if (slot.sequenceType === 'arabic' && slot.marker === '点') {
                const parts = line.match(/\d+([.．]\d+)*[.．]?/)?.[0]?.split(/[.．]/).filter(Boolean) ?? [];
                subLevel = Math.max(0, parts.length - 1);
            } else if (slot.sequenceType === 'arabic' && slot.marker === '§') {
                const parts = line.match(/§\s*\d+([.．]\d+)*/)?.[0]?.match(/\d+/g) ?? [];
                subLevel = Math.max(0, parts.length - 1);
            } else {
                const dots = line.match(/[.．]/g);
                subLevel = dots ? dots.length : 0;
            }
        }

        const headingPrefix = m[1]?.trim();

        return {
            slotId: slot.slotId,
            subLevel,
            numberingText,
            numberingValue: value,
            headingPrefix: headingPrefix || undefined,
        };
    }

    const customSlots = getCustomSlotsFromConfig();
    const normalizedLine = normalizeForMatch(line);
    for (const slot of customSlots) {
        const m = normalizedLine.match(slot.pattern);
        if (!m) continue;
        const numPart = (m[2] ?? m[1] ?? '').trim();
        const seqType = (slot.sequenceType ?? 'arabic') as SequenceType;
        const numberingText = (m[0] ?? numPart).trim();
        const value = extractNumberingValue(m, seqType, numPart || numberingText);
        return {
            slotId: slot.slotId,
            subLevel: 0,
            numberingText,
            numberingValue: value,
            headingPrefix: undefined,
        };
    }
    return null;
}

/**
 * 判断是否为标题序号（行首、缩进不超过阈值）
 */
function isHeadingPosition(line: string, maxIndent: number): boolean {
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;
    return indent <= maxIndent;
}

/**
 * 解析文档，构建 NumberingNode 树
 * 流程：解析 → 简化 → 排定层级 → 构建树
 */
export function parseDocument(
    text: string,
    options: ParseOptions = {}
): NumberingNode[] {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const normalized = normalizeLineEndings(text);
    const lines = normalized.split('\n');

    // 1. 解析：收集所有匹配行
    const rawRows: { lineIndex: number; line: string; match: RawMatch; charStart?: number }[] = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (opts.skipMarkdownHeadingLines && line.trimStart().startsWith('#')) continue;

        if (opts.multiMatchPerLine) {
            const allMatches = tryMatchAllInLine(line);
            for (const { match, startIndex } of allMatches) {
                rawRows.push({ lineIndex: i, line, match, charStart: startIndex });
            }
        } else {
            const match = tryMatchLine(line);
            if (!match) continue;
            const isHeading = isHeadingPosition(line, opts.headingMaxIndent);
            const category: NumberingCategory = isHeading ? 'heading' : 'intext';
            if (opts.checkScope === 'heading' && category !== 'heading') continue;
            if (opts.checkScope === 'intext' && category !== 'intext') continue;
            rawRows.push({ lineIndex: i, line, match });
        }
    }

    // 2. 构建树（assignedLevel 由 slot 的 baseLevel + subLevel 决定）
    const roots: NumberingNode[] = [];
    const stack: { node: NumberingNode; assignedLevel: number }[] = [];

    for (const row of rawRows) {
        const slot = getEffectiveSlotById(row.match.slotId);
        const baseLevel = slot?.baseLevel ?? 1;
        const assignedLevel = baseLevel - 1 + row.match.subLevel;

        const offset = opts.lineOffset ?? 0;
        const lineIdx = row.lineIndex + offset;
        const charStart = row.charStart ?? 0;
        const charEnd = charStart + row.match.numberingText.length;
        const range = new vscode.Range(lineIdx, charStart, lineIdx, charEnd);
        const node: NumberingNode = {
            lineNumber: row.lineIndex + 1 + offset,
            lineText: row.line,
            category: isHeadingPosition(row.line, opts.headingMaxIndent) ? 'heading' : 'intext',
            headingPrefix: opts.ignoreMarkdownPrefix ? row.match.headingPrefix : undefined,
            numberingText: row.match.numberingText,
            numberingValue: row.match.numberingValue,
            slotId: row.match.slotId,
            assignedLevel,
            level: assignedLevel,
            children: [],
            range,
        };

        while (stack.length > 0 && stack[stack.length - 1].assignedLevel >= assignedLevel) {
            stack.pop();
        }

        if (stack.length === 0) {
            roots.push(node);
        } else {
            stack[stack.length - 1].node.children.push(node);
        }
        stack.push({ node, assignedLevel });
    }

    return roots;
}

/** 收集树中所有节点（文档顺序） */
function collectNodesInOrder(roots: NumberingNode[]): NumberingNode[] {
    const out: NumberingNode[] = [];
    function walk(n: NumberingNode) {
        out.push(n);
        for (const c of n.children) walk(c);
    }
    for (const r of roots) walk(r);
    return out;
}

/** 若段落头部第一个匹配是孤立的（无同级别其他匹配），则移除它并将其子节点提升为根 */
function dropIsolatedFirstMatch(roots: NumberingNode[]): NumberingNode[] {
    if (roots.length === 0) return roots;
    const all = collectNodesInOrder(roots);
    const first = all[0];
    const key = `${first.slotId}:${first.assignedLevel}`;
    const sameLevel = all.filter((n) => `${n.slotId}:${n.assignedLevel}` === key);
    if (sameLevel.length > 1) return roots;

    const firstRoot = roots[0];
    return [...firstRoot.children, ...roots.slice(1)];
}

/**
 * 按段解析：以空行分隔，每段一个根节点，仅检测段内（文中）序号
 */
export function parseDocumentBySegments(
    text: string,
    options: ParseOptions = {}
): SegmentNode[] {
    const opts = { ...DEFAULT_OPTIONS, ...options, checkScope: 'intext' as const };
    const normalized = normalizeLineEndings(text);
    const lines = normalized.split('\n');

    const segments: { startLine: number; endLine: number; lines: string[] }[] = [];
    let current: string[] = [];
    let currentStart = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === '') {
            if (current.length > 0) {
                segments.push({ startLine: currentStart, endLine: i - 1, lines: current });
                current = [];
            }
        } else {
            if (current.length === 0) currentStart = i;
            current.push(line);
        }
    }
    if (current.length > 0) {
        segments.push({ startLine: currentStart, endLine: lines.length - 1, lines: current });
    }

    const result: SegmentNode[] = [];
    for (let si = 0; si < segments.length; si++) {
        const seg = segments[si];
        const segmentText = seg.lines.join('\n');
        let roots = parseDocument(segmentText, {
            ...opts,
            lineOffset: seg.startLine,
            skipMarkdownHeadingLines: true,
            multiMatchPerLine: true,
        });
        roots = dropIsolatedFirstMatch(roots);
        if (roots.length === 0) continue;

        const firstLine = seg.lines[0];
        const preview = firstLine.length > 20 ? firstLine.slice(0, 20) + '…' : firstLine;
        result.push({
            segmentIndex: si + 1,
            startLine: seg.startLine + 1,
            endLine: seg.endLine + 1,
            preview,
            children: roots,
            range: new vscode.Range(seg.startLine, 0, seg.endLine, seg.lines[seg.lines.length - 1].length),
        });
    }
    return result;
}
