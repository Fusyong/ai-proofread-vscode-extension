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
     * 生成可读的时间戳字符串（格式：YYYYMMDD-HHmmss）
     * @returns 时间戳字符串，例如：20240115-143025
     */
    public static getReadableTimestamp(): string {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        return `${year}${month}${day}-${hours}${minutes}${seconds}`;
    }

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

    /**
     * 如果文件已存在，将其备份为带时间戳的.bak文件
     * @param filePath 文件路径
     * @param deleteOriginal 是否在备份后删除原文件（默认 false）
     * @returns 如果文件已存在并已备份，返回备份文件路径；否则返回 null
     */
    public static backupFileIfExists(filePath: string, deleteOriginal: boolean = false): string | null {
        if (fs.existsSync(filePath)) {
            const timestamp = this.getReadableTimestamp();
            const dir = path.dirname(filePath);
            const baseName = path.basename(filePath, path.extname(filePath));
            const ext = path.extname(filePath);
            const backupPath = path.join(dir, `${baseName}${ext}-${timestamp}.bak`);
            fs.copyFileSync(filePath, backupPath);
            if (deleteOriginal) {
                fs.unlinkSync(filePath);
            }
            return backupPath;
        }
        return null;
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

/**
 * 跨平台命令构建工具
 */
export class CommandBuilder {
    /**
     * 检测当前 shell 类型
     * @returns shell 类型：'powershell' | 'cmd' | 'bash' | 'sh' | 'unknown'
     */
    private static detectShellType(): 'powershell' | 'cmd' | 'bash' | 'sh' | 'unknown' {
        const shell = vscode.env.shell;
        if (!shell) {
            // 如果无法检测，根据平台推断
            if (process.platform === 'win32') {
                // Windows 默认可能是 PowerShell 或 CMD，优先使用兼容性更好的方式
                return 'cmd';
            }
            return 'bash';
        }

        const shellLower = shell.toLowerCase();
        if (shellLower.includes('powershell') || shellLower.includes('pwsh')) {
            return 'powershell';
        } else if (shellLower.includes('cmd.exe')) {
            return 'cmd';
        } else if (shellLower.includes('bash')) {
            return 'bash';
        } else if (shellLower.includes('sh')) {
            return 'sh';
        }

        // 根据平台推断
        if (process.platform === 'win32') {
            return 'cmd';
        }
        return 'bash';
    }

    /**
     * 转义路径中的特殊字符（用于命令行参数）
     * @param filePath 文件路径
     * @param shellType shell 类型
     * @returns 转义后的路径
     */
    private static escapePath(filePath: string, shellType: string): string {
        // 对于所有 shell，使用双引号包裹路径即可
        // 但需要转义路径中的双引号
        const escaped = filePath.replace(/"/g, '\\"');
        return `"${escaped}"`;
    }

    /**
     * 构建跨平台命令
     * 在指定目录执行命令，兼容 PowerShell、CMD、Bash 等
     * @param workDir 工作目录
     * @param command 要执行的命令（不包含 cd 部分）
     * @returns 完整的跨平台命令字符串
     */
    public static buildCommand(workDir: string, command: string): string {
        const shellType = this.detectShellType();
        const escapedWorkDir = this.escapePath(workDir, shellType);
        const escapedCommand = command;

        switch (shellType) {
            case 'powershell':
                // PowerShell: cd "dir"; command
                return `cd ${escapedWorkDir}; ${escapedCommand}`;
            
            case 'cmd':
                // CMD: cd /d "dir" && command
                // 使用 /d 参数以支持跨驱动器切换
                return `cd /d ${escapedWorkDir} && ${escapedCommand}`;
            
            case 'bash':
            case 'sh':
                // Bash/Sh: cd "dir" && command
                return `cd ${escapedWorkDir} && ${escapedCommand}`;
            
            default:
                // 默认使用 && 分隔符，在大多数 shell 中都支持
                return `cd ${escapedWorkDir} && ${escapedCommand}`;
        }
    }

    /**
     * 构建使用绝对路径的命令（不需要切换目录）
     * @param command 命令字符串，其中可以使用 {workDir} 占位符表示工作目录
     * @param workDir 工作目录（用于替换占位符）
     * @returns 完整的命令字符串
     */
    public static buildCommandWithAbsolutePaths(command: string, workDir: string): string {
        // 替换占位符
        return command.replace(/\{workDir\}/g, this.escapePath(workDir, 'unknown'));
    }
}