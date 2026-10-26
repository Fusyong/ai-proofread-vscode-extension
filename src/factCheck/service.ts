/**
 * 抽取与检索的编辑器侧入口。不改并行校对循环。
 */

import * as fs from 'fs';
import * as vscode from 'vscode';
import { llmGenerateJson } from '../llm/llmClient';
import { resolveProofreadModel } from '../modelRoutes/modelRouteResolver';
import { ConfigManager, Logger } from '../utils';
import { loadClaimsFile, saveClaimsFile } from './claimsFile';
import { extractClaimsFromSegments } from './extractClaims';
import {
    DEFAULT_EXCLUDE_SITES,
    DEFAULT_URGENCY_MIN,
    SEARCH_RESULT_COUNT,
    type FactCheckClaimsFile,
    type FactCheckHit,
    type FactCheckScope,
} from './schema';
import {
    applyHitsToParagraphs,
    attachHits,
    claimsPendingSearch,
    needsSearchConfirm,
    readParagraphs,
    writeParagraphs,
} from './searchSelected';
import { resolveSearchProvider, searchWeb } from './webSearch';

export interface FactCheckSettings {
    scope: FactCheckScope;
    urgencyMin: number;
    searchProvider: string;
    excludeSites: string[];
    deepseekKey: string;
    iqsKey: string;
    platform: string;
    model: string;
    disableThinking: boolean;
}

export function readFactCheckSettings(): FactCheckSettings {
    const config = vscode.workspace.getConfiguration('ai-proofread');
    const scope: FactCheckScope = config.get<string>('factCheck.scope', 'key') === 'general' ? 'general' : 'key';
    const urgencyRaw = config.get<number>('factCheck.defaultUrgencyMin', DEFAULT_URGENCY_MIN);
    const urgencyMin = typeof urgencyRaw === 'number' && urgencyRaw >= 0 && urgencyRaw <= 1 ? urgencyRaw : DEFAULT_URGENCY_MIN;
    const exclude = config.get<string[]>('factCheck.excludeSites', DEFAULT_EXCLUDE_SITES);
    const route = resolveProofreadModel();
    const cm = ConfigManager.getInstance();
    return {
        scope,
        urgencyMin,
        searchProvider: config.get<string>('factCheck.searchProvider', 'auto'),
        excludeSites: Array.isArray(exclude) && exclude.length > 0 ? exclude : DEFAULT_EXCLUDE_SITES,
        deepseekKey: cm.getApiKey('deepseek'),
        iqsKey: cm.getApiKey('iqs'),
        platform: route.platform,
        model: route.model,
        disableThinking: route.disableThinking,
    };
}

async function mapPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>, isCancelled?: () => boolean): Promise<void> {
    let cursor = 0;
    const workers = Math.min(limit, items.length);
    async function worker(): Promise<void> {
        while (cursor < items.length) {
            if (isCancelled?.()) return;
            const index = cursor;
            cursor += 1;
            await fn(items[index]);
        }
    }
    await Promise.all(Array.from({ length: workers }, () => worker()));
}

export async function runExtractFactClaims(
    sourceJsonPath: string,
    token?: vscode.CancellationToken
): Promise<FactCheckClaimsFile | undefined> {
    if (!fs.existsSync(sourceJsonPath)) {
        vscode.window.showErrorMessage(`找不到切分 JSON：${sourceJsonPath}`);
        return undefined;
    }
    let segments: unknown;
    try {
        segments = JSON.parse(fs.readFileSync(sourceJsonPath, 'utf8'));
    } catch (e) {
        vscode.window.showErrorMessage(`无法读取切分 JSON：${e instanceof Error ? e.message : String(e)}`);
        return undefined;
    }
    if (!Array.isArray(segments)) {
        vscode.window.showErrorMessage('切分 JSON 不是数组，无法抽取待核断言。');
        return undefined;
    }
    const settings = readFactCheckSettings();
    if (settings.platform !== 'ollama' && !ConfigManager.getInstance().getApiKey(settings.platform)) {
        vscode.window.showErrorMessage(`未配置 ${settings.platform} 的 API 密钥，无法抽取待核断言。`);
        return undefined;
    }
    const file = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: '抽取待核断言',
            cancellable: true,
        },
        async (progress, progressToken) => {
            const linked = token ?? progressToken;
            return extractClaimsFromSegments({
                segments,
                scope: settings.scope,
                urgencyMin: settings.urgencyMin,
                sourceJsonPath,
                isCancelled: () => linked.isCancellationRequested,
                onProgress: (done, total, info) => {
                    progress.report({ message: info, increment: total > 0 ? 100 / total : 0 });
                },
                generate: (systemPrompt, userPrompt) =>
                    llmGenerateJson({
                        platform: settings.platform,
                        model: settings.model,
                        systemPrompt,
                        userPrompt,
                        disableThinking: settings.disableThinking,
                        logTag: 'factCheckExtract',
                    }),
            });
        }
    );
    const saved = saveClaimsFile(file, sourceJsonPath);
    const selected = file.claims.filter((c) => c.selected).length;
    vscode.window.showInformationMessage(
        `已抽出 ${file.claims.length} 条待核断言（默认勾选 ${selected} 条），写在 ${saved}。检索写入 reference 后，请用「知识核查（item）」校对。`
    );
    return file;
}

