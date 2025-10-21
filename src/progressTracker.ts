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
export type ProgressUpdateCallback = (progressTracker: ProgressTracker) => void;

/**
 * 进度跟踪器类
 */
export class ProgressTracker {
    private items: ProgressItem[] = [];
    private totalChars: number = 0;
    private updateCallback?: ProgressUpdateCallback;
    private isCancelled: boolean = false;
    private startTime: number = 0;
    private endTime: number = 0;

    constructor(paragraphs: Array<{target: string}>, updateCallback?: ProgressUpdateCallback) {
        this.updateCallback = updateCallback;
        this.initializeItems(paragraphs);
        this.startTime = Date.now();
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
            this.updateCallback(this);
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
                    <div class="progress-stats-inline">
                        <span class="stat-item">段落: <span class="stat-value">${stats.completedItems}/${stats.totalItems} (${stats.progressPercentage.toFixed(1)}%)</span></span>
                        <span class="stat-item">字符: <span class="stat-value">${stats.completedChars}/${stats.totalChars} (${stats.charProgressPercentage.toFixed(1)}%)</span></span>
                        <span class="stat-item">本次耗时: <span class="stat-value">${this.getFormattedElapsedTime()}</span></span>
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
            </div>
        `;
    }

    /**
     * 生成进度条CSS样式
     */
    public static generateProgressBarCss(): string {
        return `
            .progress-container {
                margin: 16px 0;
                padding: 16px;
                background-color: #F8FAFB;
                border: 1px solid #E8F0F2;
                border-radius: 6px;
            }
            
            .progress-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 12px;
            }
            
            .progress-header h4 {
                margin: 0;
                color: #5A7A85;
                font-size: 14px;
                font-weight: 500;
            }
            
            .progress-stats-inline {
                display: flex;
                gap: 16px;
                align-items: center;
            }
            
            .progress-stats {
                display: flex;
                gap: 16px;
            }
            
            .stat-item {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                font-size: 12px;
            }
            
            .stat-label {
                font-size: 12px;
                color: #6B8E9A;
                margin-bottom: 2px;
            }
            
            .stat-value {
                font-size: 12px;
                font-weight: 600;
                color: #4A6B7A;
            }
            
            .progress-bar-container {
                margin-bottom: 12px;
            }
            
            .progress-bar {
                width: 100%;
                height: 20px;
                background-color: #E8F0F2;
                border: 1px solid #D0DDE3;
                border-radius: 10px;
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
                background: linear-gradient(90deg, #8BB5A0, #9BC2B0);
            }
            
            .progress-segment.submitted {
                background: linear-gradient(90deg, #D4C4A0, #E0D0B0);
            }
            
            .progress-segment.pending {
                background: linear-gradient(90deg, #9BB5C2, #A8C0CC);
            }
            
            .progress-segment.failed {
                background: linear-gradient(90deg, #D4A0A0, #E0B0B0);
            }
            
            .progress-legend {
                display: flex;
                justify-content: center;
                gap: 16px;
                margin-top: 8px;
                flex-wrap: wrap;
            }
            
            .legend-item {
                display: flex;
                align-items: center;
                gap: 4px;
            }
            
            .legend-color {
                width: 10px;
                height: 10px;
                border-radius: 50%;
            }
            
            .legend-color.completed {
                background-color: #8BB5A0;
            }
            
            .legend-color.submitted {
                background-color: #D4C4A0;
            }
            
            .legend-color.pending {
                background-color: #9BB5C2;
            }
            
            .legend-color.failed {
                background-color: #D4A0A0;
            }
            
            .legend-text {
                font-size: 11px;
                color: #6B8E9A;
            }
            
            .progress-details-inline {
                display: flex;
                flex-wrap: wrap;
                gap: 12px;
                margin-top: 10px;
                padding-top: 10px;
                border-top: 1px solid #E8F0F2;
                font-size: 11px;
            }
            
            .progress-details {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
                gap: 8px;
                margin-top: 10px;
                padding-top: 10px;
                border-top: 1px solid #E8F0F2;
            }
            
            .detail-item {
                display: inline-flex;
                align-items: center;
                gap: 4px;
            }
            
            .detail-label {
                font-size: 11px;
                color: #6B8E9A;
            }
            
            .detail-value {
                font-size: 11px;
                font-weight: 600;
                color: #4A6B7A;
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

    /**
     * 完成进度跟踪
     */
    public complete(): void {
        this.endTime = Date.now();
    }

    /**
     * 获取耗时（毫秒）
     */
    public getElapsedTime(): number {
        const endTime = this.endTime || Date.now();
        return endTime - this.startTime;
    }

    /**
     * 格式化耗时显示
     */
    public getFormattedElapsedTime(): string {
        const elapsed = this.getElapsedTime();
        const seconds = Math.floor(elapsed / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);

        if (hours > 0) {
            return `${hours}:${(minutes % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
        } else if (minutes > 0) {
            return `${minutes}:${(seconds % 60).toString().padStart(2, '0')}`;
        } else {
            return `${seconds}s`;
        }
    }
}
