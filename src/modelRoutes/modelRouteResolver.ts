import * as vscode from 'vscode';
import type { LlmPlatformId, ModelRouteId, ModelRouteInheritFrom } from './modelRouteRegistry';
import { getDefaultInheritFrom } from './modelRouteRegistry';

export interface ModelRouteOverride {
    inherit?: boolean;
    inheritFrom?: ModelRouteInheritFrom;
    platform?: string;
    model?: string;
    /** 显式覆盖本管线是否禁用思考；未设置则跟随上级 / 校对根开关 */
    disableThinking?: boolean;
}

export interface ResolvedModelRoute {
    platform: string;
    model: string;
    inherited: boolean;
    inheritedFrom?: ModelRouteInheritFrom;
    /** true = 禁用思考（快模式） */
    disableThinking: boolean;
    /** 本管线是否显式覆盖了思考开关 */
    thinkingOverridden: boolean;
}

/** 各平台未显式配置 proofread.models.* 时的默认模型（校对与各路由解析统一使用） */
export const FALLBACK_MODEL: Record<string, string> = {
    aliyun: 'qwen3.8-max',
    deepseek: 'deepseek-v4-flash',
    google: 'gemini-2.5-pro-exp-03-25',
    ollama: 'gemma3:1b',
};

function cfg() {
    return vscode.workspace.getConfiguration('ai-proofread');
}

function readProofreadDisableThinking(): boolean {
    return cfg().get<boolean>('proofread.disableThinking', true);
}

export function resolveProofreadModel(): ResolvedModelRoute {
    const config = cfg();
    const platform = config.get<string>('proofread.platform', 'deepseek');
    const model = config.get<string>(
        'proofread.models.' + platform,
        FALLBACK_MODEL[platform] ?? 'deepseek-v4-flash'
    );
    return {
        platform,
        model,
        inherited: false,
        disableThinking: readProofreadDisableThinking(),
        thinkingOverridden: false,
    };
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

/** 本管线是否显式配置了 disableThinking */
export function hasRouteThinkingOverride(routeId: ModelRouteId): boolean {
    if (routeId === 'proofread') return false;
    const o = readRouteOverride(routeId);
    return typeof o?.disableThinking === 'boolean';
}

/** 读取某管线的覆盖配置（不含解析） */
export function getRouteOverride(routeId: ModelRouteId): ModelRouteOverride {
    if (routeId === 'proofread') {
        const base = resolveProofreadModel();
        return {
            inherit: false,
            platform: base.platform,
            model: base.model,
            disableThinking: base.disableThinking,
        };
    }
    const o = readRouteOverride(routeId);
    if (isRouteInherited(routeId)) {
        return {
            inherit: true,
            inheritFrom: getEffectiveInheritFrom(routeId),
            ...(typeof o?.disableThinking === 'boolean' ? { disableThinking: o.disableThinking } : {}),
        };
    }
    return {
        inherit: false,
        platform: o?.platform?.trim() || undefined,
        model: o?.model?.trim() || undefined,
        ...(typeof o?.disableThinking === 'boolean' ? { disableThinking: o.disableThinking } : {}),
    };
}

export async function setRouteOverride(routeId: ModelRouteId, patch: ModelRouteOverride): Promise<void> {
    const config = cfg();
    const routes = { ...(config.get<Record<string, ModelRouteOverride>>('modelRoutes', {}) ?? {}) };
    const prev = routes[routeId] ?? {};
    routes[routeId] = { ...prev, ...patch };
    await config.update('modelRoutes', routes, vscode.ConfigurationTarget.Global);
}

/**
 * 设置或清除本管线思考覆盖。
 * - proofread：写入 `proofread.disableThinking`（value 为 undefined 时恢复默认 true）
 * - 其他：写入 modelRoutes；undefined 表示删除覆盖，恢复跟随上级
 */
export async function setRouteDisableThinking(
    routeId: ModelRouteId,
    value: boolean | undefined
): Promise<void> {
    if (routeId === 'proofread') {
        await cfg().update(
            'proofread.disableThinking',
            value === undefined ? true : value,
            vscode.ConfigurationTarget.Global
        );
        return;
    }
    const config = cfg();
    const routes = { ...(config.get<Record<string, ModelRouteOverride>>('modelRoutes', {}) ?? {}) };
    const prev: ModelRouteOverride = { ...(routes[routeId] ?? {}) };
    if (value === undefined) {
        delete prev.disableThinking;
    } else {
        prev.disableThinking = value;
    }
    routes[routeId] = prev;
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

    const o = readRouteOverride(routeId);
    const thinkingOverride = typeof o?.disableThinking === 'boolean' ? o.disableThinking : undefined;

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
            disableThinking: thinkingOverride ?? parent.disableThinking,
            thinkingOverridden: thinkingOverride !== undefined,
        };
    }

    const base = resolveProofreadModel();
    const platform = o?.platform?.trim() || base.platform;
    const model = o?.model?.trim() || modelForPlatform(platform, base.model);
    return {
        platform,
        model,
        inherited: false,
        disableThinking: thinkingOverride ?? base.disableThinking,
        thinkingOverridden: thinkingOverride !== undefined,
    };
}

/** 侧栏 / QuickPick：思考开|关（可选·覆盖） */
export function formatThinkingCurrentLabel(resolved: ResolvedModelRoute): string {
    const onOff = resolved.disableThinking ? '关' : '开';
    return resolved.thinkingOverridden ? `${onOff}·覆盖` : onOff;
}
