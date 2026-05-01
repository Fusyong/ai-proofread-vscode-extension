import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FilePathUtils, Logger } from '../utils';
import { editorialMemoryChat, stripJsonFence } from './llmChat';
import { parseEditorialMemory } from './parser';
import { docMatches, normalizeDocPath } from './window';

export interface ReconcileRow {
    old_path: string;
    new_path: string | null;
    action: string;
    notes?: string;
}

const RECONCILE_SYSTEM = `你是书稿结构助手。输入为「当前文档 TOC 路径列表」和「待对齐的记忆块 old_path」。
只输出一个 JSON 数组，元素形如 { "old_path": "...", "new_path": "新路径字符串或 null", "action": "rename|keep_pending", "notes": "..." }。
new_path 必须从给定的 TOC 列表中**逐字**选取一项，或在与 old_path 明确等价时选最接近的一项；若无法映射则 new_path 为 null 且 action 为 keep_pending。
不要输出 Markdown 围栏以外的文字。`;

export function extractTocBreadcrumbs(docText: string): string[] {
    const lines = docText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const stack: { level: number; title: string }[] = [];
    const out: string[] = [];
    for (const line of lines) {
        const m = line.match(/^(#{1,6})\s+(.+)$/);
        if (!m) {
            continue;
        }
        const level = m[1].length;
        let title = m[2].trim().replace(/\s+#+\s*$/, '');
        while (stack.length > 0 && stack[stack.length - 1].level >= level) {
            stack.pop();
        }
        stack.push({ level, title });
        out.push(stack.map((s) => s.title).join(' > '));
    }
    return [...new Set(out)];
}

export function collectOldPathsForReconcile(memPath: string, documentId: string): string[] {
    if (!fs.existsSync(memPath)) {
        return [];
    }
    const raw = fs.readFileSync(memPath, 'utf8');
    const p = parseEditorialMemory(raw);
    const out = new Set<string>();
    const id = normalizeDocPath(documentId);
    for (const b of [...p.structureBlocks, ...p.pendingBlocks]) {
        if (docMatches(b, id)) {
            out.add(b.path);
        }
    }
    return [...out];
}

/** 机械替换 ### path: 行（仅当 new_path 在 tocSet 中） */
export function applyReconcilePaths(memRaw: string, rows: ReconcileRow[], tocSet: Set<string>): { text: string; applied: number; skipped: string[] } {
    let text = memRaw;
    let applied = 0;
    const skipped: string[] = [];
    for (const row of rows) {
        if (row.action !== 'rename' || !row.new_path) {
            skipped.push(`${row.old_path}: ${row.action}`);
            continue;
        }
        if (!tocSet.has(row.new_path)) {
            skipped.push(`${row.old_path}: new_path not in TOC`);
            continue;
        }
        const re = new RegExp(`^(### path:\\s*)${escapeRe(row.old_path)}\\s*$`, 'gm');
        const n = text.replace(re, `$1${row.new_path}`);
        if (n !== text) {
            text = n;
            applied++;
        }
    }
    return { text, applied, skipped };
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function runReconcileForActiveDocument(
    memPath: string,
    docUri: vscode.Uri,
    platform: string,
    model: string
): Promise<void> {
    const logger = Logger.getInstance();
    const doc = await vscode.workspace.openTextDocument(docUri);
    const docText = doc.getText();
    const folder = vscode.workspace.getWorkspaceFolder(docUri);
    const documentId = folder ? path.relative(folder.uri.fsPath, docUri.fsPath).replace(/\\/g, '/') : path.basename(docUri.fsPath);

    const toc = extractTocBreadcrumbs(docText);
    const tocSet = new Set(toc);
    const uniqueOld = collectOldPathsForReconcile(memPath, documentId);
    if (uniqueOld.length === 0) {
        vscode.window.showInformationMessage('未在记忆文件中找到与本稿相关的 ### path 块。');
        return;
    }

    const user = `【当前 TOC 路径列表】\n${JSON.stringify(toc, null, 2)}\n\n【待对齐 old_path 列表】\n${JSON.stringify(uniqueOld, null, 2)}\n\n请输出 JSON 数组。`;
    const raw = await editorialMemoryChat(platform, model, RECONCILE_SYSTEM, user, 0.2);
    if (!raw) {
        vscode.window.showErrorMessage('reconcile：模型无返回。');
        return;
    }
    let rows: ReconcileRow[];
    try {
        rows = JSON.parse(stripJsonFence(raw)) as ReconcileRow[];
        if (!Array.isArray(rows)) {
            throw new Error('not array');
        }
    } catch {
        vscode.window.showErrorMessage('reconcile：无法解析 JSON。');
        return;
    }

    const memRaw = fs.existsSync(memPath) ? fs.readFileSync(memPath, 'utf8') : '';
    const { text, applied, skipped } = applyReconcilePaths(memRaw, rows, tocSet);
    const logDir = path.dirname(memPath);
    FilePathUtils.ensureDirExists(logDir);
    const logPath = path.join(logDir, 'editorial-memory.reconcile.log.md');
    const ts = new Date().toISOString();
    const logBody = `\n## ${ts}\n- applied: ${applied}\n- skipped:\n${skipped.map((s) => `  - ${s}`).join('\n')}\n`;
    fs.appendFileSync(logPath, logBody, 'utf8');

    const backup = vscode.workspace.getConfiguration('ai-proofread').get<boolean>('editorialMemory.backupBeforeWrite', true);
    if (backup && fs.existsSync(memPath)) {
        FilePathUtils.backupFileIfExists(memPath, false);
    }
    fs.writeFileSync(memPath, text, 'utf8');
    vscode.window.showInformationMessage(`reconcile 完成：已改写 ${applied} 条 path；详情见 .proofread/editorial-memory.reconcile.log.md`);
    logger.info(`[reconcile] applied=${applied}`);
}
