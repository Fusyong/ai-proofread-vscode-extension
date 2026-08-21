/**
 * 「Proofread Selection」交互向导的上次选择，存于工作区 workspaceState。
 */

import * as vscode from 'vscode';

export const KEY_PROOFREAD_SELECTION_LAST_RUN = 'ai-proofread.proofreadSelection.lastRun';

export const PROOFREAD_SELECTION_CONTEXT_BUILD_METHODS = [
    '不使用上下文',
    '前后增加段落',
    '使用所在标题范围'
] as const;

export type ProofreadSelectionContextBuildMethod =
    (typeof PROOFREAD_SELECTION_CONTEXT_BUILD_METHODS)[number];

export const PROOFREAD_SELECTION_HEADING_LEVELS = [
    '1 级标题',
    '2 级标题',
    '3 级标题',
    '4 级标题',
    '5 级标题',
    '6 级标题'
] as const;

export type ProofreadSelectionHeadingLevel = (typeof PROOFREAD_SELECTION_HEADING_LEVELS)[number];

export const PROOFREAD_SELECTION_REPETITION_MODES = ['none', 'target', 'all'] as const;

export type ProofreadSelectionRepetitionMode = (typeof PROOFREAD_SELECTION_REPETITION_MODES)[number];

export interface ProofreadSelectionLastRun {
    contextBuildMethod?: ProofreadSelectionContextBuildMethod;
    beforeParagraphs?: number;
    afterParagraphs?: number;
    headingLevel?: ProofreadSelectionHeadingLevel;
    useReference?: boolean;
    referenceFilePath?: string;
    temperature?: number;
    repetitionMode?: ProofreadSelectionRepetitionMode;
}

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null;
}

function asEnum<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
    return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}

function clampInt(v: unknown, min: number, max: number): number | undefined {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (!Number.isFinite(n)) {
        return undefined;
    }
    return Math.min(max, Math.max(min, Math.round(n)));
}

/** 温度合法范围为 [0, 2) */
function clampTemperature(v: unknown): number | undefined {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (!Number.isFinite(n) || n < 0 || n >= 2) {
        return undefined;
    }
    return n;
}

export function parseProofreadSelectionLastRun(raw: unknown): ProofreadSelectionLastRun | undefined {
    if (!isRecord(raw)) {
        return undefined;
    }

    const parsed: ProofreadSelectionLastRun = {};
    const contextBuildMethod = asEnum(raw.contextBuildMethod, PROOFREAD_SELECTION_CONTEXT_BUILD_METHODS);
    if (contextBuildMethod) {
        parsed.contextBuildMethod = contextBuildMethod;
    }
    const headingLevel = asEnum(raw.headingLevel, PROOFREAD_SELECTION_HEADING_LEVELS);
    if (headingLevel) {
        parsed.headingLevel = headingLevel;
    }
    const repetitionMode = asEnum(raw.repetitionMode, PROOFREAD_SELECTION_REPETITION_MODES);
    if (repetitionMode) {
        parsed.repetitionMode = repetitionMode;
    }
    const beforeParagraphs = clampInt(raw.beforeParagraphs, 0, 10);
    if (beforeParagraphs !== undefined) {
        parsed.beforeParagraphs = beforeParagraphs;
    }
    const afterParagraphs = clampInt(raw.afterParagraphs, 0, 10);
    if (afterParagraphs !== undefined) {
        parsed.afterParagraphs = afterParagraphs;
    }
    const temperature = clampTemperature(raw.temperature);
    if (temperature !== undefined) {
        parsed.temperature = temperature;
    }
    if (typeof raw.useReference === 'boolean') {
        parsed.useReference = raw.useReference;
    }
    if (typeof raw.referenceFilePath === 'string' && raw.referenceFilePath.trim()) {
        parsed.referenceFilePath = raw.referenceFilePath.trim();
    }

    return parsed;
}

export function loadProofreadSelectionLastRun(
    context: vscode.ExtensionContext
): ProofreadSelectionLastRun | undefined {
    return parseProofreadSelectionLastRun(
        context.workspaceState.get<unknown>(KEY_PROOFREAD_SELECTION_LAST_RUN)
    );
}

export async function saveProofreadSelectionLastRun(
    context: vscode.ExtensionContext,
    run: ProofreadSelectionLastRun
): Promise<void> {
    const parsed = parseProofreadSelectionLastRun(run) ?? {};
    await context.workspaceState.update(KEY_PROOFREAD_SELECTION_LAST_RUN, parsed);
}
