/**
 * 提示词管理器模块
 */

import * as vscode from 'vscode';

export type PromptOutputType = 'full' | 'item' | 'other';

/** 当前选中的为「系统默认提示词（full）」时，globalState 中 currentPrompt 的值 */
export const SYSTEM_PROMPT_NAME_FULL = '';
/** 当前选中的为「系统默认提示词（item）」时，globalState 中 currentPrompt 的值 */
export const SYSTEM_PROMPT_NAME_ITEM = '__system_item__';

/** 将存值转为显示名称（供无 PromptManager 的调用方使用） */
export function getPromptDisplayName(name: string): string {
    if (name === SYSTEM_PROMPT_NAME_FULL) return '系统默认提示词（full）';
    if (name === SYSTEM_PROMPT_NAME_ITEM) return '系统默认提示词（item）';
    return name || '系统默认提示词（full）';
}

export interface Prompt {
    name: string;
    content: string;
    outputType?: PromptOutputType;
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

    /** 当前选中的提示词名称（globalState 存值：'' | '__system_item__' | 自定义 name） */
    public getCurrentPromptName(): string {
        return this.context.globalState.get<string>('currentPrompt', SYSTEM_PROMPT_NAME_FULL) ?? SYSTEM_PROMPT_NAME_FULL;
    }

    /** 当前提示词的显示名称（用于日志、消息等） */
    public getCurrentPromptDisplayName(): string {
        const name = this.getCurrentPromptName();
        if (name === SYSTEM_PROMPT_NAME_FULL) return '系统默认提示词（full）';
        if (name === SYSTEM_PROMPT_NAME_ITEM) return '系统默认提示词（item）';
        return name;
    }

    /** 设为当前使用的提示词；name 为 SYSTEM_PROMPT_NAME_FULL 表示系统全文，SYSTEM_PROMPT_NAME_ITEM 表示系统条目 */
    public async setCurrentPrompt(name: string): Promise<void> {
        await this.context.globalState.update('currentPrompt', name);
    }

    /** 新建提示词（弹窗输入名称、内容与输出类型），并设为当前 */
    public async addPrompt(): Promise<void> {
        const prompts = this.getPrompts();
        const name = await vscode.window.showInputBox({
            prompt: '请输入提示词名称',
            placeHolder: '例如：通用校对、学术论文校对等',
        });
        if (!name) return;
        if (name === SYSTEM_PROMPT_NAME_ITEM) {
            vscode.window.showWarningMessage('该名称为系统保留，请使用其他名称。');
            return;
        }
        const content = await vscode.window.showInputBox({
            prompt: '请输入提示词内容',
            placeHolder: '请输入完整的提示词内容，内容必须对要校对的"目标文本（target）""参考资料（reference）""上下文（context）"进行说明',
        });
        if (!content) return;
        const outputTypePick = await vscode.window.showQuickPick(
            [
                { label: '全文', value: 'full' as const },
                { label: '条目', value: 'item' as const, description: 'original+corrected+explanation' },
                { label: '其他', value: 'other' as const },
            ],
            { placeHolder: '选择输出类型', ignoreFocusOut: true }
        );
        const outputType = outputTypePick?.value ?? 'full';
        prompts.push({ name, content, outputType });
        await this.savePrompts(prompts);
        await this.context.globalState.update('currentPrompt', name);
        vscode.window.showInformationMessage(`提示词「${name}」已添加并设为当前`);
    }

    /** 编辑指定提示词（弹窗修改名称、内容与输出类型），并设为当前 */
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
        if (name === SYSTEM_PROMPT_NAME_ITEM) {
            vscode.window.showWarningMessage('该名称为系统保留，请使用其他名称。');
            return;
        }
        const content = await vscode.window.showInputBox({
            prompt: '请输入提示词内容',
            value: prompt.content,
            placeHolder: '请输入完整的提示词内容，内容必须对要校对的"目标文本（target）""参考资料（reference）""上下文（context）"进行说明',
        });
        if (!content) return;
        const currentOutputType = prompt.outputType ?? 'full';
        const outputTypePick = await vscode.window.showQuickPick(
            [
                { label: '全文', value: 'full' as const },
                { label: '条目', value: 'item' as const, description: 'original+corrected+explanation' },
                { label: '其他', value: 'other' as const },
            ],
            { placeHolder: '选择输出类型', ignoreFocusOut: true, title: '输出类型' }
        );
        const outputType = outputTypePick?.value ?? currentOutputType;
        prompts[index] = { name, content, outputType };
        await this.savePrompts(prompts);
        await this.context.globalState.update('currentPrompt', name);
        vscode.window.showInformationMessage(`提示词「${name}」已修改并设为当前`);
    }

    /** 删除指定名称的提示词；若其为当前则切回系统默认（全文） */
    public async deletePrompt(name: string): Promise<void> {
        const prompts = this.getPrompts().filter((p) => p.name !== name);
        await this.savePrompts(prompts);
        const current = this.context.globalState.get<string>('currentPrompt', '');
        if (current === name) {
            await this.context.globalState.update('currentPrompt', SYSTEM_PROMPT_NAME_FULL);
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
            await this.context.globalState.update('currentPrompt', SYSTEM_PROMPT_NAME_FULL);
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