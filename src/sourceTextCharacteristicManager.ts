/**
 * 用户自定义「源文本特性提示词」管理（内置条目不在此存储）
 */

import * as vscode from 'vscode';
import { getSourceCharacteristicContentInputPrompt, type UserSourceTextCharacteristicPrompt } from './sourceTextCharacteristics';

export class SourceTextCharacteristicManager {
    private static instance: SourceTextCharacteristicManager;
    private context: vscode.ExtensionContext;

    private constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    public static getInstance(context?: vscode.ExtensionContext): SourceTextCharacteristicManager {
        if (!SourceTextCharacteristicManager.instance && context) {
            SourceTextCharacteristicManager.instance = new SourceTextCharacteristicManager(context);
        }
        return SourceTextCharacteristicManager.instance;
    }

    public getUserPrompts(): UserSourceTextCharacteristicPrompt[] {
        const config = vscode.workspace.getConfiguration('ai-proofread');
        return config.get<UserSourceTextCharacteristicPrompt[]>('sourceTextCharacteristicPrompts', []) ?? [];
    }

    public async addPrompt(): Promise<void> {
        const prompts = this.getUserPrompts();
        const name = await vscode.window.showInputBox({
            prompt: '源文本特性提示词名称',
            placeHolder: '例如：小学语文练习册',
        });
        if (!name) return;
        const content = await vscode.window.showInputBox({
            title: '新建源文本特性提示词',
            prompt: getSourceCharacteristicContentInputPrompt(),
            placeHolder: '内容、格式、禁忌等对整稿的说明和要求',
        });
        if (!content) return;
        prompts.push({ name, content });
        await this.savePrompts(prompts);
        vscode.window.showInformationMessage(`已添加「${name}」`);
    }

    public async editPrompt(prompt: UserSourceTextCharacteristicPrompt): Promise<void> {
        const prompts = this.getUserPrompts();
        const index = prompts.findIndex((p) => p.name === prompt.name);
        if (index === -1) return;
        const name = await vscode.window.showInputBox({
            prompt: '源文本特性提示词名称',
            value: prompt.name,
        });
        if (!name) return;
        const content = await vscode.window.showInputBox({
            title: '编辑源文本特性提示词',
            prompt: getSourceCharacteristicContentInputPrompt(),
            placeHolder: '内容、格式、禁忌等对整稿的说明和要求',
            value: prompt.content,
        });
        if (!content) return;
        prompts[index] = { name, content };
        await this.savePrompts(prompts);
        vscode.window.showInformationMessage(`已更新「${name}」`);
    }

    public async deletePrompt(name: string): Promise<void> {
        const prompts = this.getUserPrompts().filter((p) => p.name !== name);
        await this.savePrompts(prompts);
        vscode.window.showInformationMessage(`已删除「${name}」`);
    }

    private async savePrompts(prompts: UserSourceTextCharacteristicPrompt[]): Promise<void> {
        const config = vscode.workspace.getConfiguration('ai-proofread');
        await config.update('sourceTextCharacteristicPrompts', prompts, true);
    }
}
