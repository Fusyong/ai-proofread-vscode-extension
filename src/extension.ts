/**
 * 扩展入口
 */

import * as vscode from 'vscode';
import { PromptManager } from './promptManager';
import { TempFileManager, ConfigManager, Logger } from './utils';
import { WebviewManager } from './ui/webviewManager';
import { FileSplitCommandHandler } from './commands/fileSplitCommandHandler';
import { ProofreadCommandHandler } from './commands/proofreadCommandHandler';
import { FileCompareCommandHandler } from './commands/fileCompareCommandHandler';
import { DocumentConvertCommandHandler } from './commands/documentConvertCommandHandler';
import { UtilityCommandHandler } from './commands/utilityCommandHandler';








export function activate(context: vscode.ExtensionContext) {
    const logger = Logger.getInstance();
    const configManager = ConfigManager.getInstance();
    logger.info('AI Proofread extension is now active!');

    // 清理临时文件
    TempFileManager.getInstance(context).cleanup();

    // 初始化管理器
    const webviewManager = WebviewManager.getInstance();
    const fileSplitHandler = new FileSplitCommandHandler(webviewManager);
    const proofreadHandler = new ProofreadCommandHandler(webviewManager);
    const fileCompareHandler = new FileCompareCommandHandler();
    const documentConvertHandler = new DocumentConvertCommandHandler();
    const utilityHandler = new UtilityCommandHandler();

    // 设置校对JSON文件的回调
    webviewManager.setProofreadJsonCallback((jsonFilePath: string, context: vscode.ExtensionContext) => {
        return proofreadHandler.handleProofreadJsonFile(jsonFilePath, context);
    });

    // 注册所有命令
    let disposables = [
        vscode.commands.registerCommand('ai-proofread.splitFile', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('No active editor!');
                return;
            }

            // 让用户选择切分模式
            const mode = await vscode.window.showQuickPick([
                { label: '按长度切分', value: 'length' },
                { label: '按标题切分', value: 'title' },
                { label: '按标题和长度切分', value: 'title-length' },
                { label: '按长度切分，以标题范围为上下文', value: 'titleContext' },
                { label: '按长度切分，扩展前后段落为上下文', value: 'paragraphContext' },
            ], {
                placeHolder: '请选择切分模式',
                canPickMany: false
            });

            if (!mode) {
                return;
            }

            await fileSplitHandler.handleFileSplitCommand(
                mode.value as 'length' | 'title' | 'title-length' | 'titleContext' | 'paragraphContext', 
                editor, 
                editor.document,
                context
            );
        }),

        vscode.commands.registerCommand('ai-proofread.splitFileByLength', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('No active editor!');
                return;
            }
            await fileSplitHandler.handleFileSplitCommand('length', editor, editor.document, context);
        }),

        vscode.commands.registerCommand('ai-proofread.splitFileByTitle', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('No active editor!');
                return;
            }
            await fileSplitHandler.handleFileSplitCommand('title', editor, editor.document, context);
        }),

        vscode.commands.registerCommand('ai-proofread.splitFileWithTitleContext', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('No active editor!');
                return;
            }
            await fileSplitHandler.handleFileSplitCommand('titleContext', editor, editor.document, context);
        }),

        vscode.commands.registerCommand('ai-proofread.splitFileWithParagraphContext', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('No active editor!');
                return;
            }
            await fileSplitHandler.handleFileSplitCommand('paragraphContext', editor, editor.document, context);
        }),

        vscode.commands.registerCommand('ai-proofread.splitFileByTitleAndLength', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('No active editor!');
                return;
            }
            await fileSplitHandler.handleFileSplitCommand('title-length', editor, editor.document, context);
        }),

        vscode.commands.registerCommand('ai-proofread.proofreadFile', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('No active editor!');
                return;
            }
            await proofreadHandler.handleProofreadFileCommand(editor, context);
        }),

        vscode.commands.registerCommand('ai-proofread.proofreadSelection', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('No active editor!');
                return;
            }
            await proofreadHandler.handleProofreadSelectionCommand(editor, context);
        }),

        // 注册提示词管理命令
        vscode.commands.registerCommand('ai-proofread.managePrompts', () => {
            PromptManager.getInstance(context).managePrompts();
        }),

        // 注册选择提示词命令
        vscode.commands.registerCommand('ai-proofread.selectPrompt', () => {
            PromptManager.getInstance(context).selectPrompt();
        }),

        // 注册合并文件命令
        vscode.commands.registerCommand('ai-proofread.mergeTwoFiles', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('No active editor!');
                return;
            }
            await utilityHandler.handleMergeTwoFilesCommand(editor);
        }),

        // 注册在PDF中搜索选中文本命令
        vscode.commands.registerCommand('ai-proofread.searchSelectionInPDF', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('请先打开PDF对应的Markdown文件并选择要搜索的文本');
                return;
            }
            await utilityHandler.handleSearchSelectionInPDFCommand(editor);
        }),

        // 注册比较两个文件命令
        vscode.commands.registerCommand('ai-proofread.diffItWithAnotherFile', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('请先打开一个文件！');
                return;
            }
            await fileCompareHandler.handleDiffItWithAnotherFileCommand(editor);
        }),

        // 注册docx转markdown命令
        vscode.commands.registerCommand('ai-proofread.convertDocxToMarkdown', async () => {
            await documentConvertHandler.handleConvertDocxToMarkdownCommand();
        }),

        // 注册markdown转docx命令
        vscode.commands.registerCommand('ai-proofread.convertMarkdownToDocx', async () => {
            await documentConvertHandler.handleConvertMarkdownToDocxCommand();
        }),

        // 注册引号转换命令
        vscode.commands.registerCommand('ai-proofread.convertQuotes', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('No active editor!');
                return;
            }
            await utilityHandler.handleConvertQuotesCommand(editor);
        }),

        // 注册重新打开结果面板命令
        vscode.commands.registerCommand('ai-proofread.reopenResultPanel', () => {
            webviewManager.reopenResultPanel(context);
        }),
    ];

    context.subscriptions.push(...disposables, configManager);
}

export function deactivate() {
    const logger = Logger.getInstance();
    const configManager = ConfigManager.getInstance();
    logger.dispose();
    configManager.dispose();
}