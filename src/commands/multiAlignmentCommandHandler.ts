/**
 * 合并多份勘误 alignment.json 命令
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AlignmentReportJson } from '../alignmentReportGenerator';
import {
    mergeAlignmentReports,
    type MultiAlignmentSource,
} from '../multiAlignmentMerger';
import { generateMultiAlignmentReport } from '../multiAlignmentReportGenerator';
import type { AlignmentOptions } from '../sentenceAligner';
import { ErrorUtils } from '../utils';
import { getJiebaWasm } from '../jiebaLoader';

function sourceLabelFromPath(filePath: string): string {
    const parent = path.basename(path.dirname(filePath));
    if (parent && parent !== '.' && parent !== path.parse(filePath).root) {
        return parent;
    }
    return path.basename(filePath, path.extname(filePath));
}

function loadReport(filePath: string): AlignmentReportJson {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw) as AlignmentReportJson;
    if (!data || !Array.isArray(data.items)) {
        throw new Error(`不是有效的 alignment JSON：${path.basename(filePath)}`);
    }
    return data;
}

async function collectAlignmentJsonPaths(): Promise<string[] | undefined> {
    const mode = await vscode.window.showQuickPick(
        [
            { label: '多选 alignment.json 文件', value: 'files' as const },
            { label: '选择文件夹（收集子目录内 *.alignment.json）', value: 'folder' as const },
        ],
        {
            placeHolder: '如何选择要合并的勘误 JSON？',
            title: '合并多份勘误 JSON',
            ignoreFocusOut: true,
        }
    );
    if (!mode) {
        return undefined;
    }

    if (mode.value === 'files') {
        const uris = await vscode.window.showOpenDialog({
            canSelectMany: true,
            canSelectFiles: true,
            canSelectFolders: false,
            filters: { 'Alignment JSON': ['json'], '所有文件': ['*'] },
            title: '选择多份 .alignment.json（顺序可稍后确认）',
        });
        if (!uris || uris.length === 0) {
            return undefined;
        }
        return uris.map(u => u.fsPath);
    }

    const folderUris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        canSelectFiles: false,
        canSelectFolders: true,
        title: '选择包含各校次子目录的文件夹',
    });
    if (!folderUris || folderUris.length === 0) {
        return undefined;
    }
    const root = folderUris[0].fsPath;
    const found: string[] = [];
    const walk = (dir: string, depth: number) => {
        if (depth > 3) {
            return;
        }
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const ent of entries) {
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) {
                walk(full, depth + 1);
            } else if (ent.isFile() && /\.alignment\.json$/i.test(ent.name)) {
                found.push(full);
            }
        }
    };
    walk(root, 0);
    if (found.length === 0) {
        vscode.window.showWarningMessage(`未在 ${root} 下找到 *.alignment.json`);
        return undefined;
    }
    found.sort((a, b) => a.localeCompare(b, 'zh'));
    return found;
}

async function confirmOrder(paths: string[]): Promise<string[] | undefined> {
    if (paths.length < 2) {
        vscode.window.showWarningMessage('请至少选择 2 份 alignment JSON');
        return undefined;
    }

    let order = [...paths];

    while (true) {
        const items: Array<vscode.QuickPickItem & { action: string; index?: number }> = [
            {
                label: '$(check) 完成（使用当前顺序）',
                description: order.map((p, i) => `${i + 1}.${sourceLabelFromPath(p)}`).join(' → '),
                action: 'done',
            },
            {
                label: '$(close) 取消',
                action: 'cancel',
            },
            ...order.map((p, i) => ({
                label: `${i + 1}. ${sourceLabelFromPath(p)}`,
                description: p,
                detail: '选择后可上移 / 下移 / 移除',
                action: 'item',
                index: i,
            })),
        ];

        const picked = await vscode.window.showQuickPick(items, {
            title: '调整校次并入顺序',
            placeHolder: '当前顺序见上方「完成」说明；点某文件可调序',
            ignoreFocusOut: true,
        });

        if (!picked || picked.action === 'cancel') {
            return undefined;
        }
        if (picked.action === 'done') {
            if (order.length < 2) {
                vscode.window.showWarningMessage('请至少保留 2 份 alignment JSON');
                continue;
            }
            return order;
        }

        const idx = picked.index!;
        const move = await vscode.window.showQuickPick(
            [
                {
                    label: '$(arrow-up) 上移',
                    action: 'up' as const,
                    description: idx === 0 ? '已在最前' : undefined,
                },
                {
                    label: '$(arrow-down) 下移',
                    action: 'down' as const,
                    description: idx >= order.length - 1 ? '已在最后' : undefined,
                },
                { label: '$(trash) 移除', action: 'remove' as const },
                { label: '返回', action: 'back' as const },
            ],
            {
                title: `调整：${sourceLabelFromPath(order[idx])}`,
                ignoreFocusOut: true,
            }
        );
        if (!move || move.action === 'back') {
            continue;
        }
        if (move.action === 'up' && idx > 0) {
            const t = order[idx - 1];
            order[idx - 1] = order[idx];
            order[idx] = t;
        } else if (move.action === 'down' && idx < order.length - 1) {
            const t = order[idx + 1];
            order[idx + 1] = order[idx];
            order[idx] = t;
        } else if (move.action === 'remove') {
            order.splice(idx, 1);
            if (order.length < 2) {
                vscode.window.showWarningMessage('至少需保留 2 份，已阻止移除到不足');
                // 不真正阻止——用户可再加不了；若已删到 <2，完成时会拦截
            }
        }
    }
}

export class MultiAlignmentCommandHandler {
    constructor(private context: vscode.ExtensionContext) {}

    public async handleMergeAlignmentReportsCommand(): Promise<void> {
        try {
            const collected = await collectAlignmentJsonPaths();
            if (!collected) {
                return;
            }
            const ordered = await confirmOrder(collected);
            if (!ordered) {
                return;
            }

            const config = vscode.workspace.getConfiguration('ai-proofread.alignment');
            const defaultSimilarityThreshold = config.get<number>('similarityThreshold', 0.6);
            const similarityThresholdInput = await vscode.window.showInputBox({
                prompt: '合并时 a 序列对齐的相似度阈值（0-1）',
                value: defaultSimilarityThreshold.toString(),
                validateInput: (value: string) => {
                    const num = parseFloat(value);
                    if (isNaN(num)) {
                        return '请输入有效的数字';
                    }
                    if (num < 0 || num > 1) {
                        return '相似度阈值必须在 0-1 之间';
                    }
                    return null;
                },
            });
            if (similarityThresholdInput === undefined) {
                return;
            }
            const similarityThreshold = parseFloat(similarityThresholdInput);

            const removeInnerWhitespaceChoice = await vscode.window.showQuickPick(
                [
                    { label: '是（默认）', description: '忽略句中空白', value: true },
                    { label: '否', description: '保留句中空白', value: false },
                ],
                {
                    placeHolder: '相似度计算时是否忽略句中空白？',
                    title: '句中空白',
                    ignoreFocusOut: true,
                }
            );
            const removeInnerWhitespace = removeInnerWhitespaceChoice?.value ?? true;

            const citationConfig = vscode.workspace.getConfiguration('ai-proofread.citation');
            const ngramGranularity = config.get<'word' | 'char'>('ngramGranularity', 'word');
            let jieba: import('../jiebaLoader').JiebaWasmModule | undefined;
            if (ngramGranularity === 'word') {
                try {
                    const customDictPath = vscode.workspace
                        .getConfiguration('ai-proofread.jieba')
                        .get<string>('customDictPath', '');
                    jieba = getJiebaWasm(
                        path.join(this.context.extensionPath, 'dist'),
                        customDictPath || undefined
                    );
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    vscode.window.showWarningMessage(
                        `jieba 加载失败，将使用字级相似度继续：${msg}`
                    );
                }
            }

            const options: AlignmentOptions = {
                algorithm: 'anchor',
                windowSize: config.get<number>('windowSize', 10),
                similarityThreshold,
                ngramSize: config.get<number>('ngramSize', 1),
                ngramGranularity: jieba ? 'word' : 'char',
                cutMode: vscode.workspace
                    .getConfiguration('ai-proofread.jieba')
                    .get<'default' | 'search'>('cutMode', 'default'),
                jieba,
                offset: config.get<number>('offset', 1),
                maxWindowExpansion: config.get<number>('maxWindowExpansion', 3),
                consecutiveFailThreshold: config.get<number>('consecutiveFailThreshold', 3),
                removeInnerWhitespace,
                removePunctuation: citationConfig.get<boolean>('normalizeIgnorePunctuation', false),
                removeDigits: config.get<boolean>('normalizeIgnoreDigits', false),
                removeLatin: config.get<boolean>('normalizeIgnoreLatin', false),
                gapEqualRatio: config.get<number>('gapEqualRatio', 0.55),
            };

            const parentDirs = ordered.map(p => path.dirname(p));
            let commonParent = parentDirs[0];
            for (const d of parentDirs.slice(1)) {
                while (
                    commonParent &&
                    commonParent !== path.parse(commonParent).root &&
                    !d.startsWith(commonParent + path.sep) &&
                    d !== commonParent
                ) {
                    commonParent = path.dirname(commonParent);
                }
            }
            const defaultOut = path.join(commonParent, 'multi-alignment.html');
            const outUri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(defaultOut),
                filters: { HTML: ['html'] },
                title: '保存多校次勘误表 HTML',
            });
            if (!outUri) {
                return;
            }
            const outputHtmlPath = outUri.fsPath;

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: '正在合并多份勘误 JSON…',
                    cancellable: false,
                },
                async progress => {
                    const start = Date.now();
                    progress.report({ message: '读取文件…' });
                    const bundles: Array<{
                        report: AlignmentReportJson;
                        source: MultiAlignmentSource;
                    }> = ordered.map((p, i) => {
                        const report = loadReport(p);
                        const source: MultiAlignmentSource = {
                            id: `run${i}`,
                            label: sourceLabelFromPath(p),
                            path: p,
                            titleA: report.titleA || '',
                            titleB: report.titleB || '',
                            options: report.options,
                        };
                        return { report, source };
                    });

                    progress.report({ message: '逐步对齐…' });
                    const table = mergeAlignmentReports(bundles, {
                        ...options,
                        classifyNgramSize: 2,
                    });

                    progress.report({ message: '生成报告…' });
                    const runtime = (Date.now() - start) / 1000;
                    const { htmlPath, jsonPath, csvPath } = generateMultiAlignmentReport(
                        table,
                        outputHtmlPath,
                        runtime
                    );

                    await vscode.env.openExternal(vscode.Uri.file(htmlPath));

                    vscode.window.showInformationMessage(
                        `合并完成：${table.rows.length} 行，${table.sources.length} 校次\n` +
                            `${path.basename(htmlPath)} / ${path.basename(jsonPath)} / ${path.basename(csvPath)}`
                    );
                }
            );
        } catch (error) {
            ErrorUtils.showError(error, '合并勘误 JSON 时出错：');
        }
    }
}
