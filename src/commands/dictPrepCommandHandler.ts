import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getDictPrepPromptDisplayName } from '../localDict/dictPrepPromptManager';
import { mergeDictPrepReferencesFromPlans, planDictPrepQueriesOnly } from '../localDict/dictPrepRunner';
import { ConfigManager, ErrorUtils } from '../utils';
import { ProcessResult, SplitResult, WebviewManager } from '../ui/webviewManager';
import { ProgressTracker } from '../progressTracker';

export class DictPrepCommandHandler {
    private configManager = ConfigManager.getInstance();

    constructor(private webviewManager: WebviewManager) {}

    /**
     * 从活动编辑器执行：命令面板入口，可选择仅规划 / 仅查词 / 两步连续。
     */
    public async handlePrepareLocalDictReferencesCommand(
        editor: vscode.TextEditor,
        context: vscode.ExtensionContext
    ): Promise<void> {
        const doc = editor.document;
        if (doc.languageId !== 'json') {
            vscode.window.showErrorMessage('请选择 JSON 文件执行本地词典参考准备。');
            return;
        }
        const jsonFilePath = doc.uri.fsPath;

        const picked = await vscode.window.showQuickPick(
            [
                {
                    label: '$(hubot) 第一步：LLM 生成查词计划',
                    description: '写入 .dictprep.json，不修改 reference',
                    value: 'llm' as const,
                },
                {
                    label: '$(book) 第二步：本地查词并写入 reference',
                    description: '依赖上一步的过程文件',
                    value: 'local' as const,
                },
                {
                    label: '$(sync) 两步连续执行',
                    description: '先规划再查词（与旧版一键行为相同）',
                    value: 'both' as const,
                },
            ],
            { title: '本地词典参考准备', ignoreFocusOut: true }
        );
        if (!picked) return;

        try {
            const content = doc.getText();
            const parsed = JSON.parse(content);
            if (!Array.isArray(parsed) || !parsed.every((x) => x && typeof x === 'object' && 'target' in x)) {
                vscode.window.showErrorMessage('JSON 文件格式不正确：需要包含 target 字段的对象数组。');
                return;
            }

            if (picked.value === 'llm') {
                const ok = await this.showDictPrepLlmConfirmation(jsonFilePath, parsed.length, context);
                if (!ok) return;
                await this.runDictPrepLlmWithUi(jsonFilePath, context);
            } else if (picked.value === 'local') {
                const ok = await this.showDictPrepLocalConfirmation(jsonFilePath, parsed.length);
                if (!ok) return;
                await this.runDictPrepLocalWithUi(jsonFilePath, context);
            } else {
                const ok = await this.showDictPrepContinuousConfirmation(jsonFilePath, parsed.length, context);
                if (!ok) return;
                await this.runDictPrepBothWithUi(jsonFilePath, context);
            }
        } catch (e) {
            ErrorUtils.showError(e, '本地词典参考准备失败：');
        }
    }

    /** Webview：仅 LLM 规划 */
    public async handleDictPrepLlmPlan(jsonFilePath: string, context: vscode.ExtensionContext): Promise<void> {
        try {
            if (!fs.existsSync(jsonFilePath)) {
                vscode.window.showErrorMessage('JSON 文件不存在。');
                return;
            }
            const parsed = JSON.parse(fs.readFileSync(jsonFilePath, 'utf8'));
            if (!Array.isArray(parsed) || !parsed.every((x) => x && typeof x === 'object' && 'target' in x)) {
                vscode.window.showErrorMessage('JSON 文件格式不正确。');
                return;
            }
            const ok = await this.showDictPrepLlmConfirmation(jsonFilePath, parsed.length, context);
            if (!ok) return;
            await this.runDictPrepLlmWithUi(jsonFilePath, context);
        } catch (e) {
            ErrorUtils.showError(e, 'LLM 查询规划失败：');
        }
    }

