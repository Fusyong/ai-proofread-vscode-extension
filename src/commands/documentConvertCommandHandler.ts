/**
 * 文档转换命令处理器
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
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
     * 处理PDF转markdown命令。可一次选择多个 PDF，参数只询问一次，再按相同参数逐一转换。
     */
    public async handleConvertPdfToMarkdownCommand(): Promise<void> {
        const fileUris = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: true,
            title: '选择 PDF 文件（可多选）',
            filters: {
                'PDF文件': ['pdf']
            }
        });

        if (!fileUris || fileUris.length === 0) {
            return;
        }

        const options = await collectPdfToTextOptions(fileUris.length);
        if (!options) {
            return;
        }

        const total = fileUris.length;
        const failures: string[] = [];
        let completed = 0;
        let cancelled = false;

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: total === 1 ? 'PDF 转 Markdown' : `PDF 转 Markdown（共 ${total} 个）`,
            cancellable: true
        }, async (progress, token) => {
            for (let i = 0; i < fileUris.length; i++) {
                if (token.isCancellationRequested) {
                    cancelled = true;
                    break;
                }

                const pdfPath = fileUris[i].fsPath;
                const fileName = path.basename(pdfPath);
                progress.report({
                    message: `(${i + 1}/${total}) ${fileName}`
                });

                const outputPath = FilePathUtils.getFilePath(pdfPath, '', '.md');
                FilePathUtils.backupFileIfExists(outputPath, true);

                try {
                    await convertPdfToMarkdown(pdfPath, outputPath, options, token);
                    completed++;
                    progress.report({ increment: 100 / total });
                } catch (error) {
                    if (error instanceof vscode.CancellationError || token.isCancellationRequested) {
                        cancelled = true;
                        this.removePartialPdfOutput(outputPath);
                        break;
                    }
                    const message = error instanceof Error ? error.message : String(error);
                    failures.push(message);
                    progress.report({ increment: 100 / total });
                }
            }
        });

        this.showPdfConvertSummary(total, completed, failures, cancelled);
    }

    /** 取消时删掉尚未写完的输出，避免把半成品当成转换结果。 */
    private removePartialPdfOutput(outputPath: string): void {
        if (!fs.existsSync(outputPath)) {
            return;
        }
        try {
            fs.unlinkSync(outputPath);
        } catch {
            // 文件仍被占用时保留现场，用户可从输出面板查看取消记录。
        }
    }

    private showPdfConvertSummary(
        total: number,
        completed: number,
        failures: string[],
        cancelled: boolean
    ): void {
        if (cancelled) {
            if (failures.length > 0) {
                vscode.window.showInformationMessage(
                    `已取消，已完成 ${completed}/${total} 个，${failures.length} 个失败。详情见输出面板「PDF转换」。`
                );
            } else {
                vscode.window.showInformationMessage(
                    completed > 0 ? `已取消，已完成 ${completed}/${total} 个。` : '已取消。'
                );
            }
            return;
        }

        if (failures.length === 0) {
            vscode.window.showInformationMessage(
                total === 1 ? '转换完成！' : `转换完成！共 ${total} 个文件。`
            );
            return;
        }

        if (completed === 0 && total === 1) {
            ErrorUtils.showError(failures[0], '转换文件时出错：');
            return;
        }

        const detail = '详情见输出面板「PDF转换」。';
        if (completed === 0) {
            vscode.window.showErrorMessage(`${total} 个文件均转换失败。${detail}`);
            return;
        }
        vscode.window.showWarningMessage(
            `已转换 ${completed}/${total} 个文件，${failures.length} 个失败。${detail}`
        );
    }
}
