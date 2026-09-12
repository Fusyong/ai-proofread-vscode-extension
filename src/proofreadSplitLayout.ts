/**
 * 切分 JSON / .json.md 与校对条目路径及段落偏移（须与 splitter 中 join 规则一致）
 */

import * as path from 'path';
import {
    proofreadItemPathToSegmentsJsonPath as roundItemToSegments,
    proofreadJsonPathToSegmentsJsonPath as roundJsonToSegments,
} from './proofreadRoundLayout';

/** 与 splitter.splitText 生成 markdownOutput 时一致 */
export const PROOFREAD_SEGMENT_JOIN = '\n---\n';

/** 第 segmentIndex 段在「各 target 用 PROOFREAD_SEGMENT_JOIN 拼接」文本中的起始偏移 */
export function segmentBaseOffsetInJoinedMarkdown(segmentTargets: string[], segmentIndex: number): number {
    let o = 0;
    for (let i = 0; i < segmentIndex && i < segmentTargets.length; i++) {
        o += segmentTargets[i].length + PROOFREAD_SEGMENT_JOIN.length;
    }
    return o;
}

/** `foo.proofread-item.json` / `foo.proofread.N-item.json` → `foo.json`（LLM 批处理输入） */
export function proofreadItemPathToSegmentsJsonPath(itemPath: string): string {
    return roundItemToSegments(itemPath);
}

/** `foo.json` → `foo.json.md`（切分拼接稿） */
export function segmentsJsonPathToSplitMarkdownPath(segmentsJsonPath: string): string {
    const dir = path.dirname(segmentsJsonPath);
    const base = path.basename(segmentsJsonPath, '.json');
    return path.join(dir, `${base}.json.md`);
}

/** `foo.json.md` → `foo.proofread-item.json`（无序号的第 1 轮条目路径；编号轮次请用 proofreadItemPathFromOutput） */
export function splitMarkdownPathToProofreadItemPath(jsonMdPath: string): string {
    const dir = path.dirname(jsonMdPath);
    const base = path.basename(jsonMdPath, '.json.md');
    return path.join(dir, `${base}.proofread-item.json`);
}

/** `foo.proofread.json` / `foo.proofread.N.json` → `foo.json` */
export function proofreadJsonPathToSegmentsJsonPath(proofreadJsonPath: string): string {
    return roundJsonToSegments(proofreadJsonPath);
}