    /** Webview：仅本地查词 */
    public async handleDictPrepLocalMerge(jsonFilePath: string, context: vscode.ExtensionContext): Promise<void> {
        try {
            if (!fs.existsSync(jsonFilePath)) {
                vscode.window.showErrorMessage('JSON 文件不存在。');
                return;
            }
            const parsed = JSON.parse(fs.readFileSync(jsonFilePath, 'utf8'));
            if (!Array.isArray(parsed) || !parsed.every((x) => x && typeof x === 'object' && 'target' in x)) {
                vscode.window.showErrorMessage('JSON 文件格式不正确。');
                return;
            }
            const ok = await this.showDictPrepLocalConfirmation(jsonFilePath, parsed.length);
            if (!ok) return;
            await this.runDictPrepLocalWithUi(jsonFilePath, context);
        } catch (e) {
            ErrorUtils.showError(e, '本地查词合并失败：');
        }
    }

    private buildSplitResult(jsonFilePath: string): SplitResult {
        const dir = path.dirname(jsonFilePath);
        const base = path.basename(jsonFilePath, '.json');
        const mainGuess = path.join(dir, `${base}.md`);
        const originalFilePath = fs.existsSync(mainGuess) ? mainGuess : path.join(dir, `${base}`);
        return {
            jsonFilePath,
            markdownFilePath: path.join(dir, `${base}.json.md`),
            logFilePath: path.join(dir, `${base}.log`),
            originalFilePath,
        };
    }

    private pushDictPrepPanel(
        jsonFilePath: string,
        context: vscode.ExtensionContext,
        message: string,
        progressTracker: ProgressTracker | undefined
    ): void {
        const existingSplit = this.webviewManager.getCurrentProcessResult()?.splitResult;
        const splitResult = existingSplit ?? this.buildSplitResult(jsonFilePath);
        const processResult: ProcessResult = {
            title: 'Proofreading panel',
            message,
            splitResult,
            progressTracker,
            actions: {},
        };
        if (this.webviewManager.getCurrentPanel()) {
            this.webviewManager.updatePanelContent(processResult);
        } else {
            const panel = this.webviewManager.createWebviewPanel(processResult, context);
            panel.webview.onDidReceiveMessage(
                (msg) => this.webviewManager.handleWebviewMessage(msg, panel, context),
                undefined,
                context.subscriptions
            );
            panel.reveal();
        }
    }

