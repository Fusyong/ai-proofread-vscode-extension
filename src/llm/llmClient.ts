import * as vscode from 'vscode';
import axios from 'axios';
import { GoogleGenAI } from '@google/genai';
import { ConfigManager, Logger } from '../utils';

function secondsToMs(v: number | undefined, fallback: number): number {
    const x = typeof v === 'number' && !Number.isNaN(v) ? v : fallback;
    return x * 1000;
}

function readProofreadLlmSettings() {
    const config = vscode.workspace.getConfiguration('ai-proofread');
    return {
        retryAttempts: config.get<number>('proofread.retryAttempts', 3),
        retryDelay: secondsToMs(config.get<number>('proofread.retryDelay', 1), 1),
        temperature: config.get<number>('proofread.temperature', 1),
        disableThinking: config.get<boolean>('proofread.disableThinking', true),
    };
}

export async function llmGenerateJson(params: {
    platform: string;
    model: string;
    systemPrompt: string;
    userPrompt: string;
    temperature?: number;
    logTag?: string;
}): Promise<string> {
    const tag = params.logTag ?? 'llmClient';
    const logger = Logger.getInstance();
    const config = vscode.workspace.getConfiguration('ai-proofread');
    const { retryAttempts, retryDelay, disableThinking } = readProofreadLlmSettings();
    const timeout = secondsToMs(config.get<number>('proofread.timeout', 120), 120);
    const temperature = params.temperature ?? readProofreadLlmSettings().temperature;

    for (let attempt = 1; attempt <= retryAttempts; attempt++) {
        try {
            if (params.platform === 'google') {
                return await callGoogle({
                    model: params.model,
                    systemPrompt: params.systemPrompt,
                    userPrompt: params.userPrompt,
                    temperature,
                    logTag: tag,
                });
            }
            if (params.platform === 'ollama') {
                return await callOllama({
                    model: params.model,
                    systemPrompt: params.systemPrompt,
                    userPrompt: params.userPrompt,
                    temperature,
                    timeout,
                    logTag: tag,
                });
            }
            if (params.platform === 'aliyun') {
                return await callOpenAICompatible({
                    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
                    apiKey: ConfigManager.getInstance().getApiKey('aliyun'),
                    model: params.model,
                    systemPrompt: params.systemPrompt,
                    userPrompt: params.userPrompt,
                    temperature,
                    timeout,
                    useAliyunEnableThinking: true,
                    disableThinking,
                    logTag: tag,
                });
            }
            return await callOpenAICompatible({
                baseUrl: 'https://api.deepseek.com/v1',
                apiKey: ConfigManager.getInstance().getApiKey('deepseek'),
                model: params.model,
                systemPrompt: params.systemPrompt,
                userPrompt: params.userPrompt,
                temperature,
                timeout,
                useDeepseekThinking: true,
                disableThinking,
                logTag: tag,
            });
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const isNetwork = /fetch failed|network|timeout|ECONNRESET|ENOTFOUND|ECONNREFUSED/i.test(msg);
            if (attempt >= retryAttempts || !isNetwork) {
                logger.error(`[${tag}] LLM 调用失败（attempt ${attempt}/${retryAttempts}）: ${msg}`, e);
                throw e;
            }
            logger.warn(`[${tag}] 网络错误，${(retryDelay / 1000).toFixed(1)}s 后重试: ${msg}`);
            await new Promise((r) => setTimeout(r, retryDelay));
        }
    }
    throw new Error('LLM 调用失败：超过重试次数');
}

/**
 * 单次 system + user 对话；失败时返回 null（用于编辑记忆合并等非关键路径）。
 */
