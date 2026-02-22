/**
 * 标题层级与连续性检查：命令入口
 * 规划见 docs/numbering-hierarchy-check-plan.md
 */

import * as vscode from 'vscode';
import type { NumberingTreeDataProvider } from '../numbering/numberingTreeProvider';
import type { SegmentTreeDataProvider } from '../numbering/segmentTreeProvider';
import type { NumberingNode } from '../numbering/types';
import { parseDocument, parseDocumentBySegments } from '../numbering/documentParser';
import { checkHierarchy } from '../numbering/hierarchyChecker';
import { focusNumberingView } from '../numbering/numberingView';
import { focusSegmentView } from '../numbering/segmentView';
import {
    parseLine,
    toTitleLine,
    promoteLine,
    demoteLine,
} from '../numbering/lineEditor';
import type { CustomLevelConfig } from '../numbering/hierarchySchema';
import { clearLevelsCache } from '../numbering/hierarchySchema';

/** 从树中查找目标节点的同级兄弟（含自身） */
function getSiblings(roots: NumberingNode[], target: NumberingNode): NumberingNode[] {
    function walk(node: NumberingNode, parent: NumberingNode | null): NumberingNode[] | null {
        if (node === target) {
            return parent ? parent.children : roots;
        }
        for (const child of node.children) {
            const found = walk(child, node);
            if (found) return found;
        }
        return null;
    }
    for (const root of roots) {
        const siblings = walk(root, null);
        if (siblings) return siblings;
    }
    return [];
}

export class NumberingCheckCommandHandler {
    constructor(
        private context: vscode.ExtensionContext,
        private provider: NumberingTreeDataProvider,
        private treeView: vscode.TreeView<NumberingNode>,
        private segmentProvider?: SegmentTreeDataProvider,
        private segmentTreeView?: vscode.TreeView<import('../numbering/segmentTreeProvider').SegmentTreeElement>
    ) {}

    async handleCheckCommand(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('请先打开要检查的文档。');
            return;
        }

        const doc = editor.document;
        const langId = doc.languageId;
        if (langId !== 'markdown' && langId !== 'text' && langId !== 'plaintext') {
            vscode.window.showWarningMessage('序号检查支持 Markdown 和纯文本文档。');
            return;
        }

