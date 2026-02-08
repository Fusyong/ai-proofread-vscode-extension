/**
 * 自定义替换表（正则）：将 CustomRule[] 编译为 CompiledCustomRule[]
 * 规划见 docs/custom-word-check-plan.md
 */

import type { CustomRule, CompiledCustomRule } from './types';

/** 汉字 Unicode 块（CJK 统一汉字），仅识别 \\c 不破坏 \\d \\s 等 */
const CJK_CHAR_CLASS = '[\\u4e00-\\u9fff]';

/**
 * 将查找串中的 \\c 展开为汉字字符类，仅识别 \\c（两字符：反斜杠 + c）。
 */
export function expandCustomClasses(source: string): string {
    let out = '';
    for (let i = 0; i < source.length; i++) {
        if (source[i] === '\\' && i + 1 < source.length && source[i + 1] === 'c') {
            out += CJK_CHAR_CLASS;
            i++;
            continue;
        }
        out += source[i];
    }
    return out;
}

export interface CompileResult {
    compiled: CompiledCustomRule[];
    errors: { lineIndex: number; message: string }[];
}

/**
 * 将规则列表编译为正则表；单条失败时记录错误并跳过该条。
 */
export function compileCustomRules(rules: CustomRule[]): CompileResult {
    const compiled: CompiledCustomRule[] = [];
    const errors: { lineIndex: number; message: string }[] = [];
    for (let i = 0; i < rules.length; i++) {
        const rule = rules[i];
        const expandedFind = expandCustomClasses(rule.find);
        try {
            const regex = new RegExp(expandedFind, 'gu');
            compiled.push({
                regex,
                replaceTemplate: rule.replace,
                rawComment: rule.rawComment,
            });
        } catch (e) {
            errors.push({
                lineIndex: i + 1,
                message: e instanceof Error ? e.message : String(e),
            });
        }
    }
    return { compiled, errors };
}
