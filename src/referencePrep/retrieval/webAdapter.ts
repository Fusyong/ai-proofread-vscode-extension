/**
 * 通用网页搜索。供资料准备的 web 来源与待核断言检索共用。
 */

import * as vscode from 'vscode';
import { digestSha1 } from '../../localDict/dictLookupShared';
import { ConfigManager, Logger } from '../../utils';
import { resolveProofreadModel } from '../../modelRoutes/modelRouteResolver';
import { formatWebReferenceBlock } from '../../factCheck/formatWebReference';
import { DEFAULT_EXCLUDE_SITES, SEARCH_RESULT_COUNT } from '../../factCheck/schema';
import {
    isAnySearchKeyConfigured,
    resolveSearchProviderForReferencePrep,
    searchWeb,
} from '../../factCheck/webSearch';
import type { CorpusHit, ReferencePrepPlanQuery } from '../schema';

export interface WebSearchQueryBlock {
    searchTerms?: string[];
    why?: string;
}

export interface WebSearchAdapterResult {
    hits: CorpusHit[];
    requestsUsed: number;
}

let hitCounter = 0;

function nextHitId(): string {
    hitCounter += 1;
    return `h-web-${hitCounter}`;
}

function readExcludeSites(): string[] {
    const list = vscode.workspace.getConfiguration('ai-proofread').get<string[]>('factCheck.excludeSites', DEFAULT_EXCLUDE_SITES);
    return Array.isArray(list) && list.length > 0 ? list : DEFAULT_EXCLUDE_SITES;
}

export function isWebSearchConfigured(): boolean {
    const cm = ConfigManager.getInstance();
    return isAnySearchKeyConfigured(cm.getApiKey('deepseek'), cm.getApiKey('iqs'));
}

export async function executeWebQuery(params: {
    query: ReferencePrepPlanQuery;
    webBlock: WebSearchQueryBlock;
    priority: number;
    existingReference: string;
    roundId?: string;
    requestsBudget: { used: number; max: number };
}): Promise<WebSearchAdapterResult> {
    const logger = Logger.getInstance();
    const terms = (params.webBlock.searchTerms ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 3);
    if (terms.length === 0) return { hits: [], requestsUsed: 0 };

    const cm = ConfigManager.getInstance();
    const deepseekKey = cm.getApiKey('deepseek');
    const iqsKey = cm.getApiKey('iqs');
    const route = resolveProofreadModel();
    const setting = vscode.workspace.getConfiguration('ai-proofread').get<string>('factCheck.searchProvider', 'auto');
    const provider = resolveSearchProviderForReferencePrep({
        setting,
        proofreadPlatform: route.platform,
        deepseekKey,
        iqsKey,
    });
    if (!provider) return { hits: [], requestsUsed: 0 };
    const apiKey = provider === 'deepseek' ? deepseekKey : iqsKey;
    const excludeHosts = readExcludeSites();

    const hits: CorpusHit[] = [];
    let requestsUsed = 0;
    const seen = new Set<string>();

    for (const term of terms) {
        if (params.requestsBudget.used + requestsUsed >= params.requestsBudget.max) break;
        try {
            const found = await searchWeb({
                provider,
                apiKey,
                query: term,
                count: SEARCH_RESULT_COUNT,
                excludeHosts,
            });
            requestsUsed += 1;
            for (const item of found) {
                if (seen.has(item.url)) continue;
                seen.add(item.url);
                const block = formatWebReferenceBlock({
                    title: item.title,
                    url: item.url,
                    summary: item.summary,
                    span: term,
                    authority: item.authority,
                });
                if (params.existingReference.includes(item.url)) continue;
                const digest = digestSha1(`web|${item.url}`);
                hits.push({
                    hitId: nextHitId(),
                    source: 'web',
                    queryId: params.query.queryId,
                    baseValue: params.priority || 0.5,
                    aggregatedValue: params.priority || 0.5,
                    snippet: item.summary.slice(0, 500),
                    digest,
                    referenceBlock: block,
                    status: 'active',
                    kind: 'evidence',
                    pageTitle: item.title,
                    pageUrl: item.url,
                    roundId: params.roundId,
                    finalScore: typeof item.authority === 'number' ? item.authority / 4 : params.priority,
                });
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            logger.error(`[webAdapter] 检索失败: ${msg}`);
            requestsUsed += 1;
        }
    }
    return { hits, requestsUsed };
}
