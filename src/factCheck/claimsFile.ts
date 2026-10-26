/**
 * 待核清单的组段、上限与读写。检索不在这里发生。
 */

import * as fs from 'fs';
import {
    claimsPathForSourceJson,
    defaultClaimSelected,
    FACT_CHECK_CLAIMS_VERSION,
    isCitationSegment,
    MAX_GENERAL_CLAIMS_PER_SEGMENT,
    MAX_KEY_CLAIMS_PER_SEGMENT,
    scopeForCategory,
    type FactCheckClaim,
    type FactCheckClaimsFile,
    type FactCheckScope,
    type FactCheckStatus,
} from './schema';
import { parseFactCheckExtractOutput, type ParsedExtractClaim } from './extractPrompt';

export interface FactCheckSegmentInput {
    target?: unknown;
    reference?: unknown;
    context?: unknown;
}

export function readSegmentText(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

export function segmentHasReference(reference: string): boolean {
    return reference.trim().length > 0;
}

export function shouldSkipSegment(target: string): 'empty' | 'citation' | undefined {
    if (!target.trim()) return 'empty';
    if (isCitationSegment(target)) return 'citation';
    return undefined;
}

/** 按段截断：关键事实最多 6 条；general 范围再加最多 4 条一般问题 */
export function capClaimsForSegment(claims: ParsedExtractClaim[], scope: FactCheckScope): ParsedExtractClaim[] {
    const key: ParsedExtractClaim[] = [];
    const general: ParsedExtractClaim[] = [];
    for (const c of claims) {
        if (scopeForCategory(c.category) === 'key') {
            if (key.length < MAX_KEY_CLAIMS_PER_SEGMENT) key.push(c);
        } else if (scope === 'general' && general.length < MAX_GENERAL_CLAIMS_PER_SEGMENT) {
            general.push(c);
        }
    }
    return [...key, ...general];
}

export function buildClaimsForSegment(params: {
    segmentIndex: number;
    rawModelOutput: string;
    scope: FactCheckScope;
    urgencyMin: number;
    reference: string;
}): FactCheckClaim[] {
    const parsed = capClaimsForSegment(parseFactCheckExtractOutput(params.rawModelOutput, params.scope), params.scope);
    const status: FactCheckStatus = segmentHasReference(params.reference) ? 'has_reference' : 'pending';
    return parsed.map((c, i) => {
        const scope = scopeForCategory(c.category);
        const claim: FactCheckClaim = {
            id: `${params.segmentIndex}:${i}`,
            segmentIndex: params.segmentIndex,
            span: c.span,
            category: c.category,
            scope,
            urgency: c.urgency,
            urgencyReason: c.urgencyReason,
            query: c.query,
            selected: false,
            status,
        };
        claim.selected = defaultClaimSelected(claim, params.urgencyMin);
        return claim;
    });
}

export function createClaimsFile(params: {
    sourceJsonPath: string;
    scope: FactCheckScope;
    claims: FactCheckClaim[];
    extractedAt?: string;
}): FactCheckClaimsFile {
    return {
        version: FACT_CHECK_CLAIMS_VERSION,
        sourceJsonPath: params.sourceJsonPath,
        scope: params.scope,
        extractedAt: params.extractedAt ?? new Date().toISOString(),
        claims: params.claims,
    };
}

export function saveClaimsFile(file: FactCheckClaimsFile, sourceJsonPath?: string): string {
    const target = claimsPathForSourceJson(sourceJsonPath ?? file.sourceJsonPath);
    fs.writeFileSync(target, JSON.stringify(file, null, 2), 'utf8');
    return target;
}

export function loadClaimsFile(sourceJsonPath: string): FactCheckClaimsFile | undefined {
    const target = claimsPathForSourceJson(sourceJsonPath);
    if (!fs.existsSync(target)) return undefined;
    try {
        const parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as FactCheckClaimsFile;
        if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.claims)) return undefined;
        return parsed;
    } catch {
        return undefined;
    }
}

export function loadClaimsFileByPath(claimsPath: string): FactCheckClaimsFile | undefined {
    if (!fs.existsSync(claimsPath)) return undefined;
    try {
        const parsed = JSON.parse(fs.readFileSync(claimsPath, 'utf8')) as FactCheckClaimsFile;
        if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.claims)) return undefined;
        return parsed;
    } catch {
        return undefined;
    }
}
