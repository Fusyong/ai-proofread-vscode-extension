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

const ALL_INTENTS: ReferencePrepIntent[] = [
    'entity_name',
    'term_norm',
    'citation',
    'general_fact',
    'word_usage',
];

export interface ReferencePrepProgressHooks {
    onProgress?: (msg: string) => void;
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
}

function resolvePlanSystemPrompt(
    context: vscode.ExtensionContext,
    enabled: ReferenceSourceId[],
    disabled: ReferenceSourceId[],
    maxQueries: number,
    intents: ReferencePrepIntent[],
    targetKind?: ReferencePrepTargetKind
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

const ALL_SOURCES: ReferenceSourceId[] = ['dict', 'grep_md', 'bm25', 'vector', 'citation', 'web'];

export async function runReferencePrepForTarget(
    params: ReferencePrepRunParams & ReferencePrepProgressHooks
): Promise<{ mergedReference: string; process: ReferencePrepProcessFileV020 }> {
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
    const maxRounds = vscode.workspace.getConfiguration('ai-proofread').get<number>('referencePrep.maxRounds', preset.maxRounds);
    const intents = params.intents?.length ? params.intents : ALL_INTENTS;
    const { platform, model } = getReferencePrepLlmConfig();
    const disabled = ALL_SOURCES.filter((s) => !params.enabledSources.includes(s));

    const proc = loadOrCreateProcessFile({
        anchorPath: params.anchorPath,
        enabledSources: params.enabledSources,
        strength: params.strength,
        sourceJsonPath: params.sourceJsonPath,
        targetPreview: params.target.slice(0, 200),
        userInput: params.target,
    });
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

    params.onProgress?.('参考资料准备：解析资源范围…');
    let resourceScope = await resolveResourceScope({
        target: params.target,
        dicts,
        catalog,
        referencesRoot: refRoot,
    });
    proc.resourceScope = resourceScope;
    proc.catalogSnapshotId = catalog?.snapshotId;
    appendProcessLog(params.anchorPath, `Phase0 scope: dicts=${resourceScope.dictIds.length} files=${resourceScope.filePaths.length} filtered=${resourceScope.llmFiltered}`);

    const scopedDicts = filterDictsByScope(dicts, resourceScope);
    const catalogSummary = catalog ? summarizeCatalogForPrompt(catalog, 60) : undefined;

    const lookupsBudget = { used: 0, max: preset.maxTotalLookups };
    let mergedReference = proc.mergedReference ?? '';
    let roundIncomingTotal = 0;

    for (let round = 0; round < maxRounds; round++) {
        if (params.token?.isCancellationRequested) break;

        const corpusSummary = buildCorpusSummary(proc.corpus);
        const navigationHints = buildNavigationHints(proc.corpus);
        const systemPrompt = resolvePlanSystemPrompt(
            params.context,
            params.enabledSources,
            disabled,
            preset.maxQueriesPerRound,
            intents,
            params.targetKind
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
        });

        params.onProgress?.(`参考资料准备：第 ${round + 1}/${maxRounds} 轮规划…`);
        appendProcessLog(params.anchorPath, `Round ${round + 1} plan LLM`);

        const raw = await generateReferencePrepPlanJson({ platform, model, systemPrompt, userPrompt });
        const plan = parseReferencePrepPlan(raw, intents);
        plan.queries = plan.queries.slice(0, preset.maxQueriesPerRound);

        const roundId = `r-${Date.now()}`;
        const roundEntry = {
            roundId,
            startedAt: new Date().toISOString(),
            plan,
            queryCount: plan.queries.length,
        };

        if (plan.sufficient && plan.queries.length === 0) {
            roundEntry.finishedAt = new Date().toISOString();
            proc.rounds.push(roundEntry);
            applyPruneToCorpus(proc.corpus, plan, preset.valuePruneThreshold);
            break;
        }

        params.onProgress?.(`参考资料准备：执行 ${plan.queries.length} 个查询…`);
        const incoming = await executeReferencePrepPlan({
            plan,
            target: params.target,
            enabledSources: params.enabledSources,
            strength: params.strength,
            context: params.context,
            existingReference: mergedReference,
            lookupsBudget,
            scope: resourceScope,
            roundId,
        });
        roundIncomingTotal += incoming.length;

        params.onProgress?.(`参考资料准备：精排 ${incoming.length} 条候选…`);
        const reranked = await runLlmRerank({ target: params.target, hits: incoming });

        mergeCorpusDedupe(proc.corpus, reranked);
        applyPruneToCorpus(proc.corpus, plan, preset.valuePruneThreshold);
        mergedReference = buildMergedReference(proc.corpus);

        roundEntry.finishedAt = new Date().toISOString();
        proc.rounds.push(roundEntry);
        proc.mergedReference = mergedReference;
        proc.resourceScope = resourceScope;
        saveProcessFile(params.anchorPath, proc);
        params.onProcessUpdated?.(proc);

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
    }

    proc.mergedReference = mergedReference;
    proc.indexVersions = {
        catalogSnapshotId: catalog?.snapshotId,
        citationDb: refRoot ? 'citation-refs.db' : undefined,
    };
    saveProcessFile(params.anchorPath, proc);
    params.onProcessUpdated?.(proc);
    return { mergedReference, process: proc };
}

export async function runReferencePrepForJsonFile(
    params: {
        jsonFilePath: string;
        context: vscode.ExtensionContext;
        enabledSources: ReferenceSourceId[];
        strength: ReferencePrepStrength;
        intents?: ReferencePrepIntent[];
        mergeMode?: 'overwrite' | 'append';
    } & ReferencePrepProgressHooks
): Promise<{ processed: number; total: number }> {
    const raw = fs.readFileSync(params.jsonFilePath, 'utf8');
    const items = JSON.parse(raw);
    if (!Array.isArray(items) || !items.every((x) => x && typeof x === 'object' && 'target' in x)) {
        throw new Error('JSON 文件格式不正确：需要包含 target 字段的对象数组');
    }

    let processed = 0;
    for (let idx = 0; idx < items.length; idx++) {
        if (params.token?.isCancellationRequested) break;
        const item = items[idx];
        const target = String(item.target ?? '');
        if (!target.trim()) continue;

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
    }
    return { processed, total: items.length };
}

export function getDefaultIntents(): ReferencePrepIntent[] {
    return [...ALL_INTENTS];
}

export { getDefaultEnabledSources };
