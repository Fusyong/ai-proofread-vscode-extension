import * as fs from 'fs';
import * as vscode from 'vscode';
import { resolveReferencesPath } from '../citation/referenceStore';
import { ensureDictFilesExist, resolveLocalDictConfigs } from '../localDict/dictConfig';
import { getOrBuildCatalog } from './catalog/catalogCache';
import { summarizeCatalogForPrompt } from './catalog/catalogBuilder';
import {
    buildCorpusSummary,
    buildNavigationHints,
    buildReferencePrepSystemPrompt,
    buildReferencePrepUserPrompt,
    parseReferencePrepPlan,
    type ReferencePrepTargetKind,
} from './referencePrepPrompt';
import { generateReferencePrepPlanJson } from './referencePrepLlm';
import {
    getDefaultEnabledSources,
    getReferencePrepLlmConfig,
    getScopeConfig,
    getStrengthPreset,
    getWikipediaBudgetForStrength,
} from './config';
import type {
    ReferencePrepIntent,
    ReferencePrepProcessFileV020,
    ReferencePrepStrength,
    ReferenceSourceId,
} from './schema';
import {
    applyPruneToCorpus,
    buildMergedReference,
    executeReferencePrepPlan,
    mergeCorpusDedupe,
} from './retrieval/executor';
import { appendProcessLog, loadOrCreateProcessFile, saveProcessFile } from './processFile';
import {
    filterDictsByScope,
    resolveResourceScope,
    widenResourceScope,
} from './scope/resourceScope';
import { runLlmRerank } from './rerank/rerankRunner';
import { recordRecentSession } from './continuation';
import { getWikiCacheStats, resetWikiCacheStats } from './wikipedia/wikiCache';
import { getWikimediaClient } from './wikipedia/wikimediaClient';
import {
    getRetrievalCacheStats,
    resetRetrievalCacheStats,
} from './retrieval/retrievalCache';
import { bridgePrepEventToProgress, type PrepEventListener } from './prepEvents';

const ALL_INTENTS: ReferencePrepIntent[] = [
    'entity_name',
    'term_norm',
    'citation',
    'general_fact',
    'word_usage',
];

export interface ReferencePrepProgressHooks {
    onProgress?: (msg: string) => void;
    /** 结构化过程事件（供 Webview 时间线）；与 onProgress 可同时使用 */
    onEvent?: PrepEventListener;
    token?: vscode.CancellationToken;
    onAfterJsonItem?: (itemIndex: number) => void;
    onProcessUpdated?: (proc: ReferencePrepProcessFileV020) => void;
}

export interface ReferencePrepRunParams {
    target: string;
    anchorPath: string;
    context: vscode.ExtensionContext;
    enabledSources: ReferenceSourceId[];
    strength: ReferencePrepStrength;
    intents?: ReferencePrepIntent[];
    sourceJsonPath?: string;
    freshProcess?: boolean;
    targetKind?: ReferencePrepTargetKind;
    /** 续跑：追加规划轮，保留 corpus */
    continuation?: boolean;
    /** 续跑时覆盖 maxRounds（默认 1） */
    maxRoundsOverride?: number;
    /** 指定过程文件中的选区记录（优先于按文本匹配） */
    recordId?: string;
}

function resolvePlanSystemPrompt(
    context: vscode.ExtensionContext,
    enabled: ReferenceSourceId[],
    disabled: ReferenceSourceId[],
    maxQueries: number,
    intents: ReferencePrepIntent[],
    targetKind?: ReferencePrepTargetKind,
    continuation?: boolean
): string {
    const custom = resolveDictPrepStylePrompt(context);
    if (custom) {
        return custom;
    }
    return buildReferencePrepSystemPrompt({
        enabledSources: enabled,
        disabledSources: disabled,
        maxQueries,
        intents,
        targetKind,
        continuation,
    });
}

function resolveDictPrepStylePrompt(context: vscode.ExtensionContext): string | null {
    const currentName = context.globalState.get<string>('currentDictPrepPrompt', '') ?? '';
    if (currentName === '') return null;
    const prompts =
        vscode.workspace.getConfiguration('ai-proofread').get<Array<{ name: string; content: string }>>('dictPrep.prompts', []) ??
        vscode.workspace.getConfiguration('ai-proofread').get<Array<{ name: string; content: string }>>('referencePrep.prompts', []) ??
        [];
    const selected = prompts.find((p) => p.name === currentName);
    if (selected?.content?.trim()) return selected.content;
    return null;
}

