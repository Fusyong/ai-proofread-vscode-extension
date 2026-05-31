import * as fs from 'fs';
import { FilePathUtils } from '../utils';
import type { ReferencePrepProcessFileV010, ReferencePrepStrength, ReferenceSourceId } from './schema';

export function getReferencePrepProcessPath(jsonOrDocPath: string): string {
    return FilePathUtils.getFilePath(jsonOrDocPath, '.referenceprep', '.json');
}

export function getReferencePrepLogPath(jsonOrDocPath: string): string {
    return FilePathUtils.getFilePath(jsonOrDocPath, '.referenceprep', '.log');
}

/** 兼容旧版 dictprep 过程文件路径 */
export function getLegacyDictPrepProcessPath(jsonFilePath: string): string {
    return FilePathUtils.getFilePath(jsonFilePath, '.dictprep', '.json');
}

export function loadOrCreateProcessFile(params: {
    anchorPath: string;
    enabledSources: ReferenceSourceId[];
    strength: ReferencePrepStrength;
    sourceJsonPath?: string;
    targetPreview?: string;
}): ReferencePrepProcessFileV010 {
    const processPath = getReferencePrepProcessPath(params.anchorPath);
    if (fs.existsSync(processPath)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(processPath, 'utf8')) as ReferencePrepProcessFileV010;
            if (parsed.version === '0.1.0') {
                return parsed;
            }
        } catch {
            /* recreate */
        }
    }
    return {
        version: '0.1.0',
        sourceJsonPath: params.sourceJsonPath,
        targetPreview: params.targetPreview,
        enabledSources: params.enabledSources,
        strength: params.strength,
        rounds: [],
        corpus: [],
    };
}

export function saveProcessFile(anchorPath: string, proc: ReferencePrepProcessFileV010): void {
    const processPath = getReferencePrepProcessPath(anchorPath);
    fs.writeFileSync(processPath, JSON.stringify(proc, null, 2), 'utf8');
}

export function appendProcessLog(anchorPath: string, line: string): void {
    const logPath = getReferencePrepLogPath(anchorPath);
    fs.appendFileSync(logPath, line + '\n', 'utf8');
}
