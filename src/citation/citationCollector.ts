/**
 * 引文收集：引号内文本、块引用（>），分句与可能非引文标记
 * 计划见 docs/citation-verification-plan.md 阶段 2
 */

import * as vscode from 'vscode';
import { splitChineseSentencesWithLineNumbers, splitChineseSentencesSimple } from '../splitter';
import { normalizeForSimilarity, NormalizeForSimilarityOptions } from '../similarity';

/** 引文条目（块级） */
export interface CitationEntry {
    uri: vscode.Uri;
    text: string;
    startLine: number;
    endLine: number;
    range?: vscode.Range;
    type: 'quote' | 'blockquote';
    confidence?: 'citation' | 'maybe' | 'likely_not';
    reason?: string;
    /** 引文注码（若有）：[^1]、^1^、①②③ 等 */
    footnoteMarker?: string;
    /** 注码在文档中的范围 */
    footnoteMarkerRange?: vscode.Range;
}

/** 引文句（块内分句后，用于匹配） */
export interface CitationSentence {
    blockId: string;
    sentenceIndex: number;
    text: string;
    normalized: string;
    lenNorm: number;
    startLine: number;
    endLine: number;
    range?: vscode.Range;
}

/** 带分句的引文块 */
export interface CitationBlockWithSentences {
    entry: CitationEntry;
    sentences: CitationSentence[];
}

/** 引号对元组：左、右（多种引号统一参与嵌套匹配） */
const QUOTE_PAIRS: [string, string][] = [
    ['「', '」'],
    ['『', '』'],
    ['\u201C', '\u201D'], // “ ” 弯双引号
    ['\u2018', '\u2019'], // ‘’ 弯单引号
    ['\u0022', '\u0022'], // ASCII 直双引号 "
    ['\u0027', '\u0027'], // ASCII 直单引号 '
];

/** 引文注码形式：Markdown 脚注 [^1][^abc]、上标 ^1^ ^abc^、圈码 ①②③…（排除空白干扰） */
const FOOTNOTE_MARKER_PATTERNS: RegExp[] = [
    /\[\^[^\]]*\]/,       // [^1] [^abc]
    /\^[^\^]+\^/,         // ^1^ ^abc^
    /[\u2460-\u2473]+/,   // ①-⑳
];

/** 在 text 中从 offset 起跳过空白后匹配第一个注码，返回 { marker, start, end }（须用 g 正则以便 exec 从 lastIndex 起搜） */
function findFootnoteMarkerAfter(text: string, offset: number): { marker: string; start: number; end: number } | null {
    let i = offset;
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) return null;
    for (const re of FOOTNOTE_MARKER_PATTERNS) {
        const copy = new RegExp(re.source, (re.flags || '').includes('g') ? re.flags : re.flags + 'g');
        copy.lastIndex = i;
        const m = copy.exec(text);
        if (m && m.index === i) {
            return { marker: m[0], start: m.index, end: m.index + m[0].length };
        }
    }
    return null;
}

/** 在 text[0..offset] 中找最右侧的注码，且注码结束位置到 offset 之间仅空白，返回 { marker, start, end } */
function findFootnoteMarkerBefore(text: string, offset: number): { marker: string; start: number; end: number } | null {
    const segment = text.slice(0, offset);
    let best: { marker: string; start: number; end: number } | null = null;
    for (const re of FOOTNOTE_MARKER_PATTERNS) {
        const copy = new RegExp(re.source, 'g');
        let m: RegExpExecArray | null;
        while ((m = copy.exec(segment)) !== null) {
            const afterEnd = segment.slice(m.index + m[0].length);
            if (/^\s*$/.test(afterEnd) || afterEnd === '') {
                if (!best || m.index + m[0].length > best.end) {
                    best = { marker: m[0], start: m.index, end: m.index + m[0].length };
                }
            }
        }
    }
    return best;
}

/** 在「从 offset 到该行末尾」的片段内查找注码：先引号后，再断句后（用分句函数判断），避免跨行误匹配 */
function findFootnoteMarkerInLineAfter(text: string, offset: number): { marker: string; start: number; end: number } | null {
    const lineEnd = text.indexOf('\n', offset);
    const segmentEnd = lineEnd === -1 ? text.length : lineEnd;
    const segment = text.slice(offset, segmentEnd);
    let result = findFootnoteMarkerAfter(text, offset);
    if (result && result.end <= segmentEnd) return result;
    const sentences = splitChineseSentencesSimple(segment);
    if (sentences.length > 0) {
        const firstSentenceEndOffset = offset + sentences[0].length;
        if (firstSentenceEndOffset < segmentEnd) {
            result = findFootnoteMarkerAfter(text, firstSentenceEndOffset);
            if (result && result.end <= segmentEnd) return result;
        }
    }
    return null;
}

