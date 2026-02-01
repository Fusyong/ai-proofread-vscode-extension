/**
 * 参考文献存储：扫描、分句、归一化、SQLite 索引
 * 计划见 docs/citation-verification-plan.md 阶段 1
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { splitChineseSentencesWithLineNumbers } from '../splitter';
import { normalizeForSimilarity, NormalizeForSimilarityOptions } from '../similarity';

/** 文献句记录（与 SQLite 表对应） */
export interface ReferenceSentence {
    id: number;
    file_path: string;
    paragraph_idx: number;
    sentence_idx: number;
    content: string;
    normalized: string;
    len_norm: number;
    /** 该句在原文中的起始行号（1-based），旧索引可为 undefined */
    start_line?: number;
    /** 该句在原文中的结束行号（1-based），旧索引可为 undefined */
    end_line?: number;
}

/** 候选查询结果 */
export interface RefSentenceRow {
    id: number;
    file_path: string;
    paragraph_idx: number;
    sentence_idx: number;
    content: string;
    normalized: string;
    len_norm: number;
    start_line?: number;
    end_line?: number;
}

function rowFromObj(obj: Record<string, unknown>): RefSentenceRow {
    return {
        id: obj.id as number,
        file_path: obj.file_path as string,
        paragraph_idx: obj.paragraph_idx as number,
        sentence_idx: obj.sentence_idx as number,
        content: obj.content as string,
        normalized: obj.normalized as string,
        len_norm: obj.len_norm as number,
        start_line: obj.start_line != null ? (obj.start_line as number) : undefined,
        end_line: obj.end_line != null ? (obj.end_line as number) : undefined
    };
}

const DB_FILENAME = 'citation-refs.db';
const TABLE_NAME = 'reference_sentences';
const INDEXED_FILES_TABLE = 'indexed_files';
const EXTENSIONS = ['.md', '.txt'];

/** sql.js 的 Database 类型（运行时注入） */
type SqlJsDatabase = {
    run(sql: string, params?: unknown[]): void;
    exec(sql: string): { columns: string[]; values: unknown[][] }[];
    close(): void;
    export(): Uint8Array;
};

type SqlJsStatic = {
    Database: new (data?: Uint8Array) => SqlJsDatabase;
};

/** 按 distDir 缓存，避免同一 dist 重复加载 */
let sqlJsInitByDir: Map<string, () => Promise<SqlJsStatic>> = new Map();

/**
 * 从扩展 dist 目录加载 sql.js（构建时由 copy-sqljs-dist 复制 sql-wasm.js + sql-wasm.wasm）。
 * @param distDir 扩展的 dist 目录绝对路径（建议 context.extensionPath + '/dist'），打包后不含 node_modules 时由此定位 sql-wasm 文件
 */
function getSqlJs(distDir: string): Promise<SqlJsStatic> {
    let init = sqlJsInitByDir.get(distDir);
    if (init) return init();
    init = async (): Promise<SqlJsStatic> => {
        const sqlWasmPath = path.join(distDir, 'sql-wasm.js');
        const sqlJsModule = require(sqlWasmPath);
        const initSqlJs =
            (typeof sqlJsModule === 'function' ? sqlJsModule : null) ??
            (typeof sqlJsModule?.default === 'function' ? sqlJsModule.default : null) ??
            (typeof (sqlJsModule as { Module?: unknown })?.Module === 'function' ? (sqlJsModule as { Module: () => Promise<SqlJsStatic> }).Module : null);
        if (typeof initSqlJs !== 'function') {
            throw new Error('sql.js: 无法获取 initSqlJs 函数，请确认已执行 copy-sqljs-dist 并将 sql-wasm.js 复制到 dist/');
        }
        const locateFile = (file: string): string => path.join(distDir, file);
        return initSqlJs({ locateFile });
    };
    sqlJsInitByDir.set(distDir, init);
    return init();
}

/**
 * 解析参考文献根路径（支持 ${workspaceFolder}）
 */
