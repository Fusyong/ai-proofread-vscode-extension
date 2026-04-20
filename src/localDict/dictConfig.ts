import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface LocalDictConfigItem {
    id: string;
    name: string;
    mdxPath: string;
    tags?: string[];
    priority?: number;
    whenToUse?: string;
}

export interface ResolvedLocalDictConfigItem extends LocalDictConfigItem {
    mdxPathResolved: string;
}

export function getLocalDictConfigs(): LocalDictConfigItem[] {
    const config = vscode.workspace.getConfiguration('ai-proofread');
    return (config.get<LocalDictConfigItem[]>('localDicts', []) ?? []).filter(Boolean);
}

export function resolveLocalDictConfigs(): ResolvedLocalDictConfigItem[] {
    const dicts = getLocalDictConfigs();
    const resolved: ResolvedLocalDictConfigItem[] = [];
    for (const d of dicts) {
        if (!d?.id || !d?.name || !d?.mdxPath) continue;
        const mdxPathResolved = resolvePath(d.mdxPath);
        resolved.push({
            ...d,
            mdxPathResolved,
            tags: d.tags ?? [],
            priority: typeof d.priority === 'number' ? d.priority : 100,
            whenToUse: d.whenToUse ?? '',
        });
    }
    return resolved;
}

export function pickDefaultDictId(dicts: ResolvedLocalDictConfigItem[]): string | undefined {
    if (dicts.length === 0) return undefined;
    return [...dicts].sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))[0]?.id;
}

export function ensureDictFilesExist(dicts: ResolvedLocalDictConfigItem[]): { ok: boolean; errors: string[] } {
    const errors: string[] = [];
    for (const d of dicts) {
        if (!fs.existsSync(d.mdxPathResolved)) {
            errors.push(`词典不存在：${d.name} (${d.id}) -> ${d.mdxPathResolved}`);
        } else if (path.extname(d.mdxPathResolved).toLowerCase() !== '.mdx') {
            errors.push(`词典文件不是 .mdx：${d.name} (${d.id}) -> ${d.mdxPathResolved}`);
        }
    }
    return { ok: errors.length === 0, errors };
}

function resolvePath(p: string): string {
    const trimmed = (p ?? '').trim();
    if (!trimmed) return trimmed;
    // 目前只支持绝对路径；保留 ${workspaceFolder} 兼容用法
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (ws) {
        return trimmed.replace(/\$\{workspaceFolder\}/g, ws);
    }
    return trimmed;
}

