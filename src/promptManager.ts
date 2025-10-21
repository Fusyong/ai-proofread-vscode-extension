/**
 * 提示词管理器模块
 */

import * as vscode from 'vscode';

interface Prompt {
    name: string;
    content: string;
}

interface PromptItem extends vscode.QuickPickItem {
    prompt?: Prompt;
}

interface ActionItem extends vscode.QuickPickItem {
    action: 'add' | 'clear';
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

    public async managePrompts(): Promise<void> {
        const config = vscode.workspace.getConfiguration('ai-proofread');
        const prompts = config.get<Prompt[]>('prompts', []);

        // 创建提示词列表
        const items: (PromptItem | ActionItem)[] = [
            {
                label: '系统默认提示词',
                description: '使用内置的系统提示词',
                prompt: undefined
            },
            ...prompts.map((prompt: Prompt) => ({
                label: prompt.name,
                description: prompt.content.slice(0, 50) + '...',
                prompt
            }))
        ];

        // 添加操作选项
        items.push(
            { label: '$(add) 添加新提示词', description: '添加一个新的提示词', action: 'add' },
            { label: '$(trash) 清空所有提示词', description: '删除所有自定义提示词', action: 'clear' }
        );

        // 显示选择菜单
        const selection = await vscode.window.showQuickPick(items, {
            placeHolder: '选择要编辑的提示词或执行操作，也可以在设置界面管理',
            ignoreFocusOut: true
        });

        if (!selection) {
            return;
        }

        // 处理选择结果
        if ('action' in selection) {
            if (selection.action === 'add') {
                await this.addPrompt(prompts);
            } else if (selection.action === 'clear') {
                await this.clearPrompts();
            }
        } else if (selection.label === '系统默认提示词') {
            await this.context.globalState.update('currentPrompt', '');
            vscode.window.showInformationMessage('已切换到系统默认提示词');
        } else if (selection.prompt) {
            await this.editPrompt(prompts, selection.prompt);
        }
    }

    public async selectPrompt(): Promise<void> {
        const config = vscode.workspace.getConfiguration('ai-proofread');
        const prompts = config.get<Prompt[]>('prompts', []);
        const currentPrompt = this.context.globalState.get<string>('currentPrompt', '');

        // 创建提示词列表
        const items: PromptItem[] = [
            {
                label: `${currentPrompt === '' ? '✓ ' : ''}系统默认提示词`,
                description: '使用内置的系统提示词',
                prompt: undefined
            },
            ...prompts.map((prompt: Prompt) => ({
                label: `${currentPrompt === prompt.name ? '✓ ' : ''}${prompt.name}`,
                description: prompt.content.slice(0, 50) + '...',
                prompt
            }))
        ];

        // 显示选择菜单
        const selection = await vscode.window.showQuickPick(items, {
            placeHolder: '选择要使用的提示词',
            ignoreFocusOut: true
        });

        if (!selection) {
            return;
        }

        if (selection.label.includes('系统默认提示词')) {
            await this.context.globalState.update('currentPrompt', '');
            vscode.window.showInformationMessage('已切换到系统默认提示词');
        } else if (selection.prompt) {
            await this.context.globalState.update('currentPrompt', selection.prompt.name);
            vscode.window.showInformationMessage(`已切换到提示词：${selection.prompt.name}`);
        }
    }

    private async addPrompt(prompts: Prompt[]): Promise<void> {

        const name = await vscode.window.showInputBox({
            prompt: '请输入提示词名称',
            placeHolder: '例如：通用校对、学术论文校对等'
        });

        if (!name) {
            return;
        }

        const content = await vscode.window.showInputBox({
            prompt: '请输入提示词内容',
            placeHolder: '请输入完整的提示词内容，内容必须对要校对的"目标文本（target）""参考资料（reference）""上下文（context）"进行说明'
        });

        if (!content) {
            return;
        }

        prompts.push({ name, content });
        await this.savePrompts(prompts);

        // 自动将新添加的提示词设为当前提示词
        await this.context.globalState.update('currentPrompt', name);
        vscode.window.showInformationMessage(`提示词"${name}"添加成功，已自动设为当前提示词`);
    }

    private async editPrompt(prompts: Prompt[], prompt: Prompt): Promise<void> {
        const index = prompts.findIndex(p => p.name === prompt.name);
        if (index === -1) {
            return;
        }

        const name = await vscode.window.showInputBox({
            prompt: '请输入提示词名称',
            value: prompt.name,
            placeHolder: '例如：通用校对、学术论文校对等'
        });

        if (!name) {
            return;
        }

        const content = await vscode.window.showInputBox({
            prompt: '请输入提示词内容',
            value: prompt.content,
            placeHolder: '请输入完整的提示词内容，内容必须对要校对的"目标文本（target）""参考资料（reference）""上下文（context）"进行说明'
        });

        if (!content) {
            return;
        }

        prompts[index] = { name, content };
        await this.savePrompts(prompts);

        // 自动将修改后的提示词设为当前提示词
        await this.context.globalState.update('currentPrompt', name);
        vscode.window.showInformationMessage(`提示词"${name}"修改成功，已自动设为当前提示词`);
    }

    private async clearPrompts(): Promise<void> {
        const result = await vscode.window.showWarningMessage(
            '确定要清空所有提示词吗？此操作不可恢复。',
            { modal: true },
            '确定'
        );

        if (result === '确定') {
            await this.savePrompts([]);

            // 自动切换回系统默认提示词
            await this.context.globalState.update('currentPrompt', '');
            vscode.window.showInformationMessage('所有提示词已清空，已自动切换回系统默认提示词');
        }
    }

    private async savePrompts(prompts: Prompt[]): Promise<void> {
        const config = vscode.workspace.getConfiguration('ai-proofread');
        await config.update('prompts', prompts, true);
    }
}