/**
 * JSON 批量校对结果轮次：路径、发现、轮次冲突、叠轮输入。
 * 结果文件：`{base}.proofread.{n}.json`；旧无序号 `{base}.proofread.json` 视为第 1 轮（仅当不存在 `.1.json`）。
 */

import * as fs from 'fs';
import * as path from 'path';

export type ProofreadRoundFile = {
    round: number;
    jsonPath: string;
    isLegacyUnnumbered: boolean;
};

export type RoundContinuityIssue = {
    kind: 'conflict';
    round: number;
    paths: string[];
};

export type InspectProofreadRounds = {
    files: ProofreadRoundFile[];
    maxRound: number;
    /** 同一轮存在多份结果文件 */
    hasConflicts: boolean;
    issues: RoundContinuityIssue[];
    message?: string;
};

export type OverlaySourceItem = {
    target: string;
    reference?: string;
    context?: string;
    [key: string]: unknown;
};

export type ProofreadPanelButtons = {
    hasConflicts: boolean;
    message?: string;
    maxRound: number;
    latestJsonPath?: string;
    latestRound?: number;
    llmEnabled: boolean;
    llmLabel: string;
    llmHint?: string;
    overlayEnabled: boolean;
    overlayLabel: string;
    overlayHint?: string;
};

const NUMBERED_JSON = /^(.*)\.proofread\.(\d+)\.json$/i;
const LEGACY_JSON = /^(.*)\.proofread\.json$/i;
const NUMBERED_ITEM = /^(.*)\.proofread\.(\d+)-item\.json$/i;
const LEGACY_ITEM = /^(.*)\.proofread-item\.json$/i;

export function parseProofreadRound(filePath: string): ProofreadRoundFile | undefined {
    const parsed = parseProofreadRoundFull(filePath);
    if (!parsed) {
        return undefined;
    }
    return {
        round: parsed.round,
        jsonPath: parsed.jsonPath,
        isLegacyUnnumbered: parsed.isLegacyUnnumbered,
    };
}

type ParsedRound = ProofreadRoundFile & { dir: string; base: string };

function parseProofreadRoundFull(filePath: string): ParsedRound | undefined {
    const dir = path.dirname(filePath);
    const name = path.basename(filePath);
    const numbered = name.match(NUMBERED_JSON);
    if (numbered) {
        return {
            round: Number(numbered[2]),
            jsonPath: filePath,
            isLegacyUnnumbered: false,
            dir,
            base: numbered[1],
        };
    }
    const legacy = name.match(LEGACY_JSON);
    if (legacy) {
        return {
            round: 1,
            jsonPath: filePath,
            isLegacyUnnumbered: true,
            dir,
            base: legacy[1],
        };
    }
    return undefined;
}

export function proofreadJsonPath(dir: string, base: string, round: number): string {
    if (round < 1) {
        throw new Error(`校对轮次必须 ≥ 1，收到 ${round}`);
    }
    return path.join(dir, `${base}.proofread.${round}.json`);
}

export function proofreadMarkdownPathFromOutput(jsonOutPath: string): string {
    return `${jsonOutPath}.md`;
}

export function proofreadItemPathFromOutput(jsonOutPath: string): string {
    const parsed = parseProofreadRoundFull(jsonOutPath);
    if (!parsed) {
        return jsonOutPath.replace(/\.json$/i, '-item.json');
    }
    if (parsed.isLegacyUnnumbered) {
        return path.join(parsed.dir, `${parsed.base}.proofread-item.json`);
    }
    return path.join(parsed.dir, `${parsed.base}.proofread.${parsed.round}-item.json`);
}

/** `foo.proofread.json` / `foo.proofread.N.json` → `foo.json` */
export function proofreadJsonPathToSegmentsJsonPath(proofreadJsonPath: string): string {
    const parsed = parseProofreadRoundFull(proofreadJsonPath);
    if (parsed) {
        return path.join(parsed.dir, `${parsed.base}.json`);
    }
    return proofreadJsonPath.replace(/\.proofread(?:\.\d+)?\.json$/i, '.json');
}

