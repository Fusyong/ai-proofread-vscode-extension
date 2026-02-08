/**
 * 检查字词：懒加载 xh7_tables.json，按表名取字典、按「更好的字词」取注释
 * 规划见 docs/xh7-word-check-plan.md
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ExtensionContext } from 'vscode';
import type { CheckType } from './types';
import type { WordCheckNotes } from './types';

/** JSON 文件结构（与 data/xh7_tables.json 一致） */
interface Xh7TablesJson {
    variant_to_standard?: Record<string, string>;
    variant_to_preferred?: Record<string, string>;
    single_char_traditional_to_standard?: Record<string, string>;
    single_char_yitihuabiao_to_standard?: Record<string, string>;
    single_char_yiti_other_to_standard?: Record<string, string>;
    raw_notes?: Record<string, string[]>;
    usage_notes?: Record<string, string[]>;
}

let cachedData: Xh7TablesJson | null = null;
let contextForPath: ExtensionContext | null = null;

/**
 * 初始化加载器（在扩展 activate 时传入 context，不在此处读文件）
 */
export function initTableLoader(context: ExtensionContext): void {
    contextForPath = context;
    cachedData = null;
}

/**
 * 懒加载并解析 xh7_tables.json，返回缓存
 */
function ensureLoaded(): Xh7TablesJson {
    if (cachedData) return cachedData;
    if (!contextForPath) {
        throw new Error('字词检查：未初始化 tableLoader，请先调用 initTableLoader(context)');
    }
    const jsonPath = contextForPath.asAbsolutePath(path.join('data', 'xh7_tables.json'));
    if (!fs.existsSync(jsonPath)) {
        throw new Error(`字词检查：数据文件不存在: ${jsonPath}`);
    }
    const raw = fs.readFileSync(jsonPath, 'utf-8');
    cachedData = JSON.parse(raw) as Xh7TablesJson;
    return cachedData;
}

/**
 * 获取指定检查类型的字典（需要提示的词 → 更好的词）
 */
export function getDict(type: CheckType): Record<string, string> {
    const data = ensureLoaded();
    const dict = data[type];
    return dict ?? {};
}

/**
 * 根据「更好的字词」获取注释（raw_notes、usage_notes）
 */
export function getNotes(preferred: string): WordCheckNotes {
    const data = ensureLoaded();
    const raw = data.raw_notes?.[preferred];
    const usage = data.usage_notes?.[preferred];
    return { raw, usage };
}
