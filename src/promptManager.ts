/**
 * 提示词管理器模块
 */

import * as vscode from 'vscode';
import {
    alignmentKindFromTask,
    alignmentKindLabel,
    BOOK_TRANSLATE_CONVERT_POLICY,
    DEFAULT_CONVERT_POLICY,
    executionFromTask,
    executionModeLabel,
    normalizeAlignmentKind,
    normalizeConvertPolicy,
    normalizeExecutionMode,
    type AlignmentKind,
    type ConvertAlignPolicy,
    type ExecutionMode,
} from './promptAlignment';
import { normalizePromptTask, resolvePromptTask, type PromptTask } from './promptTask';

export type PromptOutputType = 'full' | 'item' | 'other';
export type { AlignmentKind, ConvertAlignPolicy, ExecutionMode };

/** 当前选中的为「系统默认提示词（full）」时，globalState 中 currentPrompt 的值 */
export const SYSTEM_PROMPT_NAME_FULL = '';
/** 当前选中的为「系统默认提示词（item）」时，globalState 中 currentPrompt 的值 */
export const SYSTEM_PROMPT_NAME_ITEM = '__system_item__';
/** 预置「表述正常化（full）」在 globalState 中的存值 */
export const SYSTEM_PROMPT_NAME_NORMALIZATION_FULL = '__preset_normalization_full__';
/** 预置「表述正常化（item）」在 globalState 中的存值 */
export const SYSTEM_PROMPT_NAME_NORMALIZATION_ITEM = '__preset_normalization_item__';
/** 预置「硬伤发现（item）」在 globalState 中的存值（仅条目输出） */
export const SYSTEM_PROMPT_NAME_HARD_ISSUE_ITEM = '__preset_hard_issue_item__';
/** 预置「对应关系核对（item）」在 globalState 中的存值（仅条目输出） */
export const SYSTEM_PROMPT_NAME_CORRESPONDENCE_CHECK_ITEM = '__preset_correspondence_check_item__';
/** 预置「拼音审校（full）」在 globalState 中的存值 */
export const SYSTEM_PROMPT_NAME_PINYIN_PROOFREAD_FULL = '__preset_pinyin_proofread_full__';
/** 预置「拼音加注（full）」在 globalState 中的存值 */
export const SYSTEM_PROMPT_NAME_PINYIN_ANNOTATION_FULL = '__preset_pinyin_annotation_full__';
/** 预置「知识核查（item）」在 globalState 中的存值 */
export const SYSTEM_PROMPT_NAME_KNOWLEDGE_VERIFY_ITEM = '__preset_knowledge_verify_item__';
/** 预置「知识核查（full）」在 globalState 中的存值 */
export const SYSTEM_PROMPT_NAME_KNOWLEDGE_VERIFY_FULL = '__preset_knowledge_verify_full__';
/** 预置「段内重组与重述（full）」在 globalState 中的存值 */
export const SYSTEM_PROMPT_NAME_PARA_RESTRUCTURE_FULL = '__preset_para_restructure_full__';
/** 预置「图书翻译（过程输出）」在 globalState 中的存值 */
export const SYSTEM_PROMPT_NAME_BOOK_TRANSLATE_FULL = '__preset_book_translate_full__';
/** 预置「译名一致核对（full）」 */
export const SYSTEM_PROMPT_NAME_TERM_CHECK_FULL = '__preset_term_check_full__';

const CURRENT_PROMPT_BY_TASK_KEY = 'currentPromptByTask';

function isReservedPromptStorageName(name: string): boolean {
    return (
        name === SYSTEM_PROMPT_NAME_ITEM ||
        name === SYSTEM_PROMPT_NAME_NORMALIZATION_FULL ||
        name === SYSTEM_PROMPT_NAME_NORMALIZATION_ITEM ||
        name === SYSTEM_PROMPT_NAME_HARD_ISSUE_ITEM ||
        name === SYSTEM_PROMPT_NAME_CORRESPONDENCE_CHECK_ITEM ||
        name === SYSTEM_PROMPT_NAME_PINYIN_PROOFREAD_FULL ||
        name === SYSTEM_PROMPT_NAME_PINYIN_ANNOTATION_FULL ||
        name === SYSTEM_PROMPT_NAME_KNOWLEDGE_VERIFY_ITEM ||
        name === SYSTEM_PROMPT_NAME_KNOWLEDGE_VERIFY_FULL ||
        name === SYSTEM_PROMPT_NAME_PARA_RESTRUCTURE_FULL ||
        name === SYSTEM_PROMPT_NAME_BOOK_TRANSLATE_FULL ||
        name === SYSTEM_PROMPT_NAME_TERM_CHECK_FULL
    );
}