/** 在块内文本末尾查找注码：找最右侧的、且其后仅空白的注码（如 "…老何为？①" 中的 ①） */
function findFootnoteMarkerAtEnd(blockText: string): { marker: string; start: number; end: number } | null {
    let best: { marker: string; start: number; end: number } | null = null;
    for (const re of FOOTNOTE_MARKER_PATTERNS) {
        const copy = new RegExp(re.source, 'g');
        let m: RegExpExecArray | null;
        while ((m = copy.exec(blockText)) !== null) {
            const afterEnd = blockText.slice(m.index + m[0].length);
            if (/^\s*$/.test(afterEnd) || afterEnd === '') {
                if (!best || m.index + m[0].length > best.end) {
                    best = { marker: m[0], start: m.index, end: m.index + m[0].length };
                }
            }
        }
    }
    return best;
}

/** 为引文条目挂接注码：块引用在块末尾（含块内末尾）或块后查找；引号引文在引号后、引号前、或第一个分句位置后查找（跳过空白） */
function attachFootnoteMarker(
    entry: CitationEntry,
    document: vscode.TextDocument,
    quoteStartOffset?: number,
    quoteEndOffset?: number
): void {
    const text = document.getText();
    let result: { marker: string; start: number; end: number } | null = null;

    if (entry.type === 'blockquote') {
        // 块引用只看块内末尾的注码（如 ①），不看块后
        const atEnd = findFootnoteMarkerAtEnd(entry.text);
        if (atEnd && entry.range) {
            const startOff = document.offsetAt(entry.range.start);
            result = {
                marker: atEnd.marker,
                start: startOff + atEnd.start,
                end: startOff + atEnd.end
            };
        }
    } else if (quoteStartOffset !== undefined && quoteEndOffset !== undefined) {
        // 引号引文：引文末尾不是合法断句位置时，注码可能在引号后，也可能在「其后最近一个断句位置」后
        // 限定同行内查找，避免误匹配下一行脚注定义（如 [^a]:）
        result = findFootnoteMarkerInLineAfter(text, quoteEndOffset);
        if (!result) result = findFootnoteMarkerBefore(text, quoteStartOffset);
    }

    if (result) {
        entry.footnoteMarker = result.marker;
        entry.footnoteMarkerRange = new vscode.Range(
            document.positionAt(result.start),
            document.positionAt(result.end)
        );
    }
}

/**
 * 收集引号内文本（仅第一层）：按引号对元组 + 栈，单遍扫描。
 * - 遇到任意左引号 → 入栈并记下位置；若栈原为空则记为该段“最外层”起点。
 * - 遇到任意右引号 → 在栈中结束最近一个同对旗标（弹出）；若弹出后栈空则记录一条第一层引文。
 */
export function collectQuotedCitations(document: vscode.TextDocument): CitationEntry[] {
    const raw: CitationEntry[] = [];
    const text = document.getText();
    const pairs = QUOTE_PAIRS;

    /** 栈：未闭合的左引号，每项为 { pairIndex, start } */
    const stack: { pairIndex: number; start: number }[] = [];
    let outerStart = -1;
    let outerPairIndex = -1;

    let i = 0;
    while (i < text.length) {
        let matched = false;

        // 1. 先检查右引号：结束最近一个同对旗标
        for (let k = 0; k < pairs.length; k++) {
            const right = pairs[k][1];
            if (text.slice(i, i + right.length) !== right) continue;
            for (let j = stack.length - 1; j >= 0; j--) {
                if (stack[j].pairIndex === k) {
                    stack.splice(j, 1);
                    if (stack.length === 0) {
                        const [oL, oR] = pairs[outerPairIndex];
                        const content = text.slice(outerStart + oL.length, i);
                        const endInclusive = i + right.length;
                        const entry: CitationEntry = {
                            uri: document.uri,
                            text: content,
                            startLine: document.positionAt(outerStart).line + 1,
                            endLine: document.positionAt(endInclusive - 1).line + 1,
                            range: new vscode.Range(
                                document.positionAt(outerStart),
                                document.positionAt(endInclusive)
                            ),
                            type: 'quote'
                        };
                        attachFootnoteMarker(entry, document, outerStart, endInclusive);
                        raw.push(entry);
                    }
                    i += right.length;
                    matched = true;
                    break;
                }
            }
            if (matched) break;
        }
        if (matched) continue;

        // 2. 再检查左引号：建立引用旗标
        for (let k = 0; k < pairs.length; k++) {
            const left = pairs[k][0];
            if (text.slice(i, i + left.length) !== left) continue;
            if (stack.length === 0) {
                outerStart = i;
                outerPairIndex = k;
            }
            stack.push({ pairIndex: k, start: i });
            i += left.length;
            matched = true;
            break;
        }
        if (matched) continue;

        i++;
    }

    return raw.sort((a, b) => a.startLine - b.startLine);
}

