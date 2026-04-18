/**
 * 文档内重复句视图注册与跳转
 */

import * as vscode from 'vscode';
import { DuplicateTreeDataProvider, type DuplicateTreeNode } from './duplicateTreeProvider';

const VIEW_ID = 'ai-proofread.duplicate';

export interface DuplicateViewRegistration {
    provider: DuplicateTreeDataProvider;
    treeView: vscode.TreeView<DuplicateTreeNode>;
}

export function registerDuplicateView(context: vscode.ExtensionContext): DuplicateViewRegistration {
    const treeDataProvider = new DuplicateTreeDataProvider();
    const treeView = vscode.window.createTreeView(VIEW_ID, {
        treeDataProvider,
        showCollapseAll: true
    });

    context.subscriptions.push(
        treeView,
        treeView.onDidChangeSelection((e) => {
            const node = e.selection[0];
            if (!node || node.kind !== 'occurrence') return;
            const docUri = treeDataProvider.getDocumentUri();
            if (!docUri) return;
            const occ = treeDataProvider.getOccurrence(node);
            const base = treeDataProvider.getOffsetBase();
            vscode.workspace.openTextDocument(docUri).then((doc) => {
                vscode.window.showTextDocument(doc, { preserveFocus: true, preview: false }).then((editor) => {
                    const start = doc.positionAt(base + occ.startOffset);
                    const end = doc.positionAt(base + occ.endOffset);
                    const range = new vscode.Range(start, end);
                    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                    editor.selection = new vscode.Selection(start, end);
                });
            });
        })
    );

    return { provider: treeDataProvider, treeView };
}

export async function focusDuplicateView(): Promise<void> {
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
}
