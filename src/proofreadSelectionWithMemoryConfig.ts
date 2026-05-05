/**
 * 工作区 `.proofread/proofread-selection-with-memory.json`：供「Proofread Selection with Memory」无交互取参。
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { BUILTIN_SOURCE_TEXT_CHARACTERISTICS } from './sourceTextCharacteristics';
import type { UserSourceTextCharacteristicPrompt } from './sourceTextCharacteristics';
import { SourceTextCharacteristicManager } from './sourceTextCharacteristicManager';
import type { SourceTextCharacteristicsPickResult } from './sourceTextCharacteristicsPicker';
import { FilePathUtils } from './utils';

export type ContextMode = 'none' | 'adjacentParagraphs' | 'headingScope';

export type RepetitionMode = 'none' | 'target' | 'all';

export interface ProofreadSelectionWithMemoryConfig {
    sourceTextHint?: string;
    contextMode: ContextMode;
    beforeParagraphs: number;
    afterParagraphs: number;
    /** 1–6，仅 `headingScope` 时有效 */
    headingLevel: 1 | 2 | 3 | 4 | 5 | 6;
    /** 相对工作区根路径，正斜杠；空数组表示不用参考文件 */
    referenceFiles: string[];
    temperature: number;
    repetitionMode: RepetitionMode;
}

const HEADING_LEVEL_LABELS: readonly string[] = [
    '1 级标题',
    '2 级标题',
    '3 级标题',
    '4 级标题',
    '5 级标题',
    '6 级标题'
];

export function getHeadingContextLevel(level: 1 | 2 | 3 | 4 | 5 | 6): string {
    return HEADING_LEVEL_LABELS[level - 1];
}

export function buildDefaultProofreadSelectionWithMemoryConfig(
    temperature: number,
    repetitionMode: RepetitionMode
): ProofreadSelectionWithMemoryConfig {
    return {
        sourceTextHint: 'none',
        contextMode: 'none',
        beforeParagraphs: 1,
        afterParagraphs: 1,
        headingLevel: 2,
        referenceFiles: [],
        temperature,
        repetitionMode
    };
}

export function configToJsonString(cfg: ProofreadSelectionWithMemoryConfig): string {
    return `${JSON.stringify(cfg, null, 2)}\n`;
}

function clampInt(n: number, min: number, max: number): number {
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, Math.trunc(n)));
}

function isRecord(x: unknown): x is Record<string, unknown> {
    return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * 合并默认值并校验；字段缺失时用默认值（便于日后扩展字段）。
 */
export function parseProofreadSelectionWithMemoryConfig(
    raw: unknown,
    defaults: ProofreadSelectionWithMemoryConfig
): ProofreadSelectionWithMemoryConfig {
    if (!isRecord(raw)) {
        throw new Error('配置文件须为 JSON 对象');
    }

    const contextModes: ContextMode[] = ['none', 'adjacentParagraphs', 'headingScope'];
    let contextMode = defaults.contextMode;
    if (typeof raw.contextMode === 'string' && contextModes.includes(raw.contextMode as ContextMode)) {
        contextMode = raw.contextMode as ContextMode;
    }

    const repetitionModes: RepetitionMode[] = ['none', 'target', 'all'];
    let repetitionMode = defaults.repetitionMode;
    if (typeof raw.repetitionMode === 'string' && repetitionModes.includes(raw.repetitionMode as RepetitionMode)) {
        repetitionMode = raw.repetitionMode as RepetitionMode;
    }

    let beforeParagraphs =
        typeof raw.beforeParagraphs === 'number' ? clampInt(raw.beforeParagraphs, 0, 10) : defaults.beforeParagraphs;
    let afterParagraphs =
        typeof raw.afterParagraphs === 'number' ? clampInt(raw.afterParagraphs, 0, 10) : defaults.afterParagraphs;

    let headingLevel = defaults.headingLevel;
    if (typeof raw.headingLevel === 'number') {
        const h = clampInt(raw.headingLevel, 1, 6);
        headingLevel = h as 1 | 2 | 3 | 4 | 5 | 6;
    }

    let temperature =
        typeof raw.temperature === 'number' && Number.isFinite(raw.temperature)
            ? raw.temperature
            : defaults.temperature;
    if (temperature < 0 || temperature >= 2) {
        throw new Error('temperature 须在 [0, 2) 内');
    }

    let referenceFiles: string[] = defaults.referenceFiles;
    if (Array.isArray(raw.referenceFiles)) {
        referenceFiles = raw.referenceFiles.filter((x): x is string => typeof x === 'string');
    }

    let sourceTextHint = defaults.sourceTextHint;
    if (typeof raw.sourceTextHint === 'string') {
        sourceTextHint = raw.sourceTextHint;
    }

    return {
        sourceTextHint,
        contextMode,
        beforeParagraphs,
        afterParagraphs,
        headingLevel,
        referenceFiles,
        temperature,
        repetitionMode
    };
}

export function mapConfigToSelectionContext(cfg: ProofreadSelectionWithMemoryConfig): {
    contextLevel: string | undefined;
    beforeParagraphs: number;
    afterParagraphs: number;
} {
    if (cfg.contextMode === 'none') {
        return { contextLevel: undefined, beforeParagraphs: 0, afterParagraphs: 0 };
    }
    if (cfg.contextMode === 'adjacentParagraphs') {
        return {
            contextLevel: '前后增加段落',
            beforeParagraphs: cfg.beforeParagraphs,
            afterParagraphs: cfg.afterParagraphs
        };
    }
    return {
        contextLevel: getHeadingContextLevel(cfg.headingLevel),
        beforeParagraphs: 0,
        afterParagraphs: 0
    };
}

/**
 * 将相对工作区根的 posix 风格路径解析为 URI；拒绝跑出工作区根路径。
 */
export function resolveReferenceFileUris(
    workspaceFolder: vscode.WorkspaceFolder,
    relativePaths: string[]
): vscode.Uri[] {
    const rootPath = workspaceFolder.uri.fsPath;
    const out: vscode.Uri[] = [];
    for (const rel of relativePaths) {
        const trimmed = rel.trim().replace(/\\/g, '/');
        if (!trimmed) continue;
        const segments = trimmed.split('/').filter((s) => s.length > 0);
        if (segments.some((s) => s === '..')) {
            throw new Error(`参考文件路径不可包含 ..：${rel}`);
        }
        const uri = vscode.Uri.joinPath(workspaceFolder.uri, ...segments);
        const relCheck = path.relative(rootPath, uri.fsPath);
        if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
            throw new Error(`参考文件须在工作区内：${rel}`);
        }
        out.push(uri);
    }
    return out;
}

