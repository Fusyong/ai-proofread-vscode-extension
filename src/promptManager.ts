/**
 * 提示词管理器模块
 */

import * as vscode from 'vscode';

export interface Prompt {
    name: string;
    content: string;
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

    /** 当前选中的提示词名称，空字符串表示系统默认 */
    public getCurrentPromptName(): string {
        return this.context.globalState.get<string>('currentPrompt', '') ?? '';
    }

    /** 设为当前使用的提示词；name 为空表示系统默认 */
    public async setCurrentPrompt(name: string): Promise<void> {
        await this.context.globalState.update('currentPrompt', name);
    }

    /** 新建提示词（弹窗输入名称与内容），并设为当前 */
    public async addPrompt(): Promise<void> {
        const prompts = this.getPrompts();
        const name = await vscode.window.showInputBox({
            prompt: '请输入提示词名称',
            placeHolder: '例如：通用校对、学术论文校对等',
        });
        if (!name) return;
        const content = await vscode.window.showInputBox({
            prompt: '请输入提示词内容',
            placeHolder: '请输入完整的提示词内容，内容必须对要校对的"目标文本（target）""参考资料（reference）""上下文（context）"进行说明',
        });
        if (!content) return;
        prompts.push({ name, content });
        await this.savePrompts(prompts);
        await this.context.globalState.update('currentPrompt', name);
        vscode.window.showInformationMessage(`提示词「${name}」已添加并设为当前`);
    }

    /** 编辑指定提示词（弹窗修改名称与内容），并设为当前 */
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
        const content = await vscode.window.showInputBox({
            prompt: '请输入提示词内容',
            value: prompt.content,
            placeHolder: '请输入完整的提示词内容，内容必须对要校对的"目标文本（target）""参考资料（reference）""上下文（context）"进行说明',
        });
        if (!content) return;
        prompts[index] = { name, content };
        await this.savePrompts(prompts);
        await this.context.globalState.update('currentPrompt', name);
        vscode.window.showInformationMessage(`提示词「${name}」已修改并设为当前`);
    }

    /** 删除指定名称的提示词；若其为当前则切回系统默认 */
    public async deletePrompt(name: string): Promise<void> {
        const prompts = this.getPrompts().filter((p) => p.name !== name);
        await this.savePrompts(prompts);
        if (this.context.globalState.get<string>('currentPrompt', '') === name) {
            await this.context.globalState.update('currentPrompt', '');
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
            await this.context.globalState.update('currentPrompt', '');
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