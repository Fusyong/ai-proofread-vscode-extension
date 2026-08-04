import * as fs from 'fs';
import * as path from 'path';
import { targetsMatch } from './continuationLogic';
import type {
    ReferencePrepOrigin,
    ReferencePrepProcessFile,
    ReferencePrepProcessFileV020,
    ReferencePrepProcessFileV030,
    ReferencePrepRecord,
    ReferencePrepStrength,
    ReferenceSourceId,
} from './schema';
import {
    newReferencePrepRecordId,
    recordFromWorkingProcess,
    upgradeProcessToV030,
    workingProcessFromRecord,
} from './schema';

function siblingPath(jsonOrDocPath: string, suffix: string, ext: string): string {
    const dir = path.dirname(jsonOrDocPath);
    const baseName = path.basename(jsonOrDocPath, path.extname(jsonOrDocPath));
    return path.join(dir, `${baseName}${suffix}${ext}`);
}

export function getReferencePrepProcessPath(jsonOrDocPath: string): string {
    return siblingPath(jsonOrDocPath, '.referenceprep', '.json');
}

export function getReferencePrepLogPath(jsonOrDocPath: string): string {
    return siblingPath(jsonOrDocPath, '.referenceprep', '.log');
}

export function getLegacyDictPrepProcessPath(jsonFilePath: string): string {
    return siblingPath(jsonFilePath, '.dictprep', '.json');
}

/** 缺省 prepOrigin：按锚点扩展名推断（兼容旧过程文件） */
export function inferPrepOrigin(
    record: { prepOrigin?: ReferencePrepOrigin },
    anchorPath: string
): ReferencePrepOrigin {
    if (record.prepOrigin === 'selection' || record.prepOrigin === 'json_item') {
        return record.prepOrigin;
    }
    return anchorPath.toLowerCase().endsWith('.json') ? 'json_item' : 'selection';
}

export function originMatches(
    record: { prepOrigin?: ReferencePrepOrigin },
    anchorPath: string,
    want?: ReferencePrepOrigin
): boolean {
    if (!want) return true;
    return inferPrepOrigin(record, anchorPath) === want;
}

function readRawProcessFile(anchorPath: string): ReferencePrepProcessFile | null {
    const processPath = getReferencePrepProcessPath(anchorPath);
    if (!fs.existsSync(processPath)) return null;
    try {
        return JSON.parse(fs.readFileSync(processPath, 'utf8')) as ReferencePrepProcessFile;
    } catch {
        return null;
    }
}

export function loadDocumentFile(anchorPath: string): ReferencePrepProcessFileV030 | null {
    const parsed = readRawProcessFile(anchorPath);
    if (!parsed) return null;
    if (parsed.version === '0.1.0' || parsed.version === '0.2.0' || parsed.version === '0.3.0') {
        return upgradeProcessToV030(parsed);
    }
    return null;
}

export function saveDocumentFile(anchorPath: string, doc: ReferencePrepProcessFileV030): void {
    const processPath = getReferencePrepProcessPath(anchorPath);
    fs.writeFileSync(processPath, JSON.stringify(doc, null, 2), 'utf8');
}

function getActiveRecord(doc: ReferencePrepProcessFileV030): ReferencePrepRecord | null {
    return doc.records.find((r) => r.id === doc.activeRecordId) ?? doc.records[0] ?? null;
}

/** 列出文档内选区记录（可按 prepOrigin 过滤） */
export function listProcessRecords(
    anchorPath: string,
    opts?: { origin?: ReferencePrepOrigin }
): ReferencePrepProcessFileV020[] {
    const doc = loadDocumentFile(anchorPath);
    if (!doc) return [];
    return doc.records
        .filter((r) => originMatches(r, anchorPath, opts?.origin))
        .map((r) => workingProcessFromRecord(r, doc.sourceJsonPath));
}

/**
 * 按选区文本查找已有记录；找不到则新建一条（不立即落盘，待 saveProcessFile）。
 * 同一锚点、不同选区 → 多条独立 records，共用一个 .referenceprep.json。
 * MD 选段与 JSON 条目通过 prepOrigin 隔离，不会互相匹配。
 */
