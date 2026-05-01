/**
 * split into sentences：将整篇或选中部分按简易中文分句后，用所选分隔符连接（通用文本整理）。
 */

import * as vscode from 'vscode';
import { splitChineseSentencesSimple } from '../splitter';

export class SplitIntoSentencesCommandHandler {
    public async handleSplitIntoSentencesCommand(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('请先打开一个文档。');
            return;
        }

        const separatorInput = await vscode.window.showInputBox({
            prompt: '请输入分隔符：数字1—10表示换行符个数，默认2（即一个空行）；或任意字符串',
            value: '2',
            validateInput: (value: string) => {
                if (!value || value.trim() === '') {
                    return '请输入数字或非空字符串';
                }
                const num = parseInt(value, 10);
                if (!isNaN(num) && (num < 1 || num > 10)) {
                    return '数字须在 1 到 10 之间';
                }
                return null;
            }
        });

        if (separatorInput === undefined) {
            return;
        }

        const trimmed = separatorInput.trim();
        const num = parseInt(trimmed, 10);
        const separator = !isNaN(num) && num >= 1 && num <= 10 ? '\n'.repeat(num) : trimmed;

        const text = editor.selection.isEmpty ? editor.document.getText() : editor.document.getText(editor.selection);

        const sentences = splitChineseSentencesSimple(text);
        const result = sentences.join(separator);

        let range: vscode.Range;
        if (editor.selection.isEmpty) {
            const lineCount = editor.document.lineCount;
            if (lineCount === 0) {
                range = new vscode.Range(0, 0, 0, 0);
            } else {
                const lastLine = editor.document.lineAt(lineCount - 1);
                range = new vscode.Range(0, 0, lineCount - 1, lastLine.text.length);
            }
        } else {
            range = editor.selection;
        }

        await editor.edit((editBuilder) => {
            editBuilder.replace(range, result);
        });

        const separatorDesc =
            !isNaN(num) && num >= 1 && num <= 10 ? `${num} 个换行符` : `自定义分隔符「${separator.replace(/\n/g, '\\n')}」`;
        vscode.window.showInformationMessage(`已按句子切分，共 ${sentences.length} 句，用 ${separatorDesc} 连接`);
    }
}
