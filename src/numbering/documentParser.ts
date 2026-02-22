/**
 * 标题层级与连续性检查：文档解析（解析→简化→排定层级→构建树）
 * 规划见 docs/numbering-hierarchy-check-plan.md 2.4
 */

import * as vscode from 'vscode';
import { normalizeLineEndings } from '../utils';
import { SLOT_TABLE, getSlotById } from './slotTable';
import { extractNumberingValue } from './numberPatterns';
import type { SequenceType } from './types';
import type { NumberingNode, NumberingCategory, ParseOptions } from './types';

/** 单行原始匹配结果 */
interface RawMatch {
    slotId: number;
    subLevel: number;
    numberingText: string;
    numberingValue: number;
    headingPrefix?: string;
}

const DEFAULT_OPTIONS: Required<ParseOptions> = {
    ignoreMarkdownPrefix: true,
    checkScope: 'both',
    headingMaxIndent: 4,
};

/** 从匹配的 numPart 推断 sequenceType（用于第章/第节等混合 slot） */
function inferSequenceType(numPart: string): SequenceType {
    if (/^[壹贰叁肆伍陆柒捌玖拾佰仟]+$/.test(numPart)) return 'chinese-upper';
    if (/^[一二三四五六七八九十百千]+$/.test(numPart)) return 'chinese-lower';
    if (/^[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫ]+$/i.test(numPart)) return 'roman-upper';
    if (/^\d+$/.test(numPart)) return 'arabic';
    return 'chinese-lower';
}

/**
 * 尝试用 slot 表匹配一行，返回第一个匹配
 */
function tryMatchLine(line: string): RawMatch | null {
    for (const slot of SLOT_TABLE) {
        const m = line.match(slot.pattern);
        if (!m) continue;

        let numberingText = '';
        const numPart = (m[2] ?? '').trim();
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
    const rawRows: { lineIndex: number; line: string; match: RawMatch }[] = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const match = tryMatchLine(line);
        if (!match) continue;

        const isHeading = isHeadingPosition(line, opts.headingMaxIndent);
        const category: NumberingCategory = isHeading ? 'heading' : 'intext';
        if (opts.checkScope === 'heading' && category !== 'heading') continue;
        if (opts.checkScope === 'intext' && category !== 'intext') continue;

        rawRows.push({ lineIndex: i, line, match });
    }

    // 2. 构建树（assignedLevel 由 slot 的 baseLevel + subLevel 决定）
    const roots: NumberingNode[] = [];
    const stack: { node: NumberingNode; assignedLevel: number }[] = [];

    for (const row of rawRows) {
        const slot = getSlotById(row.match.slotId);
        const baseLevel = slot?.baseLevel ?? 1;
        const assignedLevel = baseLevel - 1 + row.match.subLevel;

        const range = new vscode.Range(row.lineIndex, 0, row.lineIndex, row.line.length);
        const node: NumberingNode = {
            lineNumber: row.lineIndex + 1,
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
