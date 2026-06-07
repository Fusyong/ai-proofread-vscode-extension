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

export interface ModelRouteMeta {
    id: ModelRouteId;
    label: string;
    description: string;
    /** 是否支持「跟随上级」 */
    canInherit: boolean;
    /** 默认继承来源（canInherit 为 true 时有效） */
    defaultInheritFrom?: ModelRouteInheritFrom;
    /** 是否可在「校对 / 参考资料准备」间切换继承来源 */
    canChooseInheritFrom?: boolean;
}

export const MODEL_ROUTE_METAS: ModelRouteMeta[] = [
    {
        id: 'proofread',
        label: '校对',
        description: '选段校对、JSON 批量校对',
        canInherit: false,
    },
    {
        id: 'referencePrep',
        label: '参考资料准备',
        description: '知识核查 / 多轮检索词典与文献',
        canInherit: true,
        defaultInheritFrom: 'proofread',
    },
    {
        id: 'referencePrepScope',
        label: '参考资料预筛',
        description: '大目录时 LLM 筛选词典与文献范围',
        canInherit: true,
        defaultInheritFrom: 'referencePrep',
        canChooseInheritFrom: true,
    },
    {
        id: 'referencePrepRerank',
        label: '参考资料精排',
        description: '检索结果相关性打分、去重与裁剪',
        canInherit: true,
        defaultInheritFrom: 'referencePrep',
        canChooseInheritFrom: true,
    },
    {
        id: 'editorialMemory',
        label: '编辑记忆合并',
        description: 'Proofread Selection with Memory 写回后的记忆整理',
        canInherit: true,
        defaultInheritFrom: 'proofread',
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
    return from === 'referencePrep' ? '参考资料准备' : '校对';
}
