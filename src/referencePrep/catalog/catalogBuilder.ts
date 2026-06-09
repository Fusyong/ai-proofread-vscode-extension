import * as fs from 'fs';
import * as path from 'path';

export interface FileCatalogEntry {
    relPath: string;
    mtimeMs: number;
    size: number;
    headingCount?: number;
}

export interface ReferenceCatalog {
    snapshotId: string;
    referencesRoot: string;
    builtAt: string;
    files: FileCatalogEntry[];
    /** 压缩目录树：dir -> file count */
    dirSummary: Record<string, number>;
}

const SKIP_DIRS = new Set(['node_modules', '.git']);
const EXTS = new Set(['.md', '.markdown', '.txt']);

function countHeadings(filePath: string): number {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        let n = 0;
        for (const line of content.split(/\r?\n/)) {
            if (/^#{1,6}\s+/.test(line)) n++;
        }
        return n;
    } catch {
        return 0;
    }
}

export function buildReferenceCatalog(referencesRoot: string, opts?: { countHeadings?: boolean }): ReferenceCatalog {
    const root = path.normalize(referencesRoot);
    const files: FileCatalogEntry[] = [];
    const dirSummary: Record<string, number> = {};

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
                if (SKIP_DIRS.has(e.name)) continue;
                walk(full);
            } else if (e.isFile() && EXTS.has(path.extname(e.name).toLowerCase())) {
                try {
                    const stat = fs.statSync(full);
                    const relPath = path.relative(root, full).replace(/\\/g, '/');
                    const dirKey = path.dirname(relPath).replace(/\\/g, '/') || '.';
                    dirSummary[dirKey] = (dirSummary[dirKey] ?? 0) + 1;
                    files.push({
                        relPath,
                        mtimeMs: stat.mtimeMs,
                        size: stat.size,
                        headingCount: opts?.countHeadings ? countHeadings(full) : undefined,
                    });
                } catch {
                    /* skip */
                }
            }
        }
    };

    if (fs.existsSync(root)) walk(root);
    files.sort((a, b) => a.relPath.localeCompare(b.relPath));

    return {
        snapshotId: `cat-${Date.now()}`,
        referencesRoot: root,
        builtAt: new Date().toISOString(),
        files,
        dirSummary,
    };
}

export function summarizeCatalogForPrompt(catalog: ReferenceCatalog, maxFiles = 80): string {
    const lines: string[] = [
        `total_files=${catalog.files.length}`,
        'dir_summary:',
    ];
    const dirs = Object.entries(catalog.dirSummary).sort((a, b) => b[1] - a[1]);
    for (const [d, c] of dirs.slice(0, 30)) {
        lines.push(`  ${d}: ${c} files`);
    }
    lines.push('sample_files:');
    for (const f of catalog.files.slice(0, maxFiles)) {
        const hc = f.headingCount != null ? ` headings=${f.headingCount}` : '';
        lines.push(`  ${f.relPath} (${Math.round(f.size / 1024)}kb${hc})`);
    }
    if (catalog.files.length > maxFiles) {
        lines.push(`  ... and ${catalog.files.length - maxFiles} more`);
    }
    return lines.join('\n');
}
