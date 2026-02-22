/**
 * 标题层级与连续性检查：类型定义
 * 规划见 docs/numbering-hierarchy-check-plan.md
 */

import type { Range } from 'vscode';

/** 序号类别：标题序号 | 文中序号 */
export type NumberingCategory = 'heading' | 'intext';

/** 序号序列类型 */
export type SequenceType =
    | 'chinese-upper'
    | 'chinese-lower'
    | 'arabic'
    | 'roman-upper'
    | 'roman-lower'
    | 'latin-upper'
    | 'latin-lower'
    | 'circled'
    | 'custom';

/** 层级定义：用于匹配和解析序号 */
export interface HierarchyLevel {
    level: number;
    name: string;
    pattern: string | RegExp;
    sequenceType?: SequenceType;
    customSequence?: string[];
}

/** 解析结果节点 */
export interface NumberingNode {
    lineNumber: number;
    lineText: string;
    category: NumberingCategory;
    headingPrefix?: string;
    numberingText: string;
    numberingValue: number;
    /** 匹配的 slotId，用于同级别多风格检查 */
    slotId: number;
    /** 排定后的层级序号（0,1,2,…），用于 TreeView # 展示和标记为标题 */
    assignedLevel: number;
    /** 兼容旧逻辑，与 assignedLevel 相同 */
    level: number;
    children: NumberingNode[];
    range?: Range;
}

/** 检查问题类型 */
export type CheckIssueType =
    | 'gap'
    | 'duplicate'
    | 'order'
    | 'level_mismatch'
    | 'inconsistent_gaps'
    | 'mixed_style_at_level';

/** 问题严重程度 */
export type CheckIssueSeverity = 'error' | 'warning' | 'info';

/** 检查问题 */
export interface CheckIssue {
    type: CheckIssueType;
    message: string;
    node: NumberingNode;
    severity: CheckIssueSeverity;
}

/** 解析选项 */
export interface ParseOptions {
    /** 是否忽略行首 # 以识别序号（Markdown 兼容） */
    ignoreMarkdownPrefix?: boolean;
    /** 检查范围：heading 仅标题序号、intext 仅文中序号、both 两者都检查 */
    checkScope?: 'heading' | 'intext' | 'both';
    /** 标题序号：行首最大缩进（空格数），超过则视为文中序号 */
    headingMaxIndent?: number;
}
