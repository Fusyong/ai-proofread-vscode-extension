import * as fs from 'fs';
import * as vscode from 'vscode';
import { createHash } from 'crypto';
import { FilePathUtils, Logger } from '../utils';
import { ensureDictFilesExist, pickDefaultDictId, resolveLocalDictConfigs, type ResolvedLocalDictConfigItem } from './dictConfig';
import { MdictClient, type LookupMode } from './mdictClient';
import { buildDictPrepSystemPrompt, buildDictPrepUserPrompt, parseDictPrepPlan, type DictPrepLookupPoint } from './dictPrepPrompt';
import { llmGenerateJson } from './dictPrepLlm';
import { convertOpencc } from '../opencc';
import { stripHtmlToText } from './htmlToText';

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
    // 查词阶段：仅删除“汉字前后”的空白，其它空白保留
    // 例：`李 白` → `李白`；`Foo 李 白 Bar` → `Foo李白Bar`；`Foo Bar` 保持不变
    const s = String(term ?? '').trim();
    if (!s) return s;
    // 使用 Unicode 属性：Han 脚本（CJK 汉字）；u 标志保证属性转义可用
    return s
        .replace(/([\p{Script=Han}])\s+/gu, '$1')
        .replace(/\s+([\p{Script=Han}])/gu, '$1');
}

/**
 * 基于 OpenCC 做简⇄繁双向转换，返回“可选变体”（不含原词）。
 * 约定：调用方应先查原词；仅当变体与原词不同且需要时再查变体。
 */
function buildOpenccAltTerms(term: string): string[] {
    const base = sanitizeLookupTerm(term);
    if (!base) return [];

    // 双向都做一遍：输入可能本来就是繁体，或包含可互转的地区词。
    const t2cn = convertOpencc(base, 't', 'cn');
    const cn2t = convertOpencc(base, 'cn', 't');

    const out: string[] = [];
    const push = (x: string) => {
        const s = sanitizeLookupTerm(x);
        if (!s) return;
        if (s === base) return;
        if (out.includes(s)) return;
        out.push(s);
    };
    push(t2cn);
    push(cn2t);
    return out;
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

            // 对该 point：不在命中后立即停止；遍历所有候选/词典/变体后做“同名分组择优”：
            // - 同名（同 dict + 同 matchedKey）的多条条目要同时输出（如辞海7的“李白”两条）
            // - 用组内“最长净文本”的长度代表该组长度
            // - 再与其它不同名组比较，最终只取“最长的一组”（可能是 1 条，也可能是同名多条）
            const MAX_ENTRIES_PER_GROUP = 6;
            type PickedEntry = {
                h: { dictName: string; dictId: string; queryTerm: string; matchedKey: string; mode: LookupMode };
                cleaned: string;
                digest: string;
                term: string;
                dictIdForLegacy: string;
            };
            const groups = new Map<
                string,
                {
                    dictId: string;
                    dictName: string;
                    matchedKey: string;
                    entriesByDigest: Map<string, PickedEntry>;
                    groupLen: number; // max cleaned length within group
                }
            >();
            for (const dict of dictTryList) {
                if (totalLookupsExecuted >= maxTotalLookupsPerRun) break;

                for (const c of candidates) {
                    if (totalLookupsExecuted >= maxTotalLookupsPerRun) break;

                    // 同一候选词：先查原样（去空白）；仅当 opencc 转换后“不同”且原样未命中时，再查转换后的词。
                    const baseTerm = sanitizeLookupTerm(c);
                    if (!baseTerm) continue;

                    const execLookupAndCollect = async (term: string): Promise<number> => {
                        if (totalLookupsExecuted >= maxTotalLookupsPerRun) return 0;
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
                            return 0;
                        }

                        if (hits.length === 0) return 0;

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

                            const groupKey = `${h.dictId}::${h.matchedKey}`;
                            let g = groups.get(groupKey);
                            if (!g) {
                                g = {
                                    dictId: h.dictId,
                                    dictName: h.dictName,
                                    matchedKey: h.matchedKey,
                                    entriesByDigest: new Map<string, PickedEntry>(),
                                    groupLen: 0,
                                };
                                groups.set(groupKey, g);
                            }
                            g.groupLen = Math.max(g.groupLen, cleaned.length);

                            const prev = g.entriesByDigest.get(digest);
                            if (!prev || cleaned.length > prev.cleaned.length) {
                                g.entriesByDigest.set(digest, {
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
                                });
                            }
                        }
                        return hits.length;
                    };

                    const baseHitCount = await execLookupAndCollect(baseTerm);
                    if (baseHitCount > 0) {
                        // 原词已命中：不再额外查 opencc 变体，避免无意义的查词开销。
                        continue;
                    }

                    const altTerms = buildOpenccAltTerms(baseTerm);
                    for (const alt of altTerms) {
                        if (totalLookupsExecuted >= maxTotalLookupsPerRun) break;
                        await execLookupAndCollect(alt);
                    }
                }
            }

            // 选出“最长的一组”
            const bestGroup = [...groups.values()].sort((a, b) => b.groupLen - a.groupLen)[0];
            if (!bestGroup) {
                continue;
            }

            const picked = [...bestGroup.entriesByDigest.values()]
                .sort((a, b) => b.cleaned.length - a.cleaned.length)
                .slice(0, MAX_ENTRIES_PER_GROUP);

            for (const one of picked) {
                const legacyKey = buildDedupKeyLegacy(one.dictIdForLegacy, one.term, mode);
                const header = `【本地词典】${one.h.dictName}｜${one.h.matchedKey}`;
                const fingerprint = `${header}\n\n${one.cleaned}`;
                const beginTag = buildLocalDictEntryBeginTag(one.digest);
                if (reference.includes(beginTag) || reference.includes(fingerprint) || reference.includes(legacyKey)) {
                    continue;
                }
                const block = formatReferenceBlockV2({
                    dictName: one.h.dictName,
                    dictId: one.h.dictId,
                    queryTerm: one.h.queryTerm,
                    matchedKey: one.h.matchedKey,
                    mode: one.h.mode,
                    definition: one.cleaned,
                    digest: one.digest,
                });
                reference = reference ? `${reference}\n\n${block}` : block;
                resultItem.hits.push({
                    pointId: p.pointId,
                    dictId: one.h.dictId,
                    queryTerm: one.h.queryTerm,
                    matchedKey: one.h.matchedKey,
                    mode: one.h.mode,
                });
                totalHits++;
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