    private async runDictPrepLlmWithUi(jsonFilePath: string, context: vscode.ExtensionContext): Promise<void> {
        const raw = fs.readFileSync(jsonFilePath, 'utf8');
        const jsonContent = JSON.parse(raw) as Array<{ target: string }>;

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: '词典准备：LLM 规划中…',
                cancellable: true,
            },
            async (progress, token) => {
                let progressTracker: ProgressTracker | undefined = new ProgressTracker(jsonContent, (pt) => {
                    this.pushDictPrepPanel(jsonFilePath, context, '词典准备：LLM 生成查词计划中…', pt);
                });

                try {
                    const stats = await planDictPrepQueriesOnly({
                        jsonFilePath,
                        context,
                        onProgress: (m) => {
                            progress.report({ message: m.slice(0, 120) });
                        },
                        onAfterItemPlanned: (i) => {
                            progressTracker?.updateProgress(i, 'completed');
                        },
                        token,
                    });
                    progressTracker?.complete();
                    vscode.window.showInformationMessage(
                        `LLM 查询计划完成：处理 ${stats.processedItems}/${stats.totalItems} 段，规划查询点 ${stats.totalPointsPlanned} 个。`
                    );
                } finally {
                    progressTracker = undefined;
                    this.webviewManager.refreshPanelContent(context);
                }
            }
        );
    }

    private async runDictPrepLocalWithUi(jsonFilePath: string, context: vscode.ExtensionContext): Promise<void> {
        const raw = fs.readFileSync(jsonFilePath, 'utf8');
        const jsonContent = JSON.parse(raw) as Array<{ target: string }>;

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: '词典准备：本地查词中…',
                cancellable: true,
            },
            async (progress, token) => {
                let progressTracker: ProgressTracker | undefined = new ProgressTracker(jsonContent, (pt) => {
                    this.pushDictPrepPanel(jsonFilePath, context, '词典准备：本地查词并写入 reference…', pt);
                });

                try {
                    const stats = await mergeDictPrepReferencesFromPlans({
                        jsonFilePath,
                        context,
                        onProgress: (m) => {
                            progress.report({ message: m.slice(0, 120) });
                        },
                        onAfterItemMerged: (i) => {
                            progressTracker?.updateProgress(i, 'completed');
                        },
                        token,
                    });
                    progressTracker?.complete();
                    vscode.window.showInformationMessage(
                        `本地查词完成：处理 ${stats.processedItems} 段，查词 ${stats.totalLookupsExecuted} 次，命中 ${stats.totalHits} 条。`
                    );
                } finally {
                    progressTracker = undefined;
                    this.webviewManager.refreshPanelContent(context);
                }
            }
        );
    }

    private async runDictPrepBothWithUi(jsonFilePath: string, context: vscode.ExtensionContext): Promise<void> {
        const raw = fs.readFileSync(jsonFilePath, 'utf8');
        const jsonContent = JSON.parse(raw) as Array<{ target: string }>;

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: '词典准备：执行中…',
                cancellable: true,
            },
            async (progress, token) => {
                try {
                    let pt1: ProgressTracker | undefined = new ProgressTracker(jsonContent, (p) => {
                        this.pushDictPrepPanel(jsonFilePath, context, '词典准备（1/2）：LLM 生成查词计划…', p);
                    });
                    const s1 = await planDictPrepQueriesOnly({
                        jsonFilePath,
                        context,
                        onProgress: (m) => progress.report({ message: m.slice(0, 100) }),
                        onAfterItemPlanned: (i) => pt1?.updateProgress(i, 'completed'),
                        token,
                    });
                    pt1?.complete();
                    pt1 = undefined;

                    if (token.isCancellationRequested) {
                        return;
                    }

                    progress.report({ message: '规划完成，开始本地查词…' });

                    let pt2: ProgressTracker | undefined = new ProgressTracker(jsonContent, (p) => {
                        this.pushDictPrepPanel(jsonFilePath, context, '词典准备（2/2）：本地查词并写入 reference…', p);
                    });
                    const s2 = await mergeDictPrepReferencesFromPlans({
                        jsonFilePath,
                        context,
                        onProgress: (m) => progress.report({ message: m.slice(0, 100) }),
                        onAfterItemMerged: (i) => pt2?.updateProgress(i, 'completed'),
                        token,
                    });
                    pt2?.complete();
                    pt2 = undefined;

                    vscode.window.showInformationMessage(
                        `词典准备完成：规划 ${s1.totalPointsPlanned} 个查询点；查词 ${s2.totalLookupsExecuted} 次，命中 ${s2.totalHits} 条。`
                    );
                } finally {
                    this.webviewManager.refreshPanelContent(context);
                }
            }
        );
    }

    private async showDictPrepLlmConfirmation(
        jsonFilePath: string,
        totalCount: number,
        context: vscode.ExtensionContext
    ): Promise<boolean> {
        const platform = this.configManager.getPlatform();
        const model = this.configManager.getModel(platform);
        const apiKey = this.configManager.getApiKey(platform);
        if (!apiKey) {
            const r = await vscode.window.showErrorMessage(
                `未配置 ${platform} 的 API 密钥，无法调用 LLM。是否打开设置？`,
                '打开设置'
            );
            if (r === '打开设置') {
                await vscode.commands.executeCommand('workbench.action.openSettings', 'ai-proofread.apiKeys');
            }
            return false;
        }

        const config = vscode.workspace.getConfiguration('ai-proofread');
        const maxPoints = config.get<number>('dictPrep.maxPointsPerItem', 6);
        const maxLookups = config.get<number>('dictPrep.maxTotalLookupsPerRun', 200);
        const maxDef = config.get<number>('dictPrep.maxDefinitionChars', 6000);
        const cacheOn = config.get<boolean>('dictPrep.cache.enabled', true);
        const timeout = config.get<number>('proofread.timeout', 50);
        const retryDelay = config.get<number>('proofread.retryDelay', 1);
        const retryAttempts = config.get<number>('proofread.retryAttempts', 3);

        const promptName = getDictPrepPromptDisplayName(
            context.globalState.get<string>('currentDictPrepPrompt', '') ?? ''
        );

        const msg = [
            '📋 词典准备 — LLM 生成查词计划',
            '',
            `📁 文件: ${jsonFilePath}`,
            `📊 片段数: ${totalCount}`,
            '',
            '⚙️ 参数:',
            `   • 词典查询提示词: ${promptName}`,
            `   • 平台 / 模型: ${platform} / ${model}`,
            `   • 每段最多查询点数: ${maxPoints}`,
            `   • 本流程查词上限（第二步时生效）: ${maxLookups}`,
            `   • 释义最大长度: ${maxDef}`,
            `   • 词典缓存: ${cacheOn ? '开' : '关'}`,
            `   • 请求超时: ${timeout} 秒`,
            `   • 重试: ${retryDelay} 秒间隔，最多 ${retryAttempts} 次`,
            '',
            '本步仅调用 LLM 写入 .dictprep.json，不修改各段 reference。',
            '',
            '是否开始？',
        ].join('\n');

        const result = await vscode.window.showInformationMessage(msg, { modal: true }, '确认开始');
        return result === '确认开始';
    }

    private async showDictPrepLocalConfirmation(jsonFilePath: string, totalCount: number): Promise<boolean> {
        const config = vscode.workspace.getConfiguration('ai-proofread');
        const maxLookups = config.get<number>('dictPrep.maxTotalLookupsPerRun', 200);
        const maxDef = config.get<number>('dictPrep.maxDefinitionChars', 6000);
        const cacheOn = config.get<boolean>('dictPrep.cache.enabled', true);

        const msg = [
            '📋 词典准备 — 查词并入 JSON',
            '',
            `📁 文件: ${jsonFilePath}`,
            `📊 片段数: ${totalCount}`,
            '',
            '⚙️ 参数:',
            `   • 总查词次数上限: ${maxLookups}`,
            `   • 释义最大长度: ${maxDef}`,
            `   • 词典缓存: ${cacheOn ? '开' : '关'}`,
            '',
            '依赖已存在的「LLM 规划」过程文件（.dictprep.json，stage=llm_planned）。',
            '',
            '是否开始？',
        ].join('\n');

        const result = await vscode.window.showInformationMessage(msg, { modal: true }, '确认开始');
        return result === '确认开始';
    }

    /** 两步连续：一次确认（含 LLM 与本地查词参数） */
    private async showDictPrepContinuousConfirmation(
        jsonFilePath: string,
        totalCount: number,
        context: vscode.ExtensionContext
    ): Promise<boolean> {
        const platform = this.configManager.getPlatform();
        const model = this.configManager.getModel(platform);
        const apiKey = this.configManager.getApiKey(platform);
        if (!apiKey) {
            const r = await vscode.window.showErrorMessage(`未配置 ${platform} 的 API 密钥。是否打开设置？`, '打开设置');
            if (r === '打开设置') {
                await vscode.commands.executeCommand('workbench.action.openSettings', 'ai-proofread.apiKeys');
            }
            return false;
        }

        const config = vscode.workspace.getConfiguration('ai-proofread');
        const maxPoints = config.get<number>('dictPrep.maxPointsPerItem', 6);
        const maxLookups = config.get<number>('dictPrep.maxTotalLookupsPerRun', 200);
        const maxDef = config.get<number>('dictPrep.maxDefinitionChars', 6000);
        const cacheOn = config.get<boolean>('dictPrep.cache.enabled', true);
        const timeout = config.get<number>('proofread.timeout', 50);
        const retryDelay = config.get<number>('proofread.retryDelay', 1);
        const retryAttempts = config.get<number>('proofread.retryAttempts', 3);
        const promptName = getDictPrepPromptDisplayName(
            context.globalState.get<string>('currentDictPrepPrompt', '') ?? ''
        );

        const msg = [
            '📋 词典准备 — 两步连续',
            '',
            `📁 文件: ${jsonFilePath}`,
            `📊 片段数: ${totalCount}`,
            '',
            '将依次：① LLM 生成查词计划 ② 本地查词并写入 reference',
            '',
            '⚙️ 参数:',
            `   • 词典查询提示词: ${promptName}`,
            `   • 平台 / 模型: ${platform} / ${model}`,
            `   • 每段最多查询点数: ${maxPoints}`,
            `   • 总查词次数上限: ${maxLookups}`,
            `   • 释义最大长度: ${maxDef}`,
            `   • 词典缓存: ${cacheOn ? '开' : '关'}`,
            `   • 请求超时: ${timeout} 秒`,
            `   • 重试: ${retryDelay} 秒间隔，最多 ${retryAttempts} 次`,
            '',
            '是否开始？',
        ].join('\n');

        const result = await vscode.window.showInformationMessage(msg, { modal: true }, '确认开始');
        return result === '确认开始';
    }
}
