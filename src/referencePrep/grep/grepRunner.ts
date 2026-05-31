import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as rg from '@vscode/ripgrep';
import type { RawGrepLineHit } from './hitMerger';

function getRgPath(): string {
    return rg.rgPath;
}

function listMdFiles(root: string): string[] {
    const out: string[] = [];
    const exts = new Set(['.md', '.markdown', '.txt']);
    const walk = (dir: string) => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (e.name === 'node_modules' || e.name === '.git') continue;
                walk(full);
            } else if (e.isFile() && exts.has(path.extname(e.name).toLowerCase())) {
                out.push(full);
            }
        }
    };
    walk(root);
    return out;
}

function grepFile(filePath: string, pattern: string, caseInsensitive: boolean): number[] {
    const args = ['--line-number', '--no-heading', '--max-count', '80'];
    if (caseInsensitive) args.push('-i');
    args.push(pattern, filePath);
    const res = spawnSync(getRgPath(), args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    if (res.status !== 0 && !res.stdout) return [];
    const lines: number[] = [];
    for (const row of String(res.stdout || '').split('\n')) {
        const m = row.match(/^(\d+):/);
        if (m) lines.push(parseInt(m[1], 10));
    }
    return lines;
}

/**
 * 在参考文献根目录下检索 md/txt（首期：逐文件 rg，避免复杂 glob）。
 */
export function runGrepInReferences(params: {
    referencesRoot: string;
    patterns: string[];
    patternValue: number;
    contextLines: number;
    maxFiles?: number;
}): RawGrepLineHit[] {
    const root = path.normalize(params.referencesRoot);
    if (!fs.existsSync(root)) return [];

    const files = listMdFiles(root).slice(0, params.maxFiles ?? 200);
    const hits: RawGrepLineHit[] = [];
    const ctx = Math.max(0, params.contextLines ?? 2);

    for (const file of files) {
        let content: string;
        try {
            content = fs.readFileSync(file, 'utf8');
        } catch {
            continue;
        }
        const fileLines = content.split(/\r?\n/);

        for (const pattern of params.patterns) {
            if (!pattern.trim()) continue;
            const matchedLines = grepFile(file, pattern, true);
            for (const lineNo of matchedLines) {
                const idx = lineNo - 1;
                if (idx < 0 || idx >= fileLines.length) continue;
                const start = Math.max(0, idx - ctx);
                const end = Math.min(fileLines.length - 1, idx + ctx);
                const snippet = fileLines.slice(start, end + 1).join('\n');
                hits.push({
                    file: path.relative(root, file) || file,
                    line: lineNo,
                    lineText: snippet,
                    pattern,
                    patternValue: params.patternValue,
                });
            }
        }
    }
    return hits;
}
