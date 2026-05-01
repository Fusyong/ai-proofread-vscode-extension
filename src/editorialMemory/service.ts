import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FilePathUtils } from '../utils';
import { applyGlobalOpsAndPushCurrentRound } from './applyMemoryPatch';
import { buildMemoryPatchUserPrompt, runMemoryPatchLlm } from './memoryPatchLlm';
import { loadActiveAndArchive, saveActiveAndArchive } from './memoryPersistV2';
import { summarizeRoundSentenceAligned } from './recentSentenceSummary';
import type { MemoryRoundContext } from './schemaV2';
import { clipText, createEmptyActiveV2, createEmptyArchiveV2, formatCurrentRoundsForPrompt, formatMemoryEntryLine } from './schemaV2';

const INJECT_GLOBAL_MAX_CHARS = 5_500;
const INJECT_CURRENT_ROUNDS_MAX_CHARS = 16_000;
const PATCH_CONTEXT_MAX_CHARS = 8_000;
const PATCH_PROMPT_GLOBAL_MAX_CHARS = 8_000;
const PATCH_PROMPT_CURRENT_ROUNDS_MAX_CHARS = 12_000;

/** 工作区内相对路径（POSIX），无工作区则 basename */
export function getDocumentRelativeId(uri: vscode.Uri): string {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
        const base = uri.fsPath.split(/[/\\]/).pop() ?? 'doc';
        return base;
    }
    const rel = vscode.workspace.asRelativePath(uri, false);
    return rel.replace(/\\/g, '/');
}

function readConfig() {
    const c = vscode.workspace.getConfiguration('ai-proofread');
    return {
        mergeAfterAccept: c.get<boolean>('editorialMemory.mergeAfterAccept', true),
        mergeModelOverride: c.get<string>('editorialMemory.mergeModelOverride', ''),
        globalActiveMax: c.get<number>('editorialMemory.globalActiveMax', 30),
        currentProofreadRoundsMax: c.get<number>('editorialMemory.currentProofreadRoundsMax', 3),
    };
}

/** 供 proofread：拼接到 preText（reference/context 之后） */
export async function buildEditorialMemoryXml(
    documentUri: vscode.Uri,
    fullText: string,
    selectionStartLine: number,
    editorialMemoryForceEnabled?: boolean
): Promise<string> {
    if (editorialMemoryForceEnabled !== true) {
        return '';
    }
    const cfg = readConfig();
    const { active } = loadActiveAndArchive(documentUri);
    const documentId = getDocumentRelativeId(documentUri);
    const sel = typeof selectionStartLine === 'number' ? `L${selectionStartLine + 1}` : '';

    const g = clipText(active.global.map(formatMemoryEntryLine).join('\n'), INJECT_GLOBAL_MAX_CHARS);
    const cur = clipText(formatCurrentRoundsForPrompt(active.currentRounds), INJECT_CURRENT_ROUNDS_MAX_CHARS);

    const ctx = `<editorial_proofread_context>
document: ${documentId}
selection: ${sel}
note: 用户框选的校对范围；以下 target 即该范围全文。
</editorial_proofread_context>`;

    let out = '';
    if (g.trim()) {
        out += `\n<editorial_memory_global>\n${g.trim()}\n</editorial_memory_global>`;
    }
    if (cur.trim()) {
        out += `\n<editorial_memory_current_rounds>\n${cur.trim()}\n</editorial_memory_current_rounds>`;
    }
    out += `\n${ctx}`;
    return out;
}

export interface AfterAcceptArgs {
    documentUri: vscode.Uri;
    selectionStartLine: number;
    selectionRangeLabel: string;
    originalSelected: string;
    finalSelected: string;
    modelOutput: string;
    platform: string;
    model: string;
    items?: Array<{ original: string; corrected: string }>;
    editorialMemoryForceEnabled?: boolean;
}

