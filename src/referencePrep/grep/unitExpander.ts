import * as fs from 'fs';
import * as path from 'path';
import { getMarkdownHeadingBreadcrumb, splitChineseSentencesWithLineNumbers } from '../../splitter';
import { normalizeLineEndings } from '../../utils';
import type { RetrievalUnit } from '../schema';

export interface ExpandedUnit {
    startLine: number;
    endLine: number;
    snippet: string;
    headingPath: string;
    paragraphIndex?: number;
    isHeadingOnly: boolean;
    startOffset?: number;
    endOffset?: number;
}

function splitMdParagraphs(text: string): Array<{ startLine: number; endLine: number; text: string }> {
    const norm = normalizeLineEndings(text);
    const lines = norm.split('\n');
    const paras: Array<{ startLine: number; endLine: number; text: string }> = [];
    let start = 0;
    let buf: string[] = [];
    const flush = (endLine: number) => {
        if (buf.length === 0) return;
        paras.push({
            startLine: start + 1,
            endLine: endLine + 1,
            text: buf.join('\n'),
        });
        buf = [];
    };
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === '') {
            flush(i - 1);
            start = i + 1;
        } else {
            if (buf.length === 0) start = i;
            buf.push(lines[i]);
        }
    }
    if (buf.length > 0) flush(lines.length - 1);
    return paras;
}

function expandHeadingSection(norm: string, anchorLine: number): ExpandedUnit {
    const lines = norm.split('\n');
    const idx = anchorLine - 1;
    const headingMatch = lines[idx]?.match(/^(#{1,6})\s+/);
    const level = headingMatch ? headingMatch[1].length : 1;
    let start = idx;
    if (!headingMatch) {
        for (let i = idx; i >= 0; i--) {
            const m = lines[i]?.match(/^(#{1,6})\s+/);
            if (m) {
                start = i;
                break;
            }
        }
    }
    let end = lines.length - 1;
    for (let i = start + 1; i < lines.length; i++) {
        const m = lines[i]?.match(/^(#{1,6})\s+/);
        if (m && m[1].length <= level) {
            end = i - 1;
            break;
        }
    }
    const snippet = lines.slice(start, end + 1).join('\n');
    const { headingPath } = getMarkdownHeadingBreadcrumb(norm, start);
    const isHeadingOnly = snippet.split('\n').every((l) => /^#{1,6}\s+/.test(l.trim()) || l.trim() === '');
    return {
        startLine: start + 1,
        endLine: end + 1,
        snippet,
        headingPath,
        isHeadingOnly,
    };
}

export function expandRetrievalUnit(params: {
    filePath: string;
    anchorLine: number;
    unit: RetrievalUnit;
    contextLines?: number;
}): ExpandedUnit | null {
    let content: string;
    try {
        content = fs.readFileSync(params.filePath, 'utf8');
    } catch {
        return null;
    }
    const norm = normalizeLineEndings(content);
    const lines = norm.split('\n');
    const idx = params.anchorLine - 1;
    if (idx < 0 || idx >= lines.length) return null;

    const unit = params.unit ?? 'line_context';
    const { headingPath } = getMarkdownHeadingBreadcrumb(norm, idx);

    if (unit === 'file_outline') {
        const isHeading = /^#{1,6}\s+/.test(lines[idx]);
        return {
            startLine: params.anchorLine,
            endLine: params.anchorLine,
            snippet: lines[idx],
            headingPath,
            isHeadingOnly: isHeading,
        };
    }

    if (unit === 'heading_section') {
        return expandHeadingSection(norm, params.anchorLine);
    }

    if (unit === 'sentence') {
        const sentences = splitChineseSentencesWithLineNumbers(norm);
        const hit = sentences.find((s) => s.startLine <= params.anchorLine && s.endLine >= params.anchorLine);
        if (hit) {
            return {
                startLine: hit.startLine,
                endLine: hit.endLine,
                snippet: hit.text,
                headingPath,
                isHeadingOnly: false,
                startOffset: hit.startOffset,
                endOffset: hit.endOffset,
            };
        }
    }

    if (unit === 'md_paragraph') {
        const paras = splitMdParagraphs(norm);
        const pIdx = paras.findIndex((p) => p.startLine <= params.anchorLine && p.endLine >= params.anchorLine);
        if (pIdx >= 0) {
            const p = paras[pIdx];
            return {
                startLine: p.startLine,
                endLine: p.endLine,
                snippet: p.text,
                headingPath,
                paragraphIndex: pIdx,
                isHeadingOnly: false,
            };
        }
    }

    const ctx = Math.max(0, params.contextLines ?? 2);
    const start = Math.max(0, idx - ctx);
    const end = Math.min(lines.length - 1, idx + ctx);
    const snippet = lines.slice(start, end + 1).join('\n');
    const isHeadingOnly = snippet.split('\n').every((l) => /^#{1,6}\s+/.test(l.trim()) || l.trim() === '');
    return {
        startLine: start + 1,
        endLine: end + 1,
        snippet,
        headingPath,
        isHeadingOnly,
    };
}

export function unitKey(relPath: string, startLine: number, endLine: number): string {
    return `${relPath}:${startLine}-${endLine}`;
}
