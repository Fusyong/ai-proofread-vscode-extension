/**
 * 提示词 TreeView：扁平列表；单选当前、新建、编辑、删除。
 * 叶子标注「编辑|转换」与「并行|串行」，不按 task 分组。
 */

import * as vscode from 'vscode';
import {
    PromptManager,
    SYSTEM_PROMPT_NAME_FULL,
    SYSTEM_PROMPT_NAME_ITEM,
    SYSTEM_PROMPT_NAME_NORMALIZATION_FULL,
    SYSTEM_PROMPT_NAME_NORMALIZATION_ITEM,
    SYSTEM_PROMPT_NAME_HARD_ISSUE_ITEM,
    SYSTEM_PROMPT_NAME_CORRESPONDENCE_CHECK_ITEM,
    SYSTEM_PROMPT_NAME_PINYIN_PROOFREAD_FULL,
    SYSTEM_PROMPT_NAME_PINYIN_ANNOTATION_FULL,
    SYSTEM_PROMPT_NAME_KNOWLEDGE_VERIFY_ITEM,
    SYSTEM_PROMPT_NAME_KNOWLEDGE_VERIFY_FULL,
    SYSTEM_PROMPT_NAME_PARA_RESTRUCTURE_FULL,
    SYSTEM_PROMPT_NAME_BOOK_TRANSLATE_FULL,
    SYSTEM_PROMPT_NAME_TERM_CHECK_FULL,
} from './promptManager';
import type { Prompt } from './promptManager';
import {
    alignmentKindLabel,
    executionModeLabel,
    resolveAlignmentKind,
    resolveExecutionMode,
} from './promptAlignment';
import { resolvePromptTask, type PromptTask } from './promptTask';

export const PROMPTS_VIEW_ID = 'ai-proofread.prompts';

/** 系统默认（全文）在树中的 id */
const SYSTEM_FULL_ITEM_ID = '__system__';
/** 系统默认（条目式）在树中的 id */
const SYSTEM_ITEM_ITEM_ID = '__system_item__';

type PromptLeaf = {
    kind: 'prompt';
    id: string;
    label: string;
    prompt?: Prompt;
    systemOutputType?: 'full' | 'item';
    task: PromptTask;
};

export type PromptTreeItem = PromptLeaf;

const PRESET_LEAVES: PromptLeaf[] = [
    { kind: 'prompt', id: SYSTEM_FULL_ITEM_ID, label: '系统默认提示词（full）', systemOutputType: 'full', task: 'proofread' },
    { kind: 'prompt', id: SYSTEM_ITEM_ITEM_ID, label: '系统默认提示词（item）', systemOutputType: 'item', task: 'proofread' },
    {
        kind: 'prompt',
        id: SYSTEM_PROMPT_NAME_NORMALIZATION_FULL,
        label: '表述正常化（full）',
        systemOutputType: 'full',
        task: 'proofread',
    },
    {
        kind: 'prompt',
        id: SYSTEM_PROMPT_NAME_NORMALIZATION_ITEM,
        label: '表述正常化（item）',
        systemOutputType: 'item',
        task: 'proofread',
    },
    {
        kind: 'prompt',
        id: SYSTEM_PROMPT_NAME_PARA_RESTRUCTURE_FULL,
        label: '段内重组与重述（full）',
        systemOutputType: 'full',
        task: 'restructure',
    },
    {
        kind: 'prompt',
        id: SYSTEM_PROMPT_NAME_BOOK_TRANSLATE_FULL,
        label: '图书翻译（过程输出）',
        systemOutputType: 'full',
        task: 'translate',
    },
    {
        kind: 'prompt',
        id: SYSTEM_PROMPT_NAME_TERM_CHECK_FULL,
        label: '译名一致核对（full）',
        systemOutputType: 'full',
        task: 'translate',
    },
    {
        kind: 'prompt',
        id: SYSTEM_PROMPT_NAME_KNOWLEDGE_VERIFY_ITEM,
        label: '知识核查（item）',
        systemOutputType: 'item',
        task: 'proofread',
    },
    {
        kind: 'prompt',
        id: SYSTEM_PROMPT_NAME_KNOWLEDGE_VERIFY_FULL,
        label: '知识核查（full）',
        systemOutputType: 'full',
        task: 'proofread',
    },
    {
        kind: 'prompt',
        id: SYSTEM_PROMPT_NAME_HARD_ISSUE_ITEM,
        label: '硬伤发现（item）',
        systemOutputType: 'item',
        task: 'proofread',
    },
    {
        kind: 'prompt',
        id: SYSTEM_PROMPT_NAME_CORRESPONDENCE_CHECK_ITEM,
        label: '对应关系核对（item）',
        systemOutputType: 'item',
        task: 'proofread',
    },
    {
        kind: 'prompt',
        id: SYSTEM_PROMPT_NAME_PINYIN_PROOFREAD_FULL,
        label: '拼音审校（full）',
        systemOutputType: 'full',
        task: 'proofread',
    },
    {
        kind: 'prompt',
        id: SYSTEM_PROMPT_NAME_PINYIN_ANNOTATION_FULL,
        label: '拼音加注（full）',
        systemOutputType: 'full',
        task: 'annotate',
    },
];