export type SourceTextHintResolution =
    | { ok: true; result: SourceTextCharacteristicsPickResult }
    | { ok: false; message: string };

/**
 * 单一字段 sourceTextHint：none / 内置 id 或内置展示名称（与 TreeView 一致）/ 用户自定义名称；其它非空报错。
 */
export function resolveSourceTextHint(
    raw: string | undefined,
    context: vscode.ExtensionContext
): SourceTextHintResolution {
    const t = typeof raw === 'string' ? raw.trim() : '';
    if (t === '' || t === 'none') {
        return { ok: true, result: { injectText: '', displayTitle: '无' } };
    }

    const builtin = BUILTIN_SOURCE_TEXT_CHARACTERISTICS.find((b) => b.id === t || b.name === t);
    if (builtin) {
        return { ok: true, result: { injectText: builtin.content, displayTitle: builtin.name } };
    }

    const manager = SourceTextCharacteristicManager.getInstance(context);
    const userPrompts: UserSourceTextCharacteristicPrompt[] = manager.getUserPrompts();
    const user = userPrompts.find((p) => p.name === t);
    if (user) {
        return { ok: true, result: { injectText: user.content, displayTitle: user.name } };
    }

    const builtinList = BUILTIN_SOURCE_TEXT_CHARACTERISTICS.map((b) => `${b.name}（id: ${b.id}）`).join('；');
    const userNames = userPrompts.map((p) => p.name).join('，');
    const msg =
        `proofread-selection-with-memory.json 中的「sourceTextHint」无效：「${t}」无法匹配。\n\n` +
        `内置条目（可填名称或 id）：${builtinList || '（无）'}\n` +
        `已保存的自定义名称：${userNames || '（无）'}\n\n` +
        `请在「管理提示词」→ prompts on source text 中核对名称，或使用上述内置名称/id。`;

    return { ok: false, message: msg };
}

export function readOrCreateProofreadSelectionWithMemoryConfig(
    documentUri: vscode.Uri,
    defaults: ProofreadSelectionWithMemoryConfig
): { config: ProofreadSelectionWithMemoryConfig; configPath: string; created: boolean } {
    const root = FilePathUtils.getProofreadWorkspaceRoot(documentUri);
    const proofreadDir = path.join(root, '.proofread');
    const configPath = path.join(proofreadDir, 'proofread-selection-with-memory.json');

    FilePathUtils.ensureDirExists(proofreadDir);

    let created = false;
    if (!fs.existsSync(configPath)) {
        fs.writeFileSync(configPath, configToJsonString(defaults), 'utf8');
        created = true;
    }

    const text = fs.readFileSync(configPath, 'utf8');
    let parsed: unknown;
    try {
        parsed = JSON.parse(text) as unknown;
    } catch (e) {
        throw new Error(`无法解析 JSON：${configPath}\n${e instanceof Error ? e.message : String(e)}`);
    }

    const config = parseProofreadSelectionWithMemoryConfig(parsed, defaults);
    return { config, configPath, created };
}