/** `foo.proofread-item.json` / `foo.proofread.N-item.json` → `foo.json` */
export function proofreadItemPathToSegmentsJsonPath(itemPath: string): string {
    const dir = path.dirname(itemPath);
    const name = path.basename(itemPath);
    const numbered = name.match(NUMBERED_ITEM);
    if (numbered) {
        return path.join(dir, `${numbered[1]}.json`);
    }
    const legacy = name.match(LEGACY_ITEM);
    if (legacy) {
        return path.join(dir, `${legacy[1]}.json`);
    }
    return itemPath.replace(/\.proofread(?:\.\d+)?-item\.json$/i, '.json');
}

export function isProofreadItemJsonPath(filePath: string): boolean {
    return parseProofreadItemPath(filePath) !== undefined;
}

export function parseProofreadItemPath(
    filePath: string
): { round: number; isLegacyUnnumbered: boolean; dir: string; base: string } | undefined {
    const dir = path.dirname(filePath);
    const name = path.basename(filePath);
    const numbered = name.match(NUMBERED_ITEM);
    if (numbered) {
        return { round: Number(numbered[2]), isLegacyUnnumbered: false, dir, base: numbered[1] };
    }
    const legacy = name.match(LEGACY_ITEM);
    if (legacy) {
        return { round: 1, isLegacyUnnumbered: true, dir, base: legacy[1] };
    }
    return undefined;
}

export function isProofreadResultJsonPath(filePath: string): boolean {
    return parseProofreadRoundFull(filePath) !== undefined;
}

/** `*.proofread.json.md` / `*.proofread.N.json.md` → 去掉该后缀后的路径前缀（用于反查 .pdf / 原稿） */
export function stripProofreadJsonMarkdownSuffix(filePath: string): string | undefined {
    const numbered = filePath.match(/^(.*)\.proofread\.\d+\.json\.md$/i);
    if (numbered) {
        return numbered[1];
    }
    const legacy = filePath.match(/^(.*)\.proofread\.json\.md$/i);
    if (legacy) {
        return legacy[1];
    }
    return undefined;
}

export function isProofreadJsonMarkdownPath(filePath: string): boolean {
    return stripProofreadJsonMarkdownSuffix(filePath) !== undefined;
}

/**
 * 从当前打开的 JSON（切分稿、结果稿或条目稿）得到切分输入 `文档.json`。
 * 无法识别时返回 undefined。
 */
export function resolveSegmentsJsonPath(filePath: string): string | undefined {
    if (isProofreadResultJsonPath(filePath)) {
        return proofreadJsonPathToSegmentsJsonPath(filePath);
    }
    if (isProofreadItemJsonPath(filePath)) {
        return proofreadItemPathToSegmentsJsonPath(filePath);
    }
    if (/\.json$/i.test(filePath)) {
        const stem = path.basename(filePath, '.json');
        if (/\.(proofread|referenceprep|dictprep)$/i.test(stem)) {
            return undefined;
        }
        return filePath;
    }
    return undefined;
}

export function listProofreadRounds(dir: string, base: string): ProofreadRoundFile[] {
    if (!fs.existsSync(dir)) {
        return [];
    }
    const names = fs.readdirSync(dir);
    const out: ProofreadRoundFile[] = [];
    for (const name of names) {
        const full = path.join(dir, name);
        const parsed = parseProofreadRoundFull(full);
        if (!parsed || parsed.base !== base) {
            continue;
        }
        out.push({
            round: parsed.round,
            jsonPath: parsed.jsonPath,
            isLegacyUnnumbered: parsed.isLegacyUnnumbered,
        });
    }
    return out.sort((a, b) => a.round - b.round || Number(a.isLegacyUnnumbered) - Number(b.isLegacyUnnumbered));
}

export function inspectProofreadRounds(dir: string, base: string): InspectProofreadRounds {
    const files = listProofreadRounds(dir, base);
    const byRound = new Map<number, ProofreadRoundFile[]>();
    for (const f of files) {
        const list = byRound.get(f.round) ?? [];
        list.push(f);
        byRound.set(f.round, list);
    }
    const issues: RoundContinuityIssue[] = [];
    const maxRound = files.reduce((m, f) => Math.max(m, f.round), 0);
    for (const [round, list] of byRound) {
        if (list.length > 1) {
            issues.push({ kind: 'conflict', round, paths: list.map((x) => x.jsonPath) });
        }
    }
    issues.sort((a, b) => a.round - b.round);
    const hasConflicts = issues.length > 0;
    return {
        files,
        maxRound,
        hasConflicts,
        issues,
        message: hasConflicts ? formatConflictMessage(issues) : undefined,
    };
}