/** 将存值转为显示名称（供无 PromptManager 的调用方使用） */
export function getPromptDisplayName(name: string): string {
    if (name === SYSTEM_PROMPT_NAME_FULL) return '系统默认提示词（full）';
    if (name === SYSTEM_PROMPT_NAME_ITEM) return '系统默认提示词（item）';
    if (name === SYSTEM_PROMPT_NAME_NORMALIZATION_FULL) return '表述正常化（full）';
    if (name === SYSTEM_PROMPT_NAME_NORMALIZATION_ITEM) return '表述正常化（item）';
    if (name === SYSTEM_PROMPT_NAME_HARD_ISSUE_ITEM) return '硬伤发现（item）';
    if (name === SYSTEM_PROMPT_NAME_CORRESPONDENCE_CHECK_ITEM) return '对应关系核对（item）';
    if (name === SYSTEM_PROMPT_NAME_PINYIN_PROOFREAD_FULL) return '拼音审校（full）';
    if (name === SYSTEM_PROMPT_NAME_PINYIN_ANNOTATION_FULL) return '拼音加注（full）';
    if (name === SYSTEM_PROMPT_NAME_KNOWLEDGE_VERIFY_ITEM) return '知识核查（item）';
    if (name === SYSTEM_PROMPT_NAME_KNOWLEDGE_VERIFY_FULL) return '知识核查（full）';
    if (name === SYSTEM_PROMPT_NAME_PARA_RESTRUCTURE_FULL) return '段内重组与重述（full）';
    if (name === SYSTEM_PROMPT_NAME_BOOK_TRANSLATE_FULL) return '图书翻译（过程输出）';
    if (name === SYSTEM_PROMPT_NAME_TERM_CHECK_FULL) return '译名一致核对（full）';
    return name || '系统默认提示词（full）';
}

export interface Prompt {
    name: string;
    content: string;
    outputType?: PromptOutputType;
    /** 业务细项预置标签（内部记忆槽等）；默认 proofread */
    task?: PromptTask;
    /** 对齐语义：编辑 | 转换（与 task/execution 正交） */
    alignmentKind?: AlignmentKind;
    /** 批处理默认调度：并行 | 串行 */
    execution?: ExecutionMode;
    /** 转换类辅助对齐策略（alignmentKind=convert 时有意义） */
    convertPolicy?: ConvertAlignPolicy;
}

export class PromptManager {
    private static instance: PromptManager;
    private context: vscode.ExtensionContext;
    private constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    public static getInstance(context?: vscode.ExtensionContext): PromptManager {
        if (!PromptManager.instance && context) {
            PromptManager.instance = new PromptManager(context);
        }
        return PromptManager.instance;
    }

    /** 供 TreeView 等读取：当前配置中的提示词列表 */
    public getPrompts(): Prompt[] {
        const config = vscode.workspace.getConfiguration('ai-proofread');
        return config.get<Prompt[]>('prompts', []) ?? [];
    }

    /** 当前选中的提示词名称（globalState 存值：内置模板含 '' / '__system_item__' / '__preset_*__'，或自定义 name） */
    public getCurrentPromptName(): string {
        return this.context.globalState.get<string>('currentPrompt', SYSTEM_PROMPT_NAME_FULL) ?? SYSTEM_PROMPT_NAME_FULL;
    }

    /** 当前提示词的显示名称（用于日志、消息等） */
    public getCurrentPromptDisplayName(): string {
        return getPromptDisplayName(this.getCurrentPromptName());
    }

    private getPromptByTaskMap(): Record<string, string> {
        const raw = this.context.globalState.get<Record<string, string>>(CURRENT_PROMPT_BY_TASK_KEY, {});
        return raw && typeof raw === 'object' ? { ...raw } : {};
    }

    /** 某任务上次选用的提示词存值 */
    public getCurrentPromptNameForTask(task: PromptTask): string {
        const map = this.getPromptByTaskMap();
        const hit = map[task];
        if (typeof hit === 'string') {
            return hit;
        }
        return task === 'translate' ? SYSTEM_PROMPT_NAME_BOOK_TRANSLATE_FULL : SYSTEM_PROMPT_NAME_FULL;
    }

    /**
     * 切换到指定业务细项上次选用的提示词（如转换入口）。
     * task 仅为记忆槽键，不表示并行/串行调度。
     */
    public async activatePromptForTask(task: PromptTask): Promise<void> {
        await this.setCurrentPrompt(this.getCurrentPromptNameForTask(task));
    }

    /** 设为当前使用的提示词；并写入 currentPromptByTask */
    public async setCurrentPrompt(name: string): Promise<void> {
        await this.context.globalState.update('currentPrompt', name);
        const task = resolvePromptTask(name);
        const map = this.getPromptByTaskMap();
        map[task] = name;
        await this.context.globalState.update(CURRENT_PROMPT_BY_TASK_KEY, map);
    }

