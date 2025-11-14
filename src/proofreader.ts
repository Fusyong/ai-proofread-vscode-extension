/**
 * 校对工具模块
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import axios from 'axios';
import * as dotenv from 'dotenv';
import { RateLimiter } from './rateLimiter';
import { GoogleGenAI } from "@google/genai";
import { ConfigManager, Logger } from './utils';
import { convertQuotes } from './quoteConverter';
import { buildTitleBasedContext, buildParagraphBasedContext } from './splitter';
import { ProgressTracker, ProgressUpdateCallback } from './progressTracker';

// 加载环境变量
dotenv.config();

// 内置的系统提示词
let DEFAULT_SYSTEM_PROMPT = `
<proofreader-system-setting version="0.0.1">
<role-setting>

你是一位精通中文的校对专家、语言文字专家，像杜永道等专家那样，能准确地发现文章的语言文字问题。

你的语感也非常好，通过朗读就能感受到句子是否自然，是否潜藏问题。

你知识渊博，能发现文中的事实错误。

你工作细致、严谨，当你发现潜在的问题时，你会通过维基百科、《现代汉语词典》《辞海》等各种权威工具书来核对；如果涉及古代汉语和古代文化，你会专门查阅中华书局、上海古籍出版社等权威出版社出版的古籍，以及《王力古汉语字典》《汉语大词典》《辞源》《辞海》等工具书。

你还学习过以下数据纠错数据集：

1. [中文语法纠错数据集](https://huggingface.co/datasets/shibing624/CSC-gpt4)
2. [校对标准A-Z](http://www.jiaodui.org/bbs/thread.php?fid=692)

你的任务是对用户提供的目标文本（target）进行校对；校对时参考用户提供的参考资料（reference）和上下文（context）。

</role-setting>
<task>

工作步骤是：

1. 一句一句地仔细阅读甚至朗读每一句话，找出句子中可能存在的问题并改正；可能的问题有：
    1. 汉字错误，如错误的形近字、同音和音近字，简体字和繁体字混用，异体字，等等；
    2. 词语错误，如生造的词语、不规范的异形词，等等；
    3. 句子的语法错误；
    4. 指代错误；
    5. 修辞错误；
    6. 逻辑错误；
    7. 标点符号错误；
    8. 数字用法错误；
    9. 语序错误；
    10. 古诗文和引文跟权威、通行的版本不一致；
    11. 等等；
2. 即使句子没有明显的错误，如果朗读过程中你感觉有下面的问题，也说明句子可能有错误，也要加以改正：
    1. 句子不自然、不顺当；
    2. 如果让你表达同一个意思，你通常不会这么说；
3. 再整体检查如下错误并改正：
    1. 逻辑错误；
    2. 章法错误；
    3. 事实错误；
    4. 前后文不一致的问题；
4. 核对参考资料和上下文中的信息，对照上下文中的格式，如果发现有错误或不一致，也要加以改正。

</task>
<output-format>

在用户提供的目标文本（target）上直接校对，并输出校对后的目标文本。对输出的要求是：

1. 用户提供的文本的格式可能是markdown、纯文本、TEX、ConTeXt，请保持文本原有的格式和标记；
2. 原文的空行、换行、分段等格式保持不变；
3. 只进行校对，不回答原文中的任何提问；
4. 只在目标文本（target）上直接校对，并输出校对后的目标文本，不给出任何说明或解释；
5. 即使你确认的确没有任何修改，也应该逐句阅读并输出原文；
</output-format>
</proofreader-system-setting>
`;

// 获取用户配置的提示词
function getSystemPrompt(context?: vscode.ExtensionContext): string {
    const config = vscode.workspace.getConfiguration('ai-proofread');
    const prompts = config.get<Array<{name: string, content: string}>>('prompts', []);
    const logger = Logger.getInstance();

    // 如果有context，从全局状态获取当前选择的提示词名称
    if (context) {
        const currentPromptName = context.globalState.get<string>('currentPrompt', '');

        // 如果当前选择的是系统默认提示词（空字符串）
        if (currentPromptName === '') {
            logger.info('使用系统默认提示词');
            return DEFAULT_SYSTEM_PROMPT;
        }

        // 如果当前选择的是自定义提示词，查找对应的提示词
        if (currentPromptName && prompts.length > 0) {
            const selectedPrompt = prompts.find(p => p.name === currentPromptName);
            if (selectedPrompt) {
                logger.info(`使用自定义提示词: ${selectedPrompt.name}`);
                return selectedPrompt.content;
            }
        }
    }

    // 如果没有context或没有找到对应的提示词，使用默认逻辑
    if (prompts.length > 0) {
        // 如果有自定义提示词，使用第一个作为默认
        logger.info(`使用自定义提示词: ${prompts[0].name}`);
        return prompts[0].content;
    }

    // 如果没有自定义提示词，使用系统默认提示词
    logger.info('使用系统默认提示词');
    return DEFAULT_SYSTEM_PROMPT;
}

/**
 * API调用接口
 */
