/**
 * 工具命令处理器
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { mergeTwoFiles, mergeMarkdownIntoJson } from '../merger';
import { getJiebaWasm, type JiebaWasmModule } from '../jiebaLoader';
import { searchSelectionInPDF } from '../pdfSearcher';
import { searchSelectionInShidianguji } from '../shidiangujiSearch';
import { searchSelectionInAncientbooks } from '../ancientbooksSearch';
import { convertQuotes } from '../quoteConverter';
import { fullToHalfPunctuation, halfToFullPunctuation } from '../punctuationConverter';
import {
    replaceFounderCircledNumbers,
    type FounderCircledFormat,
} from '../founderCircledNumbers';
import { formatParagraphs } from '../paragraphDetector';
import {
    DEFAULT_DELETE_INLINE_WHITESPACE_OPTIONS,
    deleteInlineWhitespace,
    type DeleteInlineWhitespaceOptions
} from '../inlineWhitespace';
import { showDiff } from '../differ';
import { ErrorUtils, FilePathUtils, normalizeLineEndings } from '../utils';
import { parseToc, markTitles, TocItem } from '../titleMarker';
import {
    alignHeadings,
    diagnoseHeadingMismatch,
    parseHeadingLevels,
    type HeadingAlignFixHint,
    type HeadingAlignMismatch,
    type HeadingAlignMode,
} from '../headingAligner';

const ALIGN_HEADINGS_LAST_LEVELS_KEY = 'ai-proofread.alignHeadings.lastLevels';

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
            // 让用户选择来源类型
            const sourceType = await vscode.window.showQuickPick(
                [
                    { label: 'JSON 文件', value: 'json', description: '一一对应合并，两个 JSON 数组长度需相同' },
                    { label: 'Markdown 文件', value: 'markdown', description: '每个 JSON 项都合并同一文本' }
                ],
                {
                    placeHolder: '选择来源类型',
                    ignoreFocusOut: true
                }
            );

            if (!sourceType) {
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

            // 让用户选择合并模式
            const mergeMode = await vscode.window.showQuickPick(
                [
                    { label: '拼接', value: 'concat', description: '将来源内容追加到目标字段后面，中间加空行' },
                    { label: '更新（覆盖）', value: 'update', description: '用来源内容覆盖目标字段' }
                ],
                {
                    placeHolder: '选择合并模式',
                    ignoreFocusOut: true
                }
            );

            if (!mergeMode) {
                return;
            }

            // 询问是否更新对应的Markdown文件（默认是）
            const updateMarkdown = await vscode.window.showQuickPick(
                [
                    { label: '是', value: true, description: '更新对应的Markdown文件' },
                    { label: '否', value: false, description: '不更新Markdown文件' }
                ],
                {
                    placeHolder: '是否更新对应的Markdown文件？',
                    ignoreFocusOut: true
                }
            );

            if (updateMarkdown === undefined) {
                return; // 用户取消
            }

            let result: { updated: number; total: number; skipped: number };

            if (sourceType.value === 'json') {
                // JSON 文件：让用户选择来源文件及来源字段
                const sourceFile = await vscode.window.showOpenDialog({
                    canSelectFiles: true,
                    canSelectFolders: false,
                    canSelectMany: false,
                    filters: {
                        'JSON files': ['json']
                    },
                    title: '选择来源 JSON 文件'
                });

                if (!sourceFile || sourceFile.length === 0) {
                    return;
                }

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

                const ignoreHeadingLevels = await this.promptIgnoreHeadingLevels();
                if (ignoreHeadingLevels === undefined) {
                    return;
                }

                result = await mergeTwoFiles(
                    document.uri.fsPath,
                    sourceFile[0].fsPath,
                    targetField as 'target' | 'reference' | 'context',
                    sourceField as 'target' | 'reference' | 'context',
                    mergeMode.value as 'update' | 'concat',
                    ignoreHeadingLevels
                );
            } else {
                // Markdown 文件：每个 JSON 项都合并同一文本
                const sourceFile = await vscode.window.showOpenDialog({
                    canSelectFiles: true,
                    canSelectFolders: false,
                    canSelectMany: false,
                    filters: {
                        'Markdown files': ['md', 'markdown'],
                        'Text files': ['txt'],
                        'All files': ['*']
                    },
                    title: '选择 Markdown 文件'
                });

                if (!sourceFile || sourceFile.length === 0) {
                    return;
                }

                const ignoreHeadingLevels = await this.promptIgnoreHeadingLevels();
                if (ignoreHeadingLevels === undefined) {
                    return;
                }

                result = await mergeMarkdownIntoJson(
                    document.uri.fsPath,
                    sourceFile[0].fsPath,
                    targetField as 'target' | 'reference' | 'context',
                    mergeMode.value as 'update' | 'concat',
                    ignoreHeadingLevels
                );
            }

            // 显示结果
            const modeText = mergeMode.value === 'update' ? '更新' : '拼接';
            let message = `合并完成！${modeText}了 ${result.updated}/${result.total} 项`;
            if (result.skipped > 0) {
                message += `（跳过 ${result.skipped} 个忽略标题单元）`;
            }

            // 如果用户选择更新Markdown文件，则执行更新
            if (updateMarkdown.value) {
                try {
                    await this.updateMarkdownFileFromJson(document.uri.fsPath, targetField as 'target' | 'reference' | 'context');
                    message += '，已更新对应的Markdown文件';
                } catch (error) {
                    ErrorUtils.showError(error, '更新Markdown文件时出错：');
                }
            }

            vscode.window.showInformationMessage(message);
        } catch (error) {
            ErrorUtils.showError(error, '合并文件时出错：');
        }
    }

    /**
     * 按 JSON 文件路径执行合并（供 Proofreading panel 调用）
     */
    public async handleMergeTwoFilesByPath(jsonFilePath: string): Promise<void> {
        try {
            const sourceType = await vscode.window.showQuickPick(
                [
                    { label: 'JSON 文件', value: 'json', description: '一一对应合并，两个 JSON 数组长度需相同' },
                    { label: 'Markdown 文件', value: 'markdown', description: '每个 JSON 项都合并同一文本' }
                ],
                { placeHolder: '选择来源类型', ignoreFocusOut: true }
            );
            if (!sourceType) return;

            const targetField = await vscode.window.showQuickPick(
                ['target', 'reference', 'context'],
                { placeHolder: '选择要更新的字段', ignoreFocusOut: true }
            );
            if (!targetField) return;

            const mergeMode = await vscode.window.showQuickPick(
                [
                    { label: '拼接', value: 'concat', description: '将来源内容追加到目标字段后面，中间加空行' },
                    { label: '更新（覆盖）', value: 'update', description: '用来源内容覆盖目标字段' }
                ],
                { placeHolder: '选择合并模式', ignoreFocusOut: true }
            );
            if (!mergeMode) return;

            const updateMarkdown = await vscode.window.showQuickPick(
                [
                    { label: '是', value: true, description: '更新对应的Markdown文件' },
                    { label: '否', value: false, description: '不更新Markdown文件' }
                ],
                { placeHolder: '是否更新对应的Markdown文件？', ignoreFocusOut: true }
            );
            if (updateMarkdown === undefined) return;

            let result: { updated: number; total: number; skipped: number };

            if (sourceType.value === 'json') {
                const sourceFile = await vscode.window.showOpenDialog({
                    canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
                    filters: { 'JSON files': ['json'] },
                    title: '选择来源 JSON 文件'
                });
                if (!sourceFile?.length) return;

                const sourceField = await vscode.window.showQuickPick(
                    ['target', 'reference', 'context'],
                    { placeHolder: '选择来源文件中的字段', ignoreFocusOut: true }
                );
                if (!sourceField) return;

                const ignoreHeadingLevels = await this.promptIgnoreHeadingLevels();
                if (ignoreHeadingLevels === undefined) {
                    return;
                }

                result = await mergeTwoFiles(
                    jsonFilePath, sourceFile[0].fsPath,
                    targetField as 'target' | 'reference' | 'context',
                    sourceField as 'target' | 'reference' | 'context',
                    mergeMode.value as 'update' | 'concat',
                    ignoreHeadingLevels
                );
            } else {
                const sourceFile = await vscode.window.showOpenDialog({
                    canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
                    filters: { 'Markdown files': ['md', 'markdown'], 'Text files': ['txt'], 'All files': ['*'] },
                    title: '选择 Markdown 文件'
                });
                if (!sourceFile?.length) return;

                const ignoreHeadingLevels = await this.promptIgnoreHeadingLevels();
                if (ignoreHeadingLevels === undefined) {
                    return;
                }

                result = await mergeMarkdownIntoJson(
                    jsonFilePath, sourceFile[0].fsPath,
                    targetField as 'target' | 'reference' | 'context',
                    mergeMode.value as 'update' | 'concat',
                    ignoreHeadingLevels
                );
            }

            let message = `合并完成！${mergeMode.value === 'update' ? '更新' : '拼接'}了 ${result.updated}/${result.total} 项`;
            if (result.skipped > 0) {
                message += `（跳过 ${result.skipped} 个忽略标题单元）`;
            }
            if (updateMarkdown.value) {
                try {
                    await this.updateMarkdownFileFromJson(jsonFilePath, targetField as 'target' | 'reference' | 'context');
                    message += '，已更新对应的Markdown文件';
                } catch (error) {
                    ErrorUtils.showError(error, '更新Markdown文件时出错：');
                }
            }
            vscode.window.showInformationMessage(message);
        } catch (error) {
            ErrorUtils.showError(error, '合并文件时出错：');
        }
    }

    /**
     * 询问当前 JSON 侧要忽略的标题级别（空=不忽略）。
     * @returns 级别数组；用户取消时返回 undefined
     */
    private async promptIgnoreHeadingLevels(): Promise<number[] | undefined> {
        const input = await vscode.window.showInputBox({
            prompt: '当前文件：忽略哪些标题级别的单元（不从来源合并）？留空表示不忽略',
            placeHolder: '例如：1，2，4（兼容全角逗号）；默认留空',
            value: '',
            ignoreFocusOut: true,
            validateInput: (value) => {
                if (!value.trim()) {
                    return null;
                }
                const parsed = parseHeadingLevels(value);
                return 'error' in parsed ? parsed.error : null;
            },
        });
        if (input === undefined) {
            return undefined;
        }
        if (!input.trim()) {
            return [];
        }
        const parsed = parseHeadingLevels(input);
        if ('error' in parsed) {
            vscode.window.showWarningMessage(parsed.error);
            return undefined;
        }
        return parsed.levels;
    }

    /**
     * 从JSON文件更新对应的Markdown文件
     * @param jsonFilePath JSON文件路径
     * @param fieldName 要使用的字段名（target、reference或context）
     */
    private async updateMarkdownFileFromJson(
        jsonFilePath: string,
        fieldName: 'target' | 'reference' | 'context'
    ): Promise<void> {
        // 读取合并后的JSON文件
        const jsonContent = JSON.parse(fs.readFileSync(jsonFilePath, 'utf8'));

        // 确保是数组
        if (!Array.isArray(jsonContent)) {
            throw new Error('JSON文件必须是数组格式');
        }

        // 将JSON数组转换为Markdown（使用指定字段）
        const markdownContent = jsonContent
            .map((item: any) => {
                if (typeof item === 'object' && item !== null && item[fieldName]) {
                    return item[fieldName];
                }
                return '';
            })
            .filter((text: string) => text.trim() !== '') // 过滤空内容
            .join('\n\n');

        // 生成对应的Markdown文件路径（x.json -> x.md）
        const dir = path.dirname(jsonFilePath);
        const baseName = path.basename(jsonFilePath, path.extname(jsonFilePath));
        const markdownFilePath = path.join(dir, `${baseName}.md`);

        // 备份原有的Markdown文件（如果存在）
        FilePathUtils.backupFileIfExists(markdownFilePath, false);

        // 写入新的Markdown文件
        fs.writeFileSync(markdownFilePath, markdownContent, 'utf8');
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

    public async handleSearchSelectionInShidiangujiCommand(editor: vscode.TextEditor): Promise<void> {
        if (!editor) {
            vscode.window.showInformationMessage('请先打开文件并选择要搜索的文本');
            return;
        }
        try {
            await searchSelectionInShidianguji(editor);
        } catch (error) {
            ErrorUtils.showError(error, '打开识典古籍搜索时出错：');
        }
    }

    public async handleSearchSelectionInAncientbooksCommand(editor: vscode.TextEditor): Promise<void> {
        if (!editor) {
            vscode.window.showInformationMessage('请先打开文件并选择要搜索的文本');
            return;
        }
        try {
            await searchSelectionInAncientbooks(editor);
        } catch (error) {
            ErrorUtils.showError(error, '打开中华经典古籍库搜索时出错：');
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
     * 半角标点转全角标点（,;:!? → ，；：！？）
     */
    public async handleHalfToFullPunctuationCommand(editor: vscode.TextEditor): Promise<void> {
        await this.replaceEditorText(
            editor,
            halfToFullPunctuation,
            '半角标点已转为全角！',
            '半角标点转全角时出错：'
        );
    }

    /**
     * 方正书版带圈序号 → Unicode 带圈符号或方头扩注序号 [n]
     */
    public async handleReplaceFounderCircledNumbersCommand(
        editor: vscode.TextEditor
    ): Promise<void> {
        if (!editor) {
            vscode.window.showInformationMessage('No active editor!');
            return;
        }

        try {
            const formatPick = await vscode.window.showQuickPick(
                [
                    {
                        label: 'Unicode 带圈符号',
                        description: '①–㊿；大于 50 用 [n]',
                        value: 'unicode' as FounderCircledFormat,
                    },
                    {
                        label: '方头扩注序号',
                        description: '一律替换为 [1]、[2]…',
                        value: 'bracket' as FounderCircledFormat,
                    },
                ],
                {
                    placeHolder: '选择替换格式',
                    ignoreFocusOut: true,
                }
            );
            if (!formatPick) {
                return;
            }

            const document = editor.document;
            const selection = editor.selection;
            const text = selection.isEmpty ? document.getText() : document.getText(selection);
            const { text: convertedText, replacedCount, strippedArtifactCount } =
                replaceFounderCircledNumbers(text, { format: formatPick.value });

            if (replacedCount === 0 && strippedArtifactCount === 0) {
                vscode.window.showInformationMessage('未发现方正书版带圈序号或版面杂质。');
                return;
            }

            await editor.edit((editBuilder) => {
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

            const parts: string[] = [];
            if (replacedCount > 0) {
                parts.push(`替换 ${replacedCount} 处序号`);
            }
            if (strippedArtifactCount > 0) {
                parts.push(`清除 ${strippedArtifactCount} 处版面杂质`);
            }
            vscode.window.showInformationMessage(`方正带圈序号处理完成：${parts.join('，')}。`);
        } catch (error) {
            ErrorUtils.showError(error, '替换方正带圈序号时出错：');
        }
    }

    /**
     * 全角标点转半角标点（，；：！？ → ,;:!?）
     */
    public async handleFullToHalfPunctuationCommand(editor: vscode.TextEditor): Promise<void> {
        await this.replaceEditorText(
            editor,
            fullToHalfPunctuation,
            '全角标点已转为半角！',
            '全角标点转半角时出错：'
        );
    }

    /**
     * 将选区或全文经 transform 后写回编辑器
     */
    private async replaceEditorText(
        editor: vscode.TextEditor,
        transform: (text: string) => string,
        successMessage: string,
        errorPrefix: string
    ): Promise<void> {
        if (!editor) {
            vscode.window.showInformationMessage('No active editor!');
            return;
        }

        try {
            const document = editor.document;
            const selection = editor.selection;
            const text = selection.isEmpty ? document.getText() : document.getText(selection);
            const convertedText = transform(text);

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

            vscode.window.showInformationMessage(successMessage);
        } catch (error) {
            ErrorUtils.showError(error, errorPrefix);
        }
    }

    /**
     * 读取「删除行中空白字符」配置
     */
    private getDeleteInlineWhitespaceConfig(): DeleteInlineWhitespaceOptions {
        const config = vscode.workspace.getConfiguration('ai-proofread.deleteInlineWhitespace');
        return {
            maxConsecutive: Math.max(
                0,
                config.get<number>('maxConsecutive', DEFAULT_DELETE_INLINE_WHITESPACE_OPTIONS.maxConsecutive)
            ),
            preserveLineEdges: config.get<boolean>(
                'preserveLineEdges',
                DEFAULT_DELETE_INLINE_WHITESPACE_OPTIONS.preserveLineEdges
            )
        };
    }

    /**
     * 交互式收集「删除行中空白字符」选项
     */
    private async promptDeleteInlineWhitespaceOptions(
        defaults: DeleteInlineWhitespaceOptions
    ): Promise<DeleteInlineWhitespaceOptions | undefined> {
        const maxConsecutiveInput = await vscode.window.showInputBox({
            title: '删除行中空白字符',
            prompt: '连续空白个数小于等于（仅删除长度不超过此值的空白序列）',
            value: String(defaults.maxConsecutive),
            ignoreFocusOut: true,
            validateInput: (value) => {
                const num = Number(value);
                if (!Number.isInteger(num) || num < 0) {
                    return '请输入非负整数';
                }
                return null;
            }
        });
        if (maxConsecutiveInput === undefined) {
            return undefined;
        }

        const preserveLineEdgesChoice = await vscode.window.showQuickPick(
            [
                {
                    label: '是（默认）',
                    description: '保留每行行首与行尾空白',
                    value: true
                },
                {
                    label: '否',
                    description: '行首行尾空白也参与处理',
                    value: false
                }
            ],
            {
                title: '删除行中空白字符',
                placeHolder: '是否保留行首行尾空白？',
                ignoreFocusOut: true
            }
        );
        if (preserveLineEdgesChoice === undefined) {
            return undefined;
        }

        return {
            maxConsecutive: Number(maxConsecutiveInput),
            preserveLineEdges: preserveLineEdgesChoice.value
        };
    }

    /**
     * 处理删除行中空白字符命令
     */
    public async handleDeleteInlineWhitespaceCommand(editor: vscode.TextEditor): Promise<void> {
        if (!editor) {
            vscode.window.showInformationMessage('No active editor!');
            return;
        }

        try {
            const config = vscode.workspace.getConfiguration('ai-proofread.deleteInlineWhitespace');
            const askOnRun = config.get<boolean>('askOnRun', true);
            const defaultOptions = this.getDeleteInlineWhitespaceConfig();
            const options = askOnRun
                ? await this.promptDeleteInlineWhitespaceOptions(defaultOptions)
                : defaultOptions;

            if (!options) {
                return;
            }

            const document = editor.document;
            const selection = editor.selection;
            const text = selection.isEmpty ? document.getText() : document.getText(selection);
            const processedText = deleteInlineWhitespace(text, options);

            await editor.edit((editBuilder) => {
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

            vscode.window.showInformationMessage('行中空白字符已处理完成！');
        } catch (error) {
            ErrorUtils.showError(error, '删除行中空白字符时出错：');
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

    /**
     * 处理根据目录标记标题命令
     */
    public async handleMarkTitlesFromTocCommand(editor: vscode.TextEditor): Promise<void> {
        if (!editor) {
            vscode.window.showInformationMessage('No active editor!');
            return;
        }

        try {
            const document = editor.document;

            // 让用户选择目录文件
            const tocFile = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: {
                    'Markdown files': ['md'],
                    'All files': ['*']
                },
                title: '选择目录文件（.目录.md 或包含目录的 Markdown 文件）'
            });

            if (!tocFile || tocFile.length === 0) {
                return;
            }

            // 让用户输入起始标题级别
            const baseLevelInput = await vscode.window.showInputBox({
                prompt: '请输入起始标题级别（正整数，默认为1；可大于6）',
                placeHolder: '1',
                value: '1',
                validateInput: (value) => {
                    const num = parseInt(value, 10);
                    if (isNaN(num) || num < 1) {
                        return '请输入大于或等于 1 的整数';
                    }
                    return null;
                }
            });

            if (baseLevelInput === undefined) {
                return; // 用户取消
            }

            const baseLevel = parseInt(baseLevelInput, 10) || 1;

            // 读取目录文件内容（parseToc 内部会做换行符规范化）
            const tocContent = fs.readFileSync(tocFile[0].fsPath, 'utf8');
            const tocItems = parseToc(tocContent, 4, baseLevel);

            if (tocItems.length === 0) {
                vscode.window.showWarningMessage('目录文件中没有找到有效的目录项！');
                return;
            }

            // 获取当前文档文本并统一换行符后按行分割
            const fullText = document.getText();
            const textLines = normalizeLineEndings(fullText).split('\n');

            // 标记标题
            const [markedLines, notFound] = markTitles(textLines, tocItems);

            // 如果有未找到的目录项，显示警告
            if (notFound.length > 0) {
                const notFoundList = notFound
                    .map(item => `- ${item.name} (级别: ${item.level})`)
                    .join('\n');

                const message = `标记完成！但有 ${notFound.length} 个目录项未找到（起始级别: ${baseLevel}）：\n${notFoundList}`;
                vscode.window.showWarningMessage(message);
            } else {
                vscode.window.showInformationMessage(`标记完成！成功标记了 ${tocItems.length} 个标题（起始级别: ${baseLevel}）。`);
            }

            // 替换文档内容，写回时使用文档当前的换行符以保持用户习惯
            const fullRange = new vscode.Range(
                document.positionAt(0),
                document.positionAt(fullText.length)
            );
            const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';

            await editor.edit(editBuilder => {
                editBuilder.replace(fullRange, markedLines.join(eol));
            });
        } catch (error) {
            ErrorUtils.showError(error, '标记标题时出错：');
        }
    }

    /**
     * 分词：可选分词替换、输出词频统计表或输出字频统计表
     */
    private async runSegment(
        editor: vscode.TextEditor,
        context: vscode.ExtensionContext,
        range: vscode.Range
    ): Promise<void> {
        const modeChoice = await vscode.window.showQuickPick(
            [
                { label: '分词后替换原文', value: 'replace', description: '分词后替换原文，可设分隔符' },
                { label: '输出词频统计表', value: 'frequency', description: '生成词语、词性、词频表' },
                { label: '输出字频统计表', value: 'charFrequency', description: '生成单字及频度表' },
            ],
            { placeHolder: '选择分词输出方式', ignoreFocusOut: true }
        );
        if (!modeChoice) return;

        const text = editor.document.getText(range);
        if (!text.trim()) {
            vscode.window.showInformationMessage('文本为空，无法分词');
            return;
        }

        try {
            if (modeChoice.value === 'charFrequency') {
                await this.outputCharFrequencyCsv(text, editor.document.uri);
                return;
            }

            const customDictPath = vscode.workspace.getConfiguration('ai-proofread.jieba').get<string>('customDictPath', '');
            const jieba = getJiebaWasm(path.join(context.extensionPath, 'dist'), customDictPath || undefined);

            if (modeChoice.value === 'frequency') {
                await this.outputWordFrequencyCsv(jieba, text, editor.document.uri);
                return;
            }

            // 分词替换模式
            const sepInput = await vscode.window.showInputBox({
                prompt: '分隔符（默认空格，留空即空格）',
                value: ' ',
                ignoreFocusOut: true,
            });
            if (sepInput === undefined) return;
            const separator = sepInput === '' ? ' ' : sepInput;

            const lines = text.split(/\r?\n/);
            const segmentedLines = lines.map((line) => {
                if (!line.trim()) return line;
                const words = jieba
                    .cut(line, true)
                    .filter((w) => !/^\s*$/.test(w));
                return words.join(separator);
            });
            const result = segmentedLines.join(editor.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n');

            await editor.edit((editBuilder) => {
                editBuilder.replace(range, result);
            });
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(`jieba 加载或分词失败，已中止：${msg}`);
        }
    }

    /** 输出词频统计表为 CSV 文件（词语、词性、词频），原样统计不转换 */
    private async outputWordFrequencyCsv(
        jieba: JiebaWasmModule,
        text: string,
        sourceUri: vscode.Uri
    ): Promise<void> {
        const freqMap = new Map<string, number>(); // key: "词语\t词性"

        const lines = text.split(/\r?\n/);
        for (const line of lines) {
            if (!line.trim()) continue;
            const tags = jieba.tag(line, true);
            for (const t of tags) {
                if (/^\s*$/.test(t.word)) continue;
                const key = `${t.word}\t${t.tag || '-'}`;
                freqMap.set(key, (freqMap.get(key) ?? 0) + 1);
            }
        }

        const rows = Array.from(freqMap.entries())
            .map(([key, count]) => {
                const [word, tag] = key.split('\t');
                return { word, tag, count };
            })
            .sort((a, b) => b.count - a.count);

        // CSV：词语,词性,词频；对含逗号/换行/双引号的字段加引号并转义
        const escapeCsv = (s: string): string => {
            if (/[,\n"]/.test(s)) {
                return `"${s.replace(/"/g, '""')}"`;
            }
            return s;
        };

        const csvLines: string[] = ['词语,词性,词频'];
        for (const r of rows) {
            csvLines.push(`${escapeCsv(r.word)},${escapeCsv(r.tag || '-')},${r.count}`);
        }

        const csvContent = '\uFEFF' + csvLines.join('\n'); // BOM for Excel UTF-8

        let outputPath: string;
        if (sourceUri.scheme === 'file' && sourceUri.fsPath) {
            outputPath = FilePathUtils.getFilePath(sourceUri.fsPath, '.wordfreq', '.csv');
        } else {
            const defaultUri = vscode.workspace.workspaceFolders?.[0]
                ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, '词频统计.csv')
                : undefined;
            const saved = await vscode.window.showSaveDialog({
                defaultUri,
                filters: { 'CSV': ['csv'] }
            });
            if (!saved) return;
            outputPath = saved.fsPath;
        }

        fs.writeFileSync(outputPath, csvContent, 'utf8');
        vscode.window.showInformationMessage(`词频统计已保存至：${path.basename(outputPath)}`);
    }

    /** 输出字频统计表为 CSV 文件（字符、频度） */
    private async outputCharFrequencyCsv(text: string, sourceUri: vscode.Uri): Promise<void> {
        const freqMap = new Map<string, number>();

        for (const ch of text) {
            if (/\s/.test(ch)) continue; // 忽略空白字符
            freqMap.set(ch, (freqMap.get(ch) ?? 0) + 1);
        }

        const rows = Array.from(freqMap.entries())
            .map(([ch, count]) => ({ ch, count }))
            .sort((a, b) => b.count - a.count);

        const escapeCsv = (s: string): string => {
            if (/[,\n"]/.test(s)) {
                return `"${s.replace(/"/g, '""')}"`;
            }
            return s;
        };

        const csvLines: string[] = ['字符,频度'];
        for (const r of rows) {
            csvLines.push(`${escapeCsv(r.ch)},${r.count}`);
        }

        const csvContent = '\uFEFF' + csvLines.join('\n');

        let outputPath: string;
        if (sourceUri.scheme === 'file' && sourceUri.fsPath) {
            outputPath = FilePathUtils.getFilePath(sourceUri.fsPath, '.charfreq', '.csv');
        } else {
            const defaultUri = vscode.workspace.workspaceFolders?.[0]
                ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, '字频统计.csv')
                : undefined;
            const saved = await vscode.window.showSaveDialog({
                defaultUri,
                filters: { 'CSV': ['csv'] }
            });
            if (!saved) return;
            outputPath = saved.fsPath;
        }

        fs.writeFileSync(outputPath, csvContent, 'utf8');
        vscode.window.showInformationMessage(`字频统计已保存至：${path.basename(outputPath)}`);
    }

    /**
     * 对齐并排两个 Markdown 窗口中指定级别的标题。
     * 默认：当前窗口 + 右侧窗口；无右侧则用左侧；否则提示先并排打开两个 md。
     * 一旦对不齐：在两窗口内跳到差异处，用户处理后可再次运行本命令。
     */
    public async handleAlignHeadingsCommand(
        editor: vscode.TextEditor,
        context: vscode.ExtensionContext
    ): Promise<void> {
        if (!editor) {
            vscode.window.showInformationMessage('No active editor!');
            return;
        }

        try {
            const pair = this.resolveSideBySideMarkdownPair(editor);
            if (!pair) {
                vscode.window.showWarningMessage(
                    '请并排打开两个 Markdown 窗口后再运行「对齐标题」（默认比较当前窗口与右侧，无右侧则与左侧比较）。'
                );
                return;
            }
            const { primary, secondary } = pair;

            const lastLevels =
                context.globalState.get<string>(ALIGN_HEADINGS_LAST_LEVELS_KEY)?.trim() || '1';
            const levelInput = await vscode.window.showInputBox({
                prompt: '请输入要对齐的标题级别（1–6），多个用逗号分隔',
                placeHolder: '例如：1，2，4',
                value: lastLevels,
                ignoreFocusOut: true,
                validateInput: (value) => {
                    const parsed = parseHeadingLevels(value);
                    return 'error' in parsed ? parsed.error : null;
                },
            });
            if (levelInput === undefined) {
                return;
            }
            const parsedLevels = parseHeadingLevels(levelInput);
            if ('error' in parsedLevels) {
                vscode.window.showWarningMessage(parsedLevels.error);
                return;
            }
            const levels = parsedLevels.levels;
            const levelsKey = levels.join('，');
            await context.globalState.update(ALIGN_HEADINGS_LAST_LEVELS_KEY, levelsKey);

            const modePick = await vscode.window.showQuickPick(
                [
                    {
                        label: '有序号则只比较序号，否则比较全文（默认）',
                        description: '两侧都有前部序号时只比序号；否则去空白后比全文',
                        value: 'serialOrFullText' as HeadingAlignMode,
                    },
                    {
                        label: '比较全文',
                        description: '去空白后标题全文须一致',
                        value: 'fullText' as HeadingAlignMode,
                    },
                ],
                {
                    placeHolder: '选择标题比较方式',
                    ignoreFocusOut: true,
                }
            );
            if (!modePick) {
                return;
            }
            const mode = modePick.value;

            const leftText = primary.document.getText();
            const rightText = secondary.document.getText();
            const leftName = path.basename(primary.document.fileName) || primary.document.uri.toString();
            const rightName = path.basename(secondary.document.fileName) || secondary.document.uri.toString();
            const levelsLabel = levels.join('，');

            const result = alignHeadings(leftText, rightText, levels, mode);
            if (result.mismatch) {
                this.revealHeadingMismatchInEditors(primary, secondary, result.mismatch);
                const hint = diagnoseHeadingMismatch(
                    result.left,
                    result.right,
                    result.mismatch,
                    mode
                );
                const detail = this.formatHeadingMismatchMessage(
                    leftName,
                    rightName,
                    levelsLabel,
                    result.mismatch,
                    result.left.length,
                    result.right.length,
                    hint
                );
                vscode.window.showWarningMessage(detail);
                return;
            }

            vscode.window.showInformationMessage(
                `标题已对齐：${leftName} 与 ${rightName}（级别 ${levelsLabel}，共 ${result.left.length} 个，按位置顺序）一致。`
            );
        } catch (error) {
            ErrorUtils.showError(error, '对齐标题时出错：');
        }
    }

    /** 当前窗口 + 右侧 md；无右侧则左侧 md；找不到则 undefined */
    private resolveSideBySideMarkdownPair(
        active: vscode.TextEditor
    ): { primary: vscode.TextEditor; secondary: vscode.TextEditor } | undefined {
        if (!this.isMarkdownEditor(active)) {
            return undefined;
        }
        const activeCol = active.viewColumn;
        if (activeCol === undefined) {
            return undefined;
        }

        const others = vscode.window.visibleTextEditors.filter(
            (e) =>
                e !== active &&
                e.viewColumn !== undefined &&
                e.viewColumn !== activeCol &&
                this.isMarkdownEditor(e)
        );

        const right = others
            .filter((e) => (e.viewColumn as number) > (activeCol as number))
            .sort((a, b) => (a.viewColumn as number) - (b.viewColumn as number))[0];
        if (right) {
            return { primary: active, secondary: right };
        }

        const left = others
            .filter((e) => (e.viewColumn as number) < (activeCol as number))
            .sort((a, b) => (b.viewColumn as number) - (a.viewColumn as number))[0];
        if (left) {
            return { primary: active, secondary: left };
        }

        return undefined;
    }

    private isMarkdownEditor(editor: vscode.TextEditor): boolean {
        if (editor.document.languageId === 'markdown') {
            return true;
        }
        const name = editor.document.fileName || editor.document.uri.fsPath || '';
        return /\.md$/i.test(name);
    }

    private formatHeadingMismatchMessage(
        leftName: string,
        rightName: string,
        levelsLabel: string,
        mismatch: HeadingAlignMismatch,
        leftCount: number,
        rightCount: number,
        hint: HeadingAlignFixHint
    ): string {
        const ord = mismatch.index + 1;
        const clip = (s: string, n = 36) => (s.length > n ? `${s.slice(0, n)}…` : s);
        const fmt = (name: string, h?: { line: number; level: number; text: string }) =>
            h ? `${name} L${h.line}（${h.level}级）${clip(h.text)}` : `${name}（无）`;

        const sideLabel =
            hint.preferSide === 'left'
                ? `当前窗口「${leftName}」`
                : hint.preferSide === 'right'
                  ? `对侧窗口「${rightName}」`
                  : `两侧（当前「${leftName}」/ 对侧「${rightName}」）`;
        const dirLabel =
            hint.direction === 'here' ? '本处' : hint.direction === 'up' ? '往上' : '往下';

        let spot: string;
        switch (mismatch.reason) {
            case 'missingLeft':
                spot = `第 ${ord} 项：当前侧已无标题；对侧为 ${fmt(rightName, mismatch.right)}`;
                break;
            case 'missingRight':
                spot = `第 ${ord} 项：对侧已无标题；当前侧为 ${fmt(leftName, mismatch.left)}`;
                break;
            case 'level':
                spot =
                    `第 ${ord} 项级别不同：\n` +
                    `· ${fmt(leftName, mismatch.left)}\n` +
                    `· ${fmt(rightName, mismatch.right)}`;
                break;
            default:
                spot =
                    `第 ${ord} 项内容不同：\n` +
                    `· ${fmt(leftName, mismatch.left)}\n` +
                    `· ${fmt(rightName, mismatch.right)}`;
                break;
        }

        return (
            `标题未对齐（级别 ${levelsLabel}；当前 ${leftCount} / 对侧 ${rightCount}，按位置）。\n` +
            `${spot}\n` +
            `→ 优先处理：${sideLabel}；查找方向：${dirLabel}\n` +
            `${hint.action}\n` +
            `已跳转到差异行，处理后请再运行「对齐标题」。`
        );
    }

    /** 在已有并排窗口中跳到首个对不齐的标题行 */
    private revealHeadingMismatchInEditors(
        primary: vscode.TextEditor,
        secondary: vscode.TextEditor,
        mismatch: HeadingAlignMismatch
    ): void {
        this.revealHeadingLine(primary, mismatch.left?.line);
        this.revealHeadingLine(secondary, mismatch.right?.line);
    }

    private revealHeadingLine(editor: vscode.TextEditor, line1Based?: number): void {
        if (line1Based === undefined || line1Based < 1) {
            return;
        }
        const line = Math.min(line1Based - 1, editor.document.lineCount - 1);
        const range = editor.document.lineAt(line).range;
        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    }

    /** 对全文分词 */
    public async handleSegmentFileCommand(
        editor: vscode.TextEditor,
        context: vscode.ExtensionContext
    ): Promise<void> {
        const doc = editor.document;
        const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
        await this.runSegment(editor, context, fullRange);
    }

    /** 对选中文本分词 */
    public async handleSegmentSelectionCommand(
        editor: vscode.TextEditor,
        context: vscode.ExtensionContext
    ): Promise<void> {
        if (editor.selection.isEmpty) {
            vscode.window.showInformationMessage('请先选中要分词的文本');
            return;
        }
        await this.runSegment(editor, context, editor.selection);
    }
}
