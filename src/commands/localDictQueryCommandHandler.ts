import * as vscode from 'vscode';
import { ErrorUtils } from '../utils';
import { resolveLocalDictConfigs, ensureDictFilesExist } from '../localDict/dictConfig';
import { MdictClient } from '../localDict/mdictClient';
import { stripHtmlToText } from '../localDict/htmlToText';
import {
    buildOpenccAltTerms,
    extractLookupCandidates,
    MAX_DIRECT_DICT_LOOKUP_CHARS,
    sanitizeLookupTerm,
} from '../localDict/dictLookupShared';
import { getDictPrepConfigKeys } from '../referencePrep/config';
import { runReferencePrepForTarget } from '../referencePrep/referencePrepRunner';

export class LocalDictQueryCommandHandler {
    public async handleQuerySelectionCommand(
        editor: vscode.TextEditor,
        context: vscode.ExtensionContext
    ): Promise<void> {
        if (!editor) {
            vscode.window.showInformationMessage('No active editor!');
            return;
        }
        const sel = editor.selection;
        if (!sel || sel.isEmpty) {
            vscode.window.showInformationMessage('请先选中要查询的词语/短语。');
            return;
        }
        const rawSelection = editor.document.getText(sel).trim();
        if (!rawSelection) {
            vscode.window.showInformationMessage('选中文本为空，无法查询。');
            return;
        }

        const dicts = resolveLocalDictConfigs();
        if (dicts.length === 0) {
            vscode.window.showErrorMessage('未配置本地词典：请在设置中配置 ai-proofread.localDicts');
            return;
        }
        const exist = ensureDictFilesExist(dicts);
        if (!exist.ok) {
            vscode.window.showErrorMessage(exist.errors.join('\n'));
            return;
        }

        const sanitized = sanitizeLookupTerm(rawSelection);
        if (sanitized.length > MAX_DIRECT_DICT_LOOKUP_CHARS) {
            const mode = await vscode.window.showQuickPick(
                [
                    {
                        label: '智能规划查词（与知识核查相同）',
                        description: '大模型从选段规划词条并查本地词典，适合段落',
                        id: 'prep',
                    },
                    {
                        label: '快速查单个词',
                        description: '从选区提取候选词，不调用大模型',
                        id: 'quick',
                    },
                    {
                        label: '打开知识核查（可接着校对）',
                        description: 'AI Proofreader: knowledge verify selection',
                        id: 'knowledge',
                    },
                ],
                { title: '选区较长', ignoreFocusOut: true }
            );
            if (!mode) return;
            if (mode.id === 'prep') {
                await this.runDictOnlyReferencePrep(editor, context, rawSelection);
                return;
            }
            if (mode.id === 'knowledge') {
                await vscode.commands.executeCommand('ai-proofread.knowledgeVerifySelection');
                return;
            }
        }

        await this.runQuickDictLookup(context, rawSelection, dicts);
    }

    /** 与知识核查「仅词典」阶段相同：多轮规划 + executeDictQuery */
    private async runDictOnlyReferencePrep(
        editor: vscode.TextEditor,
        context: vscode.ExtensionContext,
        target: string
    ): Promise<void> {
        try {
            const { mergedReference } = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: '本地词典（智能规划）',
                    cancellable: true,
                },
                async (_p, token) =>
                    runReferencePrepForTarget({
                        target,
                        anchorPath: editor.document.uri.fsPath,
                        context,
                        enabledSources: ['dict'],
                        strength: 'light',
                        freshProcess: true,
                        onProgress: (m) => _p.report({ message: m }),
                        token,
                    })
            );