export interface ApiClient {
    proofread(targetText: string, preText?: string, temperature?: number | null, context?: vscode.ExtensionContext): Promise<string | null>;
}

/**
 * 处理进度统计
 */
export interface ProcessStats {
    totalCount: number;
    processedCount: number;
    totalLength: number;
    processedLength: number;
    unprocessedParagraphs: Array<{
        index: number;
        preview: string;
    }>;
    progressTracker?: ProgressTracker;
}

/**
 * Deepseek API客户端
 */
export class DeepseekApiClient implements ApiClient {
    private apiKey: string;
    private baseUrl: string;
    private model: string;

    constructor(model: string) {
        const configManager = ConfigManager.getInstance();
        this.model = model;
        this.apiKey = configManager.getApiKey('deepseek');
        this.baseUrl = 'https://api.deepseek.com/v1';

        if (!this.apiKey) {
            throw new Error('未配置 Deepseek开放平台 API密钥，请在设置中配置');
        }
    }

    // 使用 Deepseek API 进行校对
    async proofread(targetText: string, preText: string = '', temperature: number|null = null, context?: vscode.ExtensionContext): Promise<string | null> {
        const logger = Logger.getInstance();
        const config = vscode.workspace.getConfiguration('ai-proofread');
        const retryAttempts = config.get<number>('proofread.retryAttempts', 3);
        const retryDelay = config.get<number>('proofread.retryDelay', 1000);
        const timeout = config.get<number>('proofread.timeout', 50000);

        const messages = [
            { role: 'system', content: getSystemPrompt(context) }
        ];

        if (preText) {
            messages.push(
                { role: 'assistant', content: '' },
                { role: 'user', content: preText }
            );
        }

        messages.push(
            { role: 'assistant', content: '' },
            { role: 'user', content: targetText }
        );

        const finalTemperature = temperature || config.get<number>('proofread.temperature');
        const requestBody: any = {
            model: this.model,
            messages,
        };

        if (finalTemperature !== undefined) {
            requestBody.temperature = finalTemperature;
        } else {
        }

        // 重试机制
        for (let attempt = 1; attempt <= retryAttempts; attempt++) {
            try {
                
                const response = await axios.post(
                    `${this.baseUrl}/chat/completions`,
                    requestBody,
                    {
                        headers: {
                            'Authorization': `Bearer ${this.apiKey}`,
                            'Content-Type': 'application/json',
                        },
                        timeout: timeout
                    }
                );

                let result = response.data.choices[0].message.content;
                result = result.replace('\n</target>', '').replace('<target>\n', '');
                return result;
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                const isNetworkError = errorMessage.includes('fetch failed') || 
                                     errorMessage.includes('network') || 
                                     errorMessage.includes('timeout') ||
                                     errorMessage.includes('ECONNRESET') ||
                                     errorMessage.includes('ENOTFOUND') ||
                                     errorMessage.includes('ECONNREFUSED');

                if (attempt === retryAttempts) {
                    // 最后一次尝试失败
                    logger.error(`API调用失败，已重试 ${retryAttempts} 次`, error);
                    return null;
                }

                if (isNetworkError) {
                    // 网络错误，进行重试
                    logger.warn(`网络错误，${retryDelay}ms后进行第 ${attempt + 1} 次重试: ${errorMessage}`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                } else {
                    // 非网络错误，不重试
                    logger.error('API调用出错（非网络错误，不重试）', error);
                    return null;
                }
            }
        }

        return null;
    }
}

/**
 * 阿里云百炼 API客户端
 */
export class AliyunApiClient implements ApiClient {
    private apiKey: string;
    private baseUrl: string;
    private model: string;

