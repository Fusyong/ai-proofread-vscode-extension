/**
 * 各 LLM 管线可独立配置平台与模型；未单独配置时可继承上级路由。
 */

export type ModelRouteId =
    | 'proofread'
    | 'referencePrep'
    | 'referencePrepScope'
    | 'referencePrepRerank'
    | 'editorialMemory';

export type LlmPlatformId = 'aliyun' | 'deepseek' | 'google' | 'ollama';

export type ModelRouteInheritFrom = 'proofread' | 'referencePrep';

export const LLM_PLATFORMS: Array<{ id: LlmPlatformId; label: string }> = [
    { id: 'aliyun', label: '阿里云百炼' },
    { id: 'deepseek', label: 'DeepSeek' },
    { id: 'google', label: 'Google Gemini' },
    { id: 'ollama', label: 'Ollama 本地' },
];

/** 思考模式配置提示：收益 / 负担 / 产品默认（供用户核对） */
export interface ModelRouteThinkingHint {
    benefit: string;
    cost: string;
    /** 展示用建议短句 */
    recommendLabel: string;
    /** 产品默认文案（不随用户改动变化） */
    defaultLabel: string;
}

export interface ModelRouteMeta {
    id: ModelRouteId;
    label: string;
    description: string;
    /** 是否支持「跟随上级」 */
    canInherit: boolean;
    /** 默认继承来源（canInherit 为 true 时有效） */
    defaultInheritFrom?: ModelRouteInheritFrom;
    /** 是否可在「校对 / 参考资料规划」间切换继承来源 */
    canChooseInheritFrom?: boolean;
    thinkingHint: ModelRouteThinkingHint;
}

/** 侧栏展示顺序与管线执行先后一致：预筛 → 规划 → 精排 */
export const MODEL_ROUTE_METAS: ModelRouteMeta[] = [
    {
        id: 'proofread',
        label: '校对',
        description: '选段校对、JSON 批量校对',
        canInherit: false,
        thinkingHint: {
            defaultLabel: '默认关（proofread.disableThinking: true）',
            benefit: '疑难句、需对照资料的知识核查更稳',
            cost: '明显更慢、费用更高；批量校对尤为拖累',
            recommendLabel: '默认关；难段再开',
        },
    },
    {
        id: 'referencePrepScope',
        label: '参考资料预筛',
        description: '大目录时 LLM 筛选词典与文献范围（规划前，条件触发）',
        canInherit: true,
        defaultInheritFrom: 'referencePrep',
        canChooseInheritFrom: true,
        thinkingHint: {
            defaultLabel: '默认跟随规划（通常为关）',
            benefit: '超大目录时筛选相关性略好',
            cost: '预筛调用变慢，收益通常有限',
            recommendLabel: '建议保持关',
        },
    },
    {
        id: 'referencePrep',
        label: '参考资料规划',
        description: '多轮生成检索计划（sufficient / queries / prune JSON）',
        canInherit: true,
        defaultInheritFrom: 'proofread',
        thinkingHint: {
            defaultLabel: '默认跟随校对（通常为关）',
            benefit: '多源检索策略、轮次取舍、sufficient 判断更好',
            cost: '每轮规划变慢，整条「准备资料」流水线拉长',
            recommendLabel: '复杂书稿可开',
        },
    },
    {
        id: 'referencePrepRerank',
        label: '参考资料精排',
        description: '每轮检索后相关性打分、去重与裁剪',
        canInherit: true,
        defaultInheritFrom: 'referencePrep',
        canChooseInheritFrom: true,
        thinkingHint: {
            defaultLabel: '默认跟随规划（通常为关）',
            benefit: '难例相关性偶有提升',
            cost: '候选多时延迟与费用放大，性价比差',
            recommendLabel: '建议保持关',
        },
    },
    {
        id: 'editorialMemory',
        label: '编辑记忆合并',
        description: 'Proofread Selection with Memory 写回后的记忆整理',
        canInherit: true,
        defaultInheritFrom: 'proofread',
        thinkingHint: {
            defaultLabel: '默认跟随校对（通常为关）',
            benefit: '语义去重与规律抽象略好',
            cost: '写回后合并变慢（不挡主校对交互）',
            recommendLabel: '需要时再开',
        },
    },
];

export const MODEL_ROUTES_VIEW_ID = 'ai-proofread.modelRoutes';

export function getRouteMeta(routeId: ModelRouteId): ModelRouteMeta {
    const m = MODEL_ROUTE_METAS.find((x) => x.id === routeId);
    if (!m) throw new Error('unknown route: ' + routeId);
    return m;
}

export function getDefaultInheritFrom(routeId: ModelRouteId): ModelRouteInheritFrom {
    return getRouteMeta(routeId).defaultInheritFrom ?? 'proofread';
}

export function routeSupportsInheritFromChoice(routeId: ModelRouteId): boolean {
    return getRouteMeta(routeId).canChooseInheritFrom === true;
}

export function inheritFromLabel(from: ModelRouteInheritFrom): string {
    return from === 'referencePrep' ? '参考资料规划' : '校对';
}

/** 组装思考模式提示：当前 / 默认 / 收益 / 负担 / 建议 */
export function formatThinkingHintDetail(
    routeId: ModelRouteId,
    currentLabel: string
): string {
    const h = getRouteMeta(routeId).thinkingHint;
    return (
        `当前：${currentLabel}｜默认：${h.defaultLabel}｜` +
        `收益：${h.benefit}；负担：${h.cost}（建议：${h.recommendLabel}）`
    );
}