const ALL_SOURCES: ReferenceSourceId[] = ['dict', 'grep_md', 'bm25', 'vector', 'citation', 'web', 'wikipedia'];

export async function runReferencePrepForTarget(
    params: ReferencePrepRunParams & ReferencePrepProgressHooks
): Promise<{ mergedReference: string; process: ReferencePrepProcessFileV020 }> {
    const emit = bridgePrepEventToProgress(params.onEvent, params.onProgress);
    const emitProcess = (proc: ReferencePrepProcessFileV020) => {
        params.onProcessUpdated?.(proc);
        emit?.({ type: 'process', process: proc, anchorPath: params.anchorPath });
    };

    try {
        const dicts = resolveLocalDictConfigs();
        if (params.enabledSources.includes('dict')) {
            if (dicts.length === 0) {
                throw new Error('未配置本地词典：请在设置中配置 ai-proofread.localDicts');
            }
            const exist = ensureDictFilesExist(dicts);
            if (!exist.ok) throw new Error(exist.errors.join('\n'));
        }

        const preset = getStrengthPreset(params.strength);
        const scopeCfg = getScopeConfig();
        const maxRounds = params.continuation
            ? (params.maxRoundsOverride ??
              vscode.workspace.getConfiguration('ai-proofread').get<number>('referencePrep.continuation.maxRounds', 1))
            : preset.maxRounds;
        const intents = params.intents?.length ? params.intents : ALL_INTENTS;
        const { platform, model, disableThinking } = getReferencePrepLlmConfig();
        const disabled = ALL_SOURCES.filter((s) => !params.enabledSources.includes(s));

        const proc = loadOrCreateProcessFile({
            anchorPath: params.anchorPath,
            enabledSources: params.enabledSources,
            strength: params.strength,
            sourceJsonPath: params.sourceJsonPath,
            targetPreview: params.target.slice(0, 200),
            userInput: params.target,
            recordId: params.recordId,
        });
        // 始终与本次目标对齐（避免旧 targetPreview 残留）
        proc.targetPreview = params.target.slice(0, 200);
        proc.userInput = params.target;
        if (params.freshProcess) {
            proc.corpus = [];
            proc.rounds = [];
            proc.mergedReference = undefined;
            proc.resourceScope = undefined;
        }
        proc.dicts = dicts.map((d) => ({ id: d.id, name: d.name, mdxPath: d.mdxPathResolved }));

        const config = vscode.workspace.getConfiguration('ai-proofread');
        const refPathRaw = config.get<string>('citation.referencesPath', '${workspaceFolder}/references');
        const refRoot = resolveReferencesPath(refPathRaw);
        const catalog = refRoot ? getOrBuildCatalog(refRoot) : null;

        if (params.continuation) {
            appendProcessLog(
                params.anchorPath,
                `Continuation: prior rounds=${proc.rounds.length} active_hits=${proc.corpus.filter((h) => h.status === 'active').length}`
            );
            emit?.({ type: 'phase', name: 'scope', message: '续跑（保留已有 corpus）…' });
        }

        emit?.({ type: 'phase', name: 'scope', message: '解析资源范围…' });
        let resourceScope =
            params.continuation && proc.resourceScope
                ? proc.resourceScope
                : await resolveResourceScope({
                      target: params.target,
                      dicts,
                      catalog,
                      referencesRoot: refRoot,
                  });
        proc.resourceScope = resourceScope;
        proc.catalogSnapshotId = catalog?.snapshotId;
        appendProcessLog(
            params.anchorPath,
            `Phase0 scope: dicts=${resourceScope.dictIds.length} files=${resourceScope.filePaths.length} filtered=${resourceScope.llmFiltered}`
        );

        const scopedDicts = filterDictsByScope(dicts, resourceScope);
        const catalogSummary = catalog ? summarizeCatalogForPrompt(catalog, 60) : undefined;

        const lookupsBudget = { used: 0, max: preset.maxTotalLookups };
        const wikiRequestsBudget = params.enabledSources.includes('wikipedia')
            ? { used: 0, max: getWikipediaBudgetForStrength(params.strength) }
            : undefined;
        // 每条 target（含 JSON 批量中的每一项）独立会话预算；速率窗口仍由进程内单例限速器跨条目共享
        if (wikiRequestsBudget) {
            getWikimediaClient().resetSessionBudget(wikiRequestsBudget.max);
        }
        resetWikiCacheStats();
        resetRetrievalCacheStats();
        let mergedReference = proc.mergedReference ?? '';
        let roundIncomingTotal = 0;

        for (let round = 0; round < maxRounds; round++) {
            if (params.token?.isCancellationRequested) {
                emit?.({ type: 'cancelled' });
                break;
            }

            const corpusSummary = buildCorpusSummary(proc.corpus);
            const navigationHints = buildNavigationHints(proc.corpus);
            const systemPrompt = resolvePlanSystemPrompt(
                params.context,
                params.enabledSources,
                disabled,
                preset.maxQueriesPerRound,
                intents,
                params.targetKind,
                params.continuation
            );
            const userPrompt = buildReferencePrepUserPrompt({
                target: params.target,
                dicts: scopedDicts,
                corpusSummary,
                roundIndex: round,
                maxRounds,
                targetKind: params.targetKind,
                catalogSummary,
                scope: resourceScope,
                navigationHints,
                continuation: params.continuation,
            });

            emit?.({
                type: 'phase',
                name: 'plan',
                round,
                message: `第 ${round + 1}/${maxRounds} 轮规划…`,
            });
            appendProcessLog(params.anchorPath, `Round ${round + 1} plan LLM`);

            const raw = await generateReferencePrepPlanJson({
                platform,
                model,
                systemPrompt,
                userPrompt,
                disableThinking,
            });
            const plan = parseReferencePrepPlan(raw, intents);
            plan.queries = plan.queries.slice(0, preset.maxQueriesPerRound);
            emit?.({ type: 'plan', round, plan });

            const roundId = `r-${Date.now()}`;
            const roundEntry: import('./schema').ReferencePrepRound = {
                roundId,
                startedAt: new Date().toISOString(),
                plan,
                queryCount: plan.queries.length,
            };

            if (plan.sufficient && plan.queries.length === 0 && !params.continuation) {
                roundEntry.finishedAt = new Date().toISOString();
                proc.rounds.push(roundEntry);
                applyPruneToCorpus(proc.corpus, plan, preset.valuePruneThreshold);
                break;
            }
            if (plan.sufficient && plan.queries.length === 0 && params.continuation) {
                appendProcessLog(params.anchorPath, 'Continuation: plan returned sufficient with no queries, stopping');
                roundEntry.finishedAt = new Date().toISOString();
                proc.rounds.push(roundEntry);
                break;
            }

            emit?.({
                type: 'phase',
                name: 'execute',
                round,
                message: `执行 ${plan.queries.length} 个查询…`,
            });
            for (const q of plan.queries) {
                emit?.({ type: 'query', round, queryId: q.queryId, detail: q });
            }

            const incoming = await executeReferencePrepPlan({
                plan,
                target: params.target,
                enabledSources: params.enabledSources,
                strength: params.strength,
                context: params.context,
                existingReference: mergedReference,
                lookupsBudget,
                wikiRequestsBudget,
                scope: resourceScope,
                roundId,
                catalogSnapshotId: catalog?.snapshotId,
            });
            roundIncomingTotal += incoming.length;
            emit?.({
                type: 'hits',
                round,
                added: incoming.length,
                total: proc.corpus.filter((h) => h.status === 'active').length + incoming.length,
            });

            const cacheStats = getWikiCacheStats();
            const retrievalCacheStats = getRetrievalCacheStats();
            roundEntry.wikiRequestsUsed = wikiRequestsBudget?.used ?? 0;
            appendProcessLog(
                params.anchorPath,
                `Round ${round + 1} wiki HTTP=${wikiRequestsBudget?.used ?? 0} wikiCache hit=${cacheStats.hits} miss=${cacheStats.misses}; retrievalCache hit=${retrievalCacheStats.hits} miss=${retrievalCacheStats.misses}`
            );

            emit?.({
                type: 'phase',
                name: 'rerank',
                round,
                message: `精排 ${incoming.length} 条候选…`,
            });
            const reranked = await runLlmRerank({ target: params.target, hits: incoming });

            mergeCorpusDedupe(proc.corpus, reranked);
            applyPruneToCorpus(proc.corpus, plan, preset.valuePruneThreshold);
            mergedReference = buildMergedReference(proc.corpus);

            roundEntry.finishedAt = new Date().toISOString();
            proc.rounds.push(roundEntry);
            proc.mergedReference = mergedReference;
            proc.resourceScope = resourceScope;
            saveProcessFile(params.anchorPath, proc);
            emitProcess(proc);

            if (round === 0 && roundIncomingTotal < scopeCfg.fallbackWidenMinHits && resourceScope.llmFiltered) {
                resourceScope = widenResourceScope(
                    resourceScope,
                    dicts,
                    catalog,
                    `首轮命中 ${roundIncomingTotal} < ${scopeCfg.fallbackWidenMinHits}`
                );
                proc.resourceScope = resourceScope;
                appendProcessLog(params.anchorPath, `fallbackWiden: ${resourceScope.widenReason}`);
            }

            if (plan.sufficient) break;
            if (lookupsBudget.used >= lookupsBudget.max) break;
            if (wikiRequestsBudget && wikiRequestsBudget.used >= wikiRequestsBudget.max) break;
        }

        proc.mergedReference = mergedReference;
        proc.indexVersions = {
            catalogSnapshotId: catalog?.snapshotId,
            citationDb: refRoot ? 'citation-refs.db' : undefined,
        };
        saveProcessFile(params.anchorPath, proc);
        await recordRecentSession(params.context, params.anchorPath, proc);
        emitProcess(proc);
        emit?.({
            type: 'phase',
            name: 'done',
            message: mergedReference ? '参考资料准备完成' : '准备完成，未检索到命中',
        });
        return { mergedReference, process: proc };
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        emit?.({ type: 'error', message });
        throw e;
    }
}

