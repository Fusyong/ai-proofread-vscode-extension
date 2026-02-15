/**
 * 自定义替换表：内存缓存与持久化（workspaceState 存元数据，按 filePath 按需加载）
 * 规划见 docs/custom-word-check-plan.md
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ExtensionContext } from 'vscode';
import type { CustomTable, CustomRule } from './types';
import { parseCustomTableFile } from './customTableParser';
import { compileCustomRules } from './customTableCompiler';

const STORAGE_KEY = 'ai-proofread.customTables';

interface StoredTableMeta {
    id: string;
    name: string;
    filePath?: string;
    enabled: boolean;
    isRegex: boolean;
    matchWordBoundary?: boolean;
}

let tables: CustomTable[] = [];
let contextRef: ExtensionContext | null = null;

function loadMetaList(): StoredTableMeta[] {
    if (!contextRef) return [];
    const raw = contextRef.workspaceState.get<StoredTableMeta[]>(STORAGE_KEY);
    return Array.isArray(raw) ? raw : [];
}

function saveMetaList(list: StoredTableMeta[]): void {
    contextRef?.workspaceState.update(
        STORAGE_KEY,
        list.map((t) => ({
            id: t.id,
            name: t.name,
            filePath: t.filePath,
            enabled: t.enabled,
            isRegex: t.isRegex,
            matchWordBoundary: t.matchWordBoundary,
        }))
    );
}

/**
 * 从文件加载规则并编译（isRegex 时）；失败时 rules 为空、compiled 为 undefined。
 */
function loadTableFromFile(table: CustomTable): { rules: CustomRule[]; compiled?: CustomTable['compiled'] } {
    if (!table.filePath || !fs.existsSync(table.filePath)) {
        return { rules: [] };
    }
    const content = fs.readFileSync(table.filePath, 'utf-8');
    const rules = parseCustomTableFile(content);
    if (table.isRegex) {
        const { compiled, errors } = compileCustomRules(rules);
        if (errors.length > 0) {
            console.warn('[customTableCache] compile errors:', errors);
        }
        return { rules, compiled };
    }
    return { rules };
}

function ensureTableLoaded(table: CustomTable): void {
    if (table.rules.length > 0) return;
    if (!table.filePath) return;
    const { rules, compiled } = loadTableFromFile(table);
    table.rules = rules;
    table.compiled = compiled;
}

export function initCustomTableCache(context: ExtensionContext): void {
    contextRef = context;
    const metaList = loadMetaList();
    tables = metaList.map((m) => ({
        id: m.id,
        name: m.name,
        filePath: m.filePath,
        enabled: m.enabled,
        isRegex: m.isRegex,
        matchWordBoundary: m.matchWordBoundary,
        rules: [],
        compiled: undefined,
    }));
}

/**
 * 返回当前缓存的表列表；若表有 filePath 且尚未加载规则，则按需从文件加载。
 */
export function getCustomTables(): CustomTable[] {
    for (const t of tables) {
        ensureTableLoaded(t);
    }
    return tables;
}

/**
 * 添加一张表（已解析的 rules 与可选 compiled）；会持久化元数据。
 */
export function addCustomTable(table: CustomTable): void {
    if (tables.some((t) => t.id === table.id)) return;
    tables.push(table);
    saveMetaList(
        tables.map((t) => ({
            id: t.id,
            name: t.name,
            filePath: t.filePath,
            enabled: t.enabled,
            isRegex: t.isRegex,
            matchWordBoundary: t.matchWordBoundary,
        }))
    );
}

/**
 * 从文件加载并添加一张表；仅接受 .txt 后缀。返回表与错误信息（解析/编译失败或文件不存在时 errors 非空）。
 * @param matchWordBoundary 仅非正则表有效：是否匹配词语边界（先分词再检查），默认 false
 */
export function addCustomTableFromFile(
    filePath: string,
    isRegex: boolean,
    name?: string,
    matchWordBoundary: boolean = false
): { table: CustomTable | null; errors: string[] } {
    const errors: string[] = [];
    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
    const ext = path.extname(absPath).toLowerCase();
    if (ext !== '.txt') {
        return { table: null, errors: ['自定义替换表仅接受 .txt 文件'] };
    }
    if (!fs.existsSync(absPath)) {
        return { table: null, errors: ['文件不存在'] };
    }
    const content = fs.readFileSync(absPath, 'utf-8');
    const rules = parseCustomTableFile(content);
    let compiled: CustomTable['compiled'];
    if (isRegex) {
        const result = compileCustomRules(rules);
        compiled = result.compiled;
        for (const e of result.errors) {
            errors.push(`第 ${e.lineIndex} 行: ${e.message}`);
        }
    }
    const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const table: CustomTable = {
        id,
        name: name ?? path.basename(absPath, path.extname(absPath)),
        filePath: absPath,
        enabled: true,
        isRegex,
        matchWordBoundary: !isRegex ? matchWordBoundary : undefined,
        rules,
        compiled,
    };
    addCustomTable(table);
    return { table, errors };
}

/**
 * 移除一张表并持久化。
 */
export function removeCustomTable(id: string): void {
    tables = tables.filter((t) => t.id !== id);
    saveMetaList(
        tables.map((t) => ({
            id: t.id,
            name: t.name,
            filePath: t.filePath,
            enabled: t.enabled,
            isRegex: t.isRegex,
            matchWordBoundary: t.matchWordBoundary,
        }))
    );
}

/**
 * 设置表的启用状态并持久化。
 */
export function setCustomTableEnabled(id: string, enabled: boolean): void {
    const t = tables.find((x) => x.id === id);
    if (t) {
        t.enabled = enabled;
        saveMetaList(
            tables.map((x) => ({
                id: x.id,
                name: x.name,
                filePath: x.filePath,
                enabled: x.enabled,
                isRegex: x.isRegex,
                matchWordBoundary: x.matchWordBoundary,
            }))
        );
    }
}