    private async pickExecution(current?: ExecutionMode): Promise<ExecutionMode | undefined> {
        const cur = current ?? 'parallel';
        const pick = await vscode.window.showQuickPick(
            [
                {
                    label: '并行',
                    value: 'parallel' as ExecutionMode,
                    description: '批处理可并发；默认工作台',
                    picked: cur === 'parallel',
                },
                {
                    label: '串行（实验）',
                    value: 'serial' as ExecutionMode,
                    description: '顺序执行并写记忆',
                    picked: cur === 'serial',
                },
            ],
            { placeHolder: '选择批处理默认调度（并行/串行）', ignoreFocusOut: true }
        );
        return pick?.value;
    }

    private async pickAlignmentKind(current?: AlignmentKind): Promise<AlignmentKind | undefined> {
        const cur = current ?? 'edit';
        const pick = await vscode.window.showQuickPick(
            [
                {
                    label: '编辑',
                    value: 'edit' as AlignmentKind,
                    description: '改动小，可 diff/句对齐（如校对）',
                    picked: cur === 'edit',
                },
                {
                    label: '转换',
                    value: 'convert' as AlignmentKind,
                    description: '改动大；可输出/回填原文与转换标记（如翻译）',
                    picked: cur === 'convert',
                },
            ],
            { placeHolder: '选择对齐语义（编辑/转换）', ignoreFocusOut: true }
        );
        return pick?.value;
    }

    private async pickConvertPolicy(current?: ConvertAlignPolicy): Promise<ConvertAlignPolicy> {
        const base = current ?? { ...DEFAULT_CONVERT_POLICY };
        const emitSource = await vscode.window.showQuickPick(
            [
                { label: '不输出原文（程序回填）', value: false, picked: !base.emitSource },
                { label: '模型输出原文', value: true, picked: base.emitSource },
            ],
            { placeHolder: '转换：是否输出原文', ignoreFocusOut: true }
        );
        const emitConvertMarkers = await vscode.window.showQuickPick(
            [
                { label: '不输出转换标记', value: false, picked: !base.emitConvertMarkers },
                { label: '输出转换标记（如术语对）', value: true, picked: base.emitConvertMarkers },
            ],
            { placeHolder: '转换：是否输出标记', ignoreFocusOut: true }
        );
        const programBackfillSource = await vscode.window.showQuickPick(
            [
                { label: '允许程序回填原文（默认）', value: true, picked: base.programBackfillSource },
                { label: '关闭程序回填', value: false, picked: !base.programBackfillSource },
            ],
            { placeHolder: '转换：程序回填原文', ignoreFocusOut: true }
        );
        return {
            emitSource: emitSource?.value ?? base.emitSource,
            emitConvertMarkers: emitConvertMarkers?.value ?? base.emitConvertMarkers,
            programBackfillSource: programBackfillSource?.value ?? base.programBackfillSource,
        };
    }

    private taskFromAxes(alignmentKind: AlignmentKind, execution: ExecutionMode, prev?: PromptTask): PromptTask {
        if (execution === 'serial' && alignmentKind === 'convert') {
            return 'translate';
        }
        if (alignmentKind === 'convert' && prev === 'annotate') {
            return 'annotate';
        }
        if (alignmentKind === 'convert') {
            return execution === 'serial' ? 'translate' : 'annotate';
        }
        const p = normalizePromptTask(prev);
        if (p === 'restructure' || p === 'other' || p === 'proofread') {
            return p;
        }
        return 'proofread';
    }

    /** 新建提示词（输出类型、对齐类、调度；转换时再问策略），并设为当前 */
    public async addPrompt(): Promise<void> {
        const prompts = this.getPrompts();
        const name = await vscode.window.showInputBox({
            prompt: '请输入提示词名称',
            placeHolder: '例如：通用校对、学术论文校对等',
        });
        if (!name) return;
        if (isReservedPromptStorageName(name)) {
            vscode.window.showWarningMessage('该名称为系统保留，请使用其他名称。');
            return;
        }
        const content = await vscode.window.showInputBox({
            prompt: '请输入提示词内容',
            placeHolder: '请输入完整的提示词内容，内容必须对要处理的"目标文本（target）""参考资料（reference）""上下文（context）"进行说明',
        });
        if (!content) return;
        const outputTypePick = await vscode.window.showQuickPick(
            [
                { label: '全文', value: 'full' as const },
                { label: '条目', value: 'item' as const, description: 'original+corrected+confidence+explanation' },
                { label: '其他', value: 'other' as const },
            ],
            { placeHolder: '选择输出类型', ignoreFocusOut: true }
        );
        const outputType = outputTypePick?.value ?? 'full';
        const alignmentKind = (await this.pickAlignmentKind('edit')) ?? 'edit';
        const execution = (await this.pickExecution('parallel')) ?? 'parallel';
        let convertPolicy: ConvertAlignPolicy | undefined;
        if (alignmentKind === 'convert') {
            convertPolicy = await this.pickConvertPolicy(DEFAULT_CONVERT_POLICY);
        }
        const task = this.taskFromAxes(alignmentKind, execution);
        prompts.push({ name, content, outputType, task, alignmentKind, execution, convertPolicy });
        await this.savePrompts(prompts);
        await this.setCurrentPrompt(name);
        vscode.window.showInformationMessage(
            `提示词「${name}」已添加（${alignmentKindLabel(alignmentKind)} · ${executionModeLabel(execution)}）并设为当前`
        );
    }

