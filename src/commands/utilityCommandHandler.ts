/**
 * 工具命令处理器
 */

import * as vscode from 'vscode';
import { mergeTwoFiles } from '../merger';
import { searchSelectionInPDF } from '../pdfSearcher';
import { convertQuotes } from '../quoteConverter';
import { formatParagraphs } from '../paragraphDetector';
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
            // 让用户选择来源文件
            const sourceFile = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: {
                    'JSON files': ['json']
                },
                title: '选择来源JSON文件'
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

            // 让用户选择来源文件中的字段
            const sourceField = await vscode.window.showQuickPick(
                ['target', 'reference', 'context'],
                {
                    placeHolder: '选择来源文件中的字段',
                    ignoreFocusOut: true
                }
            );

            if (!sourceField) {
                return;
            }

            // 让用户选择合并模式
            const mergeMode = await vscode.window.showQuickPick(
                [
                    { label: '更新（覆盖）', value: 'update', description: '用来源字段的值覆盖目标字段' },
                    { label: '拼接', value: 'concat', description: '将来源字段的内容追加到目标字段后面，中间加空行' }
                ],
                {
                    placeHolder: '选择合并模式',
                    ignoreFocusOut: true
                }
            );

            if (!mergeMode) {
                return;
            }

            // 执行合并
            const result = await mergeTwoFiles(
                document.uri.fsPath,
                sourceFile[0].fsPath,
                targetField as 'target' | 'reference' | 'context',
                sourceField as 'target' | 'reference' | 'context',
                mergeMode.value as 'update' | 'concat'
            );

            // 显示结果
            const modeText = mergeMode.value === 'update' ? '更新' : '拼接';
            vscode.window.showInformationMessage(
                `合并完成！${modeText}了 ${result.updated}/${result.total} 项`
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

    /**
     * 处理段落整理命令
     */
    public async handleFormatParagraphsCommand(editor: vscode.TextEditor): Promise<void> {
        if (!editor) {
            vscode.window.showInformationMessage('No active editor!');
            return;
        }

        try {
            // 让用户选择处理模式
            const mode = await vscode.window.showQuickPick(
                [
                    {
                        label: '段末加空行',
                        value: 'addBlankLines',
                        description: '仅在段落结尾添加空行，不删除段内分行'
                    },
                    {
                        label: '删除段内分行',
                        value: 'removeLineBreaks',
                        description: '删除段内分行，将段内多行合并为一行，不添加空行'
                    },
                    {
                        label: '段末加空行，删除段内分行',
                        value: 'both',
                        description: '既添加空行，又删除段内分行'
                    }
                ],
                {
                    placeHolder: '请选择处理模式',
                    ignoreFocusOut: true
                }
            );

            if (mode === undefined) {
                return; // 用户取消
            }

            const document = editor.document;
            const selection = editor.selection;
            const text = selection.isEmpty ? document.getText() : document.getText(selection);

            // 始终使用整个文档来计算行长度众数，不管是否选中文本
            const fullDocumentText = document.getText();

            let processedText: string;

            // 根据用户选择执行相应的处理（统一使用 formatParagraphs 函数）
            const options: { addBlankLines: boolean; removeLineBreaks: boolean } =
                mode.value === 'addBlankLines'
                    ? { addBlankLines: true, removeLineBreaks: false }
                    : mode.value === 'removeLineBreaks'
                    ? { addBlankLines: false, removeLineBreaks: true }
                    : { addBlankLines: true, removeLineBreaks: true };

            processedText = formatParagraphs(text, fullDocumentText, options);

            // 替换文本
            await editor.edit(editBuilder => {
                if (selection.isEmpty) {
                    const fullRange = new vscode.Range(
                        document.positionAt(0),
                        document.positionAt(document.getText().length)
                    );
                    editBuilder.replace(fullRange, processedText);
                } else {
                    editBuilder.replace(selection, processedText);
                }
            });

            // 根据选择的模式显示相应的提示信息
            let message = '处理完成！';
            if (mode.value === 'addBlankLines') {
                message = '段落整理完成，已添加空行！';
            } else if (mode.value === 'removeLineBreaks') {
                message = '删除段内分行完成！';
            } else {
                message = '段落整理完成！';
            }
            vscode.window.showInformationMessage(message);
        } catch (error) {
            ErrorUtils.showError(error, '整理段落时出错：');
        }
    }
}
