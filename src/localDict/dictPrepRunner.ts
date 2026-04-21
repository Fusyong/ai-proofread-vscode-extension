import * as fs from 'fs';
import * as vscode from 'vscode';
import { createHash } from 'crypto';
import { FilePathUtils, Logger } from '../utils';
import { ensureDictFilesExist, pickDefaultDictId, resolveLocalDictConfigs, type ResolvedLocalDictConfigItem } from './dictConfig';
import { MdictClient, type LookupMode } from './mdictClient';
import { buildDictPrepSystemPrompt, buildDictPrepUserPrompt, parseDictPrepPlan, type DictPrepLookupPoint } from './dictPrepPrompt';
import { llmGenerateJson } from './dictPrepLlm';
import { convertOpencc } from '../opencc';

export interface DictPrepRunStats {
    totalItems: number;
    processedItems: number;
    totalLookupsExecuted: number;
    totalHits: number;
    totalPointsPlanned: number;
}

export interface DictPrepPlanItem {
    index: number; // 1-based
    plannedPoints: DictPrepLookupPoint[];
}

export interface DictPrepResultItem {
    index: number; // 1-based
    hits: Array<{
        pointId: string;
        dictId: string;
        queryTerm: string;
        matchedKey: string;
        mode: LookupMode;
    }>;
    errors: string[];
}

export type DictPrepResultMergeMode = 'overwrite' | 'append_new_run' | 'append_to_last_run';

export interface DictPrepResultRun {
    runId: string;
    startedAt: string;
    finishedAt?: string;
    stats?: DictPrepRunStats;
    items: DictPrepResultItem[];
}

export interface DictPrepProcessFileV030 {
    version: '0.3.0';
    sourceJsonPath: string;
    dicts: Array<{ id: string; name: string; mdxPath: string }>;
    plan: {
        runId: string;
        startedAt: string;
        finishedAt?: string;
        stats?: DictPrepRunStats;
        items: DictPrepPlanItem[];
    };
    result?: {
        runs: DictPrepResultRun[];
    };
}

export interface DictPrepProgressHooks {
    onProgress?: (msg: string) => void;
    /** 每完成一条的 LLM 规划后调用（0-based 索引） */
    onAfterItemPlanned?: (itemIndex: number) => void;
    /** 每完成一条的本地查词后调用（0-based 索引） */
    onAfterItemMerged?: (itemIndex: number) => void;
    token?: vscode.CancellationToken;
}

function sanitizeLookupTerm(term: string): string {
    // 查词阶段：统一移除候选词中的所有空白字符（如“李 白”→“李白”）
    return String(term ?? '').replace(/\s+/g, '').trim();
}

function buildLookupVariantsForTraditional(term: string): string[] {
    const base = sanitizeLookupTerm(term);
    if (!base) return [];
    const t = convertOpencc(base, 'cn', 't');
    if (t && t !== base) {
        return [base, t];
    }
    return [base];
}

function stripHtmlToText(html: string): string {
    const s = String(html ?? '');
    if (!s) return s;
    let out = s.replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
    out = out.replace(/<\s*br\s*\/?\s*>/gi, '\n');
    out = out.replace(/<\s*\/\s*p\s*>/gi, '\n');
    out = out.replace(/<\s*\/\s*div\s*>/gi, '\n');
    out = out.replace(/<[^>]+>/g, '');
    out = out
        .replace(/&nbsp;/gi, ' ')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/g, "'");
    out = out.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    out = out.replace(/\n{3,}/g, '\n\n');
    return out.trim();
}

function limitCleanText(s: string, maxChars: number): string {
    const text = String(s ?? '');
    if (!text) return text;
    if (!maxChars || maxChars <= 0) return text;
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars) + '\n\n[...已截断...]';
}

function sha1(text: string): string {
    return createHash('sha1').update(text).digest('hex').slice(0, 12);
}

function resolveSystemPrompt(context: vscode.ExtensionContext): string {
    const currentName = context.globalState.get<string>('currentDictPrepPrompt', '') ?? '';
    if (currentName === '') {
        return buildDictPrepSystemPrompt();
    }
    const prompts =
        vscode.workspace.getConfiguration('ai-proofread').get<Array<{ name: string; content: string }>>('dictPrep.prompts', []) ?? [];
    const selected = prompts.find((p) => p.name === currentName);
    return selected?.content?.trim() ? selected.content : buildDictPrepSystemPrompt();
}