            if (mergedReference?.trim()) {
                const doc = await vscode.workspace.openTextDocument({
                    content: mergedReference,
                    language: 'markdown',
                });
                await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
                vscode.window.showInformationMessage('词典参考资料已准备（与知识核查流程相同）。');
            } else {
                vscode.window.showInformationMessage('未检索到词典命中。');
            }
        } catch (e) {
            ErrorUtils.showError(e, '智能规划查词失败：');
        }
    }

    private async runQuickDictLookup(
        context: vscode.ExtensionContext,
        rawSelection: string,
        dicts: Awaited<ReturnType<typeof resolveLocalDictConfigs>>
    ): Promise<void> {
        const candidates = extractLookupCandidates(rawSelection);
        if (candidates.length === 0) {
            vscode.window.showWarningMessage(
                '无法从选区识别可查词的中文词语。长段落请改用「智能规划查词」或「knowledge verify selection」。'
            );
            return;
        }

        let term = candidates[0];
        if (candidates.length > 1) {
            const pickedTerm = await vscode.window.showQuickPick(
                candidates.slice(0, 30).map((c) => ({
                    label: c,
                    description: c.length > 8 ? '较长短语' : undefined,
                })),
                {
                    title: '请选择要查询的词语',
                    placeHolder: `已从选区提取 ${candidates.length} 个候选`,
                    ignoreFocusOut: true,
                }
            );
            if (!pickedTerm) return;
            term = pickedTerm.label;
        }

        const choices: Array<{ label: string; id: string; description?: string }> = [
            { label: '全部词典', id: '__all__', description: '依次查询所有已配置词典' },
            ...dicts.map((d) => ({ label: d.name, id: d.id, description: d.mdxPathResolved })),
        ];

        const picked = await vscode.window.showQuickPick(choices, {
            title: '本地词典查询（快速）',
            placeHolder: `查询：${term}`,
            ignoreFocusOut: true,
        });
        if (!picked) return;

        const { maxDefinitionChars, cacheEnabled, cacheTtlHours } = getDictPrepConfigKeys();
        const client = MdictClient.getInstance(context);
        const targets = picked.id === '__all__' ? dicts : dicts.filter((d) => d.id === picked.id);

        try {
            const hits = await this.lookupTermAcrossDicts(client, targets, term, {
                maxDefinitionChars,
                cacheEnabled,
                cacheTtlHours,
            });

            const content = buildMarkdownResult(term, rawSelection, hits);
            const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content });
            await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
        } catch (e) {
            ErrorUtils.showError(e, '本地词典查询失败：');
        }
    }

    private async lookupTermAcrossDicts(
        client: MdictClient,
        dicts: Awaited<ReturnType<typeof resolveLocalDictConfigs>>,
        term: string,
        options: {
            maxDefinitionChars: number;
            cacheEnabled: boolean;
            cacheTtlHours: number;
        }
    ): Promise<
        Array<{
            dictId: string;
            dictName: string;
            matchedKey: string;
            definition: string;
            entryIndex: number;
            queryTerm: string;
        }>
    > {
        const baseTerm = sanitizeLookupTerm(term);
        if (!baseTerm) return [];

        const termsToTry = [baseTerm, ...buildOpenccAltTerms(baseTerm)];
        const hits: Array<{
            dictId: string;
            dictName: string;
            matchedKey: string;
            definition: string;
            entryIndex: number;
            queryTerm: string;
        }> = [];

        for (const d of dicts) {
            let dictHits: Awaited<ReturnType<typeof client.lookupMany>> = [];
            let usedQuery = baseTerm;
            for (const t of termsToTry) {
                const many = await client.lookupMany(d, t, 'exact', {
                    prefixMaxCandidates: 0,
                    minPrefixLength: 999,
                    maxDefinitionChars: options.maxDefinitionChars,
                    cacheEnabled: options.cacheEnabled,
                    cacheTtlHours: options.cacheTtlHours,
                });
                if (many.length > 0) {
                    dictHits = many;
                    usedQuery = t;
                    break;
                }
            }
            for (let i = 0; i < dictHits.length; i++) {
                const hit = dictHits[i];
                hits.push({
                    dictId: hit.dictId,
                    dictName: hit.dictName,
                    matchedKey: hit.matchedKey,
                    definition: hit.definition,
                    entryIndex: i + 1,
                    queryTerm: usedQuery,
                });
            }
        }

        return hits;
    }
}

function buildMarkdownResult(
    term: string,
    rawSelection: string,
    hits: Array<{
        dictId: string;
        dictName: string;
        matchedKey: string;
        definition: string;
        entryIndex: number;
        queryTerm: string;
    }>
): string {
    const lines: string[] = [];
    lines.push(`# 本地词典查询（快速）`);
    lines.push('');
    lines.push(`- 查询词：**${escapeMd(term)}**`);
    if (sanitizeLookupTerm(rawSelection) !== sanitizeLookupTerm(term)) {
        const preview =
            rawSelection.length > 80 ? rawSelection.slice(0, 80) + '…' : rawSelection;
        lines.push(`- 原选区（节选）：${escapeMd(preview)}`);
    }
    lines.push(`- 命中：**${hits.length}**`);
    lines.push('');

    if (hits.length === 0) {
        lines.push('未命中任何词典。');
        lines.push('');
        lines.push(
            '提示：查**段落**请用命令面板中的 **knowledge verify selection**，或在长选区时选择「智能规划查词」。'
        );
        lines.push('');
        return lines.join('\n');
    }

    for (const h of hits) {
        const suffix = hits.filter((x) => x.dictId === h.dictId).length > 1 ? ` #${h.entryIndex}` : '';
        const altNote = h.queryTerm !== term ? `（检索用形：${h.queryTerm}）` : '';
        lines.push(`## ${escapeMd(h.dictName)}（${escapeMd(h.dictId)}）${suffix}${altNote}`);
        lines.push('');
        lines.push(`- 词条：**${escapeMd(h.matchedKey)}**`);
        lines.push('');
        lines.push(stripHtmlToText(h.definition));
        lines.push('');
    }
    return lines.join('\n');
}

function escapeMd(s: string): string {
    return s.replace(/[\\`*_{}\[\]()#+\-.!]/g, '\\$&');
}