export function resolveReferencesPath(configPath: string): string {
    if (!configPath || !configPath.trim()) return '';
    let p = configPath.trim();
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (folder && p.includes('${workspaceFolder}')) {
        p = p.replace(/\$\{workspaceFolder\}/g, folder);
    }
    return path.isAbsolute(p) ? p : (folder ? path.join(folder, p) : p);
}

/**
 * 递归收集目录下所有 .md / .txt 文件路径（相对 refRoot 的路径用于存储）
 */
function collectMdTxtFiles(refRoot: string, baseDir: string = refRoot): string[] {
    const result: string[] = [];
    if (!fs.existsSync(baseDir) || !fs.statSync(baseDir).isDirectory()) return result;
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const e of entries) {
        const full = path.join(baseDir, e.name);
        const rel = path.relative(refRoot, full);
        if (e.isDirectory()) {
            result.push(...collectMdTxtFiles(refRoot, full));
        } else if (e.isFile()) {
            const ext = path.extname(e.name).toLowerCase();
            if (EXTENSIONS.includes(ext)) result.push(full);
        }
    }
    return result;
}

/**
 * 获取引文核对用的归一化选项（从 citation 配置读取，默认去掉数字、拉丁与注码）
 */
export function getCitationNormalizeOptions(): NormalizeForSimilarityOptions {
    const config = vscode.workspace.getConfiguration('ai-proofread.citation');
    return {
        removeInnerWhitespace: true,
        removePunctuation: config.get<boolean>('normalizeIgnorePunctuation', false),
        removeDigits: config.get<boolean>('normalizeIgnoreDigits', true),
        removeLatin: config.get<boolean>('normalizeIgnoreLatin', true),
        removeFootnoteMarkers: config.get<boolean>('normalizeIgnoreFootnoteMarkers', true)
    };
}

export class ReferenceStore {
    private static instance: ReferenceStore | null = null;
    private context: vscode.ExtensionContext;
    private db: SqlJsDatabase | null = null;
    /** 当前已打开的 DB 文件路径（用于检测文献根变更后需重连） */
    private dbPath: string = '';

    private constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    static getInstance(context: vscode.ExtensionContext): ReferenceStore {
        if (!ReferenceStore.instance) {
            ReferenceStore.instance = new ReferenceStore(context);
        }
        return ReferenceStore.instance;
    }

    /** 数据库强制存放在用户指定的文献根目录下 */
    getDbPath(): string {
        const root = this.getReferencesRoot();
        return root ? path.join(root, DB_FILENAME) : '';
    }

