/**
 * 文献相对路径统一为正斜杠，避免 Windows `\` 与 catalog `/` 无法匹配。
 */
export function normalizeRelPath(relPath: string): string {
    return relPath.replace(/\\/g, '/');
}

/** 判断 relPath 是否落在 prefix 下（含相等）；两侧均先规范化 */
export function relPathEqualsOrUnder(relPath: string, prefix: string): boolean {
    const n = normalizeRelPath(relPath);
    const p = normalizeRelPath(prefix);
    if (!p) return true;
    return n === p || n.startsWith(p.endsWith('/') ? p : `${p}/`);
}
