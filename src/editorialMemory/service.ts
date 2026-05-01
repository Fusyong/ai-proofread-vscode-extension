import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FilePathUtils, normalizeLineEndings } from '../utils';
import { getMarkdownHeadingBreadcrumb } from '../splitter';
import type { EditorialPathBlock, MergeRoundPayload, ParsedEditorialMemory } from './types';
import { DEFAULT_EDITORIAL_MEMORY_FILE, parseEditorialMemory, serializeEditorialMemory, upsertPathBlock } from './parser';
import {
    attentionForHeading,
    buildMatchedSet,
    buildReferenceSet,
    docMatches,
} from './window';
import { summarizeRoundSentenceAligned } from './recentSentenceSummary';
import { runMergeLlm, validateSectionPaths } from './mergeRound';
import type { MergeLlmResult } from './types';

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
        enabled: c.get<boolean>('editorialMemory.enabled', true),
        backupBeforeWrite: c.get<boolean>('editorialMemory.backupBeforeWrite', true),
        maxFileChars: c.get<number>('editorialMemory.maxFileChars', 200_000),
        injectMatchedMaxChars: c.get<number>('editorialMemory.injectMatchedMaxChars', 12_000),
        injectReferenceMaxChars: c.get<number>('editorialMemory.injectReferenceMaxChars', 8_000),
        injectReferenceMaxBlocks: c.get<number>('editorialMemory.injectReferenceMaxBlocks', 12),
        injectRecentMaxChars: c.get<number>('editorialMemory.injectRecentMaxChars', 4_000),
        injectMatchedMode: c.get<'prefixThenNarrow' | 'ancestorChainOnly'>(
            'editorialMemory.injectMatchedMode',
            'prefixThenNarrow'
        ),
        injectIncludeChildPathDepth: c.get<number>('editorialMemory.injectIncludeChildPathDepth', 1),
        mergeAfterAccept: c.get<boolean>('editorialMemory.mergeAfterAccept', true),
        mergeWindowMaxChars: c.get<number>('editorialMemory.mergeWindowMaxChars', 24_000),
        mergeModelOverride: c.get<string>('editorialMemory.mergeModelOverride', ''),
        attentionScoreBase: c.get<number>('editorialMemory.attentionScoreBase', 1),
        attentionScoreBonusUserEdit: c.get<number>('editorialMemory.attentionScoreBonusUserEdit', 2),
        attentionScoreMax: c.get<number>('editorialMemory.attentionScoreMax', 99),
        recentMaxRounds: c.get<number>('editorialMemory.recentMaxRounds', 40),
        recentMaxChars: c.get<number>('editorialMemory.recentMaxChars', 12_000),
        roundMaxChars: c.get<number>('editorialMemory.roundMaxChars', 8_000),
    };
}

function loadOrInit(memPath: string): ParsedEditorialMemory {
    FilePathUtils.ensureDirExists(path.dirname(memPath));
    if (!fs.existsSync(memPath)) {
        fs.writeFileSync(memPath, DEFAULT_EDITORIAL_MEMORY_FILE, 'utf8');
    }
    return parseEditorialMemory(fs.readFileSync(memPath, 'utf8'));
}

function truncateGlobalAndPaths(globalBody: string, pathsMd: string, max: number): { g: string; p: string } {
    let g = globalBody;
    let p = pathsMd;
    while (g.length + p.length > max && p.length > 200) {
        p = p.slice(0, Math.floor(p.length * 0.85));
    }
    while (g.length + p.length > max && g.length > 200) {
        g = g.slice(0, Math.floor(g.length * 0.85));
    }
    return { g, p };
}

function clip(s: string, max: number): string {
    if (s.length <= max) {
        return s;
    }
    return s.slice(0, max) + '\n…(截断)';
}

function prependRecentBullet(parsed: ParsedEditorialMemory, bulletLine: string, maxRounds: number, maxChars: number): void {
    const existing = parsed.recentSectionBody
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('-'));
    const merged = [bulletLine.trim(), ...existing].slice(0, maxRounds);
    let body = merged.join('\n');
    if (body.length > maxChars) {
        const lines: string[] = [];
        let used = 0;
        for (const line of merged) {
            if (used + line.length + 1 > maxChars) {
                break;
            }
            lines.push(line);
            used += line.length + 1;
        }
        body = lines.join('\n');
    }
    parsed.recentSectionBody = body;
}

