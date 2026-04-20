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

export interface DictPrepProcessFile {
    version: '0.1.0';
    sourceJsonPath: string;
    startedAt: string;
    finishedAt?: string;
    dicts: Array<{ id: string; name: string; mdxPath: string }>;
    stats?: DictPrepRunStats;
    items: DictPrepProcessItem[];
}

export async function prepareReferencesFromLocalDicts(params: {
    jsonFilePath: string;
    context: vscode.ExtensionContext;
    onProgress?: (msg: string) => void;
}): Promise<DictPrepRunStats> {
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
    const maxPointsPerItem = config.get<number>('dictPrep.maxPointsPerItem', 6);
    const maxTotalLookupsPerRun = config.get<number>('dictPrep.maxTotalLookupsPerRun', 200);
    const maxDefinitionChars = config.get<number>('dictPrep.maxDefinitionChars', 6000);
    const cacheEnabled = config.get<boolean>('dictPrep.cache.enabled', true);
    const cacheTtlHours = config.get<number>('dictPrep.cache.ttlHours', 0);

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
        version: '0.1.0',
        sourceJsonPath: params.jsonFilePath,
        startedAt: new Date().toISOString(),
        dicts: dicts.map((d) => ({ id: d.id, name: d.name, mdxPath: d.mdxPathResolved })),
        items: [],
    };
    fs.writeFileSync(processPath, JSON.stringify(proc, null, 2), 'utf8');

    const client = MdictClient.getInstance(params.context);
    const systemPrompt = (() => {
        // 直接读取全局状态与配置，避免打包时的模块导入问题
        const currentName = params.context.globalState.get<string>('currentDictPrepPrompt', '') ?? '';
        if (currentName === '') {
            return buildDictPrepSystemPrompt();
        }
        const prompts = vscode.workspace
            .getConfiguration('ai-proofread')
            .get<Array<{ name: string; content: string }>>('dictPrep.prompts', []) ?? [];
        const selected = prompts.find((p) => p.name === currentName);
        return selected?.content?.trim() ? selected.content : buildDictPrepSystemPrompt();
    })();

    let totalLookupsExecuted = 0;
    let totalHits = 0;
    let totalPointsPlanned = 0;
    let processedItems = 0;

    const progress = (m: string) => {
        params.onProgress?.(m);
        fs.appendFileSync(logPath, m + '\n', 'utf8');
    };

    progress(`Start: ${new Date().toLocaleString()}`);
    progress(`Dicts: ${dicts.map((d) => `${d.id}:${d.name}`).join(' | ')}`);
    progress(`Model: ${platform}, ${model}`);

    for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        const target = String(item.target ?? '');
        if (!target.trim()) {
            continue;
        }
        if (maxPointsPerItem <= 0) {
            break;
        }
        if (totalLookupsExecuted >= maxTotalLookupsPerRun) {
            progress(`达到总查词上限 ${maxTotalLookupsPerRun}，已停止。`);
            break;
        }

        const itemNo = idx + 1;
        progress(`规划 No.${itemNo}/${items.length}（targetLen=${target.length}）`);

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

        // 执行查询并拼接 reference
        let reference: string = typeof item.reference === 'string' ? item.reference : '';
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
                        // 已存在同 dictId+term+mode 的块，跳过该候选
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
                        break; // 命中即停（该查询点停止）
                    }
                }

                if (hitFound) break; // 已命中：停止尝试其他词典
            }
        }

        if (reference && reference !== item.reference) {
            item.reference = reference;
        }
        proc.items.push(processItem);
        fs.writeFileSync(processPath, JSON.stringify(proc, null, 2), 'utf8');
        processedItems++;
    }

    fs.writeFileSync(params.jsonFilePath, JSON.stringify(items, null, 2), 'utf8');

    const stats: DictPrepRunStats = {
        totalItems: items.length,
        processedItems,
        totalLookupsExecuted,
        totalHits,
        totalPointsPlanned,
    };
    proc.stats = stats;
    proc.finishedAt = new Date().toISOString();
    fs.writeFileSync(processPath, JSON.stringify(proc, null, 2), 'utf8');

    progress(`Done: items=${processedItems}/${items.length}, points=${totalPointsPlanned}, lookups=${totalLookupsExecuted}, hits=${totalHits}`);
    logger.info(`[dictPrepRunner] done: ${JSON.stringify(stats)}`);

    return stats;
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

function buildDedupKey(dictId: string, term: string, mode: LookupMode): string {
    const t = (term ?? '').trim().replace(/\s+/g, ' ');
    return `<!-- ai-proofread:dictref dictId=${dictId} mode=${mode} term=${escapeAttr(t)} -->`;
}

function escapeAttr(s: string): string {
    return s.replace(/-->/g, '--\\>');
}

function formatReferenceBlock(hit: { dictName: string; dictId: string; queryTerm: string; matchedKey: string; mode: LookupMode; definition: string }, dedupKey: string): string {
    const header = `【本地词典】${hit.dictName}（${hit.dictId}） | mode=${hit.mode} | query=${hit.queryTerm} | hit=${hit.matchedKey}`;
    return [
        dedupKey,
        header,
        '',
        hit.definition,
        '<!-- ai-proofread:dictref end -->',
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

    // 1) LLM 指定词典优先
    pushById(preferredDictId);
    // 2) 默认回退词典（若不同）
    pushById(defaultDictId ?? null);
    // 3) 其余词典按优先级依次尝试
    for (const d of byPriority) {
        if (seen.has(d.id)) continue;
        picked.push(d);
        seen.add(d.id);
    }
    return picked;
}