    constructor(model: string) {
        const configManager = ConfigManager.getInstance();
        this.model = model;
        this.apiKey = configManager.getApiKey('aliyun');
        this.baseUrl = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

        if (!this.apiKey) {
            throw new Error('未配置阿里云百炼平台 API密钥，请在设置中配置');
        }
    }

    // 使用阿里云百炼 API 进行校对
    async proofread(targetText: string, preText: string = '', temperature: number|null = null, context?: vscode.ExtensionContext): Promise<string | null> {
        const logger = Logger.getInstance();
        const config = vscode.workspace.getConfiguration('ai-proofread');
        const retryAttempts = config.get<number>('proofread.retryAttempts', 3);
        const retryDelay = config.get<number>('proofread.retryDelay', 1000);
        const timeout = config.get<number>('proofread.timeout', 50000);

        const messages = [
            { role: 'system', content: getSystemPrompt(context) }
        ];

        if (preText) {
            messages.push(
                { role: 'assistant', content: '' },
                { role: 'user', content: preText }
            );
        }

        messages.push(
            { role: 'assistant', content: '' },
            { role: 'user', content: targetText }
        );

        const finalTemperature = temperature || config.get<number>('proofread.temperature');
        const requestBody: any = {
            model: this.model,
            messages,
        };

        if (finalTemperature !== undefined) {
            requestBody.temperature = finalTemperature;
        } else {
        }

        // 重试机制
        for (let attempt = 1; attempt <= retryAttempts; attempt++) {
            try {
                
                const response = await axios.post(
                    `${this.baseUrl}/chat/completions`,
                    requestBody,
                    {
                        headers: {
                            'Authorization': `Bearer ${this.apiKey}`,
                            'Content-Type': 'application/json',
                        },
                        timeout: timeout
                    }
                );

                let result = response.data.choices[0].message.content;
                result = result.replace('\n</target>', '').replace('<target>\n', '');
                return result;
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                const isNetworkError = errorMessage.includes('fetch failed') || 
                                     errorMessage.includes('network') || 
                                     errorMessage.includes('timeout') ||
                                     errorMessage.includes('ECONNRESET') ||
                                     errorMessage.includes('ENOTFOUND') ||
                                     errorMessage.includes('ECONNREFUSED');

                if (attempt === retryAttempts) {
                    // 最后一次尝试失败
                    logger.error(`API调用失败，已重试 ${retryAttempts} 次`, error);
                    return null;
                }

                if (isNetworkError) {
                    // 网络错误，进行重试
                    logger.warn(`网络错误，${retryDelay}ms后进行第 ${attempt + 1} 次重试: ${errorMessage}`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                } else {
                    // 非网络错误，不重试
                    logger.error('API调用出错（非网络错误，不重试）', error);
                    return null;
                }
            }
        }

        return null;
    }
}

/**
 * Google API客户端
 */
export class GoogleApiClient implements ApiClient {
    private apiKey: string;
    private model: string;
    private ai: GoogleGenAI;

    constructor(model: string) {
        const configManager = ConfigManager.getInstance();
        this.model = model;
        this.apiKey = configManager.getApiKey('google');
        this.ai = new GoogleGenAI({ apiKey: this.apiKey });

        if (!this.apiKey) {
            throw new Error('未配置 Google Gemini API密钥，请在设置中配置');
        }
    }

