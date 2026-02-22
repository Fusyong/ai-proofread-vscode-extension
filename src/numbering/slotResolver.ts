/**
 * 标题体系：预置 + 自定义 slot 解析
 * 独立模块，避免 documentParser 与 hierarchyChecker 循环依赖
 */

import * as vscode from 'vscode';
import { getSlotById, type SlotDef } from './slotTable';
import type { SequenceType } from './types';

export const CUSTOM_SLOT_BASE = 1000;
/** 段内序号自定义 pattern 的 slotId 起始，与 customLevels 分开存储 */
export const CUSTOM_INLINE_SLOT_BASE = 1100;

function patternToRegExp(pattern: string): RegExp {
    try {
        const m = pattern.match(/^\/(.*)\/([gimsuy]*)$/);
        if (m) return new RegExp(m[1], m[2] || undefined);
        return new RegExp(pattern);
    } catch {
        return new RegExp('');
    }
}

export function getCustomSlotsFromConfig(): SlotDef[] {
    const config = vscode.workspace.getConfiguration('ai-proofread.numbering');
    const raw = config.get<{ level?: number; name?: string; pattern?: string; sequenceType?: string }[]>('customLevels', []);
    return raw
        .filter((c) => c?.level != null && c?.name && c?.pattern)
        .map((c, i) => ({
            slotId: CUSTOM_SLOT_BASE + i,
            baseLevel: Math.max(1, Math.min(8, c.level!)),
            sequenceType: (c.sequenceType as SequenceType) ?? 'arabic',
            marker: c.name!,
            pattern: patternToRegExp(c.pattern!),
            multiLevel: false,
        }));
}

/** 段内序号：用户自定义 pattern，单独存储于 customInlinePatterns */
export interface CustomInlinePattern {
    slotId: number;
    pattern: RegExp;
    sequenceType: SequenceType;
}

export function getCustomInlinePatternsFromConfig(): CustomInlinePattern[] {
    const config = vscode.workspace.getConfiguration('ai-proofread.numbering');
    const raw = config.get<{ pattern?: string; name?: string; sequenceType?: string }[]>('customInlinePatterns', []);
    return raw
        .filter((c) => c?.pattern)
        .map((c, i) => ({
            slotId: CUSTOM_INLINE_SLOT_BASE + i,
            pattern: patternToRegExp(c.pattern!),
            sequenceType: (c.sequenceType as SequenceType) ?? 'arabic',
        }));
}

export function getEffectiveSlotById(slotId: number): SlotDef | undefined {
    if (slotId < CUSTOM_SLOT_BASE) return getSlotById(slotId);
    if (slotId < CUSTOM_INLINE_SLOT_BASE) return getCustomSlotsFromConfig().find((s) => s.slotId === slotId);
    const customs = getCustomInlinePatternsFromConfig();
    const c = customs.find((s) => s.slotId === slotId);
    if (!c) return undefined;
    return {
        slotId: c.slotId,
        baseLevel: 1,
        sequenceType: c.sequenceType,
        marker: 'custom-inline',
        pattern: c.pattern,
        multiLevel: false,
    };
}