export function formatConflictMessage(issues: RoundContinuityIssue[]): string {
    const parts: string[] = ['同一轮不能有多份结果文件。请自行处理：'];
    for (const issue of issues) {
        parts.push(`第 ${issue.round} 轮存在多份：${issue.paths.map((p) => path.basename(p)).join('、')}`);
    }
    return parts.join(' ');
}

function uniqueFileForRound(inspected: InspectProofreadRounds, round: number): ProofreadRoundFile | undefined {
    const list = inspected.files.filter((f) => f.round === round);
    return list.length === 1 ? list[0] : undefined;
}

/** 第 1 轮输出路径：已有唯一第 1 轮文件则沿用（含旧无序号），否则写 `.proofread.1.json` */
export function round1OutputJsonPath(dir: string, base: string, inspection?: InspectProofreadRounds): string {
    const inspected = inspection ?? inspectProofreadRounds(dir, base);
    const r1 = inspected.files.filter((f) => f.round === 1);
    if (r1.length === 1) {
        return r1[0].jsonPath;
    }
    return proofreadJsonPath(dir, base, 1);
}

export function readJsonArray(filePath: string): unknown[] | undefined {
    try {
        const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return Array.isArray(content) ? content : undefined;
    } catch {
        return undefined;
    }
}

export function proofreadJsonHasNulls(filePath: string): boolean | undefined {
    const arr = readJsonArray(filePath);
    if (!arr) {
        return undefined;
    }
    return arr.some((item) => item === null);
}

export function buildOverlayInput(
    sourceItems: OverlaySourceItem[],
    previousStrings: Array<string | null>
): OverlaySourceItem[] {
    if (sourceItems.length !== previousStrings.length) {
        throw new Error(
            `切分已变化，请删除旧校对结果后重跑第 1 轮。（输入 ${sourceItems.length} 条，上一轮结果 ${previousStrings.length} 条）`
        );
    }
    const nullIndexes: number[] = [];
    for (let i = 0; i < previousStrings.length; i++) {
        if (previousStrings[i] === null) {
            nullIndexes.push(i + 1);
        }
    }
    if (nullIndexes.length > 0) {
        throw new Error(`上一轮结果仍有未完成条目（null）：第 ${nullIndexes.join('、')} 条`);
    }
    return sourceItems.map((item, i) => ({
        ...item,
        target: previousStrings[i] as string,
    }));
}

export function asOverlaySourceItems(jsonContent: unknown): OverlaySourceItem[] | undefined {
    if (!Array.isArray(jsonContent)) {
        return undefined;
    }
    if (
        !jsonContent.every(
            (item) => typeof item === 'object' && item !== null && 'target' in item
        )
    ) {
        return undefined;
    }
    return jsonContent as OverlaySourceItem[];
}

export function asProofreadOutputStrings(jsonContent: unknown): Array<string | null> | undefined {
    if (!Array.isArray(jsonContent)) {
        return undefined;
    }
    if (!jsonContent.every((item) => item === null || typeof item === 'string')) {
        return undefined;
    }
    return jsonContent as Array<string | null>;
}

const LLM_LABEL = 'LLM 校对 JSON';
const LLM_RESUME_LABEL = 'LLM 校对 JSON - 续跑';
const OVERLAY_LABEL = '重叠校对 JSON';
const OVERLAY_RESUME_LABEL = '重叠校对 JSON - 续跑';