function appendLog(logPath: string, m: string, onProgress?: (msg: string) => void): void {
    onProgress?.(m);
    fs.appendFileSync(logPath, m + '\n', 'utf8');
}

async function buildPlanForItem(params: {
    platform: string;
    model: string;
    systemPrompt: string;
    target: string;
    dicts: ResolvedLocalDictConfigItem[];
    maxPoints: number;
}): Promise<{ lookups: DictPrepLookupPoint[] }> {
    const userPrompt = buildDictPrepUserPrompt({
        target: params.target,
        dicts: params.dicts,
        maxPoints: params.maxPoints,
    });
    const raw = await llmGenerateJson({
        platform: params.platform,
        model: params.model,
        systemPrompt: params.systemPrompt,
        userPrompt,
    });
    const parsed = parseDictPrepPlan(raw);
    return { lookups: parsed.lookups.slice(0, params.maxPoints) };
}

/**
 * 第一段：仅调用 LLM 生成查词计划，写入 .dictprep.json（stage=llm_planned），不修改主 JSON 的 reference。
 */
export async function planDictPrepQueriesOnly(
    params: {
        jsonFilePath: string;
        context: vscode.ExtensionContext;
    } & DictPrepProgressHooks
): Promise<DictPrepRunStats> {
    const logger = Logger.getInstance();
    const config = vscode.workspace.getConfiguration('ai-proofread');

    const dicts = resolveLocalDictConfigs();
    if (dicts.length === 0) {
        throw new Error('未配置本地词典：请在设置中配置 ai-proofread.localDicts');
    }
    const exist = ensureDictFilesExist(dicts);
    if (!exist.ok) {
        throw new Error(exist.errors.join('\n'));
    }

    const maxPointsPerItem = config.get<number>('dictPrep.maxPointsPerItem', 6);

    const platform = config.get<string>('proofread.platform', 'deepseek');
    const model = config.get<string>(`proofread.models.${platform}`, '');
    if (!model) {
        throw new Error(`未配置模型：ai-proofread.proofread.models.${platform}`);
    }

    const raw = fs.readFileSync(params.jsonFilePath, 'utf8');
    const items = JSON.parse(raw);
    if (!Array.isArray(items) || !items.every((x) => x && typeof x === 'object' && 'target' in x)) {
        throw new Error('JSON 文件格式不正确：需要包含 target 字段的对象数组');
    }

    const processPath = FilePathUtils.getFilePath(params.jsonFilePath, '.dictprep', '.json');
    const logPath = FilePathUtils.getFilePath(params.jsonFilePath, '.dictprep', '.log');

    const nowIso = new Date().toISOString();
    const planRunId = `plan-${nowIso}`;
    const existing = fs.existsSync(processPath) ? (JSON.parse(fs.readFileSync(processPath, 'utf8')) as any) : undefined;
    const existingRuns: DictPrepResultRun[] =
        existing?.version === '0.3.0' && Array.isArray(existing?.result?.runs) ? (existing.result.runs as DictPrepResultRun[]) : [];

    const proc: DictPrepProcessFileV030 = {
        version: '0.3.0',
        sourceJsonPath: params.jsonFilePath,
        dicts: dicts.map((d) => ({ id: d.id, name: d.name, mdxPath: d.mdxPathResolved })),
        plan: {
            runId: planRunId,
            startedAt: nowIso,
            items: [],
        },
        result: { runs: existingRuns },
    };
    fs.writeFileSync(processPath, JSON.stringify(proc, null, 2), 'utf8');

    const systemPrompt = resolveSystemPrompt(params.context);

    let totalPointsPlanned = 0;
    let processedItems = 0;

    appendLog(logPath, `Phase LLM Start: ${new Date().toLocaleString()}`, params.onProgress);
    appendLog(logPath, `Dicts: ${dicts.map((d) => `${d.id}:${d.name}`).join(' | ')}`, params.onProgress);
    appendLog(logPath, `Model: ${platform}, ${model}`, params.onProgress);

    for (let idx = 0; idx < items.length; idx++) {
        if (params.token?.isCancellationRequested) {
            break;
        }

        const item = items[idx];
        const target = String(item.target ?? '');
        if (!target.trim()) {
            params.onAfterItemPlanned?.(idx);
            continue;
        }
        if (maxPointsPerItem <= 0) {
            break;
        }

        const itemNo = idx + 1;
        appendLog(logPath, `规划 No.${itemNo}/${items.length}（targetLen=${target.length}）`, params.onProgress);

        const plan = await buildPlanForItem({
            platform,
            model,
            systemPrompt,
            target,
            dicts,
            maxPoints: maxPointsPerItem,
        });

        const planned = plan.lookups.slice(0, maxPointsPerItem);
        totalPointsPlanned += planned.length;

        const planItem: DictPrepPlanItem = { index: itemNo, plannedPoints: planned };
        proc.plan.items.push(planItem);
        fs.writeFileSync(processPath, JSON.stringify(proc, null, 2), 'utf8');
        processedItems++;
        params.onAfterItemPlanned?.(idx);
    }

    const stats: DictPrepRunStats = {
        totalItems: items.length,
        processedItems,
        totalLookupsExecuted: 0,
        totalHits: 0,
        totalPointsPlanned,
    };
    proc.plan.stats = stats;
    proc.plan.finishedAt = new Date().toISOString();
    fs.writeFileSync(processPath, JSON.stringify(proc, null, 2), 'utf8');

    appendLog(
        logPath,
        `Phase LLM Done: items=${processedItems}/${items.length}, plannedPoints=${totalPointsPlanned}`,
        params.onProgress
    );
    logger.info(`[dictPrepRunner] plan phase done: ${JSON.stringify(stats)}`);

    return stats;
}

