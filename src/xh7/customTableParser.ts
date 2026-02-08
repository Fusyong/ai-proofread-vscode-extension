/**
 * 自定义替换表：解析替换表文件（行解析、转义 # % =）
 * 规划见 docs/custom-word-check-plan.md
 */

import type { CustomRule } from './types';

/** 格式转义：\# \% \= \\ → # % = \ */
function unescapeFormat(s: string): string {
    let out = '';
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '\\' && i + 1 < s.length) {
            const next = s[i + 1];
            if (next === '#' || next === '%' || next === '=' || next === '\\') {
                out += next;
                i++;
                continue;
            }
        }
        out += s[i];
    }
    return out;
}

/** 找到第一个未转义的 ch 的位置，不存在返回 -1 */
function indexOfUnescaped(line: string, ch: string): number {
    for (let i = 0; i < line.length; i++) {
        if (line[i] === '\\' && i + 1 < line.length) {
            i++;
            continue;
        }
        if (line[i] === ch) return i;
    }
    return -1;
}

/** 行是否为注释行（整行忽略：空行或以未转义的 #/% 开头） */
function isCommentOrEmptyLine(line: string): boolean {
    const t = line.trimStart();
    if (t.length === 0) return true;
    if (t[0] === '\\' && t.length >= 2 && (t[1] === '#' || t[1] === '%')) return false;
    if (t[0] === '#' || t[0] === '%') return true;
    return false;
}

/**
 * 解析单行：拆出 find、replace、行内注释（# 或 % 后）。
 * 行注释前的空格视为无效（replace 段在注释前 trimEnd）。
 */
function parseLine(line: string): CustomRule | null {
    const eqIdx = indexOfUnescaped(line, '=');
    if (eqIdx < 0) return null;
    const findPart = line.slice(0, eqIdx);
    let rest = line.slice(eqIdx + 1);
    const hashIdx = indexOfUnescaped(rest, '#');
    const percIdx = indexOfUnescaped(rest, '%');
    const commentIdx = hashIdx < 0 ? percIdx : percIdx < 0 ? hashIdx : Math.min(hashIdx, percIdx);
    let replacePart: string;
    let rawComment: string | undefined;
    if (commentIdx < 0) {
        replacePart = rest;
    } else {
        replacePart = rest.slice(0, commentIdx).trimEnd();
        rawComment = rest.slice(commentIdx + 1).trim();
    }
    const find = unescapeFormat(findPart.trim());
    const replace = unescapeFormat(replacePart);
    if (find.length === 0) return null;
    if (rawComment !== undefined && rawComment.length === 0) rawComment = undefined;
    return { find, replace, rawComment };
}

/**
 * 解析整个文件内容，返回规则列表；注释行与空行忽略。
 */
export function parseCustomTableFile(content: string): CustomRule[] {
    const lines = content.split(/\r?\n/);
    const rules: CustomRule[] = [];
    for (const line of lines) {
        if (isCommentOrEmptyLine(line)) continue;
        const rule = parseLine(line);
        if (rule) rules.push(rule);
    }
    return rules;
}
