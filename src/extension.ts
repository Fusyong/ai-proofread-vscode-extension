/**
 * 扩展入口
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { PromptManager } from './promptManager';
import { TempFileManager, ConfigManager, Logger } from './utils';
import { WebviewManager } from './ui/webviewManager';
import { FileSplitCommandHandler } from './commands/fileSplitCommandHandler';
import { ProofreadCommandHandler } from './commands/proofreadCommandHandler';
import { FileCompareCommandHandler } from './commands/fileCompareCommandHandler';
import { ExamplesCommandHandler } from './commands/examplesCommandHandler';
import { DocumentConvertCommandHandler } from './commands/documentConvertCommandHandler';
import { UtilityCommandHandler } from './commands/utilityCommandHandler';
import { CitationCommandHandler } from './commands/citationCommandHandler';
import { registerCitationView } from './citation/citationView';
import { WordCheckCommandHandler } from './commands/wordCheckCommandHandler';
import { NumberingTreeDataProvider } from './numbering/numberingTreeProvider';
import { registerNumberingView } from './numbering/numberingView';
import { SegmentTreeDataProvider } from './numbering/segmentTreeProvider';
import { registerSegmentView } from './numbering/segmentView';
import { NumberingCheckCommandHandler } from './commands/numberingCheckCommandHandler';
import { ContinuousProofreadCommandHandler } from './commands/continuousProofreadCommandHandler';
import { registerPromptsView, type PromptTreeItem } from './promptsView';
import { getJiebaWasm } from './jiebaLoader';


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
    const fileCompareHandler = new FileCompareCommandHandler(context);
    const examplesHandler = new ExamplesCommandHandler(context);
    const documentConvertHandler = new DocumentConvertCommandHandler();
    const utilityHandler = new UtilityCommandHandler();
    const { provider: citationTreeProvider, treeView: citationTreeView } = registerCitationView(context);
    const citationHandler = new CitationCommandHandler(context, citationTreeProvider, citationTreeView);
    const wordCheckHandler = new WordCheckCommandHandler(context);
    wordCheckHandler.registerView();
    wordCheckHandler.registerCustomTablesView();
    wordCheckHandler.registerCheckTypesViews();

    const numberingProvider = new NumberingTreeDataProvider();
    const { treeView: numberingTreeView } = registerNumberingView(context, numberingProvider);
    const segmentProvider = new SegmentTreeDataProvider();
    const { treeView: segmentTreeView } = registerSegmentView(context, segmentProvider);
    const numberingHandler = new NumberingCheckCommandHandler(context, numberingProvider, numberingTreeView, segmentProvider, segmentTreeView);
    const continuousProofreadHandler = new ContinuousProofreadCommandHandler(examplesHandler);

    const promptManager = PromptManager.getInstance(context);
    const { provider: promptsTreeProvider } = registerPromptsView(context, promptManager);

    // 按需显示 TreeView：默认全部隐藏，由命令显式打开
    vscode.commands.executeCommand('setContext', 'aiProofread.showPromptsView', false);
    vscode.commands.executeCommand('setContext', 'aiProofread.showDictCheckTypesView', false);
    vscode.commands.executeCommand('setContext', 'aiProofread.showTgsccCheckTypesView', false);
    vscode.commands.executeCommand('setContext', 'aiProofread.showCustomTablesView', false);
    vscode.commands.executeCommand('setContext', 'aiProofread.showWordCheckView', false);
    vscode.commands.executeCommand('setContext', 'aiProofread.showCitationView', false);
    vscode.commands.executeCommand('setContext', 'aiProofread.showNumberingView', false);
    vscode.commands.executeCommand('setContext', 'aiProofread.showNumberingSegmentsView', false);

    // 设置校对、切分、合并的回调
    webviewManager.setProofreadJsonCallback((jsonFilePath: string, ctx: vscode.ExtensionContext) => {
        return proofreadHandler.handleProofreadJsonFile(jsonFilePath, ctx);
    });
    webviewManager.setSplitCallback((mainFilePath: string, ctx: vscode.ExtensionContext) => {
        return fileSplitHandler.handleFileSplitByPath(mainFilePath, ctx);
    });
    webviewManager.setMergeCallback((jsonFilePath: string) => {
        return utilityHandler.handleMergeTwoFilesByPath(jsonFilePath);
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
                { label: '按长度切分，以前后段落为上下文', value: 'paragraphContext' },
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
        vscode.commands.registerCommand('ai-proofread.proofreadSelectionWithExamples', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('No active editor!');
                return;
            }
            await proofreadHandler.handleProofreadSelectionWithExamplesCommand(editor, context);
        }),
        vscode.commands.registerCommand('ai-proofread.editProofreadingExamples', async () => {
            await examplesHandler.handleEditProofreadingExamplesCommand();
        }),
        vscode.commands.registerCommand('ai-proofread.splitIntoSentences', async () => {
            await examplesHandler.handleSplitIntoSentencesCommand();
        }),

        // 注册提示词管理命令（聚焦 TreeView）
        vscode.commands.registerCommand('ai-proofread.managePrompts', async () => {
            // 按需显示 prompts 视图
            await vscode.commands.executeCommand('setContext', 'aiProofread.showPromptsView', true);
            PromptManager.getInstance(context).managePrompts();
        }),

        vscode.commands.registerCommand('ai-proofread.prompts.new', async () => {
            await promptManager.addPrompt();
            promptsTreeProvider.refresh();
        }),
        vscode.commands.registerCommand('ai-proofread.prompts.edit', async (el: PromptTreeItem) => {
            if (el?.prompt) {
                await promptManager.editPrompt(el.prompt);
                promptsTreeProvider.refresh();
            }
        }),
        vscode.commands.registerCommand('ai-proofread.prompts.delete', async (el: PromptTreeItem) => {
            if (el?.id && el.prompt) {
                await promptManager.deletePrompt(el.id);
                promptsTreeProvider.refresh();
            }
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

        // 注册PDF转markdown命令
        vscode.commands.registerCommand('ai-proofread.convertPdfToMarkdown', async () => {
            await documentConvertHandler.handleConvertPdfToMarkdownCommand();
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

        // 注册段落整理命令
        vscode.commands.registerCommand('ai-proofread.formatParagraphs', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('No active editor!');
                return;
            }
            await utilityHandler.handleFormatParagraphsCommand(editor);
        }),

        // 注册根据目录标记标题命令
        vscode.commands.registerCommand('ai-proofread.markTitlesFromToc', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('No active editor!');
                return;
            }
            await utilityHandler.handleMarkTitlesFromTocCommand(editor);
        }),

        // 注册分词命令
        vscode.commands.registerCommand('ai-proofread.segmentFile', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('No active editor!');
                return;
            }
            await utilityHandler.handleSegmentFileCommand(editor, context);
        }),
        vscode.commands.registerCommand('ai-proofread.segmentSelection', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('No active editor!');
                return;
            }
            await utilityHandler.handleSegmentSelectionCommand(editor, context);
        }),

        // 打开校对面板（支持空面板）
        vscode.commands.registerCommand('ai-proofread.openProofreadingPanel', () => {
            webviewManager.openProofreadingPanel(context);
        }),
        // 兼容旧命令
        vscode.commands.registerCommand('ai-proofread.reopenResultPanel', () => {
            webviewManager.openProofreadingPanel(context);
        }),

        // 引文核对
        vscode.commands.registerCommand('ai-proofread.citation.openView', async () => {
            // 按需显示引文核对视图
            await vscode.commands.executeCommand('setContext', 'aiProofread.showCitationView', true);
            citationHandler.handleOpenViewCommand();
        }),
        vscode.commands.registerCommand('ai-proofread.citation.rebuildIndex', async () => {
            await citationHandler.handleRebuildIndexCommand();
        }),
        vscode.commands.registerCommand('ai-proofread.citation.verifySelection', async () => {
            // 使用“核对选中引文”命令时，也自动显示引文视图
            await vscode.commands.executeCommand('setContext', 'aiProofread.showCitationView', true);
            await citationHandler.handleVerifySelectionCommand();
        }),
        vscode.commands.registerCommand('ai-proofread.citation.showDiff', (nodeOrItem?: unknown) => {
            citationHandler.handleShowDiffCommand(nodeOrItem as import('./citation/citationTreeProvider').CitationTreeNode | { id?: string } | undefined);
        }),
        vscode.commands.registerCommand('ai-proofread.citation.searchInPdf', (nodeOrItem?: unknown) => {
            citationHandler.handleSearchInPdfCommand(nodeOrItem as import('./citation/citationTreeProvider').CitationTreeNode | { id?: string } | undefined);
        }),
        vscode.commands.registerCommand('ai-proofread.checkWords', async () => {
            // 按需显示与字词检查相关的视图
            await vscode.commands.executeCommand('setContext', 'aiProofread.showWordCheckView', true);
            await vscode.commands.executeCommand('setContext', 'aiProofread.showDictCheckTypesView', true);
            await vscode.commands.executeCommand('setContext', 'aiProofread.showTgsccCheckTypesView', true);
            await vscode.commands.executeCommand('setContext', 'aiProofread.showCustomTablesView', true);
            await wordCheckHandler.handleCheckWordsCommand();
        }),
        vscode.commands.registerCommand('ai-proofread.wordCheck.prevOccurrence', () => wordCheckHandler.handlePrevOccurrenceCommand()),
        vscode.commands.registerCommand('ai-proofread.wordCheck.nextOccurrence', () => wordCheckHandler.handleNextOccurrenceCommand()),
        vscode.commands.registerCommand('ai-proofread.wordCheck.showNotes', () => wordCheckHandler.handleShowNotesCommand()),
        vscode.commands.registerCommand('ai-proofread.wordCheck.revealCurrentAndAdvance', () => wordCheckHandler.handleRevealCurrentAndAdvanceCommand()),
        vscode.commands.registerCommand('ai-proofread.wordCheck.applyReplaceForEntry', () => wordCheckHandler.handleApplyReplaceForEntryCommand()),
        vscode.commands.registerCommand('ai-proofread.manageCustomTables', async () => {
            // 按需显示自定义替换表及相关视图
            await vscode.commands.executeCommand('setContext', 'aiProofread.showCustomTablesView', true);
            await vscode.commands.executeCommand('setContext', 'aiProofread.showDictCheckTypesView', true);
            await vscode.commands.executeCommand('setContext', 'aiProofread.showTgsccCheckTypesView', true);
            await vscode.commands.executeCommand('setContext', 'aiProofread.showWordCheckView', true);
            await wordCheckHandler.handleManageCustomTablesCommand();
        }),
        vscode.commands.registerCommand('ai-proofread.customTables.delete', (el: import('./xh7/customTablesView').CustomTableTreeItem) => wordCheckHandler.handleCustomTableDelete(el)),
        vscode.commands.registerCommand('ai-proofread.customTables.moveUp', (el: import('./xh7/customTablesView').CustomTableTreeItem) => wordCheckHandler.handleCustomTableMoveUp(el)),
        vscode.commands.registerCommand('ai-proofread.customTables.moveDown', (el: import('./xh7/customTablesView').CustomTableTreeItem) => wordCheckHandler.handleCustomTableMoveDown(el)),
        vscode.commands.registerCommand('ai-proofread.customTables.loadTable', () => wordCheckHandler.handleLoadCustomTableCommand()),
        vscode.commands.registerCommand('ai-proofread.dictCheckTypes.moveUp', (el: import('./xh7/checkTypesView').CheckTypeTreeItem) => wordCheckHandler.handleDictCheckTypeMoveUp(el)),
        vscode.commands.registerCommand('ai-proofread.dictCheckTypes.moveDown', (el: import('./xh7/checkTypesView').CheckTypeTreeItem) => wordCheckHandler.handleDictCheckTypeMoveDown(el)),
        vscode.commands.registerCommand('ai-proofread.tgsccCheckTypes.moveUp', (el: import('./xh7/checkTypesView').CheckTypeTreeItem) => wordCheckHandler.handleTgsccCheckTypeMoveUp(el)),
        vscode.commands.registerCommand('ai-proofread.tgsccCheckTypes.moveDown', (el: import('./xh7/checkTypesView').CheckTypeTreeItem) => wordCheckHandler.handleTgsccCheckTypeMoveDown(el)),

        // 标题层级与连续性检查
        vscode.commands.registerCommand('ai-proofread.numbering.check', async () => {
            const choice = await vscode.window.showQuickPick(
                [
                    { label: '标题树', value: 'title' },
                    { label: '段内序号', value: 'segment' },
                ],
                { title: '选择检查模式', placeHolder: '标题树：全文序号结构；段内序号：按段检测文中序号' }
            );
            if (!choice) return;
            if (choice.value === 'title') {
                await vscode.commands.executeCommand('setContext', 'aiProofread.showNumberingView', true);
                await new Promise((r) => setTimeout(r, 50));
                await numberingHandler.handleCheckCommand();
            } else {
                await vscode.commands.executeCommand('setContext', 'aiProofread.showNumberingSegmentsView', true);
                await new Promise((r) => setTimeout(r, 50));
                await numberingHandler.handleSegmentCheckCommand();
            }
        }),
        vscode.commands.registerCommand('ai-proofread.numbering.reveal', (node?: import('./numbering/types').NumberingNode) => numberingHandler.handleRevealCommand(node)),
        vscode.commands.registerCommand('ai-proofread.numbering.markAsTitle', (node?: import('./numbering/types').NumberingNode) => numberingHandler.handleMarkAsTitleCommand(node)),
        vscode.commands.registerCommand('ai-proofread.numbering.promote', (node?: import('./numbering/types').NumberingNode) => numberingHandler.handlePromoteCommand(node)),
        vscode.commands.registerCommand('ai-proofread.numbering.demote', (node?: import('./numbering/types').NumberingNode) => numberingHandler.handleDemoteCommand(node)),
        vscode.commands.registerCommand('ai-proofread.numbering.toggleSimplifiedLevel', () => numberingHandler.handleToggleSimplifiedLevelCommand()),
        vscode.commands.registerCommand('ai-proofread.numberingSegments.toggleSimplifiedLevel', () => numberingHandler.handleSegmentToggleSimplifiedLevelCommand()),
        vscode.commands.registerCommand('ai-proofread.numbering.defineTitle', () => numberingHandler.handleDefineTitleCommand()),
        vscode.commands.registerCommand('ai-proofread.numbering.defineSegmentPattern', () => numberingHandler.handleDefineSegmentPatternCommand()),
        vscode.commands.registerCommand('ai-proofread.numbering.checkSegments', async () => {
            await vscode.commands.executeCommand('setContext', 'aiProofread.showNumberingSegmentsView', true);
            await new Promise((r) => setTimeout(r, 50));
            await numberingHandler.handleSegmentCheckCommand();
        }),

        // 持续发现与监督校对
        vscode.commands.registerCommand('ai-proofread.continuousProofread', () =>
            continuousProofreadHandler.handleContinuousProofreadCommand(context)
        ),
        vscode.commands.registerCommand('ai-proofread.continuousProofread.accept', () =>
            continuousProofreadHandler.handleAcceptAndContinueCommand(context)
        ),
        vscode.commands.registerCommand('ai-proofread.continuousProofread.skip', () =>
            continuousProofreadHandler.handleSkipCommand(context)
        ),
        vscode.commands.registerCommand('ai-proofread.continuousProofread.stop', () =>
            continuousProofreadHandler.handleStopCommand()
        ),
    ];

    context.subscriptions.push(...disposables, configManager, new vscode.Disposable(() => continuousProofreadHandler.dispose()));
}

export function deactivate() {
    const logger = Logger.getInstance();
    const configManager = ConfigManager.getInstance();
    logger.dispose();
    configManager.dispose();
}