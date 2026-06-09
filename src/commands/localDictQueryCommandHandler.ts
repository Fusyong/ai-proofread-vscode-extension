import * as vscode from 'vscode';
import { ErrorUtils } from '../utils';
import { resolveLocalDictConfigs, ensureDictFilesExist } from '../localDict/dictConfig';
import { MdictClient } from '../localDict/mdictClient';
import { stripHtmlToText } from '../localDict/htmlToText';
import { getDictPrepConfigKeys } from '../referencePrep/config';

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
        const term = editor.document.getText(sel).trim();
        if (!term) {
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

        const choices: Array<{ label: string; id: string; description?: string }> = [
            { label: '全部词典', id: '__all__', description: '依次查询所有已配置词典' },
            ...dicts.map((d) => ({ label: d.name, id: d.id, description: d.mdxPathResolved })),
        ];

        const picked = await vscode.window.showQuickPick(choices, {
            title: '本地词典查询（整段选文作词条）',
            placeHolder: `查询：${term.length > 40 ? term.slice(0, 40) + '…' : term}`,
            ignoreFocusOut: true,
        });
        if (!picked) return;

        const { maxDefinitionChars, cacheEnabled, cacheTtlHours } = getDictPrepConfigKeys();
        const client = MdictClient.getInstance(context);
        const targets = picked.id === '__all__' ? dicts : dicts.filter((d) => d.id === picked.id);

        try {
            const hits: Array<{
                dictId: string;
                dictName: string;
                matchedKey: string;
                definition: string;
                entryIndex: number;
            }> = [];

            for (const d of targets) {
                const many = await client.lookupMany(d, term, 'exact', {
                    prefixMaxCandidates: 0,
                    minPrefixLength: 999,
                    maxDefinitionChars,
                    cacheEnabled,
                    cacheTtlHours,
                });
                if (many.length > 0) {
                    for (let i = 0; i < many.length; i++) {
                        const hit = many[i];
                        hits.push({
                            dictId: hit.dictId,
                            dictName: hit.dictName,
                            matchedKey: hit.matchedKey,
                            definition: hit.definition,
                            entryIndex: i + 1,
                        });
                    }
                }
            }

            const content = buildMarkdownResult(term, hits);
            const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content });
            await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
        } catch (e) {
            ErrorUtils.showError(e, '本地词典查询失败：');
        }
    }
}

function buildMarkdownResult(
    term: string,
    hits: Array<{
        dictId: string;
        dictName: string;
        matchedKey: string;
        definition: string;
        entryIndex: number;
    }>
): string {
    const lines: string[] = [];
    lines.push(`# 本地词典查询`);
    lines.push('');
    lines.push(`- 查询词（整段选文）：**${escapeMd(term)}**`);
    lines.push(`- 命中：**${hits.length}**`);
    lines.push('');

    if (hits.length === 0) {
        lines.push('未命中任何词典。');
        lines.push('');
        return lines.join('\n');
    }

    for (const h of hits) {
        const suffix = hits.filter((x) => x.dictId === h.dictId).length > 1 ? ` #${h.entryIndex}` : '';
        lines.push(`## ${escapeMd(h.dictName)}（${escapeMd(h.dictId)}）${suffix}`);
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
