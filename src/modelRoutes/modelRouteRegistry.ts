/**
 * 各 LLM 管线可独立配置平台与模型；未单独配置时可「跟随校对」。
 */

export type ModelRouteId = 'proofread' | 'referencePrep' | 'referencePrepRerank' | 'editorialMemory';

export type LlmPlatformId = 'aliyun' | 'deepseek' | 'google' | 'ollama';

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
    /** 是否支持「跟随校对」 */
    canInherit: boolean;
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
    },
    {
        id: 'referencePrepRerank',
        label: '参考资料精排',
        description: '检索结果相关性打分、去重与裁剪',
        canInherit: true,
    },
    {
        id: 'editorialMemory',
        label: '编辑记忆合并',
        description: 'Proofread Selection with Memory 写回后的记忆整理',
        canInherit: true,
    },
];

export const MODEL_ROUTES_VIEW_ID = 'ai-proofread.modelRoutes';