function setAttentionOnBlock(block: EditorialPathBlock, score: number): EditorialPathBlock {
    const clamped = Math.max(0, Math.min(score, 99));
    let raw = block.fullRaw;
    if (/<!--\s*attention_score:\s*\d+\s*-->/.test(raw)) {
        raw = raw.replace(/<!--\s*attention_score:\s*\d+\s*-->/i, `<!-- attention_score: ${clamped} -->`);
    } else {
        const m = raw.match(/^(### path:[^\n]*\n)/);
        if (m) {
            raw = `${m[1]}<!-- attention_score: ${clamped} -->\n${raw.slice(m[0].length)}`;
        }
    }
    return { ...block, attentionScore: clamped, fullRaw: raw };
}

function bumpAttentionForHeading(
    parsed: ParsedEditorialMemory,
    headingPath: string,
    documentId: string,
    base: number,
    bonus: number,
    userEdited: boolean,
    maxScore: number
): void {
    let bestI = -1;
    let bestLen = -1;
    parsed.structureBlocks.forEach((b, i) => {
        if (!docMatches(b, documentId)) {
            return;
        }
        if (headingPath === b.path || headingPath.startsWith(b.path + ' >')) {
            if (b.path.length >= bestLen) {
                bestLen = b.path.length;
                bestI = i;
            }
        }
    });
    if (bestI < 0) {
        return;
    }
    const b = parsed.structureBlocks[bestI];
    const delta = base + (userEdited ? bonus : 0);
    const next = Math.min(maxScore, b.attentionScore + delta);
    parsed.structureBlocks[bestI] = setAttentionOnBlock(b, next);
}

function enforceMaxFileChars(parsed: ParsedEditorialMemory, maxN: number): void {
    let s = serializeEditorialMemory(parsed);
    while (s.length > maxN && parsed.structureBlocks.length > 0) {
        parsed.structureBlocks.pop();
        s = serializeEditorialMemory(parsed);
    }
    while (s.length > maxN && parsed.recentSectionBody.length > 50) {
        const lines = parsed.recentSectionBody.split('\n').filter((l) => l.trim().startsWith('-'));
        lines.pop();
        parsed.recentSectionBody = lines.join('\n');
        s = serializeEditorialMemory(parsed);
    }
}

function applyMergeResult(
    parsed: ParsedEditorialMemory,
    merge: MergeLlmResult,
    documentId: string,
    headingPath: string,
    matchedBlocks: EditorialPathBlock[]
): void {
    parsed.globalBody = merge.global_md.trim();
    let blocks = [...parsed.structureBlocks];
    const allowed = new Set([headingPath, ...matchedBlocks.map((b) => b.path)]);
    const sections = validateSectionPaths(merge.sections, allowed);
    for (const sec of sections) {
        const path = sec.path.trim();
        const body = (sec.body_md ?? '').trim();
        if (!body) {
            continue;
        }
        const existing = blocks.find((b) => b.path === path && docMatches(b, documentId));
        const att = existing?.attentionScore ?? 0;
        const docRel = existing?.docRel;
        blocks = upsertPathBlock(blocks, path, docRel, body, att);
    }
    parsed.structureBlocks = blocks;
    if (merge.recent_append && merge.recent_append.trim()) {
        const line = merge.recent_append.trim();
        if (!parsed.recentSectionBody.includes(line)) {
            prependRecentBullet(parsed, line, readConfig().recentMaxRounds, readConfig().recentMaxChars);
        }
    }
}

function appendMergeFallback(parsed: ParsedEditorialMemory, headingPath: string, documentId: string, snippet: string): void {
    const ts = new Date().toISOString();
    const line = `- \`[${ts}]\` ${documentId} / \`${headingPath}\`：[merge-fallback] ${snippet.replace(/\s+/g, ' ').slice(0, 400)}`;
    prependRecentBullet(parsed, line, readConfig().recentMaxRounds, readConfig().recentMaxChars);
}

/** 供 proofread：拼接到 preText（reference/context 之后） */
export async function buildEditorialMemoryXml(
    documentUri: vscode.Uri,
    fullText: string,
    selectionStartLine: number,
    editorialMemoryForceEnabled?: boolean
): Promise<string> {
    const cfg = readConfig();
    const memoryOn = editorialMemoryForceEnabled === true || cfg.enabled;
    if (!memoryOn) {
        return '';
    }
    const memPath = FilePathUtils.getEditorialMemoryPath(documentUri);
    const parsed = loadOrInit(memPath);
    const { headingPath, nearestHeadingLevel } = getMarkdownHeadingBreadcrumb(fullText, selectionStartLine);
    const documentId = getDocumentRelativeId(documentUri);

    const matched = buildMatchedSet(
        parsed.structureBlocks,
        headingPath,
        documentId,
        cfg.injectMatchedMode,
        cfg.injectIncludeChildPathDepth,
        cfg.injectMatchedMaxChars
    );
    const matchedMd =
        `## 全局\n` +
        clip(parsed.globalBody, Math.min(8000, cfg.injectMatchedMaxChars / 2)) +
        `\n\n## 按文档结构\n` +
        matched.map((b) => b.fullRaw).join('\n').slice(0, cfg.injectMatchedMaxChars);

    const ref = buildReferenceSet(
        parsed.structureBlocks,
        parsed.pendingBlocks,
        headingPath,
        documentId,
        matched,
        cfg.injectReferenceMaxBlocks,
        cfg.injectReferenceMaxChars
    );
    const refMd = ref.map((b) => b.fullRaw).join('\n');

    const recentClip = clip(parsed.recentSectionBody, cfg.injectRecentMaxChars);
    const att = attentionForHeading(parsed.structureBlocks, headingPath, documentId);
    const sel =
        typeof selectionStartLine === 'number'
            ? `L${selectionStartLine + 1}`
            : '';
    const ctx = `<current_proofread_context>
document: ${documentId}
heading_path: ${headingPath}
nearest_heading_level: ${nearestHeadingLevel}
selection: ${sel}
heading_path_attention: ${att}
note: 用户自行框选的校对范围；以下 target 即该范围全文。
</current_proofread_context>`;

    let out = '';
    if (matchedMd.trim()) {
        out += `\n<editorial_memory>\n${matchedMd.trim()}\n</editorial_memory>`;
    }
    if (recentClip.trim()) {
        out += `\n<editorial_memory_recent>\n${recentClip.trim()}\n</editorial_memory_recent>`;
    }
    if (refMd.trim()) {
        out += `\n<editorial_memory_reference>\n${refMd.trim()}\n</editorial_memory_reference>`;
    }
    out += `\n${ctx}`;
    return out;
}

export interface AfterAcceptArgs {
    documentUri: vscode.Uri;
    fullText: string;
    selectionStartLine: number;
    selectionRangeLabel: string;
    originalSelected: string;
    finalSelected: string;
    modelOutput: string;
    platform: string;
    model: string;
    items?: Array<{ original: string; corrected: string }>;
    /** 为 true 时忽略 `editorialMemory.enabled=false`，仍为本次校对注入并写回记忆 */
    editorialMemoryForceEnabled?: boolean;
}

export async function runEditorialMemoryAfterAccept(args: AfterAcceptArgs): Promise<void> {
    const cfg = readConfig();
    if (!cfg.enabled && args.editorialMemoryForceEnabled !== true) {
        return;
    }
    const memPath = FilePathUtils.getEditorialMemoryPath(args.documentUri);
    const parsed = loadOrInit(memPath);
    const { headingPath } = getMarkdownHeadingBreadcrumb(args.fullText, args.selectionStartLine);
    const documentId = getDocumentRelativeId(args.documentUri);
    const userEdited = args.finalSelected !== args.modelOutput;

    const ts = new Date().toISOString();
    const sum = summarizeRoundSentenceAligned(args.originalSelected, args.finalSelected, cfg.roundMaxChars);
    const bullet = `- \`[${ts}]\` ${documentId} / \`${headingPath}\`：${sum}`;
    prependRecentBullet(parsed, bullet, cfg.recentMaxRounds, cfg.recentMaxChars);

    if (cfg.mergeAfterAccept) {
        const matched = buildMatchedSet(
            parsed.structureBlocks,
            headingPath,
            documentId,
            cfg.injectMatchedMode,
            cfg.injectIncludeChildPathDepth,
            cfg.mergeWindowMaxChars
        );
        let winGlobal = parsed.globalBody;
        let winPaths = matched.map((b) => b.fullRaw).join('\n');
        const tw = truncateGlobalAndPaths(winGlobal, winPaths, cfg.mergeWindowMaxChars);
        winGlobal = tw.g;
        winPaths = tw.p;

        const payload: MergeRoundPayload = {
            document_id: documentId,
            heading_path: headingPath,
            selection_range: args.selectionRangeLabel,
            original_selected: clip(args.originalSelected, cfg.roundMaxChars),
            final_selected: clip(args.finalSelected, cfg.roundMaxChars),
            item_level_changes: args.items,
            user_edited_away_from_model: userEdited,
        };
        const mergeModel = cfg.mergeModelOverride.trim() || args.model;
        const allowedPaths = [...new Set([headingPath, ...matched.map((b) => b.path)])];
        const merge = await runMergeLlm(args.platform, mergeModel, winGlobal, winPaths, payload, allowedPaths);
        if (merge) {
            applyMergeResult(parsed, merge, documentId, headingPath, matched);
        } else {
            appendMergeFallback(parsed, headingPath, documentId, `合并 LLM 失败；原/终稿摘要：${sum}`);
        }
    }

    bumpAttentionForHeading(
        parsed,
        headingPath,
        documentId,
        cfg.attentionScoreBase,
        cfg.attentionScoreBonusUserEdit,
        userEdited,
        cfg.attentionScoreMax
    );

    enforceMaxFileChars(parsed, cfg.maxFileChars);
    const out = serializeEditorialMemory(parsed);
    const dir = path.dirname(memPath);
    FilePathUtils.ensureDirExists(dir);
    if (cfg.backupBeforeWrite && fs.existsSync(memPath)) {
        FilePathUtils.backupFileIfExists(memPath, false);
    }
    fs.writeFileSync(memPath, out, 'utf8');
}

export async function clearEditorialMemory(uri: vscode.Uri): Promise<void> {
    const memPath = FilePathUtils.getEditorialMemoryPath(uri);
    const cfg = readConfig();
    if (cfg.backupBeforeWrite && fs.existsSync(memPath)) {
        FilePathUtils.backupFileIfExists(memPath, false);
    }
    fs.writeFileSync(memPath, DEFAULT_EDITORIAL_MEMORY_FILE, 'utf8');
}