export async function runEditorialMemoryAfterAccept(args: AfterAcceptArgs): Promise<void> {
    if (args.editorialMemoryForceEnabled !== true) {
        return;
    }
    const cfg = readConfig();
    let { active, archive } = loadActiveAndArchive(args.documentUri);

    const userEdited = args.finalSelected !== args.modelOutput;
    const round: MemoryRoundContext = {
        document_id: getDocumentRelativeId(args.documentUri),
        selection_range: args.selectionRangeLabel,
        original_selected: clipText(args.originalSelected, PATCH_CONTEXT_MAX_CHARS),
        final_selected: clipText(args.finalSelected, PATCH_CONTEXT_MAX_CHARS),
        item_level_changes: args.items,
        user_edited_away_from_model: userEdited,
    };

    const d = Math.max(1, cfg.currentProofreadRoundsMax);

    if (cfg.mergeAfterAccept) {
        const user = buildMemoryPatchUserPrompt({
            activeSnapshot: active,
            round,
            globalMax: cfg.globalActiveMax,
            maxProofreadRounds: d,
            globalPromptMaxChars: PATCH_PROMPT_GLOBAL_MAX_CHARS,
            currentRoundsPromptMaxChars: PATCH_PROMPT_CURRENT_ROUNDS_MAX_CHARS,
        });
        const mergeModel = cfg.mergeModelOverride.trim() || args.model;
        const patch = await runMemoryPatchLlm(args.platform, mergeModel, user);
        const applied =
            patch != null
                ? applyGlobalOpsAndPushCurrentRound({
                      active,
                      archive,
                      globalOps: patch.global_ops,
                      currentRoundFlat:
                          typeof patch.current_round_flat === 'string' && patch.current_round_flat.trim()
                              ? patch.current_round_flat.trim()
                              : undefined,
                      globalMax: cfg.globalActiveMax,
                      maxProofreadRounds: d,
                  })
                : null;
        if (applied) {
            active = applied.active;
            archive = applied.archive;
        } else {
            const sum = summarizeRoundSentenceAligned(
                args.originalSelected,
                args.finalSelected,
                PATCH_CONTEXT_MAX_CHARS
            );
            const fb = applyGlobalOpsAndPushCurrentRound({
                active,
                archive,
                globalOps: [],
                currentRoundFlat: clipText(sum || `选区已改；手改=${userEdited}`, 3000),
                globalMax: cfg.globalActiveMax,
                maxProofreadRounds: d,
            });
            active = fb.active;
            archive = fb.archive;
        }
    } else {
        const sum = summarizeRoundSentenceAligned(
            args.originalSelected,
            args.finalSelected,
            PATCH_CONTEXT_MAX_CHARS
        );
        const fb = applyGlobalOpsAndPushCurrentRound({
            active,
            archive,
            globalOps: [],
            currentRoundFlat: clipText(sum || `选区已改；merge 关闭`, 3000),
            globalMax: cfg.globalActiveMax,
            maxProofreadRounds: d,
        });
        active = fb.active;
        archive = fb.archive;
    }

    saveActiveAndArchive({
        anchorUri: args.documentUri,
        active,
        archive,
    });
}

/** 重置活跃与存档为空白（与用户「清空记忆」交互一致）。 */
export async function clearEditorialMemory(uri: vscode.Uri): Promise<void> {
    const jsonPath = FilePathUtils.getEditorialMemoryPath(uri);
    const archPath = FilePathUtils.getEditorialMemoryArchivePath(uri);
    const legacyMd = FilePathUtils.getEditorialMemoryLegacyMarkdownPath(uri);
    const c = vscode.workspace.getConfiguration('ai-proofread');
    const backup = c.get<boolean>('editorialMemory.backupBeforeWrite', true);
    FilePathUtils.ensureDirExists(path.dirname(jsonPath));
    if (backup) {
        FilePathUtils.backupFileIfExists(jsonPath, false);
        FilePathUtils.backupFileIfExists(archPath, false);
        if (fs.existsSync(legacyMd)) {
            FilePathUtils.backupFileIfExists(legacyMd, false);
        }
    }
    fs.writeFileSync(jsonPath, JSON.stringify(createEmptyActiveV2(), null, 2), 'utf8');
    fs.writeFileSync(archPath, JSON.stringify(createEmptyArchiveV2(), null, 2), 'utf8');
}
