/**
 * 标题层级与连续性检查：预置与用户扩展的层级定义
 * 规划见 docs/numbering-hierarchy-check-plan.md
 */

import * as vscode from 'vscode';
import type { HierarchyLevel } from './types';
import { BUILTIN_LEVELS } from './numberPatterns';

/** 用户自定义层级的配置结构 */
export interface CustomLevelConfig {
    level: number;
    name: string;
    pattern: string;
    sequenceType?: string;
}

let cachedLevels: HierarchyLevel[] | null = null;

/**
 * 将字符串 pattern 转为 RegExp
 */
function patternToRegExp(pattern: string): RegExp {
    try {
        const m = pattern.match(/^\/(.*)\/([gimsuy]*)$/);
        if (m) {
            return new RegExp(m[1], m[2] || undefined);
        }
        return new RegExp(pattern);
    } catch {
        return new RegExp('');
    }
}

/**
 * 将用户配置转为 HierarchyLevel
 */
function configToLevel(c: CustomLevelConfig): HierarchyLevel {
    return {
        level: c.level,
        name: c.name,
        pattern: patternToRegExp(c.pattern),
        sequenceType: c.sequenceType as HierarchyLevel['sequenceType'],
    };
}

/**
 * 获取当前生效的层级列表（预置 + 用户扩展，用户定义覆盖同 level 的预置）
 */
export function getEffectiveLevels(): HierarchyLevel[] {
    if (cachedLevels) return cachedLevels;

    const config = vscode.workspace.getConfiguration('ai-proofread.numbering');
    const customRaw = config.get<CustomLevelConfig[]>('customLevels', []);

    const customByLevel = new Map<number, HierarchyLevel>();
    for (const c of customRaw) {
        if (c?.level != null && c?.name && c?.pattern) {
            customByLevel.set(c.level, configToLevel(c));
        }
    }

    const result: HierarchyLevel[] = [];
    for (const builtin of BUILTIN_LEVELS) {
        const overridden = customByLevel.get(builtin.level);
        result.push(overridden ?? builtin);
        if (overridden) customByLevel.delete(builtin.level);
    }
    for (const [, level] of customByLevel) {
        result.push(level);
    }
    result.sort((a, b) => a.level - b.level);

    cachedLevels = result;
    return result;
}

/**
 * 清除缓存（配置变更时调用）
 */
export function clearLevelsCache(): void {
    cachedLevels = null;
}
