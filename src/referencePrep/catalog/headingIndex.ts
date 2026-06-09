import * as fs from 'fs';
import * as path from 'path';
import { getMarkdownHeadingBreadcrumb } from '../../splitter';
import { normalizeLineEndings } from '../../utils';

export interface HeadingEntry {
    file: string;
    line: number;
    level: number;
    title: string;
    headingPath: string;
}

export function buildHeadingIndexForFile(filePath: string, relPath: string): HeadingEntry[] {
    let content: string;
    try {
        content = fs.readFileSync(filePath, 'utf8');
    } catch {
        return [];
    }
    const norm = normalizeLineEndings(content);
    const lines = norm.split('\n');
    const entries: HeadingEntry[] = [];
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^(#{1,6})\s+(.+)$/);
        if (!m) continue;
        const level = m[1].length;
        const title = m[2].trim().replace(/\s+#+\s*$/, '');
        const { headingPath } = getMarkdownHeadingBreadcrumb(norm, i);
        entries.push({ file: relPath, line: i + 1, level, title, headingPath });
    }
    return entries;
}

export function buildHeadingIndexForFiles(
    referencesRoot: string,
    relPaths: string[]
): HeadingEntry[] {
    const out: HeadingEntry[] = [];
    for (const rel of relPaths) {
        const full = path.join(referencesRoot, rel);
        out.push(...buildHeadingIndexForFile(full, rel));
    }
    return out;
}

export function summarizeHeadingsForPrompt(headings: HeadingEntry[], maxEntries = 60): string {
    if (headings.length === 0) return '(无标题索引)';
    const lines = headings.slice(0, maxEntries).map(
        (h) => `${h.file}:${h.line} [L${h.level}] ${h.headingPath}`
    );
    if (headings.length > maxEntries) {
        lines.push(`... and ${headings.length - maxEntries} more headings`);
    }
    return lines.join('\n');
}
