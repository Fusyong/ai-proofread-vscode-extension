import { llmGenerateJson } from '../localDict/dictPrepLlm';

export { llmGenerateJson as referencePrepLlmGenerateJson };

export async function generateReferencePrepPlanJson(params: {
    platform: string;
    model: string;
    systemPrompt: string;
    userPrompt: string;
}): Promise<string> {
    return llmGenerateJson({
        logTag: 'referencePrepLlm',
        platform: params.platform,
        model: params.model,
        systemPrompt: params.systemPrompt,
        userPrompt: params.userPrompt,
    });
}