    /** 编辑指定提示词，并设为当前 */
    public async editPrompt(prompt: Prompt): Promise<void> {
        const prompts = this.getPrompts();
        const index = prompts.findIndex((p) => p.name === prompt.name);
        if (index === -1) return;
        const name = await vscode.window.showInputBox({
            prompt: '请输入提示词名称',
            value: prompt.name,
            placeHolder: '例如：通用校对、学术论文校对等',
        });
        if (!name) return;
        if (isReservedPromptStorageName(name)) {
            vscode.window.showWarningMessage('该名称为系统保留，请使用其他名称。');
            return;
        }
        const content = await vscode.window.showInputBox({
            prompt: '请输入提示词内容',
            value: prompt.content,
            placeHolder: '请输入完整的提示词内容，内容必须对要处理的"目标文本（target）""参考资料（reference）""上下文（context）"进行说明',
        });
        if (!content) return;
        const currentOutputType = prompt.outputType ?? 'full';
        const outputTypePick = await vscode.window.showQuickPick(
            [
                { label: '全文', value: 'full' as const },
                { label: '条目', value: 'item' as const, description: 'original+corrected+confidence+explanation' },
                { label: '其他', value: 'other' as const },
            ],
            { placeHolder: '选择输出类型', ignoreFocusOut: true, title: '输出类型' }
        );
        const outputType = outputTypePick?.value ?? currentOutputType;
        const prevTask = normalizePromptTask(prompt.task);
        const curAlign =
            normalizeAlignmentKind(prompt.alignmentKind) ?? alignmentKindFromTask(prevTask);
        const curExec = normalizeExecutionMode(prompt.execution) ?? executionFromTask(prevTask);
        const alignmentKind = (await this.pickAlignmentKind(curAlign)) ?? curAlign;
        const execution = (await this.pickExecution(curExec)) ?? curExec;
        let convertPolicy: ConvertAlignPolicy | undefined = prompt.convertPolicy;
        if (alignmentKind === 'convert') {
            convertPolicy = await this.pickConvertPolicy(
                normalizeConvertPolicy(prompt.convertPolicy, DEFAULT_CONVERT_POLICY)
            );
        } else {
            convertPolicy = undefined;
        }
        const task = this.taskFromAxes(alignmentKind, execution, prevTask);
        prompts[index] = { name, content, outputType, task, alignmentKind, execution, convertPolicy };
        await this.savePrompts(prompts);
        await this.setCurrentPrompt(name);
        vscode.window.showInformationMessage(
            `提示词「${name}」已修改（${alignmentKindLabel(alignmentKind)} · ${executionModeLabel(execution)}）并设为当前`
        );
    }

    /** 删除指定名称的提示词；若其为当前则切回系统默认（全文） */
    public async deletePrompt(name: string): Promise<void> {
        const prompts = this.getPrompts().filter((p) => p.name !== name);
        await this.savePrompts(prompts);
        const current = this.context.globalState.get<string>('currentPrompt', '');
        if (current === name) {
            await this.setCurrentPrompt(SYSTEM_PROMPT_NAME_FULL);
        }
        vscode.window.showInformationMessage(`已删除提示词「${name}」`);
    }

    /** 清空所有自定义提示词并切回系统默认 */
    public async clearPrompts(): Promise<void> {
        const result = await vscode.window.showWarningMessage(
            '确定要清空所有提示词吗？此操作不可恢复。',
            { modal: true },
            '确定'
        );
        if (result === '确定') {
            await this.savePrompts([]);
            await this.setCurrentPrompt(SYSTEM_PROMPT_NAME_FULL);
            vscode.window.showInformationMessage('已清空所有提示词并切换回系统默认');
        }
    }

    public async managePrompts(): Promise<void> {
        await vscode.commands.executeCommand('ai-proofread.prompts.focus');
    }

    private async savePrompts(prompts: Prompt[]): Promise<void> {
        const config = vscode.workspace.getConfiguration('ai-proofread');
        await config.update('prompts', prompts, true);
    }
}