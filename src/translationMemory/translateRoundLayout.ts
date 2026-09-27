/**
 * JSON 批量翻译结果轮次：`{base}.translate.{n}.json`
 */

import * as fs from 'fs';
import * as path from 'path';

export type TranslateRoundFile = {
    round: number;
    jsonPath: string;
};

const NUMBERED = /^(.*)\.translate\.(\d+)\.json$/i;

export function parseTranslateRound(filePath: string): TranslateRoundFile | undefined {
    const name = path.basename(filePath);
    const m = name.match(NUMBERED);
    if (!m) {
        return undefined;
    }
    return { round: Number(m[2]), jsonPath: filePath };
}

export function translateJsonPath(dir: string, base: string, round: number): string {
    if (round < 1) {
        throw new Error(`翻译轮次必须 ≥ 1，收到 ${round}`);
    }
    return path.join(dir, `${base}.translate.${round}.json`);
}

export function translateProcessJsonPath(dir: string, base: string, round: number): string {
    return path.join(dir, `${base}.translate.${round}-process.json`);
}

export function segmentsJsonDirAndBaseFromPath(jsonFilePath: string): { dir: string; base: string } {
    const dir = path.dirname(jsonFilePath);
    const base = path.basename(jsonFilePath, '.json');
    return { dir, base };
}

export function inspectTranslateRounds(dir: string, base: string): {
    files: TranslateRoundFile[];
    maxRound: number;
    latestJsonPath?: string;
} {
    const files: TranslateRoundFile[] = [];
    if (!fs.existsSync(dir)) {
        return { files, maxRound: 0 };
    }
    for (const name of fs.readdirSync(dir)) {
        if (!name.startsWith(`${base}.translate.`)) {
            continue;
        }
        const full = path.join(dir, name);
        const parsed = parseTranslateRound(full);
        if (parsed) {
            files.push(parsed);
        }
    }
    files.sort((a, b) => a.round - b.round);
    const maxRound = files.length ? files[files.length - 1].round : 0;
    return {
        files,
        maxRound,
        latestJsonPath: maxRound > 0 ? translateJsonPath(dir, base, maxRound) : undefined,
    };
}

/** 第 1 轮：已有未完成的 .1 则续跑；否则新建 .1（本期不做多轮重叠译） */
export function guardTranslateFileCommand(dir: string, base: string): {
    ok: true;
    outputJsonPath: string;
    processJsonPath: string;
    round: number;
    resume: boolean;
} {
    const round1 = translateJsonPath(dir, base, 1);
    const resume = fs.existsSync(round1) && translateJsonHasNulls(round1) === true;
    return {
        ok: true,
        outputJsonPath: round1,
        processJsonPath: translateProcessJsonPath(dir, base, 1),
        round: 1,
        resume,
    };
}

export function translateJsonHasNulls(filePath: string): boolean | undefined {
    if (!fs.existsSync(filePath)) {
        return undefined;
    }
    try {
        const arr = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!Array.isArray(arr)) {
            return undefined;
        }
        return arr.some((x) => x === null);
    } catch {
        return undefined;
    }
}

/** `{base}.translate.N.json` → `{base}.json` */
export function translateJsonPathToSegmentsJsonPath(translateOutPath: string): string {
    const name = path.basename(translateOutPath);
    const m = name.match(/^(.*)\.translate\.(\d+)(-process)?\.json$/i);
    if (!m) {
        throw new Error(`不是翻译结果 JSON：${translateOutPath}`);
    }
    return path.join(path.dirname(translateOutPath), `${m[1]}.json`);
}

export type TranslatePanelButtons = {
    llmEnabled: boolean;
    llmLabel: string;
    llmHint?: string;
    resume: boolean;
};

const TRANSLATE_LLM_LABEL = 'LLM 翻译 JSON';
const TRANSLATE_LLM_RESUME_LABEL = 'LLM 翻译 JSON - 续跑';

export function getTranslatePanelButtons(dir: string, base: string): TranslatePanelButtons {
    const guard = guardTranslateFileCommand(dir, base);
    return {
        llmEnabled: true,
        llmLabel: guard.resume ? TRANSLATE_LLM_RESUME_LABEL : TRANSLATE_LLM_LABEL,
        resume: guard.resume,
    };
}

export function readJsonStringArray(filePath: string, expectedLen?: number): (string | null)[] | null {
    if (!fs.existsSync(filePath)) {
        return null;
    }
    try {
        const arr = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!Array.isArray(arr)) {
            return null;
        }
        if (expectedLen != null && arr.length !== expectedLen) {
            return null;
        }
        return arr.map((x) => (x === null || typeof x === 'string' ? x : String(x)));
    } catch {
        return null;
    }
}
