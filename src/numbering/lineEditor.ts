/**
 * 标题层级与连续性检查：行编辑工具（标记为标题、升级、降级）
 * 规划见 docs/numbering-hierarchy-check-plan.md
 */

/** 解析行结构：前导空白 + 可选的 # 前缀 + 正文 */
const LINE_RE = /^(\s*)(#{1,6}\s*)?(.*)$/;

export interface ParsedLine {
    leadingSpaces: string;
    hashPrefix: string;
    hashCount: number;
    body: string;
}

export function parseLine(line: string): ParsedLine {
    const m = line.match(LINE_RE);
    if (!m) {
        return { leadingSpaces: '', hashPrefix: '', hashCount: 0, body: line };
    }
    const hashPrefix = m[2] ?? '';
    const hashCount = hashPrefix.replace(/\s/g, '').length;
    return {
        leadingSpaces: m[1] ?? '',
        hashPrefix,
        hashCount,
        body: (m[3] ?? '').trimStart(),
    };
}

/**
 * 生成新行：指定 # 数量
 */
export function buildLine(parsed: ParsedLine, hashCount: number): string {
    const hashes = hashCount > 0 ? '#'.repeat(hashCount) + ' ' : '';
    return parsed.leadingSpaces + hashes + parsed.body;
}

/**
 * 标记为标题：按排定后的 assignedLevel 添加 #
 * assignedLevel 0 -> #, 1 -> ##, ...
 */
export function toTitleLine(parsed: ParsedLine, assignedLevel: number): string {
    const hashCount = Math.max(1, Math.min(6, assignedLevel + 1));
    return buildLine(parsed, hashCount);
}

/**
 * 升级：减少一个 #
 */
export function promoteLine(parsed: ParsedLine): string | null {
    if (parsed.hashCount <= 0) return null;
    const newCount = Math.max(1, parsed.hashCount - 1);
    return buildLine(parsed, newCount);
}

/**
 * 降级：增加一个 #（无 # 时视为 0，降级后为 #）
 */
export function demoteLine(parsed: ParsedLine): string | null {
    if (parsed.hashCount >= 6) return null;
    const newCount = parsed.hashCount + 1;
    return buildLine(parsed, newCount);
}