/**
 * 第二段：根据 .dictprep.json 中的计划查询本地词典，合并 reference，stage → local_merged。
 */
export async function mergeDictPrepReferencesFromPlans(
    params: {
        jsonFilePath: string;
        context: vscode.ExtensionContext;
        mergeMode?: DictPrepResultMergeMode;
    } & DictPrepProgressHooks
): Promise<DictPrepRunStats> {
    const logger = Logger.getInstance();
    const config = vscode.workspace.getConfiguration('ai-proofread');

    const dicts = resolveLocalDictConfigs();
    if (dicts.length === 0) {
        throw new Error('未配置本地词典：请在设置中配置 ai-proofread.localDicts');
    }
    const exist = ensureDictFilesExist(dicts);
    if (!exist.ok) {
        throw new Error(exist.errors.join('\n'));
    }

    const defaultDictId = pickDefaultDictId(dicts);
    const maxTotalLookupsPerRun = config.get<number>('dictPrep.maxTotalLookupsPerRun', 200);
    const maxDefinitionChars = config.get<number>('dictPrep.maxDefinitionChars', 6000);
    const cacheEnabled = config.get<boolean>('dictPrep.cache.enabled', true);
    const cacheTtlHours = config.get<number>('dictPrep.cache.ttlHours', 0);

    const processPath = FilePathUtils.getFilePath(params.jsonFilePath, '.dictprep', '.json');
    const logPath = FilePathUtils.getFilePath(params.jsonFilePath, '.dictprep', '.log');

    if (!fs.existsSync(processPath)) {
        throw new Error('未找到查词准备过程文件（.dictprep.json）。请先执行「LLM 生成查词计划」。');
    }

    const procAny = JSON.parse(fs.readFileSync(processPath, 'utf8')) as any;
    if (procAny?.version !== '0.3.0') {
        throw new Error('过程文件版本不匹配：需要 0.3.0。请重新执行「LLM 生成查词计划」。');
    }
    if (!Array.isArray(procAny?.plan?.items)) {
        throw new Error('过程文件中未找到查词规划（plan.items）。请先执行「LLM 生成查词计划」。');
    }

    const planItems: DictPrepPlanItem[] = procAny.plan.items as DictPrepPlanItem[];
    const existingRuns: DictPrepResultRun[] = Array.isArray(procAny?.result?.runs) ? (procAny.result.runs as DictPrepResultRun[]) : [];

    const mergeMode: DictPrepResultMergeMode = params.mergeMode ?? 'append_new_run';
    const nowIso = new Date().toISOString();
    const run: DictPrepResultRun = {
        runId: `run-${nowIso}`,
        startedAt: nowIso,
        items: [],
    };

    const raw = fs.readFileSync(params.jsonFilePath, 'utf8');
    const items = JSON.parse(raw);
    if (!Array.isArray(items) || !items.every((x) => x && typeof x === 'object' && 'target' in x)) {
        throw new Error('JSON 文件格式不正确：需要包含 target 字段的对象数组');
    }

    const client = MdictClient.getInstance(params.context);

    let totalLookupsExecuted = 0;
    let totalHits = 0;
    let totalPointsPlanned = 0;
    let processedItems = 0;

    appendLog(logPath, `Phase local Start: ${new Date().toLocaleString()}`, params.onProgress);

    const plannedIndexSet = new Set(planItems.map((p) => p.index - 1));
    for (let i = 0; i < items.length; i++) {
        if (!plannedIndexSet.has(i)) {
            params.onAfterItemMerged?.(i);
        }
    }

    for (const planItem of planItems) {
        if (params.token?.isCancellationRequested) {
            break;
        }

        const idx = planItem.index - 1;
        if (idx < 0 || idx >= items.length) {
            run.items.push({ index: planItem.index, hits: [], errors: [`条目 index=${planItem.index} 超出 JSON 范围`] });
            continue;
        }

        const item = items[idx];
        const target = String(item.target ?? '');
        if (!target.trim()) {
            params.onAfterItemMerged?.(idx);
            continue;
        }

        totalPointsPlanned += planItem.plannedPoints.length;
        const resultItem: DictPrepResultItem = { index: planItem.index, hits: [], errors: [] };

        let reference: string = typeof item.reference === 'string' ? item.reference : '';
        const planned = planItem.plannedPoints;

        for (const p of planned) {
            if (totalLookupsExecuted >= maxTotalLookupsPerRun) {
                resultItem.errors.push(`达到总查词上限 ${maxTotalLookupsPerRun}，中止后续查询点`);
                break;
            }
            const mode: LookupMode = 'exact';
            const candidates = (p.candidates ?? [])
                .map((c) => sanitizeLookupTerm(c))
                .filter((c) => !!c)
                .slice(0, 3);
            if (candidates.length === 0) continue;

            const preferredDictId = p.dictId && dicts.some((d) => d.id === p.dictId) ? p.dictId : null;
            const dictTryList = buildDictTryList(dicts, preferredDictId, defaultDictId);
            if (dictTryList.length === 0) {
                resultItem.errors.push(`pointId=${p.pointId}: 未能确定词典`);
                continue;
            }

            // 对该 point：不在命中后立即停止；遍历所有候选/词典/变体后取“净文本最长”的那条
            let best:
                | {
                      h: { dictName: string; dictId: string; queryTerm: string; matchedKey: string; mode: LookupMode };
                      cleaned: string;
                      digest: string;
                      term: string;
                      dictIdForLegacy: string;
                  }
                | undefined;
            for (const dict of dictTryList) {
                if (totalLookupsExecuted >= maxTotalLookupsPerRun) break;

                for (const c of candidates) {
                    if (totalLookupsExecuted >= maxTotalLookupsPerRun) break;

                    // 同一候选词：先查原样（去空白），未命中再查繁体（若不同）
                    const variants = buildLookupVariantsForTraditional(c);
                    for (const term of variants) {
                        if (totalLookupsExecuted >= maxTotalLookupsPerRun) break;
                        totalLookupsExecuted++;

                        appendLog(
                            logPath,
                            `Lookup ${totalLookupsExecuted}/${maxTotalLookupsPerRun}: item=${planItem.index} pointId=${p.pointId} dict=${dict.id} term=${term}`,
                            params.onProgress
                        );

                        let hits: Awaited<ReturnType<typeof client.lookupMany>> = [];
                        try {
                            hits = await client.lookupMany(dict, term, mode, {
                                prefixMaxCandidates: 0,
                                minPrefixLength: 999,
                                maxDefinitionChars,
                                cacheEnabled,
                                cacheTtlHours,
                            });
                        } catch (e) {
                            const msg = e instanceof Error ? e.message : String(e);
                            resultItem.errors.push(`pointId=${p.pointId} dict=${dict.id} term=${term}: lookup failed: ${msg}`);
                            appendLog(logPath, `Lookup ERROR: ${msg}`, params.onProgress);
                            continue;
                        }
                        if (hits.length > 0) {
                            for (const h of hits) {
                                const cleaned = limitCleanText(stripHtmlToText(h.definition), maxDefinitionChars);
                                const digest = sha1(`${h.matchedKey}\n${cleaned}`);

                                const legacyKey = buildDedupKeyLegacy(dict.id, term, mode);
                                const header = `【本地词典】${h.dictName}｜${h.matchedKey}`;
                                const fingerprint = `${header}\n\n${cleaned}`;
                                const beginTag = buildLocalDictEntryBeginTag(digest);
                                if (reference.includes(beginTag) || reference.includes(fingerprint) || reference.includes(legacyKey)) {
                                    continue;
                                }

                                if (!best || cleaned.length > best.cleaned.length) {
                                    best = {
                                        h: {
                                            dictName: h.dictName,
                                            dictId: h.dictId,
                                            queryTerm: h.queryTerm,
                                            matchedKey: h.matchedKey,
                                            mode: h.mode,
                                        },
                                        cleaned,
                                        digest,
                                        term,
                                        dictIdForLegacy: dict.id,
                                    };
                                }
                            }
                        }
                    }
                }
            }

            if (best) {
                const legacyKey = buildDedupKeyLegacy(best.dictIdForLegacy, best.term, mode);
                const header = `【本地词典】${best.h.dictName}｜${best.h.matchedKey}`;
                const fingerprint = `${header}\n\n${best.cleaned}`;
                const beginTag = buildLocalDictEntryBeginTag(best.digest);
                if (!reference.includes(beginTag) && !reference.includes(fingerprint) && !reference.includes(legacyKey)) {
                    const block = formatReferenceBlockV2({
                        dictName: best.h.dictName,
                        dictId: best.h.dictId,
                        queryTerm: best.h.queryTerm,
                        matchedKey: best.h.matchedKey,
                        mode: best.h.mode,
                        definition: best.cleaned,
                        digest: best.digest,
                    });
                    reference = reference ? `${reference}\n\n${block}` : block;
                    resultItem.hits.push({
                        pointId: p.pointId,
                        dictId: best.h.dictId,
                        queryTerm: best.h.queryTerm,
                        matchedKey: best.h.matchedKey,
                        mode: best.h.mode,
                    });
                    totalHits++;
                }
            }
        }

        if (reference && reference !== item.reference) {
            item.reference = reference;
        }

        run.items.push(resultItem);
        fs.writeFileSync(params.jsonFilePath, JSON.stringify(items, null, 2), 'utf8');
        processedItems++;
        params.onAfterItemMerged?.(idx);
    }

    const stats: DictPrepRunStats = {
        totalItems: items.length,
        processedItems,
        totalLookupsExecuted,
        totalHits,
        totalPointsPlanned,
    };
    run.stats = stats;
    run.finishedAt = new Date().toISOString();

    const nextRuns = (() => {
        if (mergeMode === 'overwrite') return [run];
        if (mergeMode === 'append_to_last_run' && existingRuns.length > 0) {
            const last = existingRuns[existingRuns.length - 1];
            last.items.push(...run.items);
            last.stats = run.stats;
            last.finishedAt = run.finishedAt;
            return existingRuns;
        }
        return [...existingRuns, run];
    })();

    const procOut: DictPrepProcessFileV030 = {
        version: '0.3.0',
        sourceJsonPath: params.jsonFilePath,
        dicts: dicts.map((d) => ({ id: d.id, name: d.name, mdxPath: d.mdxPathResolved })),
        plan: {
            runId: String(procAny.plan?.runId ?? 'plan-unknown'),
            startedAt: String(procAny.plan?.startedAt ?? ''),
            finishedAt: procAny.plan?.finishedAt as any,
            stats: procAny.plan?.stats as any,
            items: planItems,
        },
        result: { runs: nextRuns },
    };
    fs.writeFileSync(processPath, JSON.stringify(procOut, null, 2), 'utf8');

    appendLog(
        logPath,
        `Phase local Done: items=${processedItems}, lookups=${totalLookupsExecuted}, hits=${totalHits}`,
        params.onProgress
    );
    logger.info(`[dictPrepRunner] merge phase done: ${JSON.stringify(stats)}`);

    return stats;
}

