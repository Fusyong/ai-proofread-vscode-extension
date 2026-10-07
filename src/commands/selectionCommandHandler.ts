/**
 * 选区命令矩阵（方案 A）：编辑/转换 × 无记忆/带记忆；AlignmentKind hard 校验。
 * 实现复用既有校对选区 / 翻译选区+记忆路径。
 */

import * as vscode from 'vscode';
import { assertAlignmentMatchesEntry, type AlignmentKind } from '../promptAlignment';
import { PromptManager } from '../promptManager';
import type { ProofreadCommandHandler } from './proofreadCommandHandler';
import type { TranslateCommandHandler } from './translateCommandHandler';

export class SelectionCommandHandler {
    constructor(
        private proofreadHandler: ProofreadCommandHandler,
        private translateHandler: TranslateCommandHandler
    ) {}

    private async requireKind(
        context: vscode.ExtensionContext,
        kind: AlignmentKind
    ): Promise<boolean> {
        return assertAlignmentMatchesEntry(context, kind);
    }

    private async withEditor(
        run: (editor: vscode.TextEditor) => Promise<void>
    ): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage('请先打开文档并选中文本。');
            return;
        }
        await run(editor);
    }

    /** 编辑选区（无记忆） */
    public async handleEditSelection(context: vscode.ExtensionContext): Promise<void> {
        if (!(await this.requireKind(context, 'edit'))) {
            return;
        }
        await this.withEditor((editor) =>
            this.proofreadHandler.handleProofreadSelectionCommand(editor, context)
        );
    }

    /** 转换选区（无记忆）：走转换选区+记忆管线但不强制记忆时仍可先激活 convert 提示词；无独立无记忆转换时复用 TM 选区并允许空记忆 */
    public async handleConvertSelection(context: vscode.ExtensionContext): Promise<void> {
        if (!(await this.requireKind(context, 'convert'))) {
            return;
        }
        // 无记忆转换：复用翻译选区路径（注入 TM 可为空）；用户也可只用过程输出
        await this.withEditor((editor) =>
            this.translateHandler.handleTranslateSelectionWithMemory(editor, context)
        );
    }

    /** 编辑选区（带记忆 · 实验） */
    public async handleEditSelectionWithMemory(context: vscode.ExtensionContext): Promise<void> {
        if (!(await this.requireKind(context, 'edit'))) {
            return;
        }
        await this.withEditor((editor) =>
            this.proofreadHandler.handleProofreadSelectionWithMemoryCommand(editor, context)
        );
    }

    /** 转换选区（带记忆 · 实验） */
    public async handleConvertSelectionWithMemory(context: vscode.ExtensionContext): Promise<void> {
        if (!(await this.requireKind(context, 'convert'))) {
            return;
        }
        const pm = PromptManager.getInstance(context);
        await pm.activatePromptForTask('translate');
        if (!(await this.requireKind(context, 'convert'))) {
            return;
        }
        await this.withEditor((editor) =>
            this.translateHandler.handleTranslateSelectionWithMemory(editor, context)
        );
    }
}
