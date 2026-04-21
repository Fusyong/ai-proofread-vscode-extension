import * as fs from 'fs';
import * as vscode from 'vscode';
import { FilePathUtils, Logger } from '../utils';
import { ensureDictFilesExist, pickDefaultDictId, resolveLocalDictConfigs, type ResolvedLocalDictConfigItem } from './dictConfig';
import { MdictClient, type LookupMode } from './mdictClient';
import { buildDictPrepSystemPrompt, buildDictPrepUserPrompt, parseDictPrepPlan, type DictPrepLookupPoint } from './dictPrepPrompt';
import { llmGenerateJson } from './dictPrepLlm';

export interface DictPrepRunStats {
    totalItems: number;
    processedItems: number;
    totalLookupsExecuted: number;
    totalHits: number;
    totalPointsPlanned: number;
}

export interface DictPrepProcessItem {
    index: number; // 1-based
    plannedPoints: DictPrepLookupPoint[];
    hits: Array<{
        pointId: string;
        dictId: string;
        queryTerm: string;
        matchedKey: string;
        mode: LookupMode;
    }>;
    errors: string[];
}

/** 过程文件阶段：llm_planned = 仅完成 LLM 规划；local_merged = 已写入 reference */
export type DictPrepProcessStage = 'llm_planned' | 'local_merged';

export interface DictPrepProcessFile {
    version: '0.2.0';
    stage: DictPrepProcessStage;
    sourceJsonPath: string;
    startedAt: string;
    llmFinishedAt?: string;
    finishedAt?: string;
    dicts: Array<{ id: string; name: string; mdxPath: string }>;
    stats?: DictPrepRunStats;
    items: DictPrepProcessItem[];
}

export interface DictPrepProgressHooks {
    onProgress?: (msg: string) => void;
    /** 每完成一条的 LLM 规划后调用（0-based 索引） */
    onAfterItemPlanned?: (itemIndex: number) => void;
    /** 每完成一条的本地查词后调用（0-based 索引） */
    onAfterItemMerged?: (itemIndex: number) => void;
    token?: vscode.CancellationToken;
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

    const proc: DictPrepProcessFile = {
        version: '0.2.0',
        stage: 'llm_planned',
        sourceJsonPath: params.jsonFilePath,
        startedAt: new Date().toISOString(),
        dicts: dicts.map((d) => ({ id: d.id, name: d.name, mdxPath: d.mdxPathResolved })),
        items: [],
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

        const processItem: DictPrepProcessItem = { index: itemNo, plannedPoints: planned, hits: [], errors: [] };
        proc.items.push(processItem);
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
    proc.stats = stats;
    proc.llmFinishedAt = new Date().toISOString();
    proc.stage = 'llm_planned';
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
        throw new Error('未找到词典准备过程文件（.dictprep.json）。请先执行「LLM 生成查词计划」。');
    }

    const procRaw = JSON.parse(fs.readFileSync(processPath, 'utf8')) as DictPrepProcessFile & { version?: string };
    if (procRaw.version !== '0.2.0' || procRaw.stage !== 'llm_planned') {
        throw new Error(
            '当前 .dictprep.json 不是「仅 LLM 规划」状态。请重新执行「LLM 生成查词计划」，或删除旧过程文件后重试。'
        );
    }

    const proc = procRaw as DictPrepProcessFile;

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

    const plannedIndexSet = new Set(proc.items.map((p) => p.index - 1));
    for (let i = 0; i < items.length; i++) {
        if (!plannedIndexSet.has(i)) {
            params.onAfterItemMerged?.(i);
        }
    }

    for (const processItem of proc.items) {
        if (params.token?.isCancellationRequested) {
            break;
        }

        const idx = processItem.index - 1;
        if (idx < 0 || idx >= items.length) {
            processItem.errors.push(`条目 index=${processItem.index} 超出 JSON 范围`);
            fs.writeFileSync(processPath, JSON.stringify(proc, null, 2), 'utf8');
            continue;
        }

        const item = items[idx];
        const target = String(item.target ?? '');
        if (!target.trim()) {
            params.onAfterItemMerged?.(idx);
            continue;
        }

        totalPointsPlanned += processItem.plannedPoints.length;
        processItem.hits = [];
        processItem.errors = [];

        let reference: string = typeof item.reference === 'string' ? item.reference : '';
        const planned = processItem.plannedPoints;

        for (const p of planned) {
            if (totalLookupsExecuted >= maxTotalLookupsPerRun) {
                processItem.errors.push(`达到总查词上限 ${maxTotalLookupsPerRun}，中止后续查询点`);
                break;
            }
            const mode: LookupMode = 'exact';
            const candidates = (p.candidates ?? []).slice(0, 3);
            if (candidates.length === 0) continue;

            const preferredDictId = p.dictId && dicts.some((d) => d.id === p.dictId) ? p.dictId : null;
            const dictTryList = buildDictTryList(dicts, preferredDictId, defaultDictId);
            if (dictTryList.length === 0) {
                processItem.errors.push(`pointId=${p.pointId}: 未能确定词典`);
                continue;
            }

            let hitFound = false;
            for (const dict of dictTryList) {
                if (totalLookupsExecuted >= maxTotalLookupsPerRun) break;

                for (const c of candidates) {
                    if (totalLookupsExecuted >= maxTotalLookupsPerRun) break;
                    totalLookupsExecuted++;

                    const dedupKey = buildDedupKey(dict.id, c, mode);
                    if (reference.includes(dedupKey)) {
                        continue;
                    }

                    const hit = await client.lookup(dict, c, mode, {
                        prefixMaxCandidates: 0,
                        minPrefixLength: 999,
                        maxDefinitionChars,
                        cacheEnabled,
                        cacheTtlHours,
                    });
                    if (hit) {
                        const block = formatReferenceBlock(hit, dedupKey);
                        reference = reference ? `${reference}\n\n${block}` : block;
                        processItem.hits.push({
                            pointId: p.pointId,
                            dictId: hit.dictId,
                            queryTerm: hit.queryTerm,
                            matchedKey: hit.matchedKey,
                            mode: hit.mode,
                        });
                        totalHits++;
                        hitFound = true;
                        break;
                    }
                }

                if (hitFound) break;
            }
        }

        if (reference && reference !== item.reference) {
            item.reference = reference;
        }

        fs.writeFileSync(params.jsonFilePath, JSON.stringify(items, null, 2), 'utf8');
        fs.writeFileSync(processPath, JSON.stringify(proc, null, 2), 'utf8');
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
    proc.stats = stats;
    proc.stage = 'local_merged';
    proc.finishedAt = new Date().toISOString();
    fs.writeFileSync(processPath, JSON.stringify(proc, null, 2), 'utf8');

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
