/**
 * jieba-wasm 中文分词加载器
 * 计划见 docs/jieba-wasm-integration-plan.md
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/** jieba-wasm 导出的 token（含位置信息） */
export interface JiebaToken {
    word: string;
    start: number;
    end: number;
}

/** jieba-wasm 导出的 tag（词性标注） */
export interface JiebaTag {
    word: string;
    tag: string;
}

/** jieba-wasm 模块 API */
export interface JiebaWasmModule {
    cut: (text: string, hmm?: boolean) => string[];
    cut_all: (text: string) => string[];
    cut_for_search: (text: string, hmm?: boolean) => string[];
    tokenize: (text: string, mode: string, hmm?: boolean) => JiebaToken[];
    add_word: (word: string, freq?: number, tag?: string) => number;
    tag: (sentence: string, hmm?: boolean) => JiebaTag[];
    with_dict: (dict: string) => void;
}

/** 按 distDir + customDictPath 缓存 */
const jiebaCache = new Map<string, JiebaWasmModule>();

/**
 * 解析自定义词典路径（支持 ${workspaceFolder}）
 */
function resolveCustomDictPath(configPath: string): string {
    if (!configPath || !configPath.trim()) return '';
    let p = configPath.trim();
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (folder && p.includes('${workspaceFolder}')) {
        p = p.replace(/\$\{workspaceFolder\}/g, folder);
    }
    return path.isAbsolute(p) ? p : folder ? path.join(folder, p) : p;
}

/**
 * 从扩展 dist 目录加载 jieba-wasm，可选加载用户自定义词典。
 * @param distDir 扩展的 dist 目录绝对路径（建议 context.extensionPath + '/dist'）
 * @param customDictPath 自定义词典路径（可选），支持 ${workspaceFolder}；格式：每行「词语 词频 词性」以换行分隔
 * @returns 加载完成的 jieba-wasm 模块
 */
export function getJiebaWasm(distDir: string, customDictPath?: string): JiebaWasmModule {
    const resolvedDictPath = customDictPath ? resolveCustomDictPath(customDictPath) : '';
    const cacheKey = distDir + '\0' + resolvedDictPath;

    let cached = jiebaCache.get(cacheKey);
    if (cached) return cached;

    // jieba-wasm Node.js 版本同步加载，内部通过 __dirname 定位 .wasm 文件
    const jiebaPath = path.join(distDir, 'jieba_rs_wasm.js');
    const mod = require(jiebaPath) as unknown;

    const jieba =
        (typeof mod === 'object' && mod !== null && typeof (mod as JiebaWasmModule).cut === 'function'
            ? (mod as JiebaWasmModule)
            : null) ??
        (typeof (mod as { default?: JiebaWasmModule })?.default === 'object' &&
        typeof ((mod as { default: JiebaWasmModule }).default.cut) === 'function'
            ? (mod as { default: JiebaWasmModule }).default
            : null);

    if (!jieba || typeof jieba.cut !== 'function') {
        throw new Error(
            'jieba-wasm: 无法获取 cut 函数，请确认已执行 copy-jieba-dist 并将 jieba_rs_wasm.js 复制到 dist/'
        );
    }

    if (resolvedDictPath && typeof jieba.with_dict === 'function' && fs.existsSync(resolvedDictPath)) {
        try {
            const content = fs.readFileSync(resolvedDictPath, 'utf8');
            const lines = content
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter((line) => line && !line.startsWith('#'));
            if (lines.length > 0) {
                jieba.with_dict(lines.join('\n'));
            }
        } catch (e) {
            console.warn('[jieba] 加载自定义词典失败:', resolvedDictPath, e);
        }
    }

    jiebaCache.set(cacheKey, jieba);
    return jieba;
}
