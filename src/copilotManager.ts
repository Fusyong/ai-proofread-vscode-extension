/**
 * GitHub Copilot 服务管理器模块
 */

import * as vscode from 'vscode';
import { CopilotApiClient } from './copilotClient';
import { Logger } from './utils';

/**
 * GitHub Copilot 服务状态
 */
export interface CopilotServiceStatus {
    isAvailable: boolean;
    isInstalled: boolean;
    isActive: boolean;
    hasCommands: boolean;
    quotaInfo: {
        isFree: boolean;
        remainingRequests?: number;
        totalRequests?: number;
        resetDate?: string;
    };
}

/**
 * GitHub Copilot 服务管理器
 * 负责检查服务状态、管理配额、提供用户反馈等
 */
export class CopilotManager {
    private static instance: CopilotManager;
    private logger: Logger;
    private statusCache: CopilotServiceStatus | null = null;
    private lastStatusCheck: number = 0;
    private readonly STATUS_CACHE_DURATION = 5 * 60 * 1000; // 5分钟缓存

    private constructor() {
        this.logger = Logger.getInstance();
    }

    public static getInstance(): CopilotManager {
        if (!CopilotManager.instance) {
            CopilotManager.instance = new CopilotManager();
        }
        return CopilotManager.instance;
    }

    /**
     * 检查Copilot服务状态
     */
    public async checkServiceStatus(): Promise<CopilotServiceStatus> {
        const now = Date.now();
        
        // 如果缓存未过期，直接返回缓存的状态
        if (this.statusCache && (now - this.lastStatusCheck) < this.STATUS_CACHE_DURATION) {
            this.logger.debug('返回缓存的Copilot服务状态');
            return this.statusCache;
        }

        this.logger.info('检查GitHub Copilot服务状态');
        
        try {
            const status = await this.performStatusCheck();
            this.statusCache = status;
            this.lastStatusCheck = now;
            
            this.logger.info(`GitHub Copilot服务状态检查完成: ${status.isAvailable ? '可用' : '不可用'}`);
            return status;
        } catch (error) {
            this.logger.error('检查GitHub Copilot服务状态失败', error);
            
            // 返回默认状态
            const defaultStatus: CopilotServiceStatus = {
                isAvailable: false,
                isInstalled: false,
                isActive: false,
                hasCommands: false,
                quotaInfo: {
                    isFree: true,
                    remainingRequests: 0,
                    totalRequests: 0
                }
            };
            
            this.statusCache = defaultStatus;
            this.lastStatusCheck = now;
            return defaultStatus;
        }
    }

    /**
     * 执行状态检查
     */
    private async performStatusCheck(): Promise<CopilotServiceStatus> {
        // 检查扩展是否安装
        const isInstalled = this.checkExtensionInstalled();
        
        // 检查扩展是否激活
        const isActive = isInstalled ? this.checkExtensionActive() : false;
        
        // 检查是否有可用命令
        const hasCommands = isActive ? await this.checkAvailableCommands() : false;
        
        // 检查服务是否可用
        const isAvailable = isInstalled && isActive && hasCommands;
        
        // 获取配额信息
        const quotaInfo = isAvailable ? await this.getQuotaInfo() : {
            isFree: true,
            remainingRequests: 0,
            totalRequests: 0
        };

        return {
            isAvailable,
            isInstalled,
            isActive,
            hasCommands,
            quotaInfo
        };
    }

    /**
     * 检查GitHub Copilot扩展是否安装
     */
    private checkExtensionInstalled(): boolean {
        const extensions = vscode.extensions.all;
        const copilotExtension = extensions.find(ext => 
            ext.id.toLowerCase().includes('copilot') ||
            ext.id.toLowerCase().includes('github.copilot')
        );
        
        return !!copilotExtension;
    }

    /**
     * 检查GitHub Copilot扩展是否激活
     */
    private checkExtensionActive(): boolean {
        const extensions = vscode.extensions.all;
        const copilotExtension = extensions.find(ext => 
            ext.id.toLowerCase().includes('copilot') ||
            ext.id.toLowerCase().includes('github.copilot')
        );
        
        return copilotExtension ? copilotExtension.isActive : false;
    }

