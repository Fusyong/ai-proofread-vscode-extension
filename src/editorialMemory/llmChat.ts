import axios from 'axios';
import { GoogleGenAI } from '@google/genai';
import * as vscode from 'vscode';
import { ConfigManager, Logger } from '../utils';

function msSeconds(sec: number | undefined, def: number): number {
    const s = typeof sec === 'number' && !Number.isNaN(sec) ? sec : def;
    return s * 1000;
}

/**
 * 单次 system + user 对话（用于记忆合并 / reconcile，不走校对专用 getSystemPrompt）
 */
export async function editorialMemoryChat(
    platform: string,
    model: string,
    system: string,
    user: string,
    temperature: number = 0.3
): Promise<string | null> {
    const config = vscode.workspace.getConfiguration('ai-proofread');
    const retryAttempts = config.get<number>('proofread.retryAttempts', 3);
    const retryDelay = msSeconds(config.get<number>('proofread.retryDelay', 1), 1);
    const timeout = msSeconds(config.get<number>('proofread.timeout', 50), 50);
    const logger = Logger.getInstance();
    const cm = ConfigManager.getInstance();

    if (platform === 'google') {
        const apiKey = cm.getApiKey('google');
        if (!apiKey) {
            return null;
        }
        const ai = new GoogleGenAI({ apiKey });
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
                return res.text || null;
            } catch (e) {
                logger.error('[editorialMemoryChat] google', e);
                if (attempt < retryAttempts) {
                    await new Promise((r) => setTimeout(r, retryDelay));
                }
            }
        }
        return null;
    }

    let url: string;
    let headers: Record<string, string>;
    if (platform === 'aliyun') {
        const key = cm.getApiKey('aliyun');
        if (!key) {
            return null;
        }
        url = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
        headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
    } else if (platform === 'ollama') {
        const base = cm.getApiKey('ollama') || 'http://localhost:11434';
        url = `${base.replace(/\/$/, '')}/api/chat`;
        headers = { 'Content-Type': 'application/json' };
    } else {
        const key = cm.getApiKey('deepseek');
        if (!key) {
            return null;
        }
        url = 'https://api.deepseek.com/v1/chat/completions';
        headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
    }

    const disableThinking = config.get<boolean>('proofread.disableThinking', true);

    for (let attempt = 1; attempt <= retryAttempts; attempt++) {
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
                const res = await axios.post(url, body, { headers, timeout });
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

            const res = await axios.post(url, body, { headers, timeout });
            const text = res.data?.choices?.[0]?.message?.content;
            return typeof text === 'string' ? text : null;
        } catch (e) {
            logger.error('[editorialMemoryChat] request', e);
            if (attempt < retryAttempts) {
                await new Promise((r) => setTimeout(r, retryDelay));
            }
        }
    }
    return null;
}

export function stripJsonFence(text: string): string {
    let t = text.trim();
    const fm = t.match(/^```(?:json)?\s*([\s\S]*?)```$/m);
    if (fm) {
        return fm[1].trim();
    }
    if (t.startsWith('```')) {
        t = t.replace(/^```\w*\s*/, '').replace(/\s*```$/, '');
    }
    return t.trim();
}
