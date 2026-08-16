/**
 * Webview / 侧栏获焦时 activeTextEditor 常为 undefined。
 * 跟踪最近一次有焦点的文本编辑器，供面板按钮使用。
 */

import * as vscode from 'vscode';

let lastActiveTextEditor: vscode.TextEditor | undefined;

function isEditorStillValid(editor: vscode.TextEditor): boolean {
    try {
        // 访问 document 在已关闭时可能抛错；同时核对是否仍在可见/已打开文档中
        const uri = editor.document.uri;
        return (
            vscode.window.visibleTextEditors.some((e) => e === editor || e.document.uri.toString() === uri.toString()) ||
            vscode.workspace.textDocuments.some((d) => d.uri.toString() === uri.toString())
        );
    } catch {
        return false;
    }
}

/** 在 activate 时注册，保持 lastActiveTextEditor 更新 */
export function registerLastActiveTextEditorTracker(context: vscode.ExtensionContext): void {
    if (vscode.window.activeTextEditor) {
        lastActiveTextEditor = vscode.window.activeTextEditor;
    }
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((ed) => {
            if (ed) {
                lastActiveTextEditor = ed;
            }
        })
    );
}

/**
 * 当前可用于「依赖选区/当前文档」操作的编辑器：
 * active → 最近活动 → 任一可见文本编辑器
 */
export function getWorkingTextEditor(): vscode.TextEditor | undefined {
    const active = vscode.window.activeTextEditor;
    if (active) {
        lastActiveTextEditor = active;
        return active;
    }
    if (lastActiveTextEditor && isEditorStillValid(lastActiveTextEditor)) {
        return lastActiveTextEditor;
    }
    const visible =
        vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme !== 'output') ??
        vscode.window.visibleTextEditors[0];
    if (visible) {
        lastActiveTextEditor = visible;
    }
    return visible;
}

/** 取工作编辑器；没有则提示并返回 undefined */
export function requireWorkingTextEditor(message = '请先打开目标文档。'): vscode.TextEditor | undefined {
    const editor = getWorkingTextEditor();
    if (!editor) {
        vscode.window.showWarningMessage(message);
        return undefined;
    }
    return editor;
}

/**
 * 将工作编辑器重新设为活动（供仍读取 activeTextEditor 的命令使用）。
 * 尽量保持原 viewColumn 与选区。
 */
export async function focusWorkingTextEditor(): Promise<vscode.TextEditor | undefined> {
    const editor = getWorkingTextEditor();
    if (!editor) {
        return undefined;
    }
    try {
        return await vscode.window.showTextDocument(editor.document, {
            viewColumn: editor.viewColumn ?? vscode.ViewColumn.One,
            selection: editor.selection,
            preserveFocus: false,
            preview: false,
        });
    } catch {
        return getWorkingTextEditor();
    }
}
