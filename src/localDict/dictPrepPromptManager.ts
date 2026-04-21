import * as vscode from 'vscode';

export interface DictPrepPrompt {
    name: string;
    content: string;
}

/** 系统默认（内置）在 globalState 中的存值 */
export const SYSTEM_DICT_PREP_PROMPT_NAME = '';

export function getDictPrepPromptDisplayName(name: string): string {
    return name === SYSTEM_DICT_PREP_PROMPT_NAME ? '系统默认提示词（专名）' : name;
}

export class DictPrepPromptManager {
    private static instance: DictPrepPromptManager;
    private constructor(private context: vscode.ExtensionContext) {}

    public static getInstance(context?: vscode.ExtensionContext): DictPrepPromptManager {
        if (!DictPrepPromptManager.instance && context) {
            DictPrepPromptManager.instance = new DictPrepPromptManager(context);
        }
        return DictPrepPromptManager.instance;
    }

    public getPrompts(): DictPrepPrompt[] {
        const config = vscode.workspace.getConfiguration('ai-proofread');
        return config.get<DictPrepPrompt[]>('dictPrep.prompts', []) ?? [];
    }

    public getCurrentPromptName(): string {
        return this.context.globalState.get<string>('currentDictPrepPrompt', SYSTEM_DICT_PREP_PROMPT_NAME) ?? SYSTEM_DICT_PREP_PROMPT_NAME;
    }

    public async setCurrentPrompt(name: string): Promise<void> {
        await this.context.globalState.update('currentDictPrepPrompt', name);
    }

    public async addPrompt(): Promise<void> {
        const prompts = this.getPrompts();
        const name = await vscode.window.showInputBox({
            prompt: '词典查询提示词名称',
            placeHolder: '例如：古汉语词典查询规划',
        });
        if (!name) return;

        const content = await vscode.window.showInputBox({
            title: '新建词典查询提示词',
            prompt: '请输入提示词内容（必须要求模型只输出 JSON，并遵循 lookups 结构）',
            placeHolder: '你是一位……（只输出 JSON）',
        });
        if (!content) return;

        prompts.push({ name, content });
        await this.savePrompts(prompts);
        await this.setCurrentPrompt(name);
        vscode.window.showInformationMessage(`已添加词典查询提示词「${name}」并设为当前`);
    }

    public async editPrompt(prompt: DictPrepPrompt): Promise<void> {
        const prompts = this.getPrompts();
        const idx = prompts.findIndex((p) => p.name === prompt.name);
        if (idx === -1) return;

        const name = await vscode.window.showInputBox({
            prompt: '词典查询提示词名称',
            value: prompt.name,
        });
        if (!name) return;

        const content = await vscode.window.showInputBox({
            title: '编辑词典查询提示词',
            prompt: '请输入提示词内容（必须要求模型只输出 JSON，并遵循 lookups 结构）',
            value: prompt.content,
        });
        if (!content) return;

        prompts[idx] = { name, content };
        await this.savePrompts(prompts);
        await this.setCurrentPrompt(name);
        vscode.window.showInformationMessage(`已更新词典查询提示词「${name}」并设为当前`);
    }

    public async deletePrompt(name: string): Promise<void> {
        const prompts = this.getPrompts().filter((p) => p.name !== name);
        await this.savePrompts(prompts);
        const current = this.getCurrentPromptName();
        if (current === name) {
            await this.setCurrentPrompt(SYSTEM_DICT_PREP_PROMPT_NAME);
        }
        vscode.window.showInformationMessage(`已删除词典查询提示词「${name}」`);
    }

    private async savePrompts(prompts: DictPrepPrompt[]): Promise<void> {
        const config = vscode.workspace.getConfiguration('ai-proofread');
        await config.update('dictPrep.prompts', prompts, true);
    }
}

