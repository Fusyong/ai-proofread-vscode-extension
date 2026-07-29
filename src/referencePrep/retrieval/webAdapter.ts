/**
 * Web 检索适配器占位：通用网页搜索尚未落地。
 * 后续可接入可配置 HTTP 搜索 API（标题/摘要/URL），可选抓取正文 + LLM 摘录。
 */

import type { CorpusHit, ReferencePrepPlanQuery } from '../schema';

export interface WebSearchQueryBlock {
    searchTerms?: string[];
    why?: string;
}

export interface WebSearchAdapterResult {
    hits: CorpusHit[];
    requestsUsed: number;
}

export function isWebSearchConfigured(): boolean {
    return false;
}

export async function executeWebQuery(_params: {
    query: ReferencePrepPlanQuery;
    webBlock: WebSearchQueryBlock;
    priority: number;
    existingReference: string;
    roundId?: string;
    requestsBudget: { used: number; max: number };
}): Promise<WebSearchAdapterResult> {
    return { hits: [], requestsUsed: 0 };
}
