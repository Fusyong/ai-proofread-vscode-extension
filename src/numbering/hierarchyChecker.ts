/**
 * 标题层级与连续性检查：检查逻辑
 * 规划见 docs/numbering-hierarchy-check-plan.md
 */

import type { NumberingNode, CheckIssue } from './types';
import { getEffectiveSlotById } from './slotResolver';

/**
 * 收集树中所有节点（深度优先）
 */
function collectNodes(roots: NumberingNode[]): NumberingNode[] {
    const out: NumberingNode[] = [];
    function walk(n: NumberingNode) {
        out.push(n);
        for (const c of n.children) walk(c);
    }
    for (const r of roots) walk(r);
    return out;
}

/**
 * 同级序号检查：按文档顺序，每增加一个与前一个比较 numberingValue（已映射为阿拉伯数字）
 * 统一报错格式：不连贯、孤立、初始非 1
 */
function checkSiblingContinuity(
    siblings: NumberingNode[],
    issues: CheckIssue[],
    allowGaps: boolean
): void {
    if (siblings.length === 0) return;

    const bySlotAndLevel = new Map<string, NumberingNode[]>();
    for (const n of siblings) {
        const key = `${n.slotId}:${n.assignedLevel}`;
        const list = bySlotAndLevel.get(key) ?? [];
        list.push(n);
        bySlotAndLevel.set(key, list);
    }

    for (const list of bySlotAndLevel.values()) {
        if (list.length === 0) continue;
        const first = list[0];
        if (list.length === 1) {
            issues.push({
                type: 'gap',
                message: `同级别孤立序号：${first.numberingText}${first.numberingValue !== 1 ? `，初始序号为 ${first.numberingValue}，当为 1` : ''}`,
                node: first,
                severity: allowGaps ? 'warning' : 'error',
            });
            continue;
        }
        if (first.numberingValue !== 1) {
            issues.push({
                type: 'gap',
                message: `初始序号为 ${first.numberingValue}，当为 1：${first.numberingText}`,
                node: first,
                severity: allowGaps ? 'warning' : 'error',
            });
        }
        for (let i = 1; i < list.length; i++) {
            const prev = list[i - 1];
            const curr = list[i];
            const diff = curr.numberingValue - prev.numberingValue;
            if (diff === 0) {
                issues.push({
                    type: 'duplicate',
                    message: `同级序号重复：${prev.numberingText} 与 ${curr.numberingText}`,
                    node: curr,
                    severity: 'error',
                });
            } else if (diff < 0) {
                issues.push({
                    type: 'order',
                    message: `同级序号乱序：${prev.numberingText} 在 ${curr.numberingText} 之后`,
                    node: curr,
                    severity: 'error',
                });
            } else if (diff > 1) {
                issues.push({
                    type: 'gap',
                    message: `同级序号不连贯，差值为 ${diff}，当为 1：${prev.numberingText} → ${curr.numberingText}`,
                    node: curr,
                    severity: allowGaps ? 'warning' : 'error',
                });
            }
        }
    }
}

/**
 * 同级别多风格检查：同一 assignedLevel 若出现多种 slotId（不同序号风格），提示用户
 */
function checkMixedStyleAtLevel(
    roots: NumberingNode[],
    issues: CheckIssue[]
): void {
    const nodes = collectNodes(roots);
    const levelToNodes = new Map<number, NumberingNode[]>();
    for (const n of nodes) {
        const list = levelToNodes.get(n.assignedLevel) ?? [];
        list.push(n);
        levelToNodes.set(n.assignedLevel, list);
    }
    for (const [, list] of levelToNodes) {
        const slotIds = new Set(list.map((n) => n.slotId));
        if (slotIds.size <= 1) continue;
        const slotNames = [...slotIds]
            .map((id) => getEffectiveSlotById(id)?.marker ?? `slot${id}`)
            .join('、');
        const firstSlot = list[0].slotId;
        const firstDiff = list.find((n) => n.slotId !== firstSlot);
        if (firstDiff) {
            issues.push({
                type: 'mixed_style_at_level',
                message: `第 ${firstDiff.assignedLevel + 1} 级同时使用了多种序号风格（${slotNames}），建议统一`,
                node: firstDiff,
                severity: 'warning',
            });
        }
    }
}

/**
 * 中段缺失一致性：同一父节点下各子分支的中段缺失应一致，尾部缺失可不同
 */
function checkGapConsistency(
    roots: NumberingNode[],
    issues: CheckIssue[]
): void {
    for (const root of roots) {
        checkGapConsistencyAt(root, issues);
    }
}

function checkGapConsistencyAt(node: NumberingNode, issues: CheckIssue[]): void {
    const children = node.children;
    if (children.length < 2) return;

    const gapSets: Set<number>[] = [];

    for (const child of children) {
        const grandChildren = child.children;
        if (grandChildren.length < 2) continue;

        const values = grandChildren.map((c) => c.numberingValue).sort((a, b) => a - b);
        const maxVal = Math.max(...values);
        const midGaps = new Set<number>();
        for (let v = values[0]; v < maxVal; v++) {
            if (!values.includes(v)) midGaps.add(v);
        }
        if (midGaps.size > 0) {
            gapSets.push(midGaps);
        }
    }

    if (gapSets.length >= 2) {
        const first = gapSets[0];
        for (let i = 1; i < gapSets.length; i++) {
            const other = gapSets[i];
            if (first.size !== other.size || [...first].some((g) => !other.has(g))) {
                issues.push({
                    type: 'inconsistent_gaps',
                    message: '各子分支的中段缺失不一致',
                    node: children[0],
                    severity: 'warning',
                });
                break;
            }
        }
    }

    for (const c of children) {
        checkGapConsistencyAt(c, issues);
    }
}

/** 允许同级序号缺失时，gap 类问题为 warning；否则为 error */
const ALLOW_GAPS = true;

/** 是否检查各分支中段缺失一致性 */
const CHECK_GAP_CONSISTENCY = false;

/**
 * 执行检查，返回问题列表
 */
export function checkHierarchy(roots: NumberingNode[]): CheckIssue[] {
    const issues: CheckIssue[] = [];

    checkSiblingContinuity(roots, issues, ALLOW_GAPS);
    function walkForContinuity(n: NumberingNode) {
        checkSiblingContinuity(n.children, issues, ALLOW_GAPS);
        for (const c of n.children) walkForContinuity(c);
    }
    for (const r of roots) walkForContinuity(r);

    checkMixedStyleAtLevel(roots, issues);

    if (CHECK_GAP_CONSISTENCY) {
        checkGapConsistency(roots, issues);
    }

    return issues;
}