    /** 初始化 SQLite（打开或创建数据库）；文献根未配置时抛错 */
    private async ensureDb(): Promise<SqlJsDatabase> {
        const wantPath = this.getDbPath();
        if (!wantPath) {
            throw new Error('请先配置「引文核对：参考文献根路径」并执行「重建引文索引」。');
        }
        if (this.db && this.dbPath !== wantPath) {
            this.db.close();
            this.db = null;
            this.dbPath = '';
        }
        if (this.db) return this.db;
        const distDir = path.join(this.context.extensionPath, 'dist');
        const SQL = await getSqlJs(distDir);
        const dir = path.dirname(wantPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        let data: Uint8Array | undefined;
        if (fs.existsSync(wantPath)) {
            data = new Uint8Array(fs.readFileSync(wantPath));
        }
        this.db = new SQL.Database(data);
        this.dbPath = wantPath;
        this.db.run(`
            CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path TEXT NOT NULL,
                paragraph_idx INTEGER NOT NULL,
                sentence_idx INTEGER NOT NULL,
                content TEXT NOT NULL,
                normalized TEXT NOT NULL,
                len_norm INTEGER NOT NULL,
                start_line INTEGER,
                end_line INTEGER,
                created_at INTEGER DEFAULT (strftime('%s','now'))
            )
        `);
        this.migrateAddLineNumbers();
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_len_norm ON ${TABLE_NAME}(len_norm)`);
        this.db.run(`
            CREATE TABLE IF NOT EXISTS ${INDEXED_FILES_TABLE} (
                file_path TEXT PRIMARY KEY,
                mtime_ms INTEGER NOT NULL,
                size INTEGER NOT NULL
            )
        `);
        return this.db;
    }

    /** 兼容旧库：若缺少 start_line/end_line 列则添加 */
    private migrateAddLineNumbers(): void {
        if (!this.db) return;
        const info = this.db.exec(`PRAGMA table_info(${TABLE_NAME})`);
        if (!info.length || !info[0].values.length) return;
        const columns = info[0].values.map((row) => row[1] as string);
        if (!columns.includes('start_line')) {
            this.db.run(`ALTER TABLE ${TABLE_NAME} ADD COLUMN start_line INTEGER`);
        }
        if (!columns.includes('end_line')) {
            this.db.run(`ALTER TABLE ${TABLE_NAME} ADD COLUMN end_line INTEGER`);
        }
    }

    /**
     * 重建索引。更新文献后请手动执行此命令更新索引。
     * @param fullRebuild true = 全部重新索引；false = 仅新文件与已变更文件
     */
    async rebuildIndex(
        cancelToken?: vscode.CancellationToken,
        fullRebuild: boolean = false
    ): Promise<{ fileCount: number; sentenceCount: number }> {
        const config = vscode.workspace.getConfiguration('ai-proofread.citation');
        const refPathRaw = config.get<string>('referencesPath', '');
        const refRoot = resolveReferencesPath(refPathRaw);
        if (!refRoot || !fs.existsSync(refRoot)) {
            throw new Error(`参考文献路径无效或不存在: ${refPathRaw}`);
        }

        const db = await this.ensureDb();
        const files = collectMdTxtFiles(refRoot);
        const opts = getCitationNormalizeOptions();
        const currentRelPaths = new Set(files.map((f) => path.relative(refRoot, f)));

        if (fullRebuild) {
            db.run(`DELETE FROM ${INDEXED_FILES_TABLE}`);
            db.run(`DELETE FROM ${TABLE_NAME}`);
        } else {
            // 删除已不存在的文件对应的记录
            const rows = db.exec(`SELECT file_path FROM ${INDEXED_FILES_TABLE}`);
            if (rows.length && rows[0].values.length) {
                for (const row of rows[0].values) {
                    const relPath = row[0] as string;
                    if (!currentRelPaths.has(relPath)) {
                        db.run(`DELETE FROM ${TABLE_NAME} WHERE file_path = ?`, [relPath]);
                        db.run(`DELETE FROM ${INDEXED_FILES_TABLE} WHERE file_path = ?`, [relPath]);
                    }
                }
            }
        }

        const indexed = new Map<string, { mtime_ms: number; size: number }>();
        if (!fullRebuild) {
            const rows = db.exec(`SELECT file_path, mtime_ms, size FROM ${INDEXED_FILES_TABLE}`);
            if (rows.length && rows[0].values.length) {
                const cols = rows[0].columns;
                for (const row of rows[0].values) {
                    const obj = cols.reduce((a, c, i) => ({ ...a, [c]: row[i] }), {} as Record<string, unknown>);
                    indexed.set(obj.file_path as string, {
                        mtime_ms: obj.mtime_ms as number,
                        size: obj.size as number
                    });
                }
            }
        }

        let filesIndexed = 0;
        let sentenceCount = 0;

        for (let f = 0; f < files.length; f++) {
            if (cancelToken?.isCancellationRequested) break;
            const filePath = files[f];
            const relativePath = path.relative(refRoot, filePath);
            let stat: fs.Stats;
            try {
                stat = fs.statSync(filePath);
            } catch {
                continue;
            }
            const mtimeMs = stat.mtimeMs;
            const size = stat.size;
            if (!fullRebuild) {
                const known = indexed.get(relativePath);
                if (known && known.mtime_ms === mtimeMs && known.size === size) continue;
            }
            db.run(`DELETE FROM ${TABLE_NAME} WHERE file_path = ?`, [relativePath]);
            let content: string;
            try {
                content = fs.readFileSync(filePath, 'utf8');
            } catch {
                continue;
            }
            const normalizedContent = content.replace(/\r\n/g, '\n');
            const sentencesWithLines = splitChineseSentencesWithLineNumbers(normalizedContent, true);
            for (let s = 0; s < sentencesWithLines.length; s++) {
                const [sentence, startLine, endLine] = sentencesWithLines[s];
                const contentTrim = sentence.trim();
                if (!contentTrim) continue;
                const normalized = normalizeForSimilarity(contentTrim, opts);
                const len_norm = normalized.length;
                db.run(
                    `INSERT INTO ${TABLE_NAME} (file_path, paragraph_idx, sentence_idx, content, normalized, len_norm, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [relativePath, 0, s, contentTrim, normalized, len_norm, startLine, endLine]
                );
                sentenceCount++;
            }
            db.run(
                `INSERT OR REPLACE INTO ${INDEXED_FILES_TABLE} (file_path, mtime_ms, size) VALUES (?, ?, ?)`,
                [relativePath, mtimeMs, size]
            );
            filesIndexed++;
        }