        const config = vscode.workspace.getConfiguration('ai-proofread.numbering');
        const ignoreMarkdownPrefix = config.get<boolean>('ignoreMarkdownPrefix', true);

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: '标题层级检查',
                cancellable: false,
            },
            async () => {
                const roots = parseDocument(doc.getText(), {
                    ignoreMarkdownPrefix,
                    checkScope: 'both',
                });
                const issues = checkHierarchy(roots);

                this.provider.refresh(roots, issues, doc.uri);
                this.updateTreeTitle();
                await focusNumberingView();
                setTimeout(() => this.provider.refresh(roots, issues, doc.uri), 100);
            }
        );
    }

    private updateTreeTitle(): void {
        const roots = this.provider.getRoots();
        const issues = this.provider.getIssues();
        const { levelHeight, emptyLevelCount } = this.computeLevelStats(roots);
        this.treeView.title = `标题树(高${levelHeight},空${emptyLevelCount},问题${issues.length})`;
    }

    private computeLevelStats(roots: NumberingNode[]): { levelHeight: number; emptyLevelCount: number } {
        const used = new Set<number>();
        function walk(n: NumberingNode) {
            used.add(n.assignedLevel);
            for (const c of n.children) walk(c);
        }
        for (const r of roots) walk(r);
        if (used.size === 0) return { levelHeight: 0, emptyLevelCount: 0 };
        const levels = [...used].sort((a, b) => a - b);
        const min = levels[0];
        const max = levels[levels.length - 1];
        const span = max - min + 1;
        return { levelHeight: max + 1, emptyLevelCount: span - used.size };
    }

    handleToggleSimplifiedLevelCommand(): void {
        const next = !this.provider.getUseSimplifiedLevel();
        this.provider.setUseSimplifiedLevel(next);
    }

    handleSegmentToggleSimplifiedLevelCommand(): void {
        if (!this.segmentProvider) return;
        const next = !this.segmentProvider.getUseSimplifiedLevel();
        this.segmentProvider.setUseSimplifiedLevel(next);
    }

    async handleDefineTitleCommand(): Promise<void> {
        const levelStr = await vscode.window.showInputBox({
            title: '定义标题',
            prompt: '输入层级（1–8，数字）',
            placeHolder: '1',
            validateInput: (v) => {
                const n = parseInt(v, 10);
                if (isNaN(n) || n < 1 || n > 8) return '请输入 1–8 的整数';
                return '';
            },
        });
        if (levelStr == null) return;
        const level = parseInt(levelStr, 10);

        const pattern = await vscode.window.showInputBox({
            title: '定义标题',
            prompt: '输入正则表达式（匹配时忽略原文中的空白字符）',
            placeHolder: '第(\\d+)章',
            validateInput: (v) => {
                if (!v.trim()) return '请输入正则';
                try {
                    const m = v.match(/^\/(.*)\/([gimsuy]*)$/);
                    if (m) new RegExp(m[1], m[2] || undefined);
                    else new RegExp(v);
                    return '';
                } catch {
                    return '正则表达式无效';
                }
            },
        });
        if (pattern == null || !pattern.trim()) return;

        const name = await vscode.window.showInputBox({
            title: '定义标题',
            prompt: '输入名称（用于显示）',
            placeHolder: '第章',
        });
        if (name == null || !name.trim()) return;

        const config = vscode.workspace.getConfiguration('ai-proofread.numbering');
        const customLevels = config.get<CustomLevelConfig[]>('customLevels', []);
        const next: CustomLevelConfig = { level, pattern: pattern.trim(), name: name.trim() };
        await config.update('customLevels', [...customLevels, next], vscode.ConfigurationTarget.Global);
        clearLevelsCache();
        vscode.window.showInformationMessage(`已添加自定义标题：${name}（层级 ${level}）`);
    }

    async handleDefineSegmentPatternCommand(): Promise<void> {
        const pattern = await vscode.window.showInputBox({
            title: '定义段内序号',
            prompt: '输入正则表达式（需用捕获组包住序号部分，支持一行多匹配）',
            placeHolder: '([一二三四五六七八九十]+)、',
            validateInput: (v) => {
                if (!v.trim()) return '请输入正则';
                try {
                    const m = v.match(/^\/(.*)\/([gimsuy]*)$/);
                    if (m) new RegExp(m[1], (m[2] || '') + 'g');
                    else new RegExp(v);
                    return '';
                } catch {
                    return '正则表达式无效';
                }
            },
        });
        if (pattern == null || !pattern.trim()) return;

        const name = await vscode.window.showInputBox({
            title: '定义段内序号',
            prompt: '输入名称（用于显示，可选）',
            placeHolder: '一、二、三、',
        });
        if (name == null) return;

        const sequenceType = await vscode.window.showQuickPick(
            [
                { label: 'arabic', description: '阿拉伯数字' },
                { label: 'chinese-lower', description: '中文小写' },
                { label: 'chinese-upper', description: '中文大写' },
                { label: 'roman-upper', description: '罗马大写' },
                { label: 'roman-lower', description: '罗马小写' },
                { label: 'latin-upper', description: '拉丁大写' },
                { label: 'latin-lower', description: '拉丁小写' },
                { label: 'circled', description: '带圈数字' },
            ],
            { title: '选择序号类型（用于数值解析）', placeHolder: 'chinese-lower' }
        );
        if (sequenceType == null) return;

        const config = vscode.workspace.getConfiguration('ai-proofread.numbering');
        const customInlinePatterns = config.get<{ pattern?: string; name?: string; sequenceType?: string }[]>('customInlinePatterns', []);
        const next = { pattern: pattern.trim(), name: name.trim() || undefined, sequenceType: sequenceType.label };
        await config.update('customInlinePatterns', [...customInlinePatterns, next], vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`已添加段内序号：${next.name || next.pattern}`);
    }

    async handleSegmentCheckCommand(): Promise<void> {
        const sp = this.segmentProvider;
        const stv = this.segmentTreeView;
        if (!sp || !stv) return;
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('请先打开要检查的文档。');
            return;
        }
        const doc = editor.document;
        const langId = doc.languageId;
        if (langId !== 'markdown' && langId !== 'text' && langId !== 'plaintext') {
            vscode.window.showWarningMessage('序号检查支持 Markdown 和纯文本文档。');
            return;
        }
        const config = vscode.workspace.getConfiguration('ai-proofread.numbering');
        const ignoreMarkdownPrefix = config.get<boolean>('ignoreMarkdownPrefix', true);

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: '段内序号检查',
                cancellable: false,
            },
            async () => {
                const segments = parseDocumentBySegments(doc.getText(), { ignoreMarkdownPrefix });
                const allIssues: import('../numbering/types').CheckIssue[] = [];
                for (const seg of segments) {
                    const issues = checkHierarchy(seg.children);
                    allIssues.push(...issues);
                }
                sp.refresh(segments, allIssues, doc.uri);
                stv.title = `段内序号 (${segments.length} 段, ${allIssues.length} 个问题)`;
                await focusSegmentView();
                setTimeout(() => sp.refresh(segments, allIssues, doc.uri), 100);
            }
        );
    }

    async handleRevealCommand(node?: NumberingNode): Promise<void> {
        const target = node ?? this.getSelectedNode();
        if (!target) {
            vscode.window.showInformationMessage('请先在树视图中选中一个节点。');
            return;
        }
        const docUri = this.provider.getDocumentUri();
        if (!docUri || !target.range) return;
        const editor = await vscode.window.showTextDocument(docUri, { preserveFocus: true });
        const range = new vscode.Range(
            target.range.start.line,
            0,
            target.range.end.line,
            target.lineText.length
        );
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        editor.selection = new vscode.Selection(range.start, range.end);
    }

    private getSelectedNode(): NumberingNode | undefined {
        return this.treeView.selection[0];
    }

    private async applyLineEdits(
        nodes: NumberingNode[],
        transform: (line: string, node: NumberingNode) => string | null
    ): Promise<boolean> {
        const docUri = this.provider.getDocumentUri();
        if (!docUri) return false;
        const editor = await vscode.window.showTextDocument(docUri);
        const doc = editor.document;

        const edits: { lineIndex: number; newText: string }[] = [];
        for (const node of nodes) {
            if (!node.range) continue;
            const lineIndex = node.range.start.line;
            const line = doc.lineAt(lineIndex).text;
            const newText = transform(line, node);
            if (newText != null && newText !== line) {
                edits.push({ lineIndex, newText });
            }
        }
        if (edits.length === 0) {
            vscode.window.showInformationMessage('无需修改。');
            return false;
        }

        return editor.edit((editBuilder) => {
            for (const { lineIndex, newText } of edits) {
                const line = doc.lineAt(lineIndex);
                editBuilder.replace(line.range, newText);
            }
        });
    }

    async handleMarkAsTitleCommand(node?: NumberingNode): Promise<void> {
        const target = node ?? this.getSelectedNode();
        if (!target) {
            vscode.window.showInformationMessage('请先在树视图中选中一个节点。');
            return;
        }
        if (target.category !== 'heading') {
            vscode.window.showWarningMessage('「标记为标题」仅适用于标题序号。');
            return;
        }
        const roots = this.provider.getRoots();
        const siblings = getSiblings(roots, target);
        const applied = await this.applyLineEdits(siblings, (line, node) => {
            const parsed = parseLine(line);
            return toTitleLine(parsed, node.assignedLevel);
        });
        if (applied) {
            await this.handleCheckCommand();
        }
    }

    async handlePromoteCommand(node?: NumberingNode): Promise<void> {
        const target = node ?? this.getSelectedNode();
        if (!target) {
            vscode.window.showInformationMessage('请先在树视图中选中一个节点。');
            return;
        }
        if (target.category !== 'heading') {
            vscode.window.showWarningMessage('「升级」仅适用于标题序号。');
            return;
        }
        const roots = this.provider.getRoots();
        const siblings = getSiblings(roots, target);
        const applied = await this.applyLineEdits(siblings, (line) => promoteLine(parseLine(line)));
        if (applied) {
            await this.handleCheckCommand();
        }
    }

    async handleDemoteCommand(node?: NumberingNode): Promise<void> {
        const target = node ?? this.getSelectedNode();
        if (!target) {
            vscode.window.showInformationMessage('请先在树视图中选中一个节点。');
            return;
        }
        if (target.category !== 'heading') {
            vscode.window.showWarningMessage('「降级」仅适用于标题序号。');
            return;
        }
        const roots = this.provider.getRoots();
        const siblings = getSiblings(roots, target);
        const applied = await this.applyLineEdits(siblings, (line) => demoteLine(parseLine(line)));
        if (applied) {
            await this.handleCheckCommand();
        }
    }
}