/**
 * 两段连续执行：先 LLM 规划，再本地查词（兼容旧版「一键」行为）。
 */
export async function prepareReferencesFromLocalDicts(
    params: {
        jsonFilePath: string;
        context: vscode.ExtensionContext;
        onProgress?: (msg: string) => void;
        onAfterItemPlanned?: (itemIndex: number) => void;
        onAfterItemMerged?: (itemIndex: number) => void;
        token?: vscode.CancellationToken;
    }
): Promise<DictPrepRunStats> {
    const hooks: DictPrepProgressHooks = {
        onProgress: params.onProgress,
        onAfterItemPlanned: params.onAfterItemPlanned,
        onAfterItemMerged: params.onAfterItemMerged,
        token: params.token,
    };
    await planDictPrepQueriesOnly({ jsonFilePath: params.jsonFilePath, context: params.context, ...hooks });
    return mergeDictPrepReferencesFromPlans({ jsonFilePath: params.jsonFilePath, context: params.context, ...hooks });
}

function buildDedupKey(dictId: string, term: string, mode: LookupMode): string {
    const t = sanitizeLookupTerm(term);
    return `<!-- ai-proofread:dictref dictId=${dictId} mode=${mode} term=${escapeAttr(t)} -->`;
}

function buildLocalDictEntryBeginTag(sha1Digest: string): string {
    // 仅保留 sha1 作为轻量去重键；不写 dictId/dictName/headword 等元信息
    return `<!-- ai-proofread:localDictEntry begin sha1=${sha1Digest} -->`;
}

