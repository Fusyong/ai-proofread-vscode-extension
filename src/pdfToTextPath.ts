import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

let cachedPdfToTextPath: string | undefined;

function getExtensionRoot(): string {
    return path.resolve(__dirname, '..');
}

function getBundledPdfToTextPath(): string | undefined {
    if (process.platform !== 'win32') {
        return undefined;
    }
    const archDir = process.arch === 'x64' || process.arch === 'arm64' ? 'win64' : 'win32';
    const bundled = path.join(getExtensionRoot(), 'vendor', 'xpdf', archDir, 'pdftotext.exe');
    return fs.existsSync(bundled) ? bundled : undefined;
}

/**
 * 返回 pdftotext 可执行文件路径：Windows 优先使用扩展内置副本，否则回退到 PATH 中的命令名。
 */
export function getPdfToTextExecutable(): string {
    if (cachedPdfToTextPath) {
        return cachedPdfToTextPath;
    }
    const bundled = getBundledPdfToTextPath();
    if (bundled) {
        cachedPdfToTextPath = bundled;
        return cachedPdfToTextPath;
    }
    cachedPdfToTextPath = process.platform === 'win32' ? 'pdftotext.exe' : 'pdftotext';
    return cachedPdfToTextPath;
}

/**
 * 确认 pdftotext 可用；内置副本存在则直接返回，否则检测 PATH。
 */
export async function ensurePdfToTextAvailable(): Promise<string> {
    const bundled = getBundledPdfToTextPath();
    if (bundled) {
        return bundled;
    }
    try {
        if (process.platform === 'win32') {
            await execAsync('where pdftotext');
        } else {
            await execAsync('which pdftotext');
        }
        return getPdfToTextExecutable();
    } catch {
        throw new Error(
            'pdftotext 未安装或不在 PATH 中。Windows 用户请确认扩展已正确安装；macOS/Linux 请安装 Xpdf 命令行工具。'
        );
    }
}

/** 为终端命令引用可执行文件路径 */
export function quotePdfToTextExecutable(exe: string): string {
    if (exe.includes(path.sep) || exe.includes('/')) {
        return `"${exe.replace(/"/g, '\\"')}"`;
    }
    return exe;
}
