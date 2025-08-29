/**
 * Copilot 相关类型定义
 */

/**
 * Copilot API 响应类型
 */
export interface CopilotApiResponse {
    success: boolean;
    data?: any;
    error?: string;
    message?: string;
}

/**
 * Copilot 配额信息类型
 */
export interface CopilotQuotaInfo {
    isFree: boolean;
    remainingRequests?: number;
    totalRequests?: number;
    resetDate?: string;
    usagePeriod?: string;
}

/**
 * Copilot 服务状态类型
 */
export interface CopilotServiceStatus {
    isAvailable: boolean;
    isInstalled: boolean;
    isActive: boolean;
    hasCommands: boolean;
    quotaInfo: CopilotQuotaInfo;
    lastCheck?: number;
    errorCount?: number;
}

/**
 * Copilot 校对请求类型
 */
export interface CopilotProofreadRequest {
    prompt: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    context?: string;
}

/**
 * Copilot 校对响应类型
 */
export interface CopilotProofreadResponse {
    text: string;
    usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
    model: string;
    timestamp: string;
}

/**
 * Copilot 扩展信息类型
 */
export interface CopilotExtensionInfo {
    id: string;
    name: string;
    version: string;
    isActive: boolean;
    isEnabled: boolean;
    publisher: string;
}

/**
 * Copilot 命令信息类型
 */
export interface CopilotCommandInfo {
    command: string;
    title: string;
    category: string;
    isEnabled: boolean;
}

/**
 * Copilot 配置选项类型
 */
export interface CopilotConfigOptions {
    enableAutoComplete: boolean;
    enableInlineSuggestions: boolean;
    enableChat: boolean;
    model: string;
    temperature: number;
    maxTokens: number;
}

/**
 * Copilot 错误类型
 */
export enum CopilotErrorType {
    EXTENSION_NOT_INSTALLED = 'EXTENSION_NOT_INSTALLED',
    EXTENSION_NOT_ACTIVE = 'EXTENSION_NOT_ACTIVE',
    NO_COMMANDS_AVAILABLE = 'NO_COMMANDS_AVAILABLE',
    QUOTA_EXCEEDED = 'QUOTA_EXCEEDED',
    NETWORK_ERROR = 'NETWORK_ERROR',
    API_ERROR = 'API_ERROR',
    UNKNOWN_ERROR = 'UNKNOWN_ERROR'
}

/**
 * Copilot 错误信息类型
 */
export interface CopilotError {
    type: CopilotErrorType;
    message: string;
    details?: any;
    timestamp: number;
    retryable: boolean;
}

/**
 * Copilot 使用统计类型
 */
export interface CopilotUsageStats {
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    totalTokens: number;
    averageResponseTime: number;
    lastUsed: string;
    quotaUsed: number;
    quotaRemaining: number;
}
