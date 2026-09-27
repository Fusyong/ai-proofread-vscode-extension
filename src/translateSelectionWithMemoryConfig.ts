/**
 * 工作区 `.proofread/translate-selection-with-memory.json`
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FilePathUtils } from './utils';
import {
    buildDefaultProofreadSelectionWithMemoryConfig,
    getHeadingContextLevel,
    parseProofreadSelectionWithMemoryConfig,
    type ProofreadSelectionWithMemoryConfig,
    resolveSourceTextHint,
} from './proofreadSelectionWithMemoryConfig';
import { CONTEXT_BUILD_ADJACENT_BY_LENGTH } from './proofreadSelectionLastRun';

export interface TranslateSelectionWithMemoryConfig extends ProofreadSelectionWithMemoryConfig {
    /** 相对工作区的试译样张路径（可选） */
    styleSamplePath?: string;
}

export async function loadTranslateSelectionWithMemoryConfig(context: vscode.ExtensionContext): Promise<{
    contextMode: ProofreadSelectionWithMemoryConfig['contextMode'];
    beforeMinLength: number;
    afterMinLength: number;
    includeTargetInContext: boolean;
    headingLevel: 1 | 2 | 3 | 4 | 5 | 6;
    temperature: number;
    repetitionMode: 'none' | 'target' | 'all';
    styleSamplePath?: string;
    sourceTextHintBody: string;
    sourceTextHintTitle?: string;
    contextLevel?: string;
} | null> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return null;
    }
    const defaultTemp =
        vscode.workspace.getConfiguration('ai-proofread').get<number>('proofread.temperature', 1.0) ?? 1.0;
    const defaults = buildDefaultProofreadSelectionWithMemoryConfig(defaultTemp, 'none') as TranslateSelectionWithMemoryConfig;
    defaults.contextMode = 'adjacentParagraphs';
    defaults.styleSamplePath = '';

    const root = FilePathUtils.getProofreadWorkspaceRoot(editor.document.uri);
    const dir = path.join(root, '.proofread');
    const configPath = path.join(dir, 'translate-selection-with-memory.json');
    FilePathUtils.ensureDirExists(dir);

    if (!fs.existsSync(configPath)) {
        fs.writeFileSync(configPath, `${JSON.stringify(defaults, null, 2)}\n`, 'utf8');
        vscode.window.showInformationMessage(
            `已生成 ${path.basename(configPath)}，请按需填写 styleSamplePath（试译样张）后重试。`
        );
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
        vscode.window.showErrorMessage(`无法解析 ${configPath}`);
        return null;
    }

    const base = parseProofreadSelectionWithMemoryConfig(parsed, defaults);
    const styleSamplePath =
        typeof (parsed as { styleSamplePath?: unknown }).styleSamplePath === 'string'
            ? String((parsed as { styleSamplePath: string }).styleSamplePath).trim()
            : '';

    const hint = resolveSourceTextHint(base.sourceTextHint, context);
    if (!hint.ok) {
        vscode.window.showErrorMessage(hint.message);
        return null;
    }

    let contextLevel: string | undefined;
    if (base.contextMode === 'headingScope') {
        contextLevel = getHeadingContextLevel(base.headingLevel);
    } else if (base.contextMode === 'adjacentParagraphs') {
        contextLevel = CONTEXT_BUILD_ADJACENT_BY_LENGTH;
    }

    return {
        ...base,
        styleSamplePath: styleSamplePath || undefined,
        sourceTextHintBody: hint.result.injectText,
        sourceTextHintTitle: hint.result.displayTitle,
        contextLevel,
    };
}
