/**
 * 进度跟踪器
 * 用于跟踪校对任务的进度状态
 */

import * as vscode from 'vscode';

/**
 * 进度项状态
 */
export type ProgressItemStatus = 'pending' | 'submitted' | 'completed' | 'failed';

/**
 * 进度项接口
 */
export interface ProgressItem {
    index: number;
    target: string;
    status: ProgressItemStatus;
    charCount: number;
    startTime?: number;
    endTime?: number;
    error?: string;
}

/**
 * 进度统计信息
 */
export interface ProgressStats {
    totalItems: number;
    totalChars: number;
    completedItems: number;
    completedChars: number;
    submittedItems: number;
    submittedChars: number;
    pendingItems: number;
    pendingChars: number;
    failedItems: number;
    failedChars: number;
    progressPercentage: number;
    charProgressPercentage: number;
}

/**
 * 进度更新回调函数类型
 */
export type ProgressUpdateCallback = (stats: ProgressStats, progressBarHtml: string) => void;

/**
 * 进度跟踪器类
 */
export class ProgressTracker {
    private items: ProgressItem[] = [];
    private totalChars: number = 0;
    private updateCallback?: ProgressUpdateCallback;
    private isCancelled: boolean = false;

    constructor(paragraphs: Array<{target: string}>, updateCallback?: ProgressUpdateCallback) {
        this.updateCallback = updateCallback;
        this.initializeItems(paragraphs);
    }

    /**
     * 初始化进度项
     */
    private initializeItems(paragraphs: Array<{target: string}>): void {
        this.items = paragraphs.map((paragraph, index) => ({
            index,
            target: paragraph.target,
            status: 'pending' as ProgressItemStatus,
            charCount: paragraph.target.length
        }));
        
        this.totalChars = this.items.reduce((sum, item) => sum + item.charCount, 0);
    }

    /**
     * 更新进度项状态
     */
    public updateProgress(index: number, status: ProgressItemStatus, error?: string): void {
        if (this.isCancelled) {
            return;
        }

        const item = this.items.find(item => item.index === index);
        if (!item) {
            return;
        }

        const oldStatus = item.status;
        item.status = status;
        
        if (status === 'submitted') {
            item.startTime = Date.now();
        } else if (status === 'completed' || status === 'failed') {
            item.endTime = Date.now();
        }

        if (error) {
            item.error = error;
        }

        // 触发更新回调
        if (this.updateCallback) {
            const stats = this.getStats();
            const progressBarHtml = this.generateProgressBarHtml();
            this.updateCallback(stats, progressBarHtml);
        }
    }

    /**
     * 获取统计信息
     */
    public getStats(): ProgressStats {
        const completedItems = this.items.filter(item => item.status === 'completed').length;
        const submittedItems = this.items.filter(item => item.status === 'submitted').length;
        const pendingItems = this.items.filter(item => item.status === 'pending').length;
        const failedItems = this.items.filter(item => item.status === 'failed').length;

        const completedChars = this.items
            .filter(item => item.status === 'completed')
            .reduce((sum, item) => sum + item.charCount, 0);
        
        const submittedChars = this.items
            .filter(item => item.status === 'submitted')
            .reduce((sum, item) => sum + item.charCount, 0);
        
        const pendingChars = this.items
            .filter(item => item.status === 'pending')
            .reduce((sum, item) => sum + item.charCount, 0);
        
        const failedChars = this.items
            .filter(item => item.status === 'failed')
            .reduce((sum, item) => sum + item.charCount, 0);

        const progressPercentage = this.items.length > 0 ? (completedItems / this.items.length) * 100 : 0;
        const charProgressPercentage = this.totalChars > 0 ? (completedChars / this.totalChars) * 100 : 0;

        return {
            totalItems: this.items.length,
            totalChars: this.totalChars,
            completedItems,
            completedChars,
            submittedItems,
            submittedChars,
            pendingItems,
            pendingChars,
            failedItems,
            failedChars,
            progressPercentage,
            charProgressPercentage
        };
    }

