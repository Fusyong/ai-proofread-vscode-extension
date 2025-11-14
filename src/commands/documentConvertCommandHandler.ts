/**
 * 文档转换命令处理器
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { convertDocxToMarkdown, convertMarkdownToDocx, convertPdfToMarkdown, collectPdfToTextOptions } from '../docConverter';
import { FilePathUtils, ErrorUtils } from '../utils';

export class DocumentConvertCommandHandler {
    /**
     * 处理docx转markdown命令
     */
    public async handleConvertDocxToMarkdownCommand(): Promise<void> {
        // 让用户选择文件
        const fileUri = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: {
                'Docx文件': ['docx']
            }
        });

        if (!fileUri || fileUri.length === 0) {
            return;
        }

        // 让用户选择转换模式
        const mode = await vscode.window.showQuickPick(
            ['默认模式', 'markdown_strict'],
            {
                placeHolder: '请选择转换模式',
                ignoreFocusOut: true
            }
        );

        if (!mode) {
            return;
        }

        // 生成输出文件路径
        const outputPath = FilePathUtils.getFilePath(fileUri[0].fsPath, '', '.md');
        // 如果输出文件已存在，备份旧文件为.bak，并删除原文件以确保 pandoc 能写入新文件
        FilePathUtils.backupFileIfExists(outputPath, true);

        // 等待文件写入完成的辅助函数
        async function waitForFile(filePath: string, maxTries = 50, interval = 200): Promise<boolean> {
            for (let i = 0; i < maxTries; i++) {
                if (fs.existsSync(filePath)) return true;
                await new Promise(res => setTimeout(res, interval));
            }
            return false;
        }

        try {
            await convertDocxToMarkdown(
                fileUri[0].fsPath,
                mode === '默认模式' ? 'default' : 'markdown_strict',
                outputPath
            );

            // 等待文件写入完成
            const fileReady = await waitForFile(outputPath, 50, 200);
            if (!fileReady) throw new Error('文件写入超时（10秒）');

            vscode.window.showInformationMessage('转换完成！');
        } catch (error) {
            ErrorUtils.showError(error, '转换文件时出错：');
        }
    }

    /**
     * 处理markdown转docx命令
     */
    public async handleConvertMarkdownToDocxCommand(): Promise<void> {
        let fileUri: vscode.Uri | undefined;

        // 让用户选择当前打开的文件或者重新选择文件
        const mode = await vscode.window.showQuickPick(
            ['当前文件', '选择文件'],
            {
                placeHolder: '确定要转换当前文件吗？',
                ignoreFocusOut: true
            }
        );

        if (!mode) {
            return;
        }

        if (mode === '当前文件') {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('请先打开一个markdown文件！');
                return;
            }

            // 检查当前文件是否为markdown
            if (editor.document.languageId !== 'markdown') {
                vscode.window.showInformationMessage('请打开一个markdown文件！');
                return;
            }

            fileUri = editor.document.uri;
        } else {
            // 让用户选择一个md文件
            const fileUris = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: {
                    'Markdown文件': ['md', 'markdown']
                }
            });

            if (!fileUris || fileUris.length === 0) {
                return;
            }

            fileUri = fileUris[0];
        }

        if (!fileUri) {
            return;
        }

        // 生成输出文件路径
        const outputPath = FilePathUtils.getFilePath(fileUri.fsPath, '', '.docx');
        // 如果输出文件已存在，备份旧文件为.bak，并删除原文件以确保 pandoc 能写入新文件
        FilePathUtils.backupFileIfExists(outputPath, true);

        // 等待文件写入完成的辅助函数
        async function waitForFile(filePath: string, maxTries = 50, interval = 200): Promise<boolean> {
            for (let i = 0; i < maxTries; i++) {
                if (fs.existsSync(filePath)) return true;
                await new Promise(res => setTimeout(res, interval));
            }
            return false;
        }

        try {
            await convertMarkdownToDocx(fileUri.fsPath, outputPath);

            // 等待文件写入完成
            const fileReady = await waitForFile(outputPath, 50, 200);
            if (!fileReady) throw new Error('文件写入超时（10秒）');

            vscode.window.showInformationMessage('转换完成！');
        } catch (error) {
            ErrorUtils.showError(error, '转换文件时出错：');
        }
    }

    /**
     * 处理PDF转markdown命令
     */
    public async handleConvertPdfToMarkdownCommand(): Promise<void> {
        // 让用户选择文件
        const fileUri = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: {
                'PDF文件': ['pdf']
            }
        });

        if (!fileUri || fileUri.length === 0) {
            return;
        }

        // 收集用户选择的参数
        const options = await collectPdfToTextOptions();
        if (!options) {
            // 用户取消了参数选择
            return;
        }

        // 生成输出文件路径
        const outputPath = FilePathUtils.getFilePath(fileUri[0].fsPath, '', '.md');
        // 如果输出文件已存在，备份旧文件为.bak，并删除原文件以确保 pdftotext 能写入新文件
        FilePathUtils.backupFileIfExists(outputPath, true);

        // 等待文件写入完成的辅助函数
        async function waitForFile(filePath: string, maxTries = 50, interval = 200): Promise<boolean> {
            for (let i = 0; i < maxTries; i++) {
                if (fs.existsSync(filePath)) return true;
                await new Promise(res => setTimeout(res, interval));
            }
            return false;
        }

        try {
            await convertPdfToMarkdown(fileUri[0].fsPath, outputPath, options);

            // 等待文件写入完成
            const fileReady = await waitForFile(outputPath, 50, 200);
            if (!fileReady) throw new Error('文件写入超时（10秒）');

            vscode.window.showInformationMessage('转换完成！');
        } catch (error) {
            ErrorUtils.showError(error, '转换文件时出错：');
        }
    }
}