/** 收集连续以 > 开头的块引用 */
export function collectBlockquoteCitations(document: vscode.TextDocument): CitationEntry[] {
    const entries: CitationEntry[] = [];
    const lines = document.getText().split(/\r?\n/);
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        const trimmed = line.trimStart();
        if (trimmed.startsWith('>')) {
            const startLine = i + 1;
            const parts: string[] = [];
            while (i < lines.length && lines[i].trimStart().startsWith('>')) {
                const ln = lines[i];
                const afterMarker = ln.replace(/^[\s>]*/, '');
                parts.push(afterMarker);
                i++;
            }
            const endLine = i;
            const blockText = parts.join('\n');
            const startOffset = document.offsetAt(new vscode.Position(startLine - 1, 0));
            const endOffset = document.offsetAt(new vscode.Position(endLine - 1, lines[endLine - 1].length));
            const entry: CitationEntry = {
                uri: document.uri,
                text: blockText,
                startLine,
                endLine,
                range: new vscode.Range(document.positionAt(startOffset), document.positionAt(endOffset)),
                type: 'blockquote'
            };
            attachFootnoteMarker(entry, document);
            entries.push(entry);
        } else {
            i++;
        }
    }
    return entries;
}

/** 合并引号与块引用，并标记可能非引文；按配置忽略过短或末尾无注码的引文，不列入结果 */
export function collectAllCitations(document: vscode.TextDocument): CitationEntry[] {
    const quoted = collectQuotedCitations(document);
    const blockquote = collectBlockquoteCitations(document);
    const config = vscode.workspace.getConfiguration('ai-proofread.citation');
    const minLen = Math.max(0, config.get<number>('minCitationLength', 5));
    const ignoredTypes = new Set(
        config.get<string[]>('ignoredCitationTypes', ['short']).filter((s): s is 'short' | 'noFootnote' =>
            s === 'short' || s === 'noFootnote'
        )
    );
    const merged: CitationEntry[] = [];
    const seen = new Set<string>();

    for (const e of [...quoted, ...blockquote]) {
        if (ignoredTypes.has('short') && e.text.trim().length < minLen) continue;
        if (ignoredTypes.has('noFootnote') && !e.footnoteMarker) continue;
        const key = `${e.startLine}-${e.endLine}-${e.text.slice(0, 20)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const withConfidence = applyConfidence(e);
        merged.push(withConfidence);
    }

    return merged.sort((a, b) => a.startLine - b.startLine);
}

function applyConfidence(entry: CitationEntry): CitationEntry {
    const t = entry.text.trim();
    const config = vscode.workspace.getConfiguration('ai-proofread.citation');
    const minLen = Math.max(0, config.get<number>('minCitationLength', 5));
    if (t.length < minLen) {
        return { ...entry, confidence: 'likely_not', reason: `长度小于 ${minLen} 字` };
    }
    const digitsPunct = (t.match(/[\d０-９\p{P}\s]/gu) ?? []).join('').length;
    if (t.length > 0 && digitsPunct / t.length >= 0.9) {
        return { ...entry, confidence: 'likely_not', reason: '绝大部分为数字或标点' };
    }
    return { ...entry, confidence: 'citation' };
}

/** 对每条引文块分句并归一化，得到 CitationBlockWithSentences；引文句的 startLine/endLine 为文档内行号 */
export function splitCitationBlocksIntoSentences(
    entries: CitationEntry[],
    normalizeOptions: NormalizeForSimilarityOptions
): CitationBlockWithSentences[] {
    const result: CitationBlockWithSentences[] = [];
    for (let b = 0; b < entries.length; b++) {
        const entry = entries[b];
        const text = entry.text.replace(/\r\n/g, '\n');
        const sentencesWithLines = splitChineseSentencesWithLineNumbers(text, true);
        const sentences: CitationSentence[] = [];
        const lineOffset = entry.startLine - 1; // 块内行号 1-based → 文档行 0-based 的偏移
        for (let s = 0; s < sentencesWithLines.length; s++) {
            const [sentenceText, startLineInBlock, endLineInBlock] = sentencesWithLines[s];
            const trimmed = sentenceText.trim();
            if (!trimmed) continue;
            const normalized = normalizeForSimilarity(trimmed, normalizeOptions);
            const docStartLine = lineOffset + startLineInBlock;
            const docEndLine = lineOffset + endLineInBlock;
            sentences.push({
                blockId: `block-${b}`,
                sentenceIndex: s,
                text: trimmed,
                normalized,
                lenNorm: normalized.length,
                startLine: docStartLine,
                endLine: docEndLine
            });
        }
        result.push({ entry, sentences });
    }
    return result;
}
