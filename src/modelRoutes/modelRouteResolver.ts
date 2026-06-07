import * as vscode from 'vscode';
import type { LlmPlatformId, ModelRouteId } from './modelRouteRegistry';

export interface ModelRouteOverride {
    inherit?: boolean;
    platform?: string;
    model?: string;
}

export interface ResolvedModelRoute {
    platform: string;
    model: string;
    inherited: boolean;
    inheritedFrom?: 'proofread';
}

const FALLBACK_MODEL: Record<string, string> = {
    aliyun: 'qwen3-max',
    deepseek: 'deepseek-v4-flash',
    google: 'gemini-2.5-pro-exp-03-25',
    ollama: 'gemma3:1b',
};

function cfg() {
    return vscode.workspace.getConfiguration('ai-proofread');
}

export function resolveProofreadModel(): ResolvedModelRoute {
    const config = cfg();
    const platform = config.get<string>('proofread.platform', 'deepseek');
    const model = config.get<string>(
        'proofread.models.' + platform,
        FALLBACK_MODEL[platform] ?? 'deepseek-v4-flash'
    );
    return { platform, model, inherited: false };
}

function readRouteOverride(routeId: ModelRouteId): ModelRouteOverride | undefined {
    const routes = cfg().get<Record<string, ModelRouteOverride>>('modelRoutes', {});
    return routes?.[routeId];
}

export function isRouteInherited(routeId: ModelRouteId): boolean {
    if (routeId === 'proofread') return false;
    const o = readRouteOverride(routeId);
    return o?.inherit !== false && !o?.platform?.trim();
}

/** 读取某管线的覆盖配置（不含解析） */
export function getRouteOverride(routeId: ModelRouteId): ModelRouteOverride {
    if (routeId === 'proofread') {
        const base = resolveProofreadModel();
        return { inherit: false, platform: base.platform, model: base.model };
    }
    const o = readRouteOverride(routeId);
    if (isRouteInherited(routeId)) {
        return { inherit: true };
    }
    const config = cfg();
    let platform = o?.platform?.trim();
    let model = o?.model?.trim();
    if (routeId === 'referencePrep' || routeId === 'referencePrepRerank') {
        platform = platform || config.get<string>('referencePrep.platform')?.trim();
        if (platform && !model) {
            model = config.get<string>('referencePrep.models.' + platform)?.trim();
        }
    }
    if (routeId === 'editorialMemory') {
        const legacyModel = config.get<string>('editorialMemory.mergeModelOverride', '').trim();
        if (!model && legacyModel) model = legacyModel;
    }
    return {
        inherit: false,
        platform: platform || undefined,
        model: model || undefined,
    };
}

export async function setRouteOverride(routeId: ModelRouteId, patch: ModelRouteOverride): Promise<void> {
    const config = cfg();
    const routes = { ...(config.get<Record<string, ModelRouteOverride>>('modelRoutes', {}) ?? {}) };
    const prev = routes[routeId] ?? {};
    routes[routeId] = { ...prev, ...patch };
    await config.update('modelRoutes', routes, vscode.ConfigurationTarget.Global);

    if (routeId === 'referencePrep' && patch.inherit === false && patch.platform) {
        await config.update('referencePrep.platform', patch.platform, vscode.ConfigurationTarget.Global);
        if (patch.model) {
            await config.update('referencePrep.models.' + patch.platform, patch.model, vscode.ConfigurationTarget.Global);
        }
    }
    if (routeId === 'editorialMemory' && patch.model) {
        await config.update('editorialMemory.mergeModelOverride', patch.model, vscode.ConfigurationTarget.Global);
    }
}

export async function setProofreadPlatform(platform: LlmPlatformId): Promise<void> {
    await cfg().update('proofread.platform', platform, vscode.ConfigurationTarget.Global);
}

export async function setProofreadModel(platform: string, model: string): Promise<void> {
    await cfg().update('proofread.models.' + platform, model, vscode.ConfigurationTarget.Global);
}

export function resolveModelRoute(routeId: ModelRouteId): ResolvedModelRoute {
    if (routeId === 'proofread') {
        return resolveProofreadModel();
    }

    const base = resolveProofreadModel();
    if (isRouteInherited(routeId)) {
        return { platform: base.platform, model: base.model, inherited: true, inheritedFrom: 'proofread' };
    }

    const o = getRouteOverride(routeId);
    const platform = o.platform?.trim() || base.platform;
    let model = o.model?.trim();
    if (!model) {
        model = cfg().get<string>('proofread.models.' + platform, FALLBACK_MODEL[platform] ?? base.model);
    }
    return { platform, model, inherited: false };
}