function buildLocalDictEntryEndTag(): string {
    return `<!-- ai-proofread:localDictEntry end -->`;
}

function buildDedupKeyLegacy(dictId: string, term: string, mode: LookupMode): string {
    // 兼容旧版：曾把连续空白折叠为单空格（而非完全移除）
    const t = (term ?? '').trim().replace(/\s+/g, ' ');
    return `<!-- ai-proofread:dictref dictId=${dictId} mode=${mode} term=${escapeAttr(t)} -->`;
}

function escapeAttr(s: string): string {
    return s.replace(/-->/g, '--\\>');
}

function formatReferenceBlock(
    hit: { dictName: string; dictId: string; queryTerm: string; matchedKey: string; mode: LookupMode; definition: string },
    dedupKey: string
): string {
    const header = `【本地词典】${hit.dictName}（${hit.dictId}） | mode=${hit.mode} | query=${hit.queryTerm} | hit=${hit.matchedKey}`;
    return [dedupKey, header, '', hit.definition, '<!-- ai-proofread:dictref end -->'].join('\n');
}

function formatReferenceBlockV2(
    hit: {
        dictName: string;
        dictId: string;
        queryTerm: string;
        matchedKey: string;
        mode: LookupMode;
        definition: string;
        digest: string;
    },
): string {
    const begin = buildLocalDictEntryBeginTag(hit.digest);
    // LLM 友好：仅保留来源与词头，去掉 query/mode 等“对校对无用”的元信息
    const header = `【本地词典】${hit.dictName}｜${hit.matchedKey}`;
    return [
        begin,
        header,
        '',
        hit.definition,
        buildLocalDictEntryEndTag(),
    ].join('\n');
}

function buildDictTryList(
    dicts: ResolvedLocalDictConfigItem[],
    preferredDictId: string | null,
    defaultDictId?: string
): ResolvedLocalDictConfigItem[] {
    if (dicts.length === 0) return [];
    const byPriority = [...dicts].sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));

    const picked: ResolvedLocalDictConfigItem[] = [];
    const seen = new Set<string>();

    const pushById = (id?: string | null) => {
        if (!id) return;
        const d = dicts.find((x) => x.id === id);
        if (!d) return;
        if (seen.has(d.id)) return;
        picked.push(d);
        seen.add(d.id);
    };

    pushById(preferredDictId);
    pushById(defaultDictId ?? null);
    for (const d of byPriority) {
        if (seen.has(d.id)) continue;
        picked.push(d);
        seen.add(d.id);
    }
    return picked;
}