    /**
     * 检查是否有可用的GitHub Copilot命令
     */
    private async checkAvailableCommands(): Promise<boolean> {
        try {
            const commands = await vscode.commands.getCommands();
            return commands.some(cmd => 
                cmd.toLowerCase().includes('copilot') ||
                cmd.toLowerCase().includes('github.copilot')
            );
        } catch (error) {
            this.logger.error('检查GitHub Copilot命令失败', error);
            return false;
        }
    }

    /**
     * 获取配额信息
     */
    private async getQuotaInfo(): Promise<CopilotServiceStatus['quotaInfo']> {
        try {
            const quotaInfo = await CopilotApiClient.getQuotaInfo();
            
            // 计算重置日期（假设每月重置）
            const now = new Date();
            const resetDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
            
            return {
                ...quotaInfo,
                resetDate: resetDate.toISOString().split('T')[0]
            };
        } catch (error) {
            this.logger.error('获取GitHub Copilot配额信息失败', error);
            return {
                isFree: true,
                remainingRequests: undefined,
                totalRequests: undefined
            };
        }
    }

    /**
     * 显示服务状态信息
     */
    public async showStatusInfo(): Promise<void> {
        const status = await this.checkServiceStatus();
        
        let message = `GitHub Copilot服务状态:\n`;
        message += `• 扩展安装: ${status.isInstalled ? '✓' : '✗'}\n`;
        message += `• 扩展激活: ${status.isActive ? '✓' : '✗'}\n`;
        message += `• 命令可用: ${status.hasCommands ? '✓' : '✗'}\n`;
        message += `• 服务状态: ${status.isAvailable ? '✓ 可用' : '✗ 不可用'}\n`;
        
        if (status.isAvailable && status.quotaInfo) {
            message += `• 用户类型: ${status.quotaInfo.isFree ? '免费用户' : '付费用户'}\n`;
            
            if (status.quotaInfo.remainingRequests !== undefined) {
                message += `• 剩余请求: ${status.quotaInfo.remainingRequests}`;
                if (status.quotaInfo.totalRequests !== undefined) {
                    message += ` / ${status.quotaInfo.totalRequests}`;
                }
                message += '\n';
            }
            
            if (status.quotaInfo.resetDate) {
                message += `• 重置日期: ${status.quotaInfo.resetDate}\n`;
            }
        }
        
        if (!status.isAvailable) {
            message += `\n如需使用GitHub Copilot服务，请：\n`;
            message += `1. 安装GitHub Copilot扩展\n`;
            message += `2. 登录GitHub账户\n`;
            message += `3. 激活GitHub Copilot服务\n`;
        }
        
        await vscode.window.showInformationMessage(message, '确定');
    }

    /**
     * 检查是否可以使用GitHub Copilot服务
     */
    public async canUseService(): Promise<boolean> {
        const status = await this.checkServiceStatus();
        
        if (!status.isAvailable) {
            return false;
        }
        
        // 检查配额
        if (status.quotaInfo.remainingRequests !== undefined && status.quotaInfo.remainingRequests <= 0) {
            this.logger.warn('GitHub Copilot服务配额已用完');
            return false;
        }
        
        return true;
    }

    /**
     * 获取服务使用建议
     */
    public async getUsageAdvice(): Promise<string> {
        const status = await this.checkServiceStatus();
        
        if (!status.isAvailable) {
            return 'GitHub Copilot服务不可用，建议使用其他AI服务或检查GitHub Copilot扩展配置。';
        }
        
        if (status.quotaInfo.isFree && status.quotaInfo.remainingRequests !== undefined) {
            if (status.quotaInfo.remainingRequests <= 5) {
                return `免费用户配额即将用完（剩余${status.quotaInfo.remainingRequests}次），建议升级到付费账户或使用其他AI服务。`;
            } else if (status.quotaInfo.remainingRequests <= 20) {
                return `免费用户配额剩余${status.quotaInfo.remainingRequests}次，建议合理使用。`;
            }
        }
        
        return 'GitHub Copilot服务正常，可以正常使用。';
    }

    /**
     * 清理状态缓存
     */
    public clearStatusCache(): void {
        this.statusCache = null;
        this.lastStatusCheck = 0;
        this.logger.debug('GitHub Copilot服务状态缓存已清理');
    }
}