export async function runReferencePrepForJsonFile(
    params: {
        jsonFilePath: string;
        context: vscode.ExtensionContext;
        enabledSources: ReferenceSourceId[];
        strength: ReferencePrepStrength;
        intents?: ReferencePrepIntent[];
        mergeMode?: 'overwrite' | 'append';
        /** 跳过已有非空 reference 的条目（断点续跑） */
        skipExistingReference?: boolean;
    } & ReferencePrepProgressHooks
): Promise<{ processed: number; skipped: number; total: number; cancelled: boolean }> {
    const raw = fs.readFileSync(params.jsonFilePath, 'utf8');
    const items = JSON.parse(raw);
    if (!Array.isArray(items) || !items.every((x) => x && typeof x === 'object' && 'target' in x)) {
        throw new Error('JSON 文件格式不正确：需要包含 target 字段的对象数组');
    }

    let processed = 0;
    let skipped = 0;
    let cancelled = false;
    for (let idx = 0; idx < items.length; idx++) {
        if (params.token?.isCancellationRequested) {
            cancelled = true;
            // 条目之间取消：目标内尚未发出 cancelled
            params.onEvent?.({ type: 'cancelled' });
            break;
        }
        const item = items[idx];
        const target = String(item.target ?? '');
        if (!target.trim()) continue;

        if (params.skipExistingReference && String(item.reference ?? '').trim()) {
            skipped++;
            params.onEvent?.({
                type: 'phase',
                name: 'json_item',
                message: `跳过第 ${idx + 1}/${items.length} 条（已有资料）`,
            });
            params.onProgress?.(`跳过第 ${idx + 1}/${items.length} 条（已有资料）`);
            continue;
        }

        params.onEvent?.({
            type: 'phase',
            name: 'json_item',
            message: `准备第 ${idx + 1}/${items.length} 条…`,
        });
        params.onProgress?.(`准备第 ${idx + 1}/${items.length} 条…`);

        const { mergedReference } = await runReferencePrepForTarget({
            target,
            anchorPath: params.jsonFilePath,
            context: params.context,
            enabledSources: params.enabledSources,
            strength: params.strength,
            intents: params.intents,
            sourceJsonPath: params.jsonFilePath,
            freshProcess: true,
            onProgress: params.onProgress,
            onEvent: params.onEvent,
            token: params.token,
            onProcessUpdated: params.onProcessUpdated,
        });

        if (mergedReference) {
            if (params.mergeMode === 'append' && item.reference) {
                item.reference = `${item.reference}\n\n${mergedReference}`;
            } else {
                item.reference = mergedReference;
            }
        }
        fs.writeFileSync(params.jsonFilePath, JSON.stringify(items, null, 2), 'utf8');
        processed++;
        params.onAfterJsonItem?.(idx);

        if (params.token?.isCancellationRequested) {
            // 轮间取消：runReferencePrepForTarget 已发 cancelled，此处不再重复
            cancelled = true;
            break;
        }
    }
    return { processed, skipped, total: items.length, cancelled };
}

export function getDefaultIntents(): ReferencePrepIntent[] {
    return [...ALL_INTENTS];
}

export { getDefaultEnabledSources };
