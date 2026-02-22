/**
 * 段内序号：TreeView 注册与选中回调
 */

import * as vscode from 'vscode';
import type { SegmentNode, NumberingNode } from './types';
import type { SegmentTreeDataProvider, SegmentTreeElement } from './segmentTreeProvider';

export const SEGMENT_VIEW_ID = 'ai-proofread.numberingSegments';

export function registerSegmentView(
    context: vscode.ExtensionContext,
    provider: SegmentTreeDataProvider
): { provider: SegmentTreeDataProvider; treeView: vscode.TreeView<SegmentTreeElement> } {
    const treeView = vscode.window.createTreeView(SEGMENT_VIEW_ID, {
        treeDataProvider: provider,
        showCollapseAll: true,
    });

    context.subscriptions.push(
        treeView,
        treeView.onDidChangeSelection((e) => {
            const el = e.selection[0];
            if (!el) return;
            handleSelectElement(el, provider);
        })
    );

    return { provider, treeView };
}

function handleSelectElement(el: SegmentTreeElement, provider: SegmentTreeDataProvider): void {
    const docUri = provider.getDocumentUri();
    if (!docUri) return;
    if ('segmentIndex' in el) {
        const seg = el as SegmentNode;
        if (seg.range) {
            vscode.window.showTextDocument(docUri, { preserveFocus: true }).then((editor) => {
                editor.revealRange(seg.range!, vscode.TextEditorRevealType.InCenter);
                editor.selection = new vscode.Selection(seg.range!.start, seg.range!.end);
            });
        }
    } else {
        const node = el as NumberingNode;
        if (!node.range) return;
        vscode.window.showTextDocument(docUri, { preserveFocus: true }).then((editor) => {
            const range = new vscode.Range(node.range!.start.line, 0, node.range!.end.line, node.lineText.length);
            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
            editor.selection = new vscode.Selection(range.start, range.end);
        });
    }
}

export async function focusSegmentView(): Promise<void> {
    await vscode.commands.executeCommand(`${SEGMENT_VIEW_ID}.focus`);
}