        this.saveDb();
        return { fileCount: fullRebuild ? files.length : filesIndexed, sentenceCount };
    }

    private saveDb(): void {
        if (!this.db || !this.dbPath) return;
        const data = this.db.export();
        fs.writeFileSync(this.dbPath, Buffer.from(data));
    }

    /**
     * 按长度过滤获取候选文献句（用于相似度匹配）
     * @param lenNorm 锚点句的归一化长度
     * @param deltaRatio 允许偏离的比例，如 0.2 表示 ±20%
     */
    async getCandidatesByLength(
        lenNorm: number,
        deltaRatio: number = 0.2
    ): Promise<RefSentenceRow[]> {
        const db = await this.ensureDb();
        const low = Math.max(0, Math.floor(lenNorm * (1 - deltaRatio)));
        const high = Math.ceil(lenNorm * (1 + deltaRatio));
        const result = db.exec(
            `SELECT id, file_path, paragraph_idx, sentence_idx, content, normalized, len_norm, start_line, end_line FROM ${TABLE_NAME} WHERE len_norm BETWEEN ${low} AND ${high}`
        );
        if (!result.length || !result[0].values.length) return [];
        const cols = result[0].columns;
        const rows: RefSentenceRow[] = [];
        for (const row of result[0].values) {
            const obj = cols.reduce((a, c, i) => ({ ...a, [c]: row[i] }), {} as Record<string, unknown>);
            rows.push(rowFromObj(obj));
        }
        return rows;
    }

    /**
     * 按文件取句（按 paragraph_idx, sentence_idx 升序），用于平行移动匹配
     */
    async getSentencesByFileOrdered(filePath: string): Promise<RefSentenceRow[]> {
        const db = await this.ensureDb();
        const escaped = String(filePath).replace(/'/g, "''");
        const result = db.exec(
            `SELECT id, file_path, paragraph_idx, sentence_idx, content, normalized, len_norm, start_line, end_line FROM ${TABLE_NAME} WHERE file_path = '${escaped}' ORDER BY paragraph_idx, sentence_idx`
        );
        if (!result.length || !result[0].values.length) return [];
        const cols = result[0].columns;
        const rows: RefSentenceRow[] = [];
        for (const row of result[0].values) {
            const obj = cols.reduce((a, c, i) => ({ ...a, [c]: row[i] }), {} as Record<string, unknown>);
            rows.push(rowFromObj(obj));
        }
        return rows;
    }

    /** 获取参考文献根路径（已解析） */
    getReferencesRoot(): string {
        const config = vscode.workspace.getConfiguration('ai-proofread.citation');
        return resolveReferencesPath(config.get<string>('referencesPath', ''));
    }

    dispose(): void {
        this.db?.close();
        this.db = null;
        this.dbPath = '';
        ReferenceStore.instance = null;
    }
}