export async function llmChat(
    platform: string,
    model: string,
    system: string,
    user: string,
    temperature: number = 0.3,
    logTag: string = 'llmClient'
): Promise<string | null> {
    const config = vscode.workspace.getConfiguration('ai-proofread');
    const { retryAttempts, retryDelay, disableThinking } = readProofreadLlmSettings();
    const timeout = secondsToMs(config.get<number>('proofread.timeout', 50), 50);
    const logger = Logger.getInstance();
    const cm = ConfigManager.getInstance();

    if (platform === 'google') {
        const apiKey = cm.getApiKey('google');
        if (!apiKey) return null;
        const ai = new GoogleGenAI({ apiKey });
        const gReq = {
            model,
            config: {
                systemInstruction: system,
                temperature,
                thinkingConfig: { thinkingBudget: 0 },
            },
            contents: user,
        };
        for (let attempt = 1; attempt <= retryAttempts; attempt++) {
            try {
                const res = await ai.models.generateContent({
                    model,
                    config: {
                        systemInstruction: system,
                        temperature,
                        thinkingConfig: { thinkingBudget: 0 },
                    },
                    contents: user,
                });
                let resSnap: unknown = { text: res.text ?? null };
                try {
                    resSnap = JSON.parse(JSON.stringify(res));
                } catch {
                    /* ignore */
                }
                logger.debugLlmRoundtrip(`[${logTag}/google]`, gReq, resSnap);
                return res.text || null;
            } catch (e) {
                logger.debugLlmFailure(`[${logTag}/google]`, gReq, e);
                logger.error(`[${logTag}] google`, e);
                if (attempt < retryAttempts) await new Promise((r) => setTimeout(r, retryDelay));
            }
        }
        return null;
    }

    let url: string;
    let headers: Record<string, string>;
    if (platform === 'aliyun') {
        const key = cm.getApiKey('aliyun');
        if (!key) return null;
        url = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
        headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
    } else if (platform === 'ollama') {
        const base = cm.getApiKey('ollama') || 'http://localhost:11434';
        url = `${base.replace(/\/$/, '')}/api/chat`;
        headers = { 'Content-Type': 'application/json' };
    } else {
        const key = cm.getApiKey('deepseek');
        if (!key) return null;
        url = 'https://api.deepseek.com/v1/chat/completions';
        headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
    }

    for (let attempt = 1; attempt <= retryAttempts; attempt++) {
        let bodyForLog: unknown = { url, platform, model };
        try {
            if (platform === 'ollama') {
                const body = {
                    model,
                    stream: false,
                    messages: [
                        { role: 'system', content: system },
                        { role: 'user', content: user },
                    ],
                    options: { temperature },
                };
                bodyForLog = body;
                const res = await axios.post(url, body, { headers, timeout });
                logger.debugLlmRoundtrip(`[${logTag}/${platform}]`, body, res.data);
                const c = res.data?.message?.content;
                return typeof c === 'string' ? c : null;
            }

            const body: Record<string, unknown> = {
                model,
                messages: [
                    { role: 'system', content: system },
                    { role: 'user', content: user },
                ],
                temperature,
            };
            if (platform === 'deepseek' && disableThinking) {
                body.thinking = { type: 'disabled' };
            }
            if (platform === 'aliyun') {
                body.enable_thinking = !disableThinking;
            }

            bodyForLog = body;
            const res = await axios.post(url, body, { headers, timeout });
            logger.debugLlmRoundtrip(`[${logTag}/${platform}]`, body, res.data);
            const text = res.data?.choices?.[0]?.message?.content;
            return typeof text === 'string' ? text : null;
        } catch (e) {
            logger.debugLlmFailure(`[${logTag}/${platform}]`, bodyForLog, e);
            logger.error(`[${logTag}] request`, e);
            if (attempt < retryAttempts) await new Promise((r) => setTimeout(r, retryDelay));
        }
    }
    return null;
}

export function stripJsonFence(text: string): string {
    let t = text.trim();
    const fm = t.match(/^```(?:json)?\s*([\s\S]*?)```$/m);
    if (fm) return fm[1].trim();
    if (t.startsWith('```')) {
        t = t.replace(/^```\w*\s*/, '').replace(/\s*```$/, '');
    }
    return t.trim();
}

