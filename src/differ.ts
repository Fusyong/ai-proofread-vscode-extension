import * as vscode from 'vscode';
import { TempFileManager } from './utils';

/**
 * 显示两个文本之间的差异
 * @param context 扩展上下文
 * @param originalText 原始文本
 * @param proofreadText 校对后的文本
 * @param fileExt 文件扩展名
 */
export async function showDiff(
    context: vscode.ExtensionContext,
    originalText: string,
    proofreadText: string,
    fileExt: string
): Promise<void> {
    const tempFileManager = TempFileManager.getInstance(context);
    const originalUri = await tempFileManager.createTempFile(originalText, fileExt);
    const proofreadUri = await tempFileManager.createTempFile(proofreadText, fileExt);
    await openDiffView(originalUri, proofreadUri);
}

/**
 * 显示两个文件之间的差异
 * @param originalFile 原始文件路径
 * @param proofreadFile 校对后的文件路径
 */
export async function showFileDiff(
    originalFile: string,
    proofreadFile: string
): Promise<void> {
    const originalUri = vscode.Uri.file(originalFile);
    const proofreadUri = vscode.Uri.file(proofreadFile);
    await openDiffView(originalUri, proofreadUri);
}

/**
 * 打开diff视图
 * @param originalUri 原始文件URI
 * @param proofreadUri 校对后的文件URI
 */
async function openDiffView(
    originalUri: vscode.Uri,
    proofreadUri: vscode.Uri
): Promise<void> {
    await vscode.commands.executeCommand('vscode.diff', originalUri, proofreadUri, 'Original ↔ Proofread');
}