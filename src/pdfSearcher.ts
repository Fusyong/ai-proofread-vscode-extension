import * as vscode from 'vscode';
import * as fs from 'fs';
import { FilePathUtils } from './utils';

/**
 * 在指定 PDF 中搜索文本（用于引文核对等场景）
 * @param pdfPath PDF 文件绝对路径
 * @param text 要搜索的文本
 */
export async function searchTextInPDF(pdfPath: string, text: string): Promise<void> {
    if (!fs.existsSync(pdfPath)) {
        vscode.window.showInformationMessage(`未找到对应的 PDF 文件: ${pdfPath}`);
        return;
    }
    if (!text || !text.trim()) {
        vscode.window.showInformationMessage('搜索文本为空');
        return;
    }
    try {
        let terminal = vscode.window.terminals.find(t => t.name === 'SumatraPDF Search');
        if (!terminal) {
            terminal = vscode.window.createTerminal('SumatraPDF Search');
        }
        terminal.sendText(`SumatraPDF -search "${text}" "${pdfPath}"`);
    } catch {
        vscode.window.showErrorMessage('SumatraPDF 未安装或不在 PATH 中，请先安装 SumatraPDF');
    }
}

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
    // 支持从 文档名.proofread.json.md 反查 文档名.pdf
    let pdfPath: string;
    if (currentFile.endsWith('.proofread.json.md')) {
        // 去掉 .proofread.json.md，添加 .pdf
        const baseName = currentFile.slice(0, -'.proofread.json.md'.length);
        pdfPath = baseName + '.pdf';
    } else {
        // 原有逻辑：从 文档名.md 反查 文档名.pdf
        pdfPath = FilePathUtils.getFilePath(currentFile, '', '.pdf');
    }

    if (!fs.existsSync(pdfPath)) {
        vscode.window.showInformationMessage(`未找到对应的PDF文件: ${pdfPath}`);
        return;
    }

    try {
        let terminal = vscode.window.terminals.find(t => t.name === 'SumatraPDF Search');
        if (!terminal) {
            terminal = vscode.window.createTerminal('SumatraPDF Search');
        }
        terminal.sendText(`SumatraPDF -search "${selection}" "${pdfPath}"`);
    } catch (error) {
        vscode.window.showErrorMessage('SumatraPDF未安装或不在PATH中，请先安装SumatraPDF');
    }
}
