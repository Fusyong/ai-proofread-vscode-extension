/**
 * 引文核对视图注册与交互
 * 计划见 docs/citation-verification-plan.md 阶段 4、5
 * 换行符：文档位置用 raw，查找/比较用 normalizeLineEndings(raw)，再用 normIndexToRawIndex 映射回 raw 索引。
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { CitationTreeDataProvider } from './citationTreeProvider';
import type { CitationTreeNode } from './citationTreeProvider';
import { ReferenceStore } from './referenceStore';
import { normalizeLineEndings } from '../utils';

const VIEW_ID = 'ai-proofread.citation';

export interface CitationViewRegistration {
    provider: CitationTreeDataProvider;
    treeView: vscode.TreeView<CitationTreeNode>;
}

export function registerCitationView(context: vscode.ExtensionContext): CitationViewRegistration {
    const treeDataProvider = new CitationTreeDataProvider();
    const treeView = vscode.window.createTreeView(VIEW_ID, {
        treeDataProvider,
        showCollapseAll: true
    });
    const refStore = ReferenceStore.getInstance(context);

    context.subscriptions.push(
        treeView,
        treeView.onDidChangeSelection((e) => {
            const node = e.selection[0];
            treeDataProvider.setLastSelectedMatchNode(
                node && node.kind === 'match' ? node : null
            );
            if (!node) return;
            handleSelectNode(node, treeDataProvider, refStore);
        })
    );

    return { provider: treeDataProvider, treeView };
}

function handleSelectNode(
    node: CitationTreeNode,
    provider: CitationTreeDataProvider,
    refStore: ReferenceStore
): void {
    const docUri = provider.getDocumentUri();
    const opts = { preserveFocus: true };
    if (node.kind === 'block') {
        if (docUri && node.data.block.entry.range) {
            vscode.window.showTextDocument(docUri, { selection: node.data.block.entry.range, ...opts }).then(
                (editor) => editor.revealRange(node.data.block.entry.range!, vscode.TextEditorRevealType.InCenter)
            );
        }
        return;
    }
    if (node.kind === 'match') {
        const match = node.data;
        const root = refStore.getReferencesRoot();
        const refPath = root && !path.isAbsolute(match.file_path)
            ? path.join(root, match.file_path)
            : match.file_path;
        const uri = vscode.Uri.file(refPath);
        vscode.workspace.openTextDocument(uri).then(
            (doc) => vscode.window.showTextDocument(doc, opts).then(
                (editor) => {
                    const first = match.refFragment[0];
                    const last = match.refFragment.length > 0 ? match.refFragment[match.refFragment.length - 1] : first;
                    const startLine = first?.start_line;
                    const endLine = last?.end_line;
                    if (typeof startLine === 'number' && typeof endLine === 'number' && startLine >= 1 && endLine >= startLine) {
                        const range = new vscode.Range(startLine - 1, 0, endLine, 0);
                        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                        editor.selection = new vscode.Selection(range.start, range.end);
                        return;
                    }
                    const raw = doc.getText();
                    const norm = normalizeLineEndings(raw);
                    const firstContent = first?.content ?? '';
                    const lastContent = last?.content ?? firstContent;
                    const firstNorm = normalizeLineEndings(firstContent);
                    const lastNorm = normalizeLineEndings(lastContent);
                    const idxFirst = norm.indexOf(firstNorm);
                    if (idxFirst < 0) {
                        editor.revealRange(new vscode.Range(0, 0, 0, 0), vscode.TextEditorRevealType.InCenter);
                        return;
                    }
                    const searchStart = idxFirst + firstNorm.length;
                    const idxLastFound = lastNorm === firstNorm
                        ? idxFirst
                        : norm.indexOf(lastNorm, searchStart);
                    const endNorm = idxLastFound >= 0 ? idxLastFound + lastNorm.length : idxFirst + firstNorm.length;
                    const rawStart = normIndexToRawIndex(raw, idxFirst);
                    const rawEnd = normIndexToRawIndex(raw, endNorm);
                    const pos = doc.positionAt(rawStart);
                    const endPos = doc.positionAt(Math.min(rawEnd, raw.length));
                    const range = new vscode.Range(pos, endPos);
                    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                    editor.selection = new vscode.Selection(pos, endPos);
                }
            )
        );
    }
}

/** 将「规范化字符串」（normalizeLineEndings 后）中的字符索引映射回原始字符串中的字符索引 */
function normIndexToRawIndex(raw: string, normIndex: number): number {
    let rawIdx = 0;
    let normIdx = 0;
    while (normIdx < normIndex && rawIdx < raw.length) {
        if (raw[rawIdx] === '\r' && raw[rawIdx + 1] === '\n') rawIdx++;
        rawIdx++;
        normIdx++;
    }
    return rawIdx;
}

/** 聚焦引文核对视图 */
export async function focusCitationView(): Promise<void> {
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
}
