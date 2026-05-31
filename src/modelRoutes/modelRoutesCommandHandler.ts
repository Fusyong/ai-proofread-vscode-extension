import * as vscode from 'vscode';
import { ConfigManager } from '../utils';
import { LLM_PLATFORMS, type LlmPlatformId, type ModelRouteId } from './modelRouteRegistry';
import type { ModelRoutesTreeDataProvider } from './modelRoutesView';
import {
    isRouteInherited,
    resolveModelRoute,
    resolveProofreadModel,
    setProofreadModel,
    setProofreadPlatform,
    setRouteOverride,
} from './modelRouteResolver';

export class ModelRoutesCommandHandler {
    constructor(private treeProvider: ModelRoutesTreeDataProvider) {}

    async openView(): Promise<void> {
        await vscode.commands.executeCommand('ai-proofread.modelRoutes.focus');
    }

    async configureRoute(item?: { routeId: ModelRouteId }): Promise<void> {
        const routeId = item?.routeId;
        if (!routeId) return;

        const actions: Array<{ label: string; id: string }> = [
            { label: '$(server-environment) 选择平台', id: 'platform' },
            { label: '$(edit) 填写模型名称', id: 'model' },
        ];
        if (routeId !== 'proofread') {
            actions.push({
                label: isRouteInherited(routeId)
                    ? '$(link) 已跟随校对（点击可改为独立配置）'
                    : '$(link) 改为跟随校对',
                id: 'inherit',
            });
        }
        actions.push({ label: '$(key) 打开 API 密钥设置', id: 'apikeys' });

        const picked = await vscode.window.showQuickPick(actions, {
            title: '模型路由：' + routeId,
            ignoreFocusOut: true,
        });
        if (!picked) return;

        switch (picked.id) {
            case 'platform':
                await this.pickPlatform(routeId);
                break;
            case 'model':
                await this.pickModel(routeId);
                break;
            case 'inherit':
                await this.toggleInherit(routeId);
                break;
            case 'apikeys':
                await vscode.commands.executeCommand('workbench.action.openSettings', 'ai-proofread.apiKeys');
                break;
        }
        this.treeProvider.refresh();
    }

    private async pickPlatform(routeId: ModelRouteId): Promise<void> {
        const picked = await vscode.window.showQuickPick(
            LLM_PLATFORMS.map((p) => ({ label: p.label, id: p.id })),
            { title: '选择平台', ignoreFocusOut: true }
        );
        if (!picked) return;

        const platform = picked.id as LlmPlatformId;
        if (routeId === 'proofread') {
            await setProofreadPlatform(platform);
            const current = resolveProofreadModel();
            if (current.platform !== platform) {
                const model = await this.promptModelName(platform, '');
                if (model) await setProofreadModel(platform, model);
            }
            return;
        }

        const inherited = resolveProofreadModel();
        const existing = resolveModelRoute(routeId);
        await setRouteOverride(routeId, {
            inherit: false,
            platform,
            model: existing.platform === platform ? existing.model : inherited.model,
        });
    }

    private async pickModel(routeId: ModelRouteId): Promise<void> {
        const resolved = resolveModelRoute(routeId);
        const model = await this.promptModelName(resolved.platform, resolved.model);
        if (!model) return;

        if (routeId === 'proofread') {
            await setProofreadModel(resolved.platform, model);
            return;
        }
        await setRouteOverride(routeId, {
            inherit: false,
            platform: resolved.platform,
            model,
        });
    }

    private async promptModelName(platform: string, current: string): Promise<string | undefined> {
        const fallback = ConfigManager.getInstance().getModel(platform);
        const value = await vscode.window.showInputBox({
            title: '模型名称（' + platform + '）',
            value: current || fallback,
            ignoreFocusOut: true,
            validateInput: (v) => (v.trim() ? null : '请输入模型名称'),
        });
        return value?.trim();
    }

    private async toggleInherit(routeId: ModelRouteId): Promise<void> {
        if (routeId === 'proofread') return;
        if (isRouteInherited(routeId)) {
            const base = resolveProofreadModel();
            await setRouteOverride(routeId, {
                inherit: false,
                platform: base.platform,
                model: base.model,
            });
        } else {
            await setRouteOverride(routeId, { inherit: true, platform: undefined, model: undefined });
        }
    }
}
