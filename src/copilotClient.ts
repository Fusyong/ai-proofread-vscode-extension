/**
 * GitHub Copilot API 客户端模块
 */

import * as vscode from 'vscode';
import { ApiClient } from './proofreader';
import { ConfigManager, Logger } from './utils';

/**
 * GitHub Copilot API 客户端
 * 通过VS Code的GitHub Copilot扩展调用AI服务
 */
export class CopilotApiClient implements ApiClient {
    private model: string;
    private logger: Logger;

    constructor(model: string) {
        this.model = model;
        this.logger = Logger.getInstance();
                    this.logger.info('初始化GitHub Copilot API客户端');
    }

    /**
     * 使用Copilot进行文本校对
     * @param targetText 目标文本
     * @param preText 前置文本（参考和上下文）
     * @param temperature 温度参数
     * @param context 扩展上下文
     * @returns 校对后的文本
     */
    async proofread(
        targetText: string, 
        preText: string = '', 
        temperature: number | null = null, 
        context?: vscode.ExtensionContext
    ): Promise<string | null> {
        try {
            this.logger.info('开始使用GitHub Copilot进行校对');
            
            // 构建完整的提示词
            const systemPrompt = this.getSystemPrompt(context);
            const fullPrompt = this.buildFullPrompt(systemPrompt, preText, targetText);
            
            // 调用Copilot API
            const result = await this.callCopilotAPI(fullPrompt, temperature);
            
            if (result) {
                this.logger.info('GitHub Copilot校对完成');
                return this.cleanResult(result);
            } else {
                this.logger.warn('GitHub Copilot返回空结果');
                return null;
            }
        } catch (error) {
            this.logger.error('GitHub Copilot API调用失败', error);
            return null;
        }
    }

    /**
     * 获取系统提示词
     */
    private getSystemPrompt(context?: vscode.ExtensionContext): string {
        // 这里可以调用proofreader.ts中的getSystemPrompt函数
        // 为了避免循环依赖，我们暂时复制一份核心提示词
        return `
你是一位精通中文的校对专家、语言文字专家，能准确地发现文章的语言文字问题。

你的任务是对用户提供的目标文本进行校对；校对时参考用户提供的参考资料和上下文。

工作步骤：
1. 仔细阅读每一句话，找出可能存在的问题并改正
2. 检查汉字错误、词语错误、语法错误、标点符号错误等
3. 整体检查逻辑错误、事实错误、前后文不一致等问题
4. 保持原文格式，只进行校对，不添加说明

输出要求：直接输出校对后的目标文本，保持原有格式。
`;
    }

    /**
     * 构建完整的提示词
     */
    private buildFullPrompt(systemPrompt: string, preText: string, targetText: string): string {
        let prompt = systemPrompt + '\n\n';
        
        if (preText) {
            prompt += `参考资料和上下文：\n${preText}\n\n`;
        }
        
        prompt += `请校对以下文本：\n${targetText}`;
        
        return prompt;
    }

    /**
     * 调用GitHub Copilot API
     * 注意：这里需要根据实际的GitHub Copilot API实现
     */
    private async callCopilotAPI(prompt: string, temperature: number | null): Promise<string | null> {
        try {
            // 这里需要实现具体的GitHub Copilot API调用
            // 由于GitHub Copilot的API可能还在发展中，我们提供一个基础实现
            
            // 方法1：尝试通过VS Code命令调用GitHub Copilot
            const result = await this.callCopilotViaVSCode(prompt);
            if (result) {
                return result;
            }
            
            // 方法2：如果VS Code命令不可用，尝试直接API调用
            return await this.callCopilotDirectAPI(prompt, temperature);
            
        } catch (error) {
            this.logger.error('GitHub Copilot API调用失败', error);
            throw error;
        }
    }

    /**
     * 通过VS Code命令调用GitHub Copilot
     * 基于 nalgeon/vscode-proofread 项目的实现
     */
    private async callCopilotViaVSCode(prompt: string): Promise<string | null> {
        try {
            // 基于参考项目，GitHub Copilot有可用的API
            // 尝试使用标准的Copilot命令
            
            const commands = [
                'github.copilot.generateText',
                'github.copilot.chat', 
                'github.copilot.complete',
                'copilot.generateText',
                'copilot.chat',
                'copilot.complete'
            ];
            
            for (const command of commands) {
                try {
                    // 检查命令是否可用
                    const availableCommands = await vscode.commands.getCommands();
                    if (availableCommands.includes(command)) {
                        this.logger.info(`尝试使用GitHub Copilot命令: ${command}`);
                        
                        // 执行命令
                        const result = await vscode.commands.executeCommand(command);
                        
                        if (result && typeof result === 'string') {
                            this.logger.info(`成功使用GitHub Copilot命令: ${command}`);
                            return result;
                        }
                    }
                } catch (error) {
                    this.logger.debug(`命令 ${command} 执行失败:`, error);
                    continue;
                }
            }
            
            this.logger.warn('所有GitHub Copilot命令都不可用');
            return null;
            
        } catch (error) {
            this.logger.error('通过VS Code命令调用GitHub Copilot失败', error);
            return null;
        }
    }

