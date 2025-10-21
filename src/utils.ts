/**
 * 工具箱模块
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 临时文件管理工具
 */
export class TempFileManager {
    private static instance: TempFileManager;
    private context: vscode.ExtensionContext;

    private constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    public static getInstance(context: vscode.ExtensionContext): TempFileManager {
        if (!TempFileManager.instance) {
            TempFileManager.instance = new TempFileManager(context);
        }
        return TempFileManager.instance;
    }

    /**
     * 获取临时目录
     */
    public getTempDir(): vscode.Uri {
        return vscode.Uri.joinPath(this.context.globalStorageUri, 'temp');
    }

    /**
     * 创建临时文件
     * @param content 文件内容
     * @param ext 文件扩展名
     * @returns 临时文件URI
     */
    public async createTempFile(content: string, ext: string): Promise<vscode.Uri> {
        const tempDir = this.getTempDir();
        const timestamp = Date.now();
        const fileUri = vscode.Uri.joinPath(tempDir, `temp-${timestamp}${ext}`);

        // 确保临时目录存在
        try {
            await vscode.workspace.fs.createDirectory(tempDir);
        } catch (error) {
            // 目录可能已存在，忽略错误
        }

        // 写入内容到临时文件
        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content));
        return fileUri;
    }

    /**
     * 清理临时文件
     */
    public async cleanup(): Promise<void> {
        const tempDir = this.getTempDir();
        try {
            const files = await vscode.workspace.fs.readDirectory(tempDir);
            const now = Date.now();
            const oneDay = 24 * 60 * 60 * 1000; // 24小时

            for (const [file] of files) {
                const fileUri = vscode.Uri.joinPath(tempDir, file);
                const stat = await vscode.workspace.fs.stat(fileUri);
                const fileAge = now - stat.mtime;

                // 删除超过24小时的临时文件
                if (fileAge > oneDay) {
                    await vscode.workspace.fs.delete(fileUri);
                }
            }
        } catch (error) {
            // 如果目录不存在或其他错误，忽略
        }
    }
}

/**
 * 文件路径工具
 */
export class FilePathUtils {
    /**
     * 生成输出文件路径
     * @param inputPath 输入文件路径
     * @param suffix 后缀
     * @param ext 扩展名
     * @returns 输出文件路径
     */
    public static getFilePath(inputPath: string, suffix: string, ext: string): string {
        const dir = path.dirname(inputPath);
        const baseName = path.basename(inputPath, path.extname(inputPath));
        return path.join(dir, `${baseName}${suffix}${ext}`);
    }

    /**
     * 确保目录存在
     * @param dirPath 目录路径
     */
    public static ensureDirExists(dirPath: string): void {
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
    }
}

/**
 * 错误处理工具
 */
export class ErrorUtils {
    /**
     * 显示错误消息
     * @param error 错误对象
     * @param prefix 错误消息前缀
     */
    public static showError(error: unknown, prefix: string = ''): void {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`${prefix}${message}`);
    }

    /**
     * 显示警告消息
     * @param message 警告消息
     * @param options 选项
     */
    public static async showWarning(message: string, options: { modal?: boolean } = {}): Promise<string | undefined> {
        return vscode.window.showWarningMessage(message, options, '确定');
    }
}

/**
 * 配置管理工具
 */
export class ConfigManager {
    private static instance: ConfigManager;
    private config: vscode.WorkspaceConfiguration;
    private configListener: vscode.Disposable;

    private constructor() {
        this.config = vscode.workspace.getConfiguration('ai-proofread');
        // 监听配置变化
        this.configListener = vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('ai-proofread')) {
                this.config = vscode.workspace.getConfiguration('ai-proofread');
            }
        });
    }

    public static getInstance(): ConfigManager {
        if (!ConfigManager.instance) {
            ConfigManager.instance = new ConfigManager();
        }
        return ConfigManager.instance;
    }

    /**
     * 获取API密钥
     * @param platform 平台名称
     * @returns API密钥
     */
    public getApiKey(platform: string): string {
        return this.config.get<string>(`apiKeys.${platform}`, '');
    }

    /**
     * 获取校对平台配置
     * @returns 平台名称
     */
    public getPlatform(): string {
        return this.config.get<string>('proofread.platform', 'deepseek');
    }

    /**
     * 获取模型配置
     * @param platform 平台名称
     * @returns 模型名称
     */
    public getModel(platform: string): string {
        return this.config.get<string>(`proofread.models.${platform}`, 'deepseek-chat');
    }

    /**
     * 获取RPM配置
     * @returns RPM值
     */
    public getRpm(): number {
        return this.config.get<number>('proofread.rpm', 15);
    }

    /**
     * 获取最大并发数配置
     * @returns 最大并发数
     */
    public getMaxConcurrent(): number {
        return this.config.get<number>('proofread.maxConcurrent', 3);
    }

    /**
     * 获取温度配置
     * @returns 温度
     */
    public getTemperature(): number {
        return this.config.get<number>('proofread.temperature', 1);
    }

    public dispose(): void {
        this.configListener.dispose();
    }
}

/**
 * 日志工具类
 */
export class Logger {
    private static instance: Logger;

    private constructor() {
        // 不再需要监听配置变化
    }

    public static getInstance(): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }

    public info(message: string): void {
        console.log(`[INFO] ${message}`);
    }


    public error(message: string, error?: any): void {
        console.error(`[ERROR] ${message}`, error);
    }

    public warn(message: string): void {
        console.warn(`[WARN] ${message}`);
    }

    public dispose(): void {
        // 不再需要处理配置监听器
    }
}