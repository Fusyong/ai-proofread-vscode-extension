import * as vscode from 'vscode';
import * as fs from 'fs';
import { FilePathUtils } from './utils';

/**
 * 在PDF中搜索选中的文本
 * @param editor 当前编辑器实例
 */
export async function searchSelectionInPDF(editor: vscode.TextEditor): Promise<void> {
    const selection = editor.document.getText(editor.selection);
    if (!selection) {
        vscode.window.showInformationMessage('请先选择要搜索的文本');
        return;
    }

    const currentFile = editor.document.uri.fsPath;
    const pdfPath = FilePathUtils.getFilePath(currentFile, '', '.pdf');

    if (!fs.existsSync(pdfPath)) {
        vscode.window.showInformationMessage(`未找到对应的PDF文件: ${pdfPath}`);
        return;
    }

    let terminal = vscode.window.terminals.find(t => t.name === 'SumatraPDF Search');
    if (!terminal) {
        terminal = vscode.window.createTerminal('SumatraPDF Search');
    }
    terminal.sendText(`SumatraPDF -search "${selection}" "${pdfPath}"`);
}
