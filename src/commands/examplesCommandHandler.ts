/**
 * 校对示例命令处理器
 * edit Proofreading examples: 在 diff 编辑器中编辑 input/output 对，保存时追加到 .proofread/examples.md
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TempFileManager, FilePathUtils, ErrorUtils, normalizeLineEndings } from '../utils';
import { splitChineseSentencesSimple } from '../splitter';

const EXAMPLES_HEADER = `## 校对示例

与项目相关的校对示例，供参考。每个 example 块的格式为：<example><input>原文</input><output>校对后</output></example>

`;

interface ExampleEditPair {
    leftUri: vscode.Uri;
    rightUri: vscode.Uri;
    examplesPath: string;
}

export class ExamplesCommandHandler {
    private exampleEditPairs = new Map<string, ExampleEditPair>();
    private saveListener: vscode.Disposable | undefined;

    constructor(private context: vscode.ExtensionContext) {
        this.registerSaveListener();
    }

    private registerSaveListener(): void {
        this.saveListener = vscode.workspace.onDidSaveTextDocument((doc) => {
            this.handleExampleEditSave(doc);
        });
        this.context.subscriptions.push(this.saveListener);
    }

    /**
     * 检测当前活动 tab 是否为 diff 编辑器
     */
    private isDiffEditorActive(): vscode.TabInputTextDiff | undefined {
        const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
        const input = tab?.input;
        if (input && typeof input === 'object' && 'original' in input && 'modified' in input) {
            return input as vscode.TabInputTextDiff;
        }
        return undefined;
    }

    /**
     * 获取用于确定 examples 路径的锚点 URI
     */
    private getAnchorUri(): vscode.Uri | undefined {
        const editor = vscode.window.activeTextEditor;
        const diffInput = this.isDiffEditorActive();
        if (diffInput) {
            return diffInput.original;
        }
        return editor?.document.uri;
    }

    /**
     * 获取 examples.md 路径
     */
    private getExamplesPath(): string | undefined {
        const anchor = this.getAnchorUri();
        if (!anchor) {
            const folders = vscode.workspace.workspaceFolders;
            if (folders && folders.length > 0) {
                return path.join(folders[0].uri.fsPath, '.proofread', 'examples.md');
            }
            return undefined;
        }
        return FilePathUtils.getExamplesPath(anchor);
    }

    /**
     * 切分文档（或选中部分）为句子，用指定数量的换行符连接
     * 用户可自行调用，用于在 edit Proofreading examples 的 diff 中预处理文本
     */
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
        const separator = (!isNaN(num) && num >= 1 && num <= 10)
            ? '\n'.repeat(num)
            : trimmed;

        const text = editor.selection.isEmpty
            ? editor.document.getText()
            : editor.document.getText(editor.selection);

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

        const separatorDesc = (!isNaN(num) && num >= 1 && num <= 10)
            ? `${num} 个换行符`
            : `自定义分隔符「${separator.replace(/\n/g, '\\n')}」`;
        vscode.window.showInformationMessage(`已按句子切分，共 ${sentences.length} 句，用 ${separatorDesc} 连接`);
    }

    /**
     * 处理 edit Proofreading examples 命令
     */
    public async handleEditProofreadingExamplesCommand(): Promise<void> {
        const diffInput = this.isDiffEditorActive();
        const examplesPath = this.getExamplesPath();
        if (!examplesPath) {
            vscode.window.showErrorMessage('无法确定工作区，请先打开一个文件或工作区。');
            return;
        }

        try {
            const tempFileManager = TempFileManager.getInstance(this.context);
            let leftUri: vscode.Uri;
            let rightUri: vscode.Uri;

            if (diffInput) {
                const originalDoc = await vscode.workspace.openTextDocument(diffInput.original);
                const modifiedDoc = await vscode.workspace.openTextDocument(diffInput.modified);
                const leftContent = originalDoc.getText();
                const rightContent = modifiedDoc.getText();
                leftUri = await tempFileManager.createTempFile(leftContent, '.md');
                rightUri = await tempFileManager.createTempFile(rightContent, '.md');
            } else {
                const editor = vscode.window.activeTextEditor;
                const content = editor?.document.getText(editor.selection) ?? '';
                leftUri = await tempFileManager.createTempFile(content, '.md');
                rightUri = await tempFileManager.createTempFile(content, '.md');
            }

            this.registerExampleEditPair(leftUri, rightUri, examplesPath);
            await vscode.commands.executeCommand(
                'vscode.diff',
                leftUri,
                rightUri,
                'Proofreading Examples',
                { preview: false }
            );
            // 关闭可能被额外打开的临时文件标签页（仅保留 diff 视图）
            await this.closeTabsWithUris([leftUri, rightUri]);
        } catch (error) {
            ErrorUtils.showError(error, '打开校对示例编辑器时出错：');
        }
    }

    /**
     * 关闭与指定 URI 匹配的单独标签页（diff 视图中的左右侧不会作为单独标签页，但有时会被额外打开）
     */
    private async closeTabsWithUris(uris: vscode.Uri[]): Promise<void> {
        const uriStrings = new Set(uris.map(u => u.toString()));
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                const input = tab.input;
                if (input && typeof input === 'object' && 'uri' in input && !('original' in input)) {
                    const tabUri = (input as { uri: vscode.Uri }).uri;
                    if (uriStrings.has(tabUri.toString())) {
                        await vscode.window.tabGroups.close(tab);
                    }
                }
            }
        }
    }

    private registerExampleEditPair(leftUri: vscode.Uri, rightUri: vscode.Uri, examplesPath: string): void {
        const pair: ExampleEditPair = { leftUri, rightUri, examplesPath };
        this.exampleEditPairs.set(leftUri.toString(), pair);
        this.exampleEditPairs.set(rightUri.toString(), pair);
    }

    /**
     * 按分隔符切分文本（忽略首尾空白）
     * @param text 原文
     * @param separator 分隔符：数字表示换行符个数，否则为自定义字符串
     */
    private splitBySeparator(text: string, separator: number | string): string[] {
        const normalized = normalizeLineEndings(text);
        const trimmed = normalized.trim();
        if (!trimmed) return [];
        const parts = typeof separator === 'number'
            ? trimmed.split(new RegExp(`\\n{${separator},}`))
            : trimmed.split(separator);
        return parts.map(s => s.trim()).filter(s => s.length > 0);
    }

    private async handleExampleEditSave(doc: vscode.TextDocument): Promise<void> {
        const pair = this.exampleEditPairs.get(doc.uri.toString());
        if (!pair) {
            return;
        }

        // 不删除 pair，允许用户多次保存

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
        const separator: number | string = (!isNaN(num) && num >= 1 && num <= 10)
            ? num
            : trimmed;

        try {
            const leftDoc = await vscode.workspace.openTextDocument(pair.leftUri);
            const rightDoc = await vscode.workspace.openTextDocument(pair.rightUri);
            const textA = leftDoc.getText();
            const textB = rightDoc.getText();

            const partsA = this.splitBySeparator(textA, separator);
            const partsB = this.splitBySeparator(textB, separator);

            if (partsA.length !== partsB.length) {
                vscode.window.showErrorMessage(
                    `两侧条目数量不一致：左侧 ${partsA.length} 条，右侧 ${partsB.length} 条。请确保使用相同的分隔符切分后再保存。`
                );
                return;
            }

            const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

            // 一一对齐，忽略两侧相同的条目
            const allExamples = partsA
                .map((a, i) => ({ a, b: partsB[i] }))
                .filter(({ a, b }) => a !== b && a.trim() !== '' && b.trim() !== '')
                .map(({ a, b }) => `<example><input>${escape(a)}</input><output>${escape(b)}</output></example>`);

            if (allExamples.length === 0) {
                vscode.window.showInformationMessage('未发现需要添加的校对示例（两侧内容相同或为空）。');
                return;
            }

            const examplesDir = path.dirname(pair.examplesPath);
            FilePathUtils.ensureDirExists(examplesDir);

            const isNewFile = !fs.existsSync(pair.examplesPath);
            const existingContent = isNewFile ? '' : fs.readFileSync(pair.examplesPath, 'utf8');

            // 过滤掉已在原文件中存在的完全相同的条目
            const examplesToAdd = allExamples.filter(ex => !existingContent.includes(ex));

            if (examplesToAdd.length === 0) {
                vscode.window.showInformationMessage('所有待添加的示例已存在于 examples.md 中。');
                return;
            }

            const contentToAppend = isNewFile
                ? EXAMPLES_HEADER + examplesToAdd.join('\n\n') + '\n\n'
                : examplesToAdd.join('\n\n') + '\n\n';

            fs.appendFileSync(pair.examplesPath, contentToAppend, 'utf8');

            const docToOpen = await vscode.workspace.openTextDocument(pair.examplesPath);
            await vscode.window.showTextDocument(docToOpen);

            // 关闭可能被保存操作带出的临时文件标签页，仅保留 examples.md
            await this.closeTabsWithUris([pair.leftUri, pair.rightUri]);

            const skipped = allExamples.length - examplesToAdd.length;
            const msg = skipped > 0
                ? `已添加 ${examplesToAdd.length} 条校对示例到 examples.md（${skipped} 条已存在已跳过）`
                : `已添加 ${examplesToAdd.length} 条校对示例到 examples.md`;
            vscode.window.showInformationMessage(msg);
        } catch (error) {
            ErrorUtils.showError(error, '处理校对示例时出错：');
        }
    }

    /**
     * 获取 examples.md 路径，供 proofread selection with examples 使用
     */
    public getExamplesPathForProofread(): string | undefined {
        return this.getExamplesPath();
    }
}
