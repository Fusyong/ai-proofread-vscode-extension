import * as fs from 'fs';
import * as vscode from 'vscode';
import { resolveReferencesPath } from '../citation/referenceStore';
import { ensureDictFilesExist, resolveLocalDictConfigs } from '../localDict/dictConfig';
import { getOrBuildCatalog } from './catalog/catalogCache';
import { summarizeCatalogForPrompt } from './catalog/catalogBuilder';
import {
    buildCorpusSummary,
    buildNavigationHints,
    buildPriorPlansSummary,
    buildReferencePrepMultiRoundAddendum,
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
    ReferencePrepOrigin,
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
import {
    appendProcessLog,
    listProcessRecords,
    loadOrCreateProcessFile,
    saveProcessFile,
} from './processFile';
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
import {
    clampControls,
    defaultControlsForStrength,
    type ReferencePrepRunControls,
} from './runControls';
import { applySoftSelectToHits } from './retrieval/softSelect';
import { filterDuplicatePlanQueries } from './planDedupe';
import type { ReferencePrepIntent } from './schema';

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
    /**
     * 规划审阅闸门：当 controls.requirePlanConfirm 时，runner 在此等待用户确认。
     * 返回 Promise，resolve 后继续执行（可带回修改后的 plan）。
     */
    requestPlanReview?: (args: {
        round: number;
        plan: import('./schema').ReferencePrepPlan;
    }) => Promise<{ action: 'confirm' | 'skip' | 'cancel'; plan?: import('./schema').ReferencePrepPlan }>;
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
    /** MD 选段 vs JSON 条目 */
    prepOrigin?: ReferencePrepOrigin;
    jsonItemIndex?: number;
    /** 面板可调控制参数（覆盖 strength 默认） */
    controls?: Partial<ReferencePrepRunControls>;
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
    const builtIn = buildReferencePrepSystemPrompt({
        enabledSources: enabled,
        disabledSources: disabled,
        maxQueries,
        intents,
        targetKind,
        continuation,
    });
    const custom = resolveDictPrepStylePrompt(context);
    if (!custom) return builtIn;
    // 自定义提示词附加多轮避重段，避免整替丢失 sufficient / prior_plans 规则
    return [custom.trim(), '', buildReferencePrepMultiRoundAddendum(continuation)].join('\n');
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
        const controls = clampControls(
            params.controls ?? defaultControlsForStrength(params.strength),
            params.strength
        );
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
            prepOrigin: params.prepOrigin ?? (params.sourceJsonPath ? 'json_item' : 'selection'),
            jsonItemIndex: params.jsonItemIndex,
        });
        // 始终与本次目标对齐（避免旧 targetPreview 残留）
        proc.targetPreview = params.target.slice(0, 200);
        proc.userInput = params.target;
        proc.prepOrigin = params.prepOrigin ?? proc.prepOrigin ?? (params.sourceJsonPath ? 'json_item' : 'selection');
        if (typeof params.jsonItemIndex === 'number') {
            proc.jsonItemIndex = params.jsonItemIndex;
        }
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
            const priorPlansSummary = buildPriorPlansSummary(proc.rounds);
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
                priorPlansSummary: priorPlansSummary || undefined,
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
            let plan = parseReferencePrepPlan(raw, intents);
            plan.queries = plan.queries.slice(0, preset.maxQueriesPerRound);
            const deduped = filterDuplicatePlanQueries(plan, proc.rounds);
            plan = deduped.plan;
            if (deduped.removed > 0) {
                appendProcessLog(
                    params.anchorPath,
                    `Round ${round + 1}: dropped ${deduped.removed} duplicate queries vs prior rounds`
                );
            }
            // 无新 query：有一定命中，或已有高相关 dict/wiki → 视为足够
            if (plan.queries.length === 0 && !params.continuation) {
                const active = proc.corpus.filter((h) => h.status === 'active');
                const strongEntity = active.some(
                    (h) =>
                        (h.source === 'dict' || h.source === 'wikipedia') &&
                        (h.rerankScore ?? h.finalScore ?? h.aggregatedValue) >= 0.75
                );
                if (active.length >= 3 || strongEntity) {
                    plan = { ...plan, sufficient: true };
                }
            }
            emit?.({ type: 'plan', round, plan });
            emit?.({
                type: 'planReview',
                round,
                plan,
                awaitConfirm: Boolean(controls.requirePlanConfirm && params.requestPlanReview),
            });

            if (controls.requirePlanConfirm && params.requestPlanReview) {
                emit?.({
                    type: 'phase',
                    name: 'plan_review',
                    round,
                    message: `等待确认第 ${round + 1} 轮规划…`,
                });
                const review = await params.requestPlanReview({ round, plan });
                if (review.action === 'cancel' || params.token?.isCancellationRequested) {
                    emit?.({ type: 'cancelled' });
                    break;
                }
                if (review.action === 'skip') {
                    appendProcessLog(params.anchorPath, `Round ${round + 1} plan skipped by user`);
                    const skipEntry: import('./schema').ReferencePrepRound = {
                        roundId: `r-${Date.now()}`,
                        startedAt: new Date().toISOString(),
                        finishedAt: new Date().toISOString(),
                        plan,
                        queryCount: plan.queries.length,
                    };
                    proc.rounds.push(skipEntry);
                    break;
                }
                if (review.plan) {
                    plan = review.plan;
                    plan.queries = plan.queries.slice(0, preset.maxQueriesPerRound);
                }
            }

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
                const intentByQuery = new Map<string, ReferencePrepIntent>();
                for (const r of proc.rounds) {
                    for (const q of r.plan.queries) {
                        intentByQuery.set(q.queryId, q.intent);
                    }
                }
                applySoftSelectToHits(proc.corpus, controls, {
                    target: params.target,
                    intentByQuery,
                });
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
                controls,
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
            const intentByQuery = new Map<string, ReferencePrepIntent>(
                plan.queries.map((q) => [q.queryId, q.intent])
            );
            applySoftSelectToHits(reranked, controls, {
                target: params.target,
                intentByQuery,
            });

            mergeCorpusDedupe(proc.corpus, reranked);
            applyPruneToCorpus(proc.corpus, plan, preset.valuePruneThreshold);
            const corpusIntentByQuery = new Map<string, ReferencePrepIntent>();
            for (const r of [...proc.rounds, { plan } as { plan: typeof plan }]) {
                for (const q of r.plan.queries) {
                    corpusIntentByQuery.set(q.queryId, q.intent);
                }
            }
            applySoftSelectToHits(proc.corpus, controls, {
                target: params.target,
                intentByQuery: corpusIntentByQuery,
            });
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

