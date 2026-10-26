/**
 * 按核查范围从切分 JSON 抽出待核断言。模型调用由参数注入。
 */

import { Logger } from '../utils';
import { buildFactCheckExtractSystemPrompt, buildFactCheckExtractUserPrompt } from './extractPrompt';
import {
    buildClaimsForSegment,
    createClaimsFile,
    readSegmentText,
    shouldSkipSegment,
    type FactCheckSegmentInput,
} from './claimsFile';
import type { FactCheckClaim, FactCheckClaimsFile, FactCheckScope } from './schema';

export interface ExtractClaimsParams {
    segments: FactCheckSegmentInput[];
    scope: FactCheckScope;
    urgencyMin: number;
    sourceJsonPath: string;
    generate: (systemPrompt: string, userPrompt: string) => Promise<string>;
    onProgress?: (done: number, total: number, info: string) => void;
    isCancelled?: () => boolean;
}

export async function extractClaimsFromSegments(params: ExtractClaimsParams): Promise<FactCheckClaimsFile> {
    const logger = Logger.getInstance();
    const total = params.segments.length;
    const claims: FactCheckClaim[] = [];
    const system = buildFactCheckExtractSystemPrompt(params.scope);
    let done = 0;
    for (let i = 0; i < total; i++) {
        if (params.isCancelled?.()) break;
        const seg = params.segments[i] ?? {};
        const target = readSegmentText(seg.target);
        const reference = readSegmentText(seg.reference);
        const context = readSegmentText(seg.context);
        const skip = shouldSkipSegment(target);
        done++;
        if (skip) {
            params.onProgress?.(done, total, `跳过第 ${i + 1} 段（${skip === 'empty' ? '空' : '引文'}）`);
            continue;
        }
        params.onProgress?.(done, total, `抽取第 ${i + 1}/${total} 段`);
        try {
            const raw = await params.generate(system, buildFactCheckExtractUserPrompt(target, context));
            claims.push(
                ...buildClaimsForSegment({
                    segmentIndex: i,
                    rawModelOutput: raw,
                    scope: params.scope,
                    urgencyMin: params.urgencyMin,
                    reference,
                })
            );
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            logger.error(`[factCheck] 第 ${i + 1} 段抽取失败: ${msg}`);
            params.onProgress?.(done, total, `第 ${i + 1} 段抽取失败: ${msg}`);
        }
    }
    return createClaimsFile({
        sourceJsonPath: params.sourceJsonPath,
        scope: params.scope,
        claims,
    });
}