function storageNameFromLeafId(id: string): string {
    if (id === SYSTEM_FULL_ITEM_ID) return SYSTEM_PROMPT_NAME_FULL;
    if (id === SYSTEM_ITEM_ITEM_ID) return SYSTEM_PROMPT_NAME_ITEM;
    return id;
}

export class PromptsTreeDataProvider implements vscode.TreeDataProvider<PromptTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<PromptTreeItem | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(
        private context: vscode.ExtensionContext,
        private promptManager: PromptManager
    ) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getChildren(element?: PromptTreeItem): PromptTreeItem[] {
        if (element) {
            return [];
        }
        const userPrompts = this.promptManager.getPrompts().map(
            (p): PromptLeaf => ({
                kind: 'prompt',
                id: p.name,
                label: p.name,
                prompt: p,
                task: resolvePromptTask(p.name),
            })
        );
        return [...PRESET_LEAVES, ...userPrompts];
    }

    getTreeItem(element: PromptTreeItem): vscode.TreeItem {
        const current = this.promptManager.getCurrentPromptName();
        const storage = storageNameFromLeafId(element.id);
        const isCurrent = current === storage;
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.id = element.id;
        const systemLabel =
            element.systemOutputType === 'full' ? '全文' : element.systemOutputType === 'item' ? '条目' : undefined;
        const userOutputLabel =
            element.prompt?.outputType === 'item' ? '条目' : element.prompt?.outputType === 'other' ? '其他' : '全文';
        const outputTypeLabel = systemLabel ?? userOutputLabel;
        const alignLabel = alignmentKindLabel(resolveAlignmentKind(storage));
        const execLabel = executionModeLabel(resolveExecutionMode(storage));
        const execNote = execLabel === '串行' ? '串行·实验' : execLabel;
        const meta = `${outputTypeLabel} · ${alignLabel} · ${execNote}`;
        if (isCurrent) {
            item.description = `★ 当前 · ${meta}`;
            item.iconPath = new vscode.ThemeIcon(
                'pass-filled',
                new vscode.ThemeColor('charts.green')
            );
        } else {
            item.description = meta;
            item.iconPath = new vscode.ThemeIcon('symbol-text');
        }
        item.contextValue = element.prompt ? 'promptUser' : 'promptSystem';
        if (element.prompt?.content) {
            const preview = element.prompt.content.slice(0, 60).replace(/\s+/g, ' ');
            item.tooltip =
                (isCurrent ? '【当前选用】\n' : '') +
                preview +
                (element.prompt.content.length > 60 ? '…' : '') +
                `\n输出类型: ${outputTypeLabel}\n对齐: ${alignLabel}\n调度: ${execNote}`;
        } else {
            item.tooltip =
                (isCurrent ? '【当前选用】\n' : '') +
                `${element.label}\n对齐: ${alignLabel}\n调度: ${execNote}`;
        }
        return item;
    }
}

export interface PromptsViewRegistration {
    provider: PromptsTreeDataProvider;
    treeView: vscode.TreeView<PromptTreeItem>;
}

export function registerPromptsView(
    context: vscode.ExtensionContext,
    promptManager: PromptManager
): PromptsViewRegistration {
    const provider = new PromptsTreeDataProvider(context, promptManager);
    const treeView = vscode.window.createTreeView(PROMPTS_VIEW_ID, {
        treeDataProvider: provider,
        showCollapseAll: false,
        canSelectMany: false,
    });

    context.subscriptions.push(
        treeView,
        treeView.onDidChangeSelection(async (e) => {
            const sel = e.selection[0];
            if (!sel || sel.kind !== 'prompt') return;
            const name = storageNameFromLeafId(sel.id);
            await promptManager.setCurrentPrompt(name);
            provider.refresh();
        })
    );

    return { provider, treeView };
}
