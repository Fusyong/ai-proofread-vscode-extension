/**
 * 文件比较命令处理器
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { showFileDiff, jsDiffMarkdown, jsDiffJsonFiles } from '../differ';
import { FilePathUtils, ErrorUtils } from '../utils';

export class FileCompareCommandHandler {
    /**
     * 处理比较两个文件命令
     */
    public async handleDiffItWithAnotherFileCommand(editor: vscode.TextEditor): Promise<void> {
        const currentFile = editor.document.uri.fsPath;
        const currentLanguageId = editor.document.languageId;

        // 检查当前文件类型
        if (currentLanguageId !== 'markdown' && currentLanguageId !== 'json') {
            vscode.window.showInformationMessage('请打开一个markdown或JSON文件！');
            return;
        }

        // 根据文件类型决定比较方式
        let diffMethod: string;
        if (currentLanguageId === 'json') {
            // JSON文件直接使用jsdiff方式
            diffMethod = '生成jsDiff结果文件';
        } else {
            // 其他文件类型让用户选择比较方式
            const selectedMethod = await vscode.window.showQuickPick(
                ['使用diff编辑器比较', '生成jsDiff结果文件'],
                {
                    placeHolder: '请选择比较方式'
                }
            );

            if (!selectedMethod) {
                return;
            }
            diffMethod = selectedMethod;
        }

        // 根据文件类型设置文件过滤器
        let filters: { [key: string]: string[] };
        if (currentLanguageId === 'json') {
            filters = {
                'JSON文件': ['json'],
                '所有文件': ['*']
            };
        } else {
            filters = {
                'Markdown文件': ['md', 'markdown'],
                'Context文件': ['tex', 'lmtx'],
                'Text文件': ['txt'],
                'Tex文件': ['tex'],
                '所有文件': ['*']
            };
        }

        // 让用户选择第二个文件
        const fileUris = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: filters
        });

        if (!fileUris || fileUris.length === 0) {
            return;
        }

        const anotherFile = fileUris[0].fsPath;
        const anotherLanguageId = path.extname(anotherFile).toLowerCase() === '.json' ? 'json' : 'markdown';

        // 如果两个文件都是JSON，提供特殊选项
        let segmentCount = 0;
        if (currentLanguageId === 'json' && anotherLanguageId === 'json') {
            if (diffMethod === '生成jsDiff结果文件') {
                // 让用户选择比较的片段数量
                const segmentInput = await vscode.window.showInputBox({
                    prompt: '请输入每次比较的片段数量（0表示所有片段）',
                    value: '0',
                    validateInput: (value: string) => {
                        const num = parseInt(value);
                        if (isNaN(num) || num < 0) {
                            return '请输入有效的非负数字';
                        }
                        return null;
                    }
                });

                if (segmentInput === undefined) {
                    return;
                }
                segmentCount = parseInt(segmentInput);
            }
        }

        try {
            if (diffMethod === '使用diff编辑器比较') {
                await showFileDiff(currentFile, anotherFile);
            } else {
                // 在第一个文件的位置生成jsdiff结果文件
                const outputFile = FilePathUtils.getFilePath(currentFile, '.diff', '.html');
                const title = `${path.basename(currentFile)} ↔ ${path.basename(anotherFile)}`;
                
                if (currentLanguageId === 'json' && anotherLanguageId === 'json') {
                    // 处理JSON文件比较
                    await jsDiffJsonFiles(currentFile, anotherFile, outputFile, title, segmentCount);
                } else {
                    // 处理普通文件比较
                    await jsDiffMarkdown(currentFile, anotherFile, outputFile, title);
                }
            }
        } catch (error) {
            ErrorUtils.showError(error, '比较文件时出错：');
        }
    }
}
