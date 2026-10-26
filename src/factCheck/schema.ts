/**
 * 待核断言：抽取结果与勾选状态。紧迫程度不是校对条目的 confidence。
 */

import * as path from 'path';

export type FactCheckScope = 'key' | 'general';

export type FactCheckCategory =
    | 'measure'
    | 'date'
    | 'named_attribute'
    | 'historical_judgment'
    | 'institution'
    | 'other';

export type FactCheckStatus = 'pending' | 'searched' | 'has_reference';

export interface FactCheckHit {
    title: string;
    url: string;
    summary: string;
    /** DeepSeek authority，0–4；未知则省略 */
    authority?: number;
}

export interface FactCheckClaim {
    id: string;
    segmentIndex: number;
    span: string;
    category: FactCheckCategory;
    scope: FactCheckScope;
    /** 0–1，像是有错、该先核的把握 */
    urgency: number;
    urgencyReason: string;
    query: string;
    selected: boolean;
    status: FactCheckStatus;
    hits?: FactCheckHit[];
}

export interface FactCheckClaimsFile {
    version: 1;
    sourceJsonPath: string;
    scope: FactCheckScope;
    extractedAt: string;
    claims: FactCheckClaim[];
}

export const FACT_CHECK_CLAIMS_VERSION = 1;

export const KEY_CATEGORIES: readonly FactCheckCategory[] = ['measure', 'date', 'named_attribute'];

export const GENERAL_CATEGORIES: readonly FactCheckCategory[] = [
    'historical_judgment',
    'institution',
    'other',
];

export const ALL_CATEGORIES: readonly FactCheckCategory[] = [...KEY_CATEGORIES, ...GENERAL_CATEGORIES];

/** 每段关键事实软上限 */
export const MAX_KEY_CLAIMS_PER_SEGMENT = 6;
/** 范围含一般问题时，每段再加的上限 */
export const MAX_GENERAL_CLAIMS_PER_SEGMENT = 4;

export const DEFAULT_URGENCY_MIN = 0.6;

export const DEEPSEEK_QUERY_MAX_CHARS = 128;

export const SEARCH_CONFIRM_THRESHOLD = 50;

export const SEARCH_RESULT_COUNT = 5;

export const DEFAULT_EXCLUDE_SITES = ['baike.baidu.com'];

export const CATEGORY_LABEL: Record<FactCheckCategory, string> = {
    measure: '度量数字',
    date: '年代',
    named_attribute: '专名属性',
    historical_judgment: '史实判断',
    institution: '制度名物',
    other: '其他',
};

export function scopeForCategory(category: FactCheckCategory): FactCheckScope {
    return KEY_CATEGORIES.includes(category) ? 'key' : 'general';
}

export function isFactCheckCategory(value: string): value is FactCheckCategory {
    return (ALL_CATEGORIES as readonly string[]).includes(value);
}

/**
 * 默认勾选：关键事实且紧迫程度达到阈值。已有资料的断言不勾选。
 */
export function defaultClaimSelected(
    claim: { scope: FactCheckScope; urgency: number; status: FactCheckStatus },
    urgencyMin: number
): boolean {
    if (claim.status === 'has_reference' || claim.status === 'searched') {
        return false;
    }
    return claim.scope === 'key' && claim.urgency >= urgencyMin;
}

/** 整段以 blockquote 开头则留给引文核对 */
export function isCitationSegment(target: string): boolean {
    return target.trimStart().startsWith('>');
}

export function claimsPathForSourceJson(sourceJsonPath: string): string {
    const dir = path.dirname(sourceJsonPath);
    const base = path.basename(sourceJsonPath, '.json');
    return path.join(dir, `${base}.factcheck-claims.json`);
}
