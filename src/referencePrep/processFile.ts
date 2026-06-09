import * as fs from 'fs';
import { FilePathUtils } from '../utils';
import type {
    ReferencePrepProcessFile,
    ReferencePrepProcessFileV020,
    ReferencePrepStrength,
    ReferenceSourceId,
} from './schema';
import { upgradeProcessToV020 } from './schema';

export function getReferencePrepProcessPath(jsonOrDocPath: string): string {
    return FilePathUtils.getFilePath(jsonOrDocPath, '.referenceprep', '.json');
}

export function getReferencePrepLogPath(jsonOrDocPath: string): string {
    return FilePathUtils.getFilePath(jsonOrDocPath, '.referenceprep', '.log');
}

export function getLegacyDictPrepProcessPath(jsonFilePath: string): string {
    return FilePathUtils.getFilePath(jsonFilePath, '.dictprep', '.json');
}

export function loadOrCreateProcessFile(params: {
    anchorPath: string;
    enabledSources: ReferenceSourceId[];
    strength: ReferencePrepStrength;
    sourceJsonPath?: string;
    targetPreview?: string;
    userInput?: string;
}): ReferencePrepProcessFileV020 {
    const processPath = getReferencePrepProcessPath(params.anchorPath);
    if (fs.existsSync(processPath)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(processPath, 'utf8')) as ReferencePrepProcessFile;
            if (parsed.version === '0.1.0' || parsed.version === '0.2.0') {
                const upgraded = upgradeProcessToV020(parsed);
                if (params.userInput) upgraded.userInput = params.userInput;
                return upgraded;
            }
        } catch {
            /* recreate */
        }
    }
    return {
        version: '0.2.0',
        sourceJsonPath: params.sourceJsonPath,
        targetPreview: params.targetPreview,
        userInput: params.userInput,
        enabledSources: params.enabledSources,
        strength: params.strength,
        rounds: [],
        corpus: [],
    };
}

export function saveProcessFile(anchorPath: string, proc: ReferencePrepProcessFileV020): void {
    const processPath = getReferencePrepProcessPath(anchorPath);
    fs.writeFileSync(processPath, JSON.stringify(proc, null, 2), 'utf8');
}

export function loadProcessFile(anchorPath: string): ReferencePrepProcessFileV020 | null {
    const processPath = getReferencePrepProcessPath(anchorPath);
    if (!fs.existsSync(processPath)) return null;
    try {
        const parsed = JSON.parse(fs.readFileSync(processPath, 'utf8')) as ReferencePrepProcessFile;
        if (parsed.version === '0.1.0' || parsed.version === '0.2.0') {
            return upgradeProcessToV020(parsed);
        }
    } catch {
        return null;
    }
    return null;
}

export function appendProcessLog(anchorPath: string, line: string): void {
    const logPath = getReferencePrepLogPath(anchorPath);
    fs.appendFileSync(logPath, line + '\n', 'utf8');
}
