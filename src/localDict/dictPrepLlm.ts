import * as vscode from 'vscode';
import axios from 'axios';
import { GoogleGenAI } from '@google/genai';
import { ConfigManager, Logger } from '../utils';

function secondsToMs(v: number | undefined, fallback: number): number {
    const x = typeof v === 'number' && !Number.isNaN(v) ? v : fallback;
    return x * 1000;
}

export async function llmGenerateJson(params: {
    platform: string;
    model: string;
    systemPrompt: string;
    userPrompt: string;
    temperature?: number;
}): Promise<string> {
    const logger = Logger.getInstance();
    const config = vscode.workspace.getConfiguration('ai-proofread');
    const retryAttempts = config.get<number>('proofread.retryAttempts', 3);
    const retryDelay = secondsToMs(config.get<number>('proofread.retryDelay', 1), 1);
    const timeout = secondsToMs(config.get<number>('proofread.timeout', 120), 120);

    const temperature = params.temperature ?? config.get<number>('proofread.temperature', 1);

    for (let attempt = 1; attempt <= retryAttempts; attempt++) {
        try {
            if (params.platform === 'google') {
                return await callGoogle({
                    model: params.model,
                    systemPrompt: params.systemPrompt,
                    userPrompt: params.userPrompt,
                    temperature,
                });
            }
            if (params.platform === 'ollama') {
                return await callOllama({
                    model: params.model,
                    systemPrompt: params.systemPrompt,
                    userPrompt: params.userPrompt,
                    temperature,
                    timeout,
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
                });
            }
            // deepseek default
            return await callOpenAICompatible({
                baseUrl: 'https://api.deepseek.com/v1',
                apiKey: ConfigManager.getInstance().getApiKey('deepseek'),
                model: params.model,
                systemPrompt: params.systemPrompt,
                userPrompt: params.userPrompt,
                temperature,
                timeout,
            });
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const isNetwork = /fetch failed|network|timeout|ECONNRESET|ENOTFOUND|ECONNREFUSED/i.test(msg);
            if (attempt >= retryAttempts || !isNetwork) {
                logger.error(`[dictPrepLlm] LLM 调用失败（attempt ${attempt}/${retryAttempts}）: ${msg}`, e);
                throw e;
            }
            logger.warn(`[dictPrepLlm] 网络错误，${(retryDelay / 1000).toFixed(1)}s 后重试: ${msg}`);
            await new Promise((r) => setTimeout(r, retryDelay));
        }
    }
    throw new Error('LLM 调用失败：超过重试次数');
}

async function callOpenAICompatible(params: {
    baseUrl: string;
    apiKey: string;
    model: string;
    systemPrompt: string;
    userPrompt: string;
    temperature: number;
    timeout: number;
}): Promise<string> {
    if (!params.apiKey) {
        throw new Error('未配置 API 密钥');
    }
    const resp = await axios.post(
        `${params.baseUrl}/chat/completions`,
        {
            model: params.model,
            messages: [
                { role: 'system', content: params.systemPrompt },
                { role: 'user', content: params.userPrompt },
            ],
            temperature: params.temperature,
        },
        {
            headers: {
                Authorization: `Bearer ${params.apiKey}`,
                'Content-Type': 'application/json',
            },
            timeout: params.timeout,
        }
    );
    const text = resp?.data?.choices?.[0]?.message?.content;
    if (!text || typeof text !== 'string') {
        throw new Error('LLM 返回空结果');
    }
    return text;
}

async function callGoogle(params: {
    model: string;
    systemPrompt: string;
    userPrompt: string;
    temperature: number;
}): Promise<string> {
    const apiKey = ConfigManager.getInstance().getApiKey('google');
    if (!apiKey) throw new Error('未配置 Google Gemini API 密钥');
    const ai = new GoogleGenAI({ apiKey });
    const resp = await ai.models.generateContent({
        model: params.model,
        config: {
            systemInstruction: params.systemPrompt,
            temperature: params.temperature,
            thinkingConfig: { thinkingBudget: 0 },
        },
        contents: params.userPrompt,
    });
    const text = resp.text;
    if (!text) throw new Error('LLM 返回空结果');
    return text;
}

async function callOllama(params: {
    model: string;
    systemPrompt: string;
    userPrompt: string;
    temperature: number;
    timeout: number;
}): Promise<string> {
    const baseUrl = ConfigManager.getInstance().getApiKey('ollama') || 'http://localhost:11434';
    const resp = await axios.post(
        `${baseUrl}/api/chat`,
        {
            model: params.model,
            stream: false,
            messages: [
                { role: 'system', content: params.systemPrompt },
                { role: 'user', content: params.userPrompt },
            ],
            options: { temperature: params.temperature },
        },
        { timeout: params.timeout }
    );
    const text = resp?.data?.message?.content;
    if (!text || typeof text !== 'string') throw new Error('LLM 返回空结果');
    return text;
}

