/**
 * 检查字词：五类表名、条目与扫描结果类型
 * 规划见 docs/xh7-word-check-plan.md
 */

import type { Range } from 'vscode';

/** 检查类型：dict7 五类 + 通用规范汉字表(tgscc) 两类 */
export type CheckType =
    | 'variant_to_standard'
    | 'variant_to_preferred'
    | 'single_char_traditional_to_standard'
    | 'single_char_yitihuabiao_to_standard'
    | 'single_char_yiti_other_to_standard'
    | 'tgscc_traditional_to_simplified'
    | 'tgscc_variant_to_simplified';

/** 表名常量，与 JSON 键一致 */
export const CHECK_TYPE_KEYS: CheckType[] = [
    'variant_to_standard',
    'variant_to_preferred',
    'single_char_traditional_to_standard',
    'single_char_yitihuabiao_to_standard',
    'single_char_yiti_other_to_standard',
    'tgscc_traditional_to_simplified',
    'tgscc_variant_to_simplified',
];

/** 用于 QuickPick 多选（复选框样式）的显示标签 */
export const CHECK_TYPE_LABELS: Record<CheckType, string> = {
    variant_to_standard: '异形词（表内）→标准',
    variant_to_preferred: '异形词（表外）→首选',
    single_char_traditional_to_standard: '繁体字→标准',
    single_char_yitihuabiao_to_standard: '异体字(表内)→标准',
    single_char_yiti_other_to_standard: '异体字(表外)→标准',
    tgscc_traditional_to_simplified: '繁体字→通用规范字',
    tgscc_variant_to_simplified: '异体字→通用规范字',
};

/** 单条扫描结果：需要提示的词、更好的词、在文档中的出现位置 */
export interface WordCheckEntry {
    /** 需要提示的字词（表中 key） */
    variant: string;
    /** 更好的字词（表中 value） */
    preferred: string;
    /** 在文档中的出现位置（vscode.Range 数组） */
    ranges: Range[];
}

/** 一次检查的完整结果：当前类型 + 条目列表 */
export interface WordCheckScanResult {
    checkType: CheckType;
    documentUri: string;
    entries: WordCheckEntry[];
}

/** 注释来源 */
export interface WordCheckNotes {
    raw?: string[];
    usage?: string[];
}