export function loadOrCreateProcessFile(params: {
    anchorPath: string;
    enabledSources: ReferenceSourceId[];
    strength: ReferencePrepStrength;
    sourceJsonPath?: string;
    targetPreview?: string;
    userInput?: string;
    /** 指定续跑某条记录（优先于文本匹配） */
    recordId?: string;
    prepOrigin?: ReferencePrepOrigin;
    jsonItemIndex?: number;
}): ReferencePrepProcessFileV020 {
    const doc = loadDocumentFile(params.anchorPath);
    const preview =
        params.targetPreview ??
        (params.userInput ? params.userInput.slice(0, 200) : undefined);
    const wantOrigin = params.prepOrigin;

    if (doc) {
        let existing: ReferencePrepRecord | undefined;
        if (params.recordId) {
            existing = doc.records.find((r) => r.id === params.recordId);
        }
        if (
            !existing &&
            wantOrigin === 'json_item' &&
            typeof params.jsonItemIndex === 'number'
        ) {
            existing = doc.records.find(
                (r) =>
                    originMatches(r, params.anchorPath, 'json_item') &&
                    r.jsonItemIndex === params.jsonItemIndex
            );
        }
        if (!existing && params.userInput) {
            existing = doc.records.find(
                (r) =>
                    originMatches(r, params.anchorPath, wantOrigin) &&
                    targetsMatch(r.userInput ?? r.targetPreview, params.userInput!)
            );
        }
        if (existing) {
            return workingProcessFromRecord(
                {
                    ...existing,
                    targetPreview: preview ?? existing.targetPreview,
                    userInput: params.userInput ?? existing.userInput,
                    enabledSources: params.enabledSources,
                    strength: params.strength,
                    prepOrigin: wantOrigin ?? existing.prepOrigin ?? inferPrepOrigin(existing, params.anchorPath),
                    jsonItemIndex:
                        params.jsonItemIndex ?? existing.jsonItemIndex,
                },
                params.sourceJsonPath ?? doc.sourceJsonPath
            );
        }
    }

    return {
        version: '0.2.0',
        id: newReferencePrepRecordId(),
        sourceJsonPath: params.sourceJsonPath ?? doc?.sourceJsonPath,
        targetPreview: preview,
        userInput: params.userInput,
        enabledSources: params.enabledSources,
        strength: params.strength,
        rounds: [],
        corpus: [],
        prepOrigin: wantOrigin,
        jsonItemIndex: params.jsonItemIndex,
    };
}

export function saveProcessFile(anchorPath: string, proc: ReferencePrepProcessFileV020): void {
    const record = recordFromWorkingProcess(proc);
    let doc = loadDocumentFile(anchorPath);
    if (!doc) {
        doc = {
            version: '0.3.0',
            sourceJsonPath: proc.sourceJsonPath,
            activeRecordId: record.id,
            records: [record],
        };
    } else {
        const idx = doc.records.findIndex((r) => r.id === record.id);
        if (idx >= 0) {
            doc.records[idx] = record;
        } else {
            doc.records.push(record);
        }
        doc.activeRecordId = record.id;
        if (proc.sourceJsonPath) {
            doc.sourceJsonPath = proc.sourceJsonPath;
        }
    }
    saveDocumentFile(anchorPath, doc);
}

/** 读取当前激活的选区记录；无过程文件则返回 null */
export function loadProcessFile(anchorPath: string): ReferencePrepProcessFileV020 | null {
    const doc = loadDocumentFile(anchorPath);
    if (!doc) return null;
    const active = getActiveRecord(doc);
    if (!active) return null;
    return workingProcessFromRecord(active, doc.sourceJsonPath);
}

export function loadProcessRecord(
    anchorPath: string,
    recordId: string
): ReferencePrepProcessFileV020 | null {
    const doc = loadDocumentFile(anchorPath);
    if (!doc) return null;
    const record = doc.records.find((r) => r.id === recordId);
    if (!record) return null;
    return workingProcessFromRecord(record, doc.sourceJsonPath);
}

export function setActiveProcessRecord(anchorPath: string, recordId: string): boolean {
    const doc = loadDocumentFile(anchorPath);
    if (!doc || !doc.records.some((r) => r.id === recordId)) return false;
    doc.activeRecordId = recordId;
    saveDocumentFile(anchorPath, doc);
    return true;
}

/** 稳定 record 键：有 id 用 id，否则用下标占位（与面板分组 hitId 前缀一致） */
export function processRecordKey(
    record: { id?: string },
    index: number
): string {
    return record.id || `rec${index}`;
}

export function appendProcessLog(anchorPath: string, line: string): void {
    const logPath = getReferencePrepLogPath(anchorPath);
    fs.appendFileSync(logPath, line + '\n', 'utf8');
}
