import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { spawnSync } from 'child_process';
import type { RawGrepLineHit } from './hitMerger';
import { getGrepMaxFiles } from '../config';

let cachedRgPath: string | undefined;

function getRgPath(): string {
    if (cachedRgPath) {
        return cachedRgPath;
    }
    const extRoot = path.resolve(__dirname, '..');
    try {
        const req = createRequire(path.join(extRoot, 'package.json'));
        const rg = req('@vscode/ripgrep') as { rgPath?: string };
        const p = rg?.rgPath;
        if (p && fs.existsSync(p)) {
            cachedRgPath = p;
            return cachedRgPath;
        }
    } catch {
        /* fallback */
    }
    cachedRgPath = process.platform === 'win32' ? 'rg.exe' : 'rg';
    return cachedRgPath;
}

function listMdFiles(root: string, scopePaths?: string[]): string[] {
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

    if (scopePaths?.length) {
        const normalized = scopePaths.map((p) => p.replace(/\\/g, '/'));
        return out.filter((full) => {
            const rel = path.relative(root, full).replace(/\\/g, '/');
            return normalized.some((sp) => rel === sp || rel.startsWith(sp + '/'));
        });
    }
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

export function buildRgCommand(filePath: string, pattern: string, caseInsensitive: boolean): string {
    const args = ['--line-number', '--no-heading', '--max-count', '80'];
    if (caseInsensitive) args.push('-i');
    args.push(JSON.stringify(pattern), JSON.stringify(filePath));
    return `rg ${args.join(' ')}`;
}

export function runGrepInReferences(params: {
    referencesRoot: string;
    patterns: string[];
    patternValue: number;
    contextLines: number;
    maxFiles?: number;
    scopePaths?: string[];
}): RawGrepLineHit[] {
    const root = path.normalize(params.referencesRoot);
    if (!fs.existsSync(root)) return [];

    const maxFiles = params.maxFiles ?? getGrepMaxFiles();
    const files = listMdFiles(root, params.scopePaths).slice(0, maxFiles);
    const hits: RawGrepLineHit[] = [];
    const ctx = Math.max(0, params.contextLines ?? 2);

    for (const file of files) {
        const relFile = path.relative(root, file).replace(/\\/g, '/') || file;
        for (const pattern of params.patterns) {
            if (!pattern.trim()) continue;
            const matchedLines = grepFile(file, pattern, true);
            for (const lineNo of matchedLines) {
                hits.push({
                    file: relFile,
                    line: lineNo,
                    lineText: '',
                    pattern,
                    patternValue: params.patternValue,
                });
            }
        }
    }

    for (const h of hits) {
        if (h.lineText) continue;
        const full = path.join(root, h.file);
        let content: string;
        try {
            content = fs.readFileSync(full, 'utf8');
        } catch {
            continue;
        }
        const fileLines = content.split(/\r?\n/);
        const idx = h.line - 1;
        if (idx < 0 || idx >= fileLines.length) continue;
        const start = Math.max(0, idx - ctx);
        const end = Math.min(fileLines.length - 1, idx + ctx);
        h.lineText = fileLines.slice(start, end + 1).join('\n');
    }

    return hits;
}
