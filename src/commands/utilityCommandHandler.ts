/**
 * 工具命令处理器
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { mergeTwoFiles, mergeMarkdownIntoJson } from '../merger';
import { getJiebaWasm, type JiebaWasmModule } from '../jiebaLoader';
import { searchSelectionInPDF } from '../pdfSearcher';
import { convertQuotes } from '../quoteConverter';
import { formatParagraphs } from '../paragraphDetector';
import { showDiff } from '../differ';
import { ErrorUtils, FilePathUtils, normalizeLineEndings } from '../utils';
import { parseToc, markTitles, TocItem } from '../titleMarker';

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

            let result: { updated: number; total: number };

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

                result = await mergeTwoFiles(
                    document.uri.fsPath,
                    sourceFile[0].fsPath,
                    targetField as 'target' | 'reference' | 'context',
                    sourceField as 'target' | 'reference' | 'context',
                    mergeMode.value as 'update' | 'concat'
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

                result = await mergeMarkdownIntoJson(
                    document.uri.fsPath,
                    sourceFile[0].fsPath,
                    targetField as 'target' | 'reference' | 'context',
                    mergeMode.value as 'update' | 'concat'
                );
            }

            // 显示结果
            const modeText = mergeMode.value === 'update' ? '更新' : '拼接';
            let message = `合并完成！${modeText}了 ${result.updated}/${result.total} 项`;

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

            let result: { updated: number; total: number };

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

                result = await mergeTwoFiles(
                    jsonFilePath, sourceFile[0].fsPath,
                    targetField as 'target' | 'reference' | 'context',
                    sourceField as 'target' | 'reference' | 'context',
                    mergeMode.value as 'update' | 'concat'
                );
            } else {
                const sourceFile = await vscode.window.showOpenDialog({
                    canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
                    filters: { 'Markdown files': ['md', 'markdown'], 'Text files': ['txt'], 'All files': ['*'] },
                    title: '选择 Markdown 文件'
                });
                if (!sourceFile?.length) return;

                result = await mergeMarkdownIntoJson(
                    jsonFilePath, sourceFile[0].fsPath,
                    targetField as 'target' | 'reference' | 'context',
                    mergeMode.value as 'update' | 'concat'
                );
            }

            let message = `合并完成！${mergeMode.value === 'update' ? '更新' : '拼接'}了 ${result.updated}/${result.total} 项`;
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
                prompt: '请输入起始标题级别（1-6，默认为1）',
                placeHolder: '1',
                value: '1',
                validateInput: (value) => {
                    const num = parseInt(value, 10);
                    if (isNaN(num)) {
                        return '请输入有效的数字';
                    }
                    if (num < 1 || num > 6) {
                        return '标题级别必须在 1-6 之间';
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
            const eol = document.eol === vscode.EndOfLineSequence.CrLf ? '\r\n' : '\n';

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
