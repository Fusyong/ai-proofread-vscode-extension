/**
 * 工具命令处理器
 */

import * as vscode from 'vscode';
import { mergeTwoFiles } from '../merger';
import { searchSelectionInPDF } from '../pdfSearcher';
import { convertQuotes } from '../quoteConverter';
import { showDiff } from '../differ';
import { ErrorUtils, FilePathUtils } from '../utils';

export class UtilityCommandHandler {
    /**
     * 处理合并两个文件命令
     */
    public async handleMergeTwoFilesCommand(editor: vscode.TextEditor): Promise<void> {
        const document = editor.document;

        // 检查文件是否为JSON
        if (document.languageId !== 'json') {
            vscode.window.showErrorMessage('请选择JSON文件进行合并！');
            return;
        }

        try {
            // 让用户选择源文件
            const sourceFile = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: {
                    'JSON files': ['json']
                },
                title: '选择源JSON文件'
            });

            if (!sourceFile || sourceFile.length === 0) {
                return;
            }

            // 让用户选择要更新的字段
            const targetField = await vscode.window.showQuickPick(
                ['target', 'reference', 'context'],
                {
                    placeHolder: '选择要更新的字段',
                    ignoreFocusOut: true
                }
            );

            if (!targetField) {
                return;
            }

            // 让用户选择源文件中的字段
            const sourceField = await vscode.window.showQuickPick(
                ['target', 'reference', 'context'],
                {
                    placeHolder: '选择源文件中的字段',
                    ignoreFocusOut: true
                }
            );

            if (!sourceField) {
                return;
            }

            // 执行合并
            const result = await mergeTwoFiles(
                document.uri.fsPath,
                sourceFile[0].fsPath,
                targetField as 'target' | 'reference' | 'context',
                sourceField as 'target' | 'reference' | 'context'
            );

            // 显示结果
            vscode.window.showInformationMessage(
                `合并完成！更新了 ${result.updated}/${result.total} 项`
            );
        } catch (error) {
            ErrorUtils.showError(error, '合并文件时出错：');
        }
    }

    /**
     * 处理在PDF中搜索选中文本命令
     */
    public async handleSearchSelectionInPDFCommand(editor: vscode.TextEditor): Promise<void> {
        if (!editor) {
            vscode.window.showInformationMessage('请先打开PDF对应的Markdown文件并选择要搜索的文本');
            return;
        }

        try {
            await searchSelectionInPDF(editor);
        } catch (error) {
            ErrorUtils.showError(error, '搜索PDF时出错：');
        }
    }

    /**
     * 处理引号转换命令
     */
    public async handleConvertQuotesCommand(editor: vscode.TextEditor): Promise<void> {
        if (!editor) {
            vscode.window.showInformationMessage('No active editor!');
            return;
        }

        try {
            const document = editor.document;
            const selection = editor.selection;
            const text = selection.isEmpty ? document.getText() : document.getText(selection);

            // 转换引号
            const convertedText = convertQuotes(text);

            // 替换文本
            await editor.edit(editBuilder => {
                if (selection.isEmpty) {
                    const fullRange = new vscode.Range(
                        document.positionAt(0),
                        document.positionAt(document.getText().length)
                    );
                    editBuilder.replace(fullRange, convertedText);
                } else {
                    editBuilder.replace(selection, convertedText);
                }
            });

            vscode.window.showInformationMessage('引号转换完成！');
        } catch (error) {
            ErrorUtils.showError(error, '转换引号时出错：');
        }
    }
}
