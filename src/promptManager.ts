import * as vscode from 'vscode';

interface Prompt {
    name: string;
    content: string;
}

interface PromptItem extends vscode.QuickPickItem {
    prompt?: Prompt;
}

export class PromptManager {
    private static instance: PromptManager;
    private constructor() {}

    public static getInstance(): PromptManager {
        if (!PromptManager.instance) {
            PromptManager.instance = new PromptManager();
        }
        return PromptManager.instance;
    }

    public async managePrompts(): Promise<void> {
        const config = vscode.workspace.getConfiguration('ai-proofread');
        const prompts = config.get<Prompt[]>('prompts', []);
        const defaultIndex = config.get<number>('defaultPromptIndex', 0);

        // 创建提示词列表
        const items: PromptItem[] = [
            {
                label: `${defaultIndex === -1 ? '✓ ' : ''}系统默认提示词`,
                description: '使用内置的系统提示词',
                prompt: undefined
            },
            ...prompts.map((prompt, index) => ({
                label: `${index === defaultIndex ? '✓ ' : ''}${prompt.name}`,
                description: prompt.content.slice(0, 50) + '...',
                prompt
            }))
        ];

        // 添加操作选项
        items.push(
            { label: '$(add) 添加新提示词', description: '添加一个新的提示词' },
            { label: '$(trash) 清空所有提示词', description: '删除所有自定义提示词' }
        );

        // 显示选择菜单
        const selection = await vscode.window.showQuickPick(items, {
            placeHolder: '选择要编辑的提示词或执行操作',
            ignoreFocusOut: true
        });

        if (!selection) {
            return;
        }

        // 处理选择结果
        if (selection.label.startsWith('$(add)')) {
            await this.addPrompt(prompts);
        } else if (selection.label.startsWith('$(trash)')) {
            await this.clearPrompts();
        } else if (selection.label === '系统默认提示词' || selection.label === '✓ 系统默认提示词') {
            // 切换到系统默认提示词
            await config.update('defaultPromptIndex', -1, true);
            vscode.window.showInformationMessage('已切换到系统默认提示词');
        } else if (selection.prompt) {
            await this.editPrompt(prompts, selection.prompt);
        }
    }

    public async switchPrompt(): Promise<void> {
        const config = vscode.workspace.getConfiguration('ai-proofread');
        const prompts = config.get<Prompt[]>('prompts', []);
        const currentIndex = config.get<number>('defaultPromptIndex', 0);

        // 创建提示词列表
        const items: PromptItem[] = [
            {
                label: `${currentIndex === -1 ? '✓ ' : ''}系统默认提示词`,
                description: '使用内置的系统提示词',
                prompt: undefined
            },
            ...prompts.map((prompt, index) => ({
                label: `${index === currentIndex ? '✓ ' : ''}${prompt.name}`,
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

        if (selection.label === '系统默认提示词' || selection.label === '✓ 系统默认提示词') {
            // 使用系统默认提示词
            await config.update('defaultPromptIndex', -1, true);
            vscode.window.showInformationMessage('已切换到系统默认提示词');
        } else if (selection.prompt) {
            // 使用自定义提示词
            const index = prompts.findIndex(p => p.name === selection.prompt!.name);
            if (index !== -1) {
                await config.update('defaultPromptIndex', index, true);
                vscode.window.showInformationMessage(`已切换到提示词：${selection.prompt!.name}`);
            }
        }
    }

    private async addPrompt(prompts: Prompt[]): Promise<void> {
        if (prompts.length >= 5) {
            vscode.window.showErrorMessage('已达到最大提示词数量限制（5个）');
            return;
        }

        const name = await vscode.window.showInputBox({
            prompt: '请输入提示词名称',
            placeHolder: '例如：通用校对、学术论文校对等'
        });

        if (!name) {
            return;
        }

        const content = await vscode.window.showInputBox({
            prompt: '请输入提示词内容',
            placeHolder: '请输入完整的提示词内容'
        });

        if (!content) {
            return;
        }

        prompts.push({ name, content });
        await this.savePrompts(prompts);
        vscode.window.showInformationMessage('提示词添加成功');
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
            placeHolder: '请输入完整的提示词内容'
        });

        if (!content) {
            return;
        }

        prompts[index] = { name, content };
        await this.savePrompts(prompts);
        vscode.window.showInformationMessage('提示词修改成功');
    }

    private async clearPrompts(): Promise<void> {
        const result = await vscode.window.showWarningMessage(
            '确定要清空所有提示词吗？此操作不可恢复。',
            { modal: true },
            '确定'
        );

        if (result === '确定') {
            await this.savePrompts([]);
            vscode.window.showInformationMessage('所有提示词已清空');
        }
    }

    private async savePrompts(prompts: Prompt[]): Promise<void> {
        const config = vscode.workspace.getConfiguration('ai-proofread');
        await config.update('prompts', prompts, true);
    }
}