async function callOpenAICompatible(params: {
    baseUrl: string;
    apiKey: string;
    model: string;
    systemPrompt: string;
    userPrompt: string;
    temperature: number;
    timeout: number;
    useDeepseekThinking?: boolean;
    useAliyunEnableThinking?: boolean;
    disableThinking?: boolean;
    logTag: string;
}): Promise<string> {
    if (!params.apiKey) throw new Error('未配置 API 密钥');
    const disableThinking = params.disableThinking ?? true;
    const logger = Logger.getInstance();
    const requestBody: Record<string, unknown> = {
        model: params.model,
        messages: [
            { role: 'system', content: params.systemPrompt },
            { role: 'user', content: params.userPrompt },
        ],
    };

    if (params.useAliyunEnableThinking) {
        requestBody.enable_thinking = !disableThinking;
    }
    if (params.useDeepseekThinking) {
        if (disableThinking) {
            requestBody.thinking = { type: 'disabled' };
        } else {
            requestBody.thinking = { type: 'enabled' };
            requestBody.reasoning_effort = 'high';
        }
    }
    if (params.temperature !== undefined) {
        if (params.useDeepseekThinking) {
            if (disableThinking) requestBody.temperature = params.temperature;
        } else {
            requestBody.temperature = params.temperature;
        }
    }

    const endpoint = `${params.baseUrl}/chat/completions`;
    const reqLabel = { url: endpoint, body: requestBody };
    try {
        const resp = await axios.post(endpoint, requestBody, {
            headers: {
                Authorization: `Bearer ${params.apiKey}`,
                'Content-Type': 'application/json',
            },
            timeout: params.timeout,
        });
        logger.debugLlmRoundtrip(`[${params.logTag}/OpenAICompatible]`, reqLabel, resp.data);
        const text = resp?.data?.choices?.[0]?.message?.content;
        if (!text || typeof text !== 'string') throw new Error('LLM 返回空结果');
        return text;
    } catch (e) {
        logger.debugLlmFailure(`[${params.logTag}/OpenAICompatible]`, reqLabel, e);
        throw e;
    }
}

async function callGoogle(params: {
    model: string;
    systemPrompt: string;
    userPrompt: string;
    temperature: number;
    logTag: string;
}): Promise<string> {
    const logger = Logger.getInstance();
    const apiKey = ConfigManager.getInstance().getApiKey('google');
    if (!apiKey) throw new Error('未配置 Google Gemini API 密钥');
    const ai = new GoogleGenAI({ apiKey });
    const reqSnap = {
        model: params.model,
        config: {
            systemInstruction: params.systemPrompt,
            temperature: params.temperature,
            thinkingConfig: { thinkingBudget: 0 },
        },
        contents: params.userPrompt,
    };
    try {
        const resp = await ai.models.generateContent({
            model: params.model,
            config: {
                systemInstruction: params.systemPrompt,
                temperature: params.temperature,
                thinkingConfig: { thinkingBudget: 0 },
            },
            contents: params.userPrompt,
        });
        let resSnap: unknown = { text: resp.text ?? null };
        try {
            resSnap = JSON.parse(JSON.stringify(resp));
        } catch {
            /* ignore */
        }
        logger.debugLlmRoundtrip(`[${params.logTag}/google]`, reqSnap, resSnap);
        const text = resp.text;
        if (!text) throw new Error('LLM 返回空结果');
        return text;
    } catch (e) {
        logger.debugLlmFailure(`[${params.logTag}/google]`, reqSnap, e);
        throw e;
    }
}

async function callOllama(params: {
    model: string;
    systemPrompt: string;
    userPrompt: string;
    temperature: number;
    timeout: number;
    logTag: string;
}): Promise<string> {
    const logger = Logger.getInstance();
    const baseUrl = ConfigManager.getInstance().getApiKey('ollama') || 'http://localhost:11434';
    const url = `${baseUrl.replace(/\/$/, '')}/api/chat`;
    const body = {
        model: params.model,
        stream: false,
        messages: [
            { role: 'system', content: params.systemPrompt },
            { role: 'user', content: params.userPrompt },
        ],
        options: { temperature: params.temperature },
    };
    try {
        const resp = await axios.post(url, body, { timeout: params.timeout });
        logger.debugLlmRoundtrip(`[${params.logTag}/ollama]`, { url, body }, resp.data);
        const text = resp?.data?.message?.content;
        if (!text || typeof text !== 'string') throw new Error('LLM 返回空结果');
        return text;
    } catch (e) {
        logger.debugLlmFailure(`[${params.logTag}/ollama]`, { url, body }, e);
        throw e;
    }
}