export async function runSearchSelectedClaims(sourceJsonPath: string): Promise<FactCheckClaimsFile | undefined> {
    const file = loadClaimsFile(sourceJsonPath);
    if (!file || file.claims.length === 0) {
        vscode.window.showWarningMessage('还没有待核断言。请先抽取。');
        return undefined;
    }
    const pending = claimsPendingSearch(file.claims);
    if (pending.length === 0) {
        vscode.window.showInformationMessage('没有勾选且待检索的断言。已有资料的条目需勾选后才会检索；已检索过的不会重复查询。');
        return file;
    }
    if (needsSearchConfirm(pending.length)) {
        const choice = await vscode.window.showWarningMessage(
            `将联网检索 ${pending.length} 条断言，可能产生搜索费用。`,
            { modal: true },
            '继续'
        );
        if (choice !== '继续') return file;
    }
    const settings = readFactCheckSettings();
    const provider = resolveSearchProvider({
        setting: settings.searchProvider,
        proofreadPlatform: settings.platform,
        deepseekKey: settings.deepseekKey,
        iqsKey: settings.iqsKey,
    });
    if (!provider) {
        vscode.window.showWarningMessage(
            '当前校对平台没有可用的检索密钥，清单已保留。DeepSeek 需要 DeepSeek API Key；阿里云百炼需要单独的 IQS API Key（不是百炼 Key）。也可在设置里把 factCheck.searchProvider 指定为 deepseek 或 iqs。'
        );
        return file;
    }
    const apiKey = provider === 'deepseek' ? settings.deepseekKey : settings.iqsKey;
    const logger = Logger.getInstance();
    const hitsById = new Map<string, FactCheckHit[]>();
    let failed = 0;
    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: '检索勾选断言',
            cancellable: true,
        },
        async (progress, token) => {
            let done = 0;
            await mapPool(
                pending,
                3,
                async (claim) => {
                    if (token.isCancellationRequested) return;
                    try {
                        const hits = await searchWeb({
                            provider,
                            apiKey,
                            query: claim.query,
                            oriQuestion: claim.span,
                            count: SEARCH_RESULT_COUNT,
                            excludeHosts: settings.excludeSites,
                        });
                        hitsById.set(claim.id, hits);
                    } catch (e) {
                        failed += 1;
                        const msg = e instanceof Error ? e.message : String(e);
                        logger.error(`[factCheck] 检索失败 ${claim.query}: ${msg}`);
                    }
                    done += 1;
                    progress.report({ message: `${done}/${pending.length}`, increment: 100 / pending.length });
                },
                () => token.isCancellationRequested
            );
        }
    );
    const withHits = attachHits(file, hitsById);
    let paragraphs;
    try {
        paragraphs = readParagraphs(sourceJsonPath);
    } catch (e) {
        vscode.window.showErrorMessage(`无法写回 reference：${e instanceof Error ? e.message : String(e)}`);
        return file;
    }
    const applied = applyHitsToParagraphs(paragraphs, withHits.claims);
    writeParagraphs(sourceJsonPath, applied.paragraphs);
    const saved: FactCheckClaimsFile = { ...withHits, claims: applied.updatedClaims };
    saveClaimsFile(saved, sourceJsonPath);
    vscode.window.showInformationMessage(
        `已检索 ${hitsById.size} 条，写入 ${applied.appendedBlocks} 条网页摘录${failed ? `，失败 ${failed} 条` : ''}。请用「知识核查（item）」校对。`
    );
    return saved;
}