export function getProofreadPanelButtons(dir: string, base: string): ProofreadPanelButtons {
    const inspected = inspectProofreadRounds(dir, base);
    const llm = guardProofreadFileCommand(dir, base);
    const overlay = guardOverlayProofreadCommand(dir, base);
    const latest = uniqueFileForRound(inspected, inspected.maxRound);
    const round1 = uniqueFileForRound(inspected, 1);
    const llmResume = llm.ok && round1 != null && proofreadJsonHasNulls(round1.jsonPath) === true;
    const overlayResume = overlay.ok && overlay.mode === 'resume';

    return {
        hasConflicts: inspected.hasConflicts,
        message: inspected.message,
        maxRound: inspected.maxRound,
        latestJsonPath: latest?.jsonPath,
        latestRound: latest?.round,
        llmEnabled: llm.ok,
        llmLabel: llmResume ? LLM_RESUME_LABEL : LLM_LABEL,
        llmHint: llm.ok ? undefined : llm.message,
        overlayEnabled: overlay.ok,
        overlayLabel: overlayResume ? OVERLAY_RESUME_LABEL : OVERLAY_LABEL,
        overlayHint: overlay.ok ? undefined : overlay.message,
    };
}

export function segmentsJsonDirAndBase(segmentsJsonPath: string): { dir: string; base: string } {
    return {
        dir: path.dirname(segmentsJsonPath),
        base: path.basename(segmentsJsonPath, '.json'),
    };
}

export type ProofreadFileGuard =
    | { ok: true; outputJsonPath: string }
    | { ok: false; message: string };

export type OverlayProofreadGuard =
    | {
          ok: true;
          mode: 'resume' | 'next';
          round: number;
          outputJsonPath: string;
          previousJsonPath: string;
      }
    | { ok: false; message: string };

export function guardProofreadFileCommand(dir: string, base: string): ProofreadFileGuard {
    const inspected = inspectProofreadRounds(dir, base);
    if (inspected.hasConflicts) {
        return { ok: false, message: inspected.message ?? '同一轮存在多份结果文件，请自行处理后重试。' };
    }
    if (inspected.maxRound >= 2) {
        return {
            ok: false,
            message:
                '已有重叠校对结果。要从原稿校第 1 轮，请先删除第 2 轮及以后的结果文件；要再校一轮，请使用 overlay proofread file。',
        };
    }
    const round1 = uniqueFileForRound(inspected, 1);
    if (round1 && proofreadJsonHasNulls(round1.jsonPath) !== true) {
        return {
            ok: false,
            message: '第 1 轮已完成。再校请用 overlay proofread file；要从原稿重跑请删除结果文件。',
        };
    }
    return { ok: true, outputJsonPath: round1OutputJsonPath(dir, base, inspected) };
}

export function guardOverlayProofreadCommand(dir: string, base: string): OverlayProofreadGuard {
    const inspected = inspectProofreadRounds(dir, base);
    if (inspected.hasConflicts) {
        return { ok: false, message: inspected.message ?? '同一轮存在多份结果文件，请自行处理后重试。' };
    }
    if (inspected.maxRound === 0) {
        return { ok: false, message: '尚未有校对结果。请先使用 proofread file 完成第 1 轮。' };
    }
    const latest = uniqueFileForRound(inspected, inspected.maxRound);
    if (!latest) {
        return { ok: false, message: '尚未有校对结果。请先使用 proofread file 完成第 1 轮。' };
    }
    if (proofreadJsonHasNulls(latest.jsonPath) === true) {
        if (inspected.maxRound === 1) {
            return { ok: false, message: '请先用 proofread file 完成第 1 轮。' };
        }
        const previous = uniqueFileForRound(inspected, inspected.maxRound - 1);
        if (!previous) {
            return {
                ok: false,
                message:
                    `无法续跑第 ${inspected.maxRound} 轮：缺少上一轮 ${path.basename(proofreadJsonPath(dir, base, inspected.maxRound - 1))}。` +
                    `要从原稿重跑请删除第 ${inspected.maxRound} 轮结果。`,
            };
        }
        if (proofreadJsonHasNulls(previous.jsonPath) === true) {
            return {
                ok: false,
                message: `上一轮（第 ${inspected.maxRound - 1} 轮）尚未完成，无法续跑第 ${inspected.maxRound} 轮。`,
            };
        }
        return {
            ok: true,
            mode: 'resume',
            round: inspected.maxRound,
            outputJsonPath: latest.jsonPath,
            previousJsonPath: previous.jsonPath,
        };
    }
    return {
        ok: true,
        mode: 'next',
        round: inspected.maxRound + 1,
        outputJsonPath: proofreadJsonPath(dir, base, inspected.maxRound + 1),
        previousJsonPath: latest.jsonPath,
    };
}

