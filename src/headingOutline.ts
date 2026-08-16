/**
 * 从 Markdown 抽出标题大纲，用于比较两个文件的标题是否一致（切分后按标题合并前）。
 */

import { normalizeLineEndings } from './utils';

export interface OutlineHeading {
    level: number;
    text: string;
    lineNumber: number;
}

export function extractMarkdownHeadings(content: string): OutlineHeading[] {
    const lines = normalizeLineEndings(content).split('\n');
    const out: OutlineHeading[] = [];
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^```/.test(line)) {
            inFence = !inFence;
            continue;
        }
        if (inFence) {
            continue;
        }
        const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
        if (!m) {
            continue;
        }
        const text = m[2].replace(/\s+#+\s*$/, '').trim();
        if (!text) {
            continue;
        }
        out.push({
            level: m[1].length,
            text,
            lineNumber: i + 1,
        });
    }
    return out;
}

export function formatHeadingOutline(headings: OutlineHeading[]): string {
    if (headings.length === 0) {
        return '（无 Markdown 标题）\n';
    }
    return headings
        .map((h) => `${'#'.repeat(h.level)} ${h.text}`)
        .join('\n') + '\n';
}

function normalizeHeadingText(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

export function headingsEqual(a: OutlineHeading, b: OutlineHeading): boolean {
    return a.level === b.level && normalizeHeadingText(a.text) === normalizeHeadingText(b.text);
}

export function firstHeadingMismatchIndex(a: OutlineHeading[], b: OutlineHeading[]): number {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
        if (!headingsEqual(a[i], b[i])) {
            return i;
        }
    }
    return a.length === b.length ? -1 : n;
}

export function formatHeadingMismatchSummary(
    nameA: string,
    nameB: string,
    a: OutlineHeading[],
    b: OutlineHeading[]
): { ok: boolean; message: string } {
    const mismatch = firstHeadingMismatchIndex(a, b);
    if (mismatch < 0) {
        return {
            ok: true,
            message: `两个文件标题一致（各 ${a.length} 个）：${nameA} 与 ${nameB}。`,
        };
    }
    const formatOne = (h: OutlineHeading | undefined, fallback: string) =>
        h ? `${'#'.repeat(h.level)} ${h.text}（第 ${h.lineNumber} 行）` : fallback;
    const at = mismatch + 1;
    const extra =
        a.length !== b.length
            ? `标题数量不同（${nameA} ${a.length} 个，${nameB} ${b.length} 个）。`
            : `标题数量相同（各 ${a.length} 个）。`;
    return {
        ok: false,
        message:
            `${extra}第 ${at} 处不一致：\n` +
            `${nameA}：${formatOne(a[mismatch], '（无）')}\n` +
            `${nameB}：${formatOne(b[mismatch], '（无）')}`,
    };
}
