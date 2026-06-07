import * as vscode from 'vscode';
import type { LlmPlatformId, ModelRouteId, ModelRouteInheritFrom } from './modelRouteRegistry';
import { getDefaultInheritFrom } from './modelRouteRegistry';

export interface ModelRouteOverride {
    inherit?: boolean;
    inheritFrom?: ModelRouteInheritFrom;
    platform?: string;
    model?: string;
}

export interface ResolvedModelRoute {
    platform: string;
    model: string;
    inherited: boolean;
    inheritedFrom?: ModelRouteInheritFrom;
}

/** 各平台未显式配置 proofread.models.* 时的默认模型（校对与各路由解析统一使用） */
export const FALLBACK_MODEL: Record<string, string> = {
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

export function getEffectiveInheritFrom(routeId: ModelRouteId): ModelRouteInheritFrom {
    const o = readRouteOverride(routeId);
    return o?.inheritFrom ?? getDefaultInheritFrom(routeId);
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
        return { inherit: true, inheritFrom: getEffectiveInheritFrom(routeId) };
    }
    return {
        inherit: false,
        platform: o?.platform?.trim() || undefined,
        model: o?.model?.trim() || undefined,
    };
}

export async function setRouteOverride(routeId: ModelRouteId, patch: ModelRouteOverride): Promise<void> {
    const config = cfg();
    const routes = { ...(config.get<Record<string, ModelRouteOverride>>('modelRoutes', {}) ?? {}) };
    const prev = routes[routeId] ?? {};
    routes[routeId] = { ...prev, ...patch };
    await config.update('modelRoutes', routes, vscode.ConfigurationTarget.Global);
}

export async function setProofreadPlatform(platform: LlmPlatformId): Promise<void> {
    await cfg().update('proofread.platform', platform, vscode.ConfigurationTarget.Global);
}

export async function setProofreadModel(platform: string, model: string): Promise<void> {
    await cfg().update('proofread.models.' + platform, model, vscode.ConfigurationTarget.Global);
}

function modelForPlatform(platform: string, fallbackModel: string): string {
    return cfg().get<string>('proofread.models.' + platform, FALLBACK_MODEL[platform] ?? fallbackModel);
}

export function resolveModelRoute(routeId: ModelRouteId): ResolvedModelRoute {
    if (routeId === 'proofread') {
        return resolveProofreadModel();
    }

    if (isRouteInherited(routeId)) {
        const inheritedFrom = getEffectiveInheritFrom(routeId);
        const parent =
            inheritedFrom === 'referencePrep'
                ? resolveModelRoute('referencePrep')
                : resolveProofreadModel();
        return {
            platform: parent.platform,
            model: parent.model,
            inherited: true,
            inheritedFrom,
        };
    }

    const o = getRouteOverride(routeId);
    const base = resolveProofreadModel();
    const platform = o.platform?.trim() || base.platform;
    const model = o.model?.trim() || modelForPlatform(platform, base.model);
    return { platform, model, inherited: false };
}
