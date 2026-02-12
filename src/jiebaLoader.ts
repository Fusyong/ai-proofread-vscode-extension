/**
 * jieba-wasm 中文分词加载器
 * 计划见 docs/jieba-wasm-integration-plan.md
 */

import * as path from 'path';

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

/** 按 distDir 缓存，避免同一 dist 重复加载 */
const jiebaCache = new Map<string, JiebaWasmModule>();

/**
 * 从扩展 dist 目录加载 jieba-wasm（构建时由 copy-jieba-dist 复制 jieba_rs_wasm.js + jieba_rs_wasm_bg.wasm）。
 * @param distDir 扩展的 dist 目录绝对路径（建议 context.extensionPath + '/dist'），打包后不含 node_modules 时由此定位 wasm 文件
 * @returns 加载完成的 jieba-wasm 模块
 */
export function getJiebaWasm(distDir: string): JiebaWasmModule {
    let cached = jiebaCache.get(distDir);
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

    jiebaCache.set(distDir, jieba);
    return jieba;
}