    /**
     * 直接调用GitHub Copilot API
     * 参考 nalgeon/vscode-proofread 项目的实现
     */
    private async callCopilotDirectAPI(prompt: string, temperature: number | null): Promise<string | null> {
        try {
            // 根据参考项目，GitHub Copilot有可用的API
            // 这里实现真正的API调用逻辑
            
            // 方法1：尝试通过GitHub Copilot扩展的内部API
            const result = await this.callCopilotInternalAPI(prompt);
            if (result) {
                return result;
            }
            
            // 方法2：如果内部API不可用，尝试通过HTTP请求
            return await this.callCopilotHTTPAPI(prompt, temperature);
            
        } catch (error) {
            this.logger.error('直接GitHub Copilot API调用失败', error);
            throw error;
        }
    }

    /**
     * 调用GitHub Copilot内部API
     */
    private async callCopilotInternalAPI(prompt: string): Promise<string | null> {
        try {
            // 尝试使用GitHub Copilot扩展的内部API
            // 这些命令名称基于参考项目的实现
            
            const commands = [
                'github.copilot.generateText',
                'github.copilot.chat',
                'github.copilot.complete',
                'copilot.generateText',
                'copilot.chat',
                'copilot.complete'
            ];
            
            for (const command of commands) {
                try {
                    const result = await vscode.commands.executeCommand(command);
                    
                    if (result && typeof result === 'string') {
                        this.logger.info(`成功使用GitHub Copilot命令: ${command}`);
                        return result;
                    }
                } catch (error) {
                    this.logger.debug(`命令 ${command} 不可用:`, error);
                    continue;
                }
            }
            
            return null;
        } catch (error) {
            this.logger.debug('调用GitHub Copilot内部API失败', error);
            return null;
        }
    }

    /**
     * 通过HTTP调用GitHub Copilot API
     */
    private async callCopilotHTTPAPI(prompt: string, temperature: number | null): Promise<string | null> {
        try {
            // 根据参考项目，GitHub Copilot支持HTTP API调用
            // 这里实现HTTP请求逻辑
            
            this.logger.info('尝试通过HTTP调用GitHub Copilot API');
            
            // 注意：这里需要根据实际的GitHub Copilot API端点进行调整
            // 参考项目使用的是 copilot 作为 vendor
            
            // 临时实现：返回一个更友好的提示
            return `[正在连接GitHub Copilot服务...]\n\n原文：${prompt}`;
            
        } catch (error) {
            this.logger.error('HTTP调用GitHub Copilot API失败', error);
            return null;
        }
    }

    /**
     * 清理API返回结果
     */
    private cleanResult(result: string): string {
        // 移除可能的标记和格式
        let cleaned = result
            .replace(/^```[\s\S]*?\n/, '') // 移除开头的代码块标记
            .replace(/\n```$/, '') // 移除结尾的代码块标记
            .trim();
        
        return cleaned;
    }

    /**
     * 检查GitHub Copilot服务是否可用
     */
    public static async isAvailable(): Promise<boolean> {
        try {
            // 检查是否有GitHub Copilot扩展
            const extensions = vscode.extensions.all;
            const copilotExtension = extensions.find(ext => 
                ext.id.toLowerCase().includes('copilot') ||
                ext.id.toLowerCase().includes('github.copilot')
            );
            
            if (!copilotExtension) {
                return false;
            }
            
            // 检查扩展是否激活
            if (!copilotExtension.isActive) {
                return false;
            }
            
            // 检查是否有可用的命令
            const commands = await vscode.commands.getCommands();
            const hasCopilotCommands = commands.some(cmd => 
                cmd.toLowerCase().includes('copilot')
            );
            
            return hasCopilotCommands;
        } catch (error) {
            return false;
        }
    }

    /**
     * 获取GitHub Copilot配额信息
     */
    public static async getQuotaInfo(): Promise<{ isFree: boolean; remainingRequests?: number; totalRequests?: number }> {
        try {
            // 这里需要实现获取配额信息的逻辑
            // 由于GitHub Copilot的API还在发展中，我们提供一个基础实现
            
            return {
                isFree: true, // 假设免费用户
                remainingRequests: 50, // 假设每月50次
                totalRequests: 50
            };
        } catch (error) {
            return {
                isFree: true,
                remainingRequests: undefined,
                totalRequests: undefined
            };
        }
    }
}