function hasJsonItemProcessWork(jsonFilePath: string, jsonItemIndex: number): boolean {
    return listProcessRecords(jsonFilePath, { origin: 'json_item' }).some(
        (r) =>
            r.jsonItemIndex === jsonItemIndex &&
            (r.corpus.length > 0 || r.rounds.length > 0)
    );
}

/**
 * 对 JSON 切分文件逐条准备参考资料。
 * 结果只写入过程文件（`.referenceprep.json`）与侧栏；不自动改写源 JSON 的 `reference`。
 * 需写入条目时，请在检索面板勾选后「合并选中到源 JSON」。
 */
export async function runReferencePrepForJsonFile(
    params: {
        jsonFilePath: string;
        context: vscode.ExtensionContext;
        enabledSources: ReferenceSourceId[];
        strength: ReferencePrepStrength;
        intents?: ReferencePrepIntent[];
        /** 跳过过程文件中已有检索记录的条目（断点续跑） */
        skipExistingReference?: boolean;
        controls?: Partial<ReferencePrepRunControls>;
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

        if (params.skipExistingReference && hasJsonItemProcessWork(params.jsonFilePath, idx)) {
            skipped++;
            params.onEvent?.({
                type: 'phase',
                name: 'json_item',
                message: `跳过第 ${idx + 1}/${items.length} 条（过程文件已有记录）`,
            });
            params.onProgress?.(`跳过第 ${idx + 1}/${items.length} 条（过程文件已有记录）`);
            continue;
        }

        params.onEvent?.({
            type: 'phase',
            name: 'json_item',
            message: `准备第 ${idx + 1}/${items.length} 条…`,
        });
        params.onProgress?.(`准备第 ${idx + 1}/${items.length} 条…`);

        await runReferencePrepForTarget({
            target,
            anchorPath: params.jsonFilePath,
            context: params.context,
            enabledSources: params.enabledSources,
            strength: params.strength,
            intents: params.intents,
            sourceJsonPath: params.jsonFilePath,
            prepOrigin: 'json_item',
            jsonItemIndex: idx,
            freshProcess: true,
            controls: params.controls,
            onProgress: params.onProgress,
            onEvent: params.onEvent,
            token: params.token,
            requestPlanReview: params.requestPlanReview,
            onProcessUpdated: params.onProcessUpdated,
        });

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