    // 使用 Google API 进行校对
    async proofread(targetText: string, preText: string = '', temperature: number|null = null, context?: vscode.ExtensionContext): Promise<string | null> {
        const logger = Logger.getInstance();
        const config = vscode.workspace.getConfiguration('ai-proofread');
        const retryAttempts = config.get<number>('proofread.retryAttempts', 3);
        const retryDelay = config.get<number>('proofread.retryDelay', 1000);

        let contents = targetText;
        if(preText) {
            contents = [contents, preText].join('\n\n');
        }

        const finalTemperature = temperature || config.get<number>('proofread.temperature');
        const disableThinking = config.get<boolean>('proofread.disableThinking', true);
        
        const configObj: any = {
            systemInstruction: getSystemPrompt(context),
        };

        if (finalTemperature !== undefined) {
            configObj.temperature = finalTemperature;
        } else {
        }

        // 配置思考功能
        if (!disableThinking) {
            configObj.thinkingConfig = {
                thinkingBudget: 1 // 1表示启用思考，0表示禁用思考
            };
        } else {
            configObj.thinkingConfig = {
                thinkingBudget: 0 // 1表示启用思考，0表示禁用思考
            };
        }

        // 重试机制
        for (let attempt = 1; attempt <= retryAttempts; attempt++) {
            try {
                
                const response = await this.ai.models.generateContent({
                    model: this.model,
                    config: configObj,
                    contents: contents,
                });

                return response.text || null;
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                const isNetworkError = errorMessage.includes('fetch failed') || 
                                     errorMessage.includes('network') || 
                                     errorMessage.includes('timeout') ||
                                     errorMessage.includes('ECONNRESET') ||
                                     errorMessage.includes('ENOTFOUND');

                if (attempt === retryAttempts) {
                    // 最后一次尝试失败
                    logger.error(`API调用失败，已重试 ${retryAttempts} 次`, error);
                    return null;
                }

                if (isNetworkError) {
                    // 网络错误，进行重试
                    logger.warn(`网络错误，${retryDelay}ms后进行第 ${attempt + 1} 次重试: ${errorMessage}`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                } else {
                    // 非网络错误，不重试
                    logger.error('API调用出错（非网络错误，不重试）', error);
                    return null;
                }
            }
        }

        return null;
    }
}

/**
 * Ollama本地模型 API客户端
 */
export class OllamaApiClient implements ApiClient {
    private baseUrl: string;
    private model: string;

    constructor(model: string) {
        const configManager = ConfigManager.getInstance();
        this.model = model;
        this.baseUrl = configManager.getApiKey('ollama') || 'http://localhost:11434';

        if (!this.baseUrl) {
            throw new Error('未配置 Ollama 服务地址，请在设置中配置');
        }
    }