    /**
     * 生成进度条HTML
     */
    public generateProgressBarHtml(): string {
        const stats = this.getStats();
        
        // 计算各状态的比例
        const completedRatio = this.totalChars > 0 ? (stats.completedChars / this.totalChars) * 100 : 0;
        const submittedRatio = this.totalChars > 0 ? (stats.submittedChars / this.totalChars) * 100 : 0;
        const pendingRatio = this.totalChars > 0 ? (stats.pendingChars / this.totalChars) * 100 : 0;
        const failedRatio = this.totalChars > 0 ? (stats.failedChars / this.totalChars) * 100 : 0;

        return `
            <div class="progress-container">
                <div class="progress-header">
                    <h4>校对进度</h4>
                    <div class="progress-stats">
                        <span class="stat-item">
                            <span class="stat-label">段落进度:</span>
                            <span class="stat-value">${stats.completedItems}/${stats.totalItems} (${stats.progressPercentage.toFixed(1)}%)</span>
                        </span>
                        <span class="stat-item">
                            <span class="stat-label">字符进度:</span>
                            <span class="stat-value">${stats.completedChars}/${stats.totalChars} (${stats.charProgressPercentage.toFixed(1)}%)</span>
                        </span>
                    </div>
                </div>
                <div class="progress-bar-container">
                    <div class="progress-bar">
                        <div class="progress-segment completed" style="width: ${completedRatio}%" title="已完成: ${stats.completedChars} 字符"></div>
                        <div class="progress-segment submitted" style="width: ${submittedRatio}%" title="处理中: ${stats.submittedChars} 字符"></div>
                        <div class="progress-segment pending" style="width: ${pendingRatio}%" title="待处理: ${stats.pendingChars} 字符"></div>
                        <div class="progress-segment failed" style="width: ${failedRatio}%" title="失败: ${stats.failedChars} 字符"></div>
                    </div>
                    <div class="progress-legend">
                        <div class="legend-item">
                            <span class="legend-color completed"></span>
                            <span class="legend-text">已完成 (${stats.completedItems})</span>
                        </div>
                        <div class="legend-item">
                            <span class="legend-color submitted"></span>
                            <span class="legend-text">处理中 (${stats.submittedItems})</span>
                        </div>
                        <div class="legend-item">
                            <span class="legend-color pending"></span>
                            <span class="legend-text">待处理 (${stats.pendingItems})</span>
                        </div>
                        <div class="legend-item">
                            <span class="legend-color failed"></span>
                            <span class="legend-text">失败 (${stats.failedItems})</span>
                        </div>
                    </div>
                </div>
                <div class="progress-details">
                    <div class="detail-item">
                        <span class="detail-label">总字符数:</span>
                        <span class="detail-value">${stats.totalChars.toLocaleString()}</span>
                    </div>
                    <div class="detail-item">
                        <span class="detail-label">已完成字符:</span>
                        <span class="detail-value">${stats.completedChars.toLocaleString()}</span>
                    </div>
                    <div class="detail-item">
                        <span class="detail-label">处理中字符:</span>
                        <span class="detail-value">${stats.submittedChars.toLocaleString()}</span>
                    </div>
                    <div class="detail-item">
                        <span class="detail-label">待处理字符:</span>
                        <span class="detail-value">${stats.pendingChars.toLocaleString()}</span>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * 生成进度条CSS样式
     */
    public static generateProgressBarCss(): string {
        return `
            .progress-container {
                margin: 20px 0;
                padding: 20px;
                background-color: var(--vscode-editor-background);
                border: 1px solid var(--vscode-panel-border);
                border-radius: 6px;
            }
            
            .progress-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 15px;
            }
            
            .progress-header h4 {
                margin: 0;
                color: var(--vscode-textLink-foreground);
                font-size: 16px;
            }
            
            .progress-stats {
                display: flex;
                gap: 20px;
            }
            
            .stat-item {
                display: flex;
                flex-direction: column;
                align-items: center;
            }
            
            .stat-label {
                font-size: 12px;
                color: var(--vscode-descriptionForeground);
                margin-bottom: 2px;
            }
            
            .stat-value {
                font-size: 14px;
                font-weight: 600;
                color: var(--vscode-textLink-foreground);
            }
            
            .progress-bar-container {
                margin-bottom: 15px;
            }
            
            .progress-bar {
                width: 100%;
                height: 24px;
                background-color: var(--vscode-input-background);
                border: 1px solid var(--vscode-input-border);
                border-radius: 12px;
                overflow: hidden;
                display: flex;
                position: relative;
            }
            
            .progress-segment {
                height: 100%;
                transition: width 0.3s ease;
                position: relative;
            }
            
            .progress-segment.completed {
                background: linear-gradient(90deg, #4CAF50, #66BB6A);
            }
            
            .progress-segment.submitted {
                background: linear-gradient(90deg, #FFC107, #FFD54F);
            }
            
            .progress-segment.pending {
                background: linear-gradient(90deg, #9E9E9E, #BDBDBD);
            }
            
            .progress-segment.failed {
                background: linear-gradient(90deg, #F44336, #EF5350);
            }
            
            .progress-legend {
                display: flex;
                justify-content: center;
                gap: 20px;
                margin-top: 10px;
                flex-wrap: wrap;
            }
            
            .legend-item {
                display: flex;
                align-items: center;
                gap: 6px;
            }
            
            .legend-color {
                width: 12px;
                height: 12px;
                border-radius: 50%;
            }
            
            .legend-color.completed {
                background-color: #4CAF50;
            }
            
            .legend-color.submitted {
                background-color: #FFC107;
            }
            
            .legend-color.pending {
                background-color: #9E9E9E;
            }
            
            .legend-color.failed {
                background-color: #F44336;
            }
            
            .legend-text {
                font-size: 12px;
                color: var(--vscode-foreground);
            }
            
            .progress-details {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
                gap: 10px;
                margin-top: 15px;
                padding-top: 15px;
                border-top: 1px solid var(--vscode-panel-border);
            }
            
            .detail-item {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 5px 0;
            }
            
            .detail-label {
                font-size: 12px;
                color: var(--vscode-descriptionForeground);
            }
            
            .detail-value {
                font-size: 12px;
                font-weight: 600;
                color: var(--vscode-textLink-foreground);
            }
        `;
    }

    /**
     * 获取待处理的索引列表
     */
    public getPendingIndices(): number[] {
        return this.items
            .filter(item => item.status === 'pending')
            .map(item => item.index);
    }

    /**
     * 获取正在处理的索引列表
     */
    public getSubmittedIndices(): number[] {
        return this.items
            .filter(item => item.status === 'submitted')
            .map(item => item.index);
    }

    /**
     * 检查是否已取消
     */
    public isCancellationRequested(): boolean {
        return this.isCancelled;
    }

    /**
     * 设置取消状态
     */
    public setCancelled(cancelled: boolean): void {
        this.isCancelled = cancelled;
    }

    /**
     * 获取所有进度项
     */
    public getItems(): ProgressItem[] {
        return [...this.items];
    }

    /**
     * 获取指定索引的进度项
     */
    public getItem(index: number): ProgressItem | undefined {
        return this.items.find(item => item.index === index);
    }
}
