/**
 * 标题层级与连续性检查：TreeView 注册与选中回调
 * 规划见 docs/numbering-hierarchy-check-plan.md
 */

import * as vscode from 'vscode';
import type { NumberingNode } from './types';
import { NumberingTreeDataProvider } from './numberingTreeProvider';

export const VIEW_ID = 'ai-proofread.numbering';

export interface NumberingViewRegistration {
    provider: NumberingTreeDataProvider;
    treeView: vscode.TreeView<NumberingNode>;
}

export function registerNumberingView(
    context: vscode.ExtensionContext,
    provider: NumberingTreeDataProvider
): NumberingViewRegistration {
    const treeView = vscode.window.createTreeView(VIEW_ID, {
        treeDataProvider: provider,
        showCollapseAll: true,
    });

    context.subscriptions.push(
        treeView,
        treeView.onDidChangeSelection((e) => {
            const node = e.selection[0];
            if (!node) return;
            handleSelectNode(node, provider);
        })
    );

    return { provider, treeView };
}

function handleSelectNode(node: NumberingNode, provider: NumberingTreeDataProvider): void {
    const docUri = provider.getDocumentUri();
    if (!docUri || !node.range) return;
    vscode.window.showTextDocument(docUri, { preserveFocus: true }).then((editor) => {
        const range = new vscode.Range(node.range!.start.line, 0, node.range!.end.line, node.lineText.length);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        editor.selection = new vscode.Selection(range.start, range.end);
    });
}

export async function focusNumberingView(): Promise<void> {
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
}
