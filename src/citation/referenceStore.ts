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
}

const DB_FILENAME = 'citation-refs.db';
const TABLE_NAME = 'reference_sentences';
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

let sqlJsInit: (() => Promise<SqlJsStatic>) | null = null;

function getSqlJs(): Promise<SqlJsStatic> {
    if (sqlJsInit) return sqlJsInit();
    sqlJsInit = async (): Promise<SqlJsStatic> => {
        const initSqlJs = (await import('sql.js')).default;
        // 从 sql.js 包所在目录加载 wasm（开发与打包后均可用）
        let distDir: string;
        try {
            distDir = path.join(path.dirname(require.resolve('sql.js')), 'dist');
        } catch {
            distDir = path.join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist');
        }
        return initSqlJs({ locateFile: (file: string) => path.join(distDir, file) });
    };
    return sqlJsInit();
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
 * 获取引文核对用的归一化选项（从 citation 配置读取，默认去掉数字与拉丁）
 */
export function getCitationNormalizeOptions(): NormalizeForSimilarityOptions {
    const config = vscode.workspace.getConfiguration('ai-proofread.citation');
    return {
        removeInnerWhitespace: true,
        removePunctuation: config.get<boolean>('normalizeIgnorePunctuation', false),
        removeDigits: config.get<boolean>('normalizeIgnoreDigits', true),
        removeLatin: config.get<boolean>('normalizeIgnoreLatin', true)
    };
}

export class ReferenceStore {
    private static instance: ReferenceStore | null = null;
    private context: vscode.ExtensionContext;
    private db: SqlJsDatabase | null = null;
    private dbPath: string = '';
    private dirty = false;
    private watcher: vscode.FileSystemWatcher | null = null;

    private constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    static getInstance(context: vscode.ExtensionContext): ReferenceStore {
        if (!ReferenceStore.instance) {
            ReferenceStore.instance = new ReferenceStore(context);
        }
        return ReferenceStore.instance;
    }

    getDbPath(): string {
        if (this.dbPath) return this.dbPath;
        const dir = this.context.globalStorageUri.fsPath;
        this.dbPath = path.join(dir, DB_FILENAME);
        return this.dbPath;
    }

    isDirty(): boolean {
        return this.dirty;
    }

    /** 初始化 SQLite（打开或创建数据库） */
    private async ensureDb(): Promise<SqlJsDatabase> {
        if (this.db) return this.db;
        const SQL = await getSqlJs();
        const dir = path.dirname(this.getDbPath());
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        let data: Uint8Array | undefined;
        if (fs.existsSync(this.getDbPath())) {
            data = new Uint8Array(fs.readFileSync(this.getDbPath()));
        }
        this.db = new SQL.Database(data);
        this.db.run(`
            CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path TEXT NOT NULL,
                paragraph_idx INTEGER NOT NULL,
                sentence_idx INTEGER NOT NULL,
                content TEXT NOT NULL,
                normalized TEXT NOT NULL,
                len_norm INTEGER NOT NULL,
                created_at INTEGER DEFAULT (strftime('%s','now'))
            )
        `);
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_len_norm ON ${TABLE_NAME}(len_norm)`);
        return this.db;
    }

    /** 清空表并重建索引 */
    async rebuildIndex(cancelToken?: vscode.CancellationToken): Promise<{ fileCount: number; sentenceCount: number }> {
        const config = vscode.workspace.getConfiguration('ai-proofread.citation');
        const refPathRaw = config.get<string>('referencesPath', '');
        const refRoot = resolveReferencesPath(refPathRaw);
        if (!refRoot || !fs.existsSync(refRoot)) {
            throw new Error(`参考文献路径无效或不存在: ${refPathRaw}`);
        }

        const db = await this.ensureDb();
        db.run(`DELETE FROM ${TABLE_NAME}`);

        const files = collectMdTxtFiles(refRoot);
        const opts = getCitationNormalizeOptions();
        let sentenceCount = 0;

        for (let f = 0; f < files.length; f++) {
            if (cancelToken?.isCancellationRequested) break;
            const filePath = files[f];
            const relativePath = path.relative(refRoot, filePath);
            let content: string;
            try {
                content = fs.readFileSync(filePath, 'utf8');
            } catch {
                continue;
            }
            const normalizedContent = content.replace(/\r\n/g, '\n');
            const sentencesWithLines = splitChineseSentencesWithLineNumbers(normalizedContent, true);
            for (let s = 0; s < sentencesWithLines.length; s++) {
                const [sentence, _startLine, _endLine] = sentencesWithLines[s];
                const contentTrim = sentence.trim();
                if (!contentTrim) continue;
                const normalized = normalizeForSimilarity(contentTrim, opts);
                const len_norm = normalized.length;
                db.run(
                    `INSERT INTO ${TABLE_NAME} (file_path, paragraph_idx, sentence_idx, content, normalized, len_norm) VALUES (?, ?, ?, ?, ?, ?)`,
                    [relativePath, 0, s, contentTrim, normalized, len_norm]
                );
                sentenceCount++;
            }
        }

        this.saveDb();
        this.dirty = false;
        this.setupWatcher(refRoot);
        return { fileCount: files.length, sentenceCount };
    }

    private saveDb(): void {
        if (!this.db) return;
        const data = this.db.export();
        fs.writeFileSync(this.getDbPath(), Buffer.from(data));
    }

    private setupWatcher(refRoot: string): void {
        this.watcher?.dispose();
        const pattern = new vscode.RelativePattern(refRoot, '**/*.{md,txt}');
        this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
        this.watcher.onDidChange(() => { this.dirty = true; });
        this.watcher.onDidCreate(() => { this.dirty = true; });
        this.watcher.onDidDelete(() => { this.dirty = true; });
    }

    /**
     * 按长度过滤获取候选文献句（用于相似度匹配）
     */
    async getCandidatesByLength(
        lenNorm: number,
        delta: number = 10
    ): Promise<RefSentenceRow[]> {
        const db = await this.ensureDb();
        const low = Math.max(0, lenNorm - delta);
        const high = lenNorm + delta;
        const result = db.exec(
            `SELECT id, file_path, paragraph_idx, sentence_idx, content, normalized, len_norm FROM ${TABLE_NAME} WHERE len_norm BETWEEN ${low} AND ${high}`
        );
        if (!result.length || !result[0].values.length) return [];
        const cols = result[0].columns;
        const rows: RefSentenceRow[] = [];
        for (const row of result[0].values) {
            const obj = cols.reduce((a, c, i) => ({ ...a, [c]: row[i] }), {} as Record<string, unknown>);
            rows.push({
                id: obj.id as number,
                file_path: obj.file_path as string,
                paragraph_idx: obj.paragraph_idx as number,
                sentence_idx: obj.sentence_idx as number,
                content: obj.content as string,
                normalized: obj.normalized as string,
                len_norm: obj.len_norm as number
            });
        }
        return rows;
    }

    /** 获取参考文献根路径（已解析） */
    getReferencesRoot(): string {
        const config = vscode.workspace.getConfiguration('ai-proofread.citation');
        return resolveReferencesPath(config.get<string>('referencesPath', ''));
    }

    dispose(): void {
        this.watcher?.dispose();
        this.db?.close();
        this.db = null;
        ReferenceStore.instance = null;
    }
}