    // 使用 Ollama API 进行校对
    async proofread(targetText: string, preText: string = '', temperature: number|null = null, context?: vscode.ExtensionContext): Promise<string | null> {
        const logger = Logger.getInstance();
        const config = vscode.workspace.getConfiguration('ai-proofread');
        const retryAttempts = config.get<number>('proofread.retryAttempts', 3);
        const retryDelay = config.get<number>('proofread.retryDelay', 1000);
        const timeout = config.get<number>('proofread.timeout', 300000); // Ollama本地模型默认5分钟超时

        const messages = [
            { role: 'system', content: getSystemPrompt(context) }
        ];

        if (preText) {
            messages.push(
                { role: 'assistant', content: '' },
                { role: 'user', content: preText }
            );
        }

        messages.push(
            { role: 'assistant', content: '' },
            { role: 'user', content: targetText }
        );

        const finalTemperature = temperature || config.get<number>('proofread.temperature');
        const requestBody: any = {
            model: this.model,
            messages,
            stream: false
        };

        if (finalTemperature !== undefined) {
            requestBody.options = {
                temperature: finalTemperature
            };
        } else {
        }

        // 重试机制
        for (let attempt = 1; attempt <= retryAttempts; attempt++) {
            try {
                
                const response = await axios.post(
                    `${this.baseUrl}/api/chat`,
                    requestBody,
                    {
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        timeout: timeout
                    }
                );

                let result = response.data.message.content;
                result = result.replace('\n</target>', '').replace('<target>\n', '');
                return result;
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                const isNetworkError = errorMessage.includes('fetch failed') || 
                                     errorMessage.includes('network') || 
                                     errorMessage.includes('timeout') ||
                                     errorMessage.includes('ECONNRESET') ||
                                     errorMessage.includes('ENOTFOUND') ||
                                     errorMessage.includes('ECONNREFUSED');

                if (attempt === retryAttempts) {
                    // 最后一次尝试失败
                    logger.error(`API调用失败，已重试 ${retryAttempts} 次`, error);
                    return null;
                }

                if (isNetworkError) {
                    // 网络错误，进行重试
                    logger.warn(`网络错误，${retryDelay}ms后进行第 ${attempt + 1} 次重试: ${errorMessage}`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                } else {
                    // 非网络错误，不重试
                    logger.error('API调用出错（非网络错误，不重试）', error);
                    return null;
                }
            }
        }

        return null;
    }
}

/**
 * 异步处理段落
 */
export async function processJsonFileAsync(
    jsonInPath: string,
    jsonOutPath: string,
    options: {
        startCount?: number | number[];
        stopCount?: number;
        platform?: string;
        model?: string;
        rpm?: number;
        maxConcurrent?: number;
        temperature?: number;
        onProgress?: (info: string) => void;
        onProgressUpdate?: (progressTracker: ProgressTracker) => void;
        token?: vscode.CancellationToken;
        context?: vscode.ExtensionContext;
        mdFilePath?: string; // 可选的 markdown 文件路径
    } = {}
): Promise<ProcessStats> {
    const logger = Logger.getInstance();
    // 设置默认值
    const {
        startCount = 1,
        stopCount,
        platform = 'deepseek',
        model = 'deepseek-chat',
        rpm = 15,
        maxConcurrent = 3,
        temperature = 1,
        onProgress,
        onProgressUpdate,
        token,
        context
    } = options;

    // 读取输入JSON文件
    const inputParagraphs = JSON.parse(fs.readFileSync(jsonInPath, 'utf8'));
    const totalCount = inputParagraphs.length;

    // 初始化或读取输出JSON文件
    let outputParagraphs: (string | null)[] = [];
    if (fs.existsSync(jsonOutPath)) {
        outputParagraphs = JSON.parse(fs.readFileSync(jsonOutPath, 'utf8'));
        if (outputParagraphs.length !== totalCount) {
            throw new Error(`输出JSON的长度与输入JSON的长度不同: ${outputParagraphs.length} != ${totalCount}。请解决冲突，或删除原有的输出JSON文件。`);
        }
    } else {
        outputParagraphs = new Array(totalCount).fill(null);
        fs.writeFileSync(jsonOutPath, JSON.stringify(outputParagraphs, null, 2), 'utf8');
    }

    // 创建进度跟踪器
    const progressTracker = new ProgressTracker(inputParagraphs, onProgressUpdate);

    // 根据现有输出文件初始化已完成的状态
    for (let i = 0; i < outputParagraphs.length; i++) {
        if (outputParagraphs[i] !== null) {
            progressTracker.updateProgress(i, 'completed');
        }
    }

    // 触发初始状态更新
    if (onProgressUpdate) {
        onProgressUpdate(progressTracker);
    }

    // 确定要处理的段落索引
    const indicesToProcess: number[] = [];
    if (typeof startCount === 'number') {
        const startIndex = startCount - 1;
        const stopIndex = stopCount ? stopCount - 1 : totalCount - 1;
        for (let i = startIndex; i <= stopIndex; i++) {
            if (i < totalCount && outputParagraphs[i] === null) {
                indicesToProcess.push(i);
            }
        }
    } else {
        for (const idx of startCount) {
            const i = idx - 1;
            if (0 <= i && i < totalCount && outputParagraphs[i] === null) {
                indicesToProcess.push(i);
            }
        }
    }

    // 创建API客户端
    const client: ApiClient = (() => {
        switch (platform) {
            case 'google':
                return new GoogleApiClient(model);
            case 'aliyun':
                return new AliyunApiClient(model);
            case 'ollama':
                return new OllamaApiClient(model);
            case 'deepseek':
            default:
                return new DeepseekApiClient(model);
        }
    })();

    // 创建限速器
    const rateLimiter = new RateLimiter(rpm);

    // 创建并发控制
    const semaphore = new Array(maxConcurrent).fill(null);

    // 处理段落
    const processOne = async (index: number): Promise<void> => {
        // 检查是否已取消
        if (token?.isCancellationRequested || progressTracker.isCancellationRequested()) {
            return;
        }

        const paragraph = inputParagraphs[index];
        const targetText = paragraph.target;
        const referenceText = paragraph.reference || '';
        const contextText = paragraph.context || '';

        // 更新状态为已提交
        progressTracker.updateProgress(index, 'submitted');

        const haseContext = contextText && contextText.trim() !== targetText.trim();
        const progressInfo = `处理 No. ${index + 1}/${totalCount}, Len ${targetText.length}` +
            `${haseContext ? ` with context ${contextText.length}` : ''}`+
            `${referenceText ? ` with reference ${referenceText.length}` : ''}:`+
            `\n${targetText.slice(0, 30)} ...\n`+
            `${'-'.repeat(40)}\n`;
        logger.info(progressInfo);
        if (onProgress) {
            onProgress(progressInfo);
        }

        // 构建提示文本
        let preText = referenceText ? `<reference>\n${referenceText}\n</reference>` : '';
        if (haseContext) {
            preText += `\n<context>\n${contextText}\n</context>`;
        }
        const labeledTargetText = `<target>\n${targetText}\n</target>`;

        // console.log(model);
        // console.log(preText);
        // console.log(postText);

        const startTime = Date.now();
        await rateLimiter.wait();

        try {
            const processedText = await client.proofread(labeledTargetText, preText, temperature, context);
            const elapsed = (Date.now() - startTime) / 1000;

            if (processedText) {
                outputParagraphs[index] = processedText;
                fs.writeFileSync(jsonOutPath, JSON.stringify(outputParagraphs, null, 2), 'utf8');
                
                // 更新状态为已完成
                progressTracker.updateProgress(index, 'completed');
                
                const completeInfo = `完成 ${index + 1}/${totalCount} 长度 ${targetText.length} 用时 ${elapsed.toFixed(2)}s\n${'-'.repeat(40)}\n`;
                logger.info(completeInfo);
                if (onProgress) {
                    onProgress(completeInfo);
                }
            } else {
                // 更新状态为失败
                progressTracker.updateProgress(index, 'failed', 'API返回空结果');
                
                const errorInfo = `段落 ${index + 1}/${totalCount}: 处理失败，跳过\n${'-'.repeat(40)}\n`;
                logger.error(errorInfo);
                if (onProgress) {
                    onProgress(errorInfo);
                }
            }
        } catch (error) {
            // 更新状态为失败
            const errorMessage = error instanceof Error ? error.message : String(error);
            progressTracker.updateProgress(index, 'failed', errorMessage);
            
            const errorInfo = `段落 ${index + 1}/${totalCount}: 处理出错 - ${errorMessage}\n${'-'.repeat(40)}\n`;
            logger.error(errorInfo);
            if (onProgress) {
                onProgress(errorInfo);
            }
        }
    };

    // 并发处理所有段落
    const processingPromises: Promise<void>[] = [];
    
    for (const index of indicesToProcess) {
        // 检查是否已取消
        if (token?.isCancellationRequested || progressTracker.isCancellationRequested()) {
            // 设置取消状态
            progressTracker.setCancelled(true);
            break;
        }

        const slot = await Promise.race(
            semaphore.map((_, i) =>
                Promise.resolve(i)
            )
        );
        
        const promise = processOne(index).finally(() => {
            semaphore[slot] = null;
        });
        
        semaphore[slot] = promise;
        processingPromises.push(promise);
        
        await promise;
    }

    // 等待所有正在处理的任务完成
    if (token?.isCancellationRequested || progressTracker.isCancellationRequested()) {
        logger.info('用户取消操作，等待已提交的任务完成...');
        await Promise.allSettled(processingPromises);
        logger.info('已提交的任务已完成');
    }

    // 生成处理统计
    const processedCount = outputParagraphs.filter(p => p !== null).length;
    const totalLength = inputParagraphs.reduce((sum: number, p: any) => sum + p.target.length, 0);
    const processedLength = outputParagraphs.reduce((sum: number, p: string | null) => sum + (p ? p.length : 0), 0);
    const unprocessedParagraphs = inputParagraphs
        .map((p: any, i: number) => ({
            index: i + 1,
            preview: p.target.trim().split('\n')[0].slice(0, 20)
        }))
        .filter((_: any, i: number) => outputParagraphs[i] === null);

    // 生成Markdown文件
    const mdFilePath = options.mdFilePath || `${jsonOutPath}.md`;
    const processedParagraphs = outputParagraphs.filter(p => p !== null);
    fs.writeFileSync(mdFilePath, processedParagraphs.join('\n\n'), 'utf8');

    return {
        totalCount,
        processedCount,
        totalLength,
        processedLength,
        unprocessedParagraphs,
        progressTracker
    };
}

/**
 * 处理选中的文本校对
 * @param editor 当前编辑器
 * @param selection 选中的文本范围
 * @param platform 使用的平台
 * @param model 使用的模型
 * @param contextLevel 上下文级别
 * @param referenceFile 参考文件
 * @param userTemperature 用户指定的温度
 * @param context 扩展上下文
 * @returns 校对后的文本
 */
export async function proofreadSelection(
    editor: vscode.TextEditor,
    selection: vscode.Selection,
    platform: string,
    model: string,
    contextLevel?: string,
    referenceFile?: vscode.Uri[],
    userTemperature?: number,
    context?: vscode.ExtensionContext,
    beforeParagraphs?: number,
    afterParagraphs?: number
): Promise<string | null> {
    // 获取选中的文本
    const selectedText = editor.document.getText(selection);
    if (!selectedText) {
        throw new Error('请先选择要校对的文本！');
    }

    // 准备校对文本
    let targetText = selectedText;
    let contextText = '';
    let referenceText = '';

    // 如果选择了上下文级别，获取上下文
    if (contextLevel && contextLevel !== '不使用上下文') {
        const fullText = editor.document.getText();
        // 切分成段落
        const lines = fullText.split(/\n/);
        const selectionStartLine = selection.start.line;
        const selectionEndLine = selection.end.line;

        if (contextLevel === '前后增加段落') {
            // 使用抽象的前后段落上下文构建函数
            contextText = buildParagraphBasedContext(
                fullText,
                selectionStartLine,
                selectionEndLine,
                beforeParagraphs || 1,
                afterParagraphs || 1
            );
        } else {
            // 使用抽象的标题级别上下文构建函数
            contextText = buildTitleBasedContext(
                fullText,
                selectionStartLine,
                selectionEndLine,
                contextLevel
            );
        }
    }

    // 如果选择了参考文件，读取参考文件内容
    if (referenceFile && referenceFile[0]) {
        referenceText = fs.readFileSync(referenceFile[0].fsPath, 'utf8');
    }

    // 构建提示文本
    let preText = referenceText ? `<reference>\n${referenceText}\n</reference>` : '';
    if (contextText && contextText.trim() !== targetText.trim()) {
        preText += `\n<context>\n${contextText}\n</context>`;
    }
    const postText = `<target>\n${targetText}\n</target>`;

    // 获取当前使用的提示词名称
    let currentPromptName = '系统默认提示词';
    if (context) {
        const promptName = context.globalState.get<string>('currentPrompt', '');
        if (promptName !== '') {
            currentPromptName = promptName;
        }
    }

    // 显示校对信息
    const targetLength = targetText.length;
    const contextLength = contextText.length;
    const referenceLength = referenceText.length;
    vscode.window.showInformationMessage(`Prompt: ${currentPromptName.slice(0, 4)}…; Context: T. ${targetLength}, C. ${contextLength}, R. ${referenceLength}; Model: ${platform}, ${model}, T. ${userTemperature}`);

    // 调用API进行校对
    const client = (() => {
        switch (platform) {
            case 'google':
                return new GoogleApiClient(model);
            case 'aliyun':
                return new AliyunApiClient(model);
            case 'ollama':
                return new OllamaApiClient(model);
            case 'deepseek':
            default:
                return new DeepseekApiClient(model);
        }
    })();

    let result = await client.proofread(postText, preText, userTemperature, context);

    // 如果校对成功且启用了引号转换，则自动转换引号
    if (result) {
        const config = vscode.workspace.getConfiguration('ai-proofread');
        const shouldConvertQuotes = config.get<boolean>('convertQuotes', false);
        if (shouldConvertQuotes) {
            result = convertQuotes(result);
        }
    }

    return result;
}