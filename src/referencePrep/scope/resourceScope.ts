import type { ResolvedLocalDictConfigItem } from '../../localDict/dictConfig';
import type { ReferenceCatalog } from '../catalog/catalogBuilder';
import { summarizeCatalogForPrompt } from '../catalog/catalogBuilder';
import {
    buildHeadingIndexForFiles,
    summarizeHeadingsForPrompt,
    type HeadingEntry,
} from '../catalog/headingIndex';
import { getScopeConfig } from '../config';
import { generateReferencePrepPlanJson } from '../referencePrepLlm';
import { getReferencePrepLlmConfig } from '../config';
import type { ResourceScope } from '../schema';

export interface ResolveResourceScopeParams {
    target: string;
    dicts: ResolvedLocalDictConfigItem[];
    catalog: ReferenceCatalog | null;
    referencesRoot: string;
    initialHitCount?: number;
}

function defaultScope(dicts: ResolvedLocalDictConfigItem[], catalog: ReferenceCatalog | null): ResourceScope {
    return {
        dictIds: dicts.map((d) => d.id),
        filePaths: catalog?.files.map((f) => f.relPath) ?? [],
        excludePaths: [],
        headingPathsByFile: {},
        llmFiltered: false,
    };
}

function needsLlmScopeFilter(dicts: ResolvedLocalDictConfigItem[], catalog: ReferenceCatalog | null): boolean {
    const cfg = getScopeConfig();
    if (dicts.length > cfg.dictCountThreshold) return true;
    if (catalog && catalog.files.length > cfg.fileCountThreshold) return true;
    const maxDepth = Math.max(
        0,
        ...Object.keys(catalog?.dirSummary ?? {}).map((d) => d.split('/').length)
    );
    if (maxDepth > cfg.dirDepthThreshold) return true;
    return false;
}

async function llmFilterScope(params: {
    target: string;
    dicts: ResolvedLocalDictConfigItem[];
    catalog: ReferenceCatalog;
    headings: HeadingEntry[];
}): Promise<Partial<ResourceScope> & { filterReason?: string }> {
    const { platform, model } = getReferencePrepLlmConfig();
    const dictLines = params.dicts
        .map((d) => `- id=${d.id}; name=${d.name}; tags=[${(d.tags ?? []).slice(0, 4).join(', ')}]`)
        .join('\n');
    const systemPrompt = [
        '你是参考资料检索的资源范围筛选助手。',
        '只输出 JSON：{"dictIds":string[],"filePaths":string[],"excludePaths":string[],"headingPathsByFile":{file:string[]},"reason":string}',
        '从给定词典与参考文献目录中，选出与 target 最可能相关的子集；宁多勿漏关键资源。',
        'filePaths 使用相对路径；excludePaths 为明确无关路径前缀。',
    ].join('\n');
    const userPrompt = [
        'dicts:',
        dictLines,
        '',
        'catalog:',
        summarizeCatalogForPrompt(params.catalog, 100),
        '',
        'headings_sample:',
        summarizeHeadingsForPrompt(params.headings, 80),
        '',
        '<target>',
        params.target.slice(0, 2000),
        '</target>',
    ].join('\n');

    const raw = await generateReferencePrepPlanJson({ platform, model, systemPrompt, userPrompt });
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) return {};
    const obj = JSON.parse(raw.slice(start, end + 1));
    const dictIds = Array.isArray(obj.dictIds)
        ? obj.dictIds.filter((x: unknown) => typeof x === 'string')
        : undefined;
    const filePaths = Array.isArray(obj.filePaths)
        ? obj.filePaths.filter((x: unknown) => typeof x === 'string')
        : undefined;
    const excludePaths = Array.isArray(obj.excludePaths)
        ? obj.excludePaths.filter((x: unknown) => typeof x === 'string')
        : [];
    const headingPathsByFile =
        obj.headingPathsByFile && typeof obj.headingPathsByFile === 'object'
            ? (obj.headingPathsByFile as Record<string, string[]>)
            : {};
    return {
        dictIds,
        filePaths,
        excludePaths,
        headingPathsByFile,
        filterReason: typeof obj.reason === 'string' ? obj.reason : undefined,
    };
}

export async function resolveResourceScope(params: ResolveResourceScopeParams): Promise<ResourceScope> {
    const base = defaultScope(params.dicts, params.catalog);
    if (!params.catalog || !needsLlmScopeFilter(params.dicts, params.catalog)) {
        return base;
    }

    const cfg = getScopeConfig();
    const scopeFiles =
        params.catalog.files.length > cfg.fileCountThreshold
            ? params.catalog.files.slice(0, 150).map((f) => f.relPath)
            : params.catalog.files.map((f) => f.relPath);

    const headings = buildHeadingIndexForFiles(params.referencesRoot, scopeFiles.slice(0, 50));
    const tocChars = headings.reduce((s, h) => s + h.headingPath.length, 0);
    const needHeadingFilter = headings.length > cfg.headingCountThreshold || tocChars > cfg.tocCharsThreshold;

    try {
        const filtered = await llmFilterScope({
            target: params.target,
            dicts: params.dicts,
            catalog: params.catalog,
            headings: needHeadingFilter ? headings : [],
        });
        const dictIds =
            filtered.dictIds?.length
                ? filtered.dictIds.filter((id) => params.dicts.some((d) => d.id === id))
                : base.dictIds;
        const filePaths =
            filtered.filePaths?.length
                ? filtered.filePaths.filter((p) => base.filePaths.includes(p))
                : base.filePaths;
        return {
            dictIds: dictIds.length > 0 ? dictIds : base.dictIds,
            filePaths: filePaths.length > 0 ? filePaths : base.filePaths,
            excludePaths: filtered.excludePaths ?? [],
            headingPathsByFile: filtered.headingPathsByFile ?? {},
            llmFiltered: true,
            filterReason: filtered.filterReason,
        };
    } catch {
        return base;
    }
}

export function widenResourceScope(scope: ResourceScope, dicts: ResolvedLocalDictConfigItem[], catalog: ReferenceCatalog | null, reason: string): ResourceScope {
    return {
        dictIds: dicts.map((d) => d.id),
        filePaths: catalog?.files.map((f) => f.relPath) ?? scope.filePaths,
        excludePaths: [],
        headingPathsByFile: {},
        llmFiltered: scope.llmFiltered,
        filterReason: scope.filterReason,
        widened: true,
        widenReason: reason,
    };
}

export function filterDictsByScope(dicts: ResolvedLocalDictConfigItem[], scope: ResourceScope): ResolvedLocalDictConfigItem[] {
    const set = new Set(scope.dictIds);
    const filtered = dicts.filter((d) => set.has(d.id));
    return filtered.length > 0 ? filtered : dicts;
}

export function isFileInScope(relPath: string, scope: ResourceScope): boolean {
    if (scope.excludePaths.some((ex) => relPath.startsWith(ex))) return false;
    if (scope.filePaths.length === 0) return true;
    return scope.filePaths.some((p) => relPath === p || relPath.startsWith(p + '/'));
}
