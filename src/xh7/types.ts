/**
 * 检查字词：五类表名、条目与扫描结果类型
 * 规划见 docs/xh7-word-check-plan.md
 */

import type { Range } from 'vscode';

/** 检查类型：dict7 六类 + 通用规范汉字表(tgscc) 七类 */
export type CheckType =
    | 'variant_to_standard'
    | 'variant_to_preferred_single'
    | 'variant_to_preferred_multi'
    | 'single_char_traditional_to_standard'
    | 'single_char_yitihuabiao_to_standard'
    | 'single_char_yiti_other_to_standard'
    | 'tgscc_traditional_to_simplified'
    | 'tgscc_variant_to_simplified'
    | 'tgscc_non_standard'
    | 'tgscc_undefined'
    | 'tgscc_traditional_equals_standard'
    | 'tgscc_table1'
    | 'tgscc_table2';

/** 表名常量，与 JSON 键一致 */
export const CHECK_TYPE_KEYS: CheckType[] = [
    'variant_to_standard',
    'variant_to_preferred_single',
    'variant_to_preferred_multi',
    'single_char_traditional_to_standard',
    'single_char_yitihuabiao_to_standard',
    'single_char_yiti_other_to_standard',
    'tgscc_traditional_to_simplified',
    'tgscc_variant_to_simplified',
    'tgscc_non_standard',
    'tgscc_undefined',
    'tgscc_traditional_equals_standard',
    'tgscc_table1',
    'tgscc_table2',
];

/** 对照词典检查：dict7 六类 */
export const DICT_CHECK_TYPES: CheckType[] = [
    'variant_to_standard',
    'variant_to_preferred_single',
    'variant_to_preferred_multi',
    'single_char_traditional_to_standard',
    'single_char_yitihuabiao_to_standard',
    'single_char_yiti_other_to_standard',
];

/** 对照通用规范汉字表检查：tgscc 七类 */
export const TGSCC_CHECK_TYPES: CheckType[] = [
    'tgscc_traditional_to_simplified',
    'tgscc_variant_to_simplified',
    'tgscc_non_standard',
    'tgscc_undefined',
    'tgscc_traditional_equals_standard',
    'tgscc_table1',
    'tgscc_table2',
];

/** dict7 中需分词后再检查的词表（异形词表） */
export function isDictWordTableType(
    type: CheckType
): type is 'variant_to_standard' | 'variant_to_preferred_single' | 'variant_to_preferred_multi' {
    return (
        type === 'variant_to_standard' ||
        type === 'variant_to_preferred_single' ||
        type === 'variant_to_preferred_multi'
    );
}

/** 用于 QuickPick 多选（复选框样式）的显示标签 */
export const CHECK_TYPE_LABELS: Record<CheckType, string> = {
    variant_to_standard: '异形词（表内）→标准',
    variant_to_preferred_multi: '异形词（表外多字）→首选',
    variant_to_preferred_single: '异形词（表外单字）→首选',
    single_char_traditional_to_standard: '繁体字→标准',
    single_char_yitihuabiao_to_standard: '异体字(表内)→标准',
    single_char_yiti_other_to_standard: '异体字(表外)→标准',
    tgscc_traditional_to_simplified: '繁体字→通用规范字',
    tgscc_variant_to_simplified: '异体字→通用规范字',
    tgscc_non_standard: '非通用规范字',
    tgscc_undefined: '未界定字（非通规字且在繁简异表外）',
    tgscc_traditional_equals_standard: '传承字（繁体字=通用规范字）',
    tgscc_table1: '表一字',
    tgscc_table2: '表二字',
};

/** 单条扫描结果：需要提示的词、更好的词、在文档中的出现位置；每条只对应一种检查类型 */
export interface WordCheckEntry {
    /** 需要提示的字词（表中 key） */
    variant: string;
    /** 更好的字词（表中 value） */
    preferred: string;
    /** 在文档中的出现位置（vscode.Range 数组） */
    ranges: Range[];
    /** 自定义表规则的行内注释，供 tooltip / 查看说明 使用 */
    rawComment?: string;
    /** 该条对应的检查类型标签（如「繁体字→通用规范字」），用于 TreeView 描述 */
    checkTypeLabel?: string;
}

/** 自定义替换表：解析后单条规则（与文件行一一对应） */
export interface CustomRule {
    find: string;
    replace: string;
    rawComment?: string;
}

/** 自定义替换表（正则）：编译后单条规则，用于扫描 */
export interface CompiledCustomRule {
    regex: RegExp;
    replaceTemplate: string;
    rawComment?: string;
}

/** 自定义表缓存单元 */
export interface CustomTable {
    id: string;
    name: string;
    filePath?: string;
    enabled: boolean;
    isRegex: boolean;
    /** 非正则表时有效：是否匹配词语边界（先分词再检查表中条目是否在分词结果中），默认 false */
    matchWordBoundary?: boolean;
    rules: CustomRule[];
    compiled?: CompiledCustomRule[];
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
