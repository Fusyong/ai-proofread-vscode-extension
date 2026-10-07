/**
 * 并行批处理：采纳本轮结果并记入记忆历史（2B；不写 active 精选库）。
 * 将 segments JSON 的 target 与轮次结果 JSON 的 target 逐项对比，抽取实质句对。
 */

import * as fs from 'fs';
import * as vscode from 'vscode';
import { parseProofreadRound } from '../proofreadRoundLayout';
import { recordEditAcceptHistory } from './recordAcceptHistory';

type Seg = { target?: string; [key: string]: unknown };

function readSegArray(filePath: string): Seg[] | null {
    try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return Array.isArray(raw) ? (raw as Seg[]) : null;
    } catch {
        return null;
    }
}

/**
 * @param segmentsJsonPath 切分后的主 JSON（原文 target）
 * @param roundJsonPath `{base}.proofread.{n}.json` 等编辑结果
 */
export async function applyParallelRoundToHistory(args: {
    segmentsJsonPath: string;
    roundJsonPath: string;
}): Promise<{ pairs: number; message: string }> {
    const roundMeta = parseProofreadRound(args.roundJsonPath);
    if (!roundMeta) {
        return { pairs: 0, message: '所选文件不是校对轮次结果（*.proofread.N.json）' };
    }
    const before = readSegArray(args.segmentsJsonPath);
    const after = readSegArray(args.roundJsonPath);
    if (!before || !after) {
        return { pairs: 0, message: '无法读取 JSON 数组' };
    }
    if (before.length !== after.length) {
        return {
            pairs: 0,
            message: `条目数不一致：源 ${before.length} vs 轮次 ${after.length}`,
        };
    }
    const uri = vscode.Uri.file(args.segmentsJsonPath);
    let pairs = 0;
    for (let i = 0; i < before.length; i++) {
        const a = String(before[i]?.target ?? '');
        const b = String(after[i]?.target ?? '');
        if (!a.trim() || a === b) {
            continue;
        }
        pairs += recordEditAcceptHistory({
            documentUri: uri,
            original: a,
            finalText: b,
            origin: 'parallel_apply',
        });
    }
    return {
        pairs,
        message: `已记入编辑记忆历史 ${pairs} 条（轮次 ${roundMeta.round}，origin=parallel_apply）`,
    };
}

export async function promptApplyParallelRoundHistory(
    defaultSegmentsPath?: string
): Promise<void> {
    const segPick = defaultSegmentsPath
        ? { fsPath: defaultSegmentsPath }
        : (
              await vscode.window.showOpenDialog({
                  canSelectMany: false,
                  filters: { JSON: ['json'] },
                  title: '选择切分后的源 JSON（含原文 target）',
              })
          )?.[0];
    if (!segPick) {
        return;
    }
    const roundPick = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { JSON: ['json'] },
        title: '选择并行轮次结果 JSON（*.proofread.N.json）',
        defaultUri: vscode.Uri.file(segPick.fsPath),
    });
    if (!roundPick?.[0]) {
        return;
    }
    const res = await applyParallelRoundToHistory({
        segmentsJsonPath: segPick.fsPath,
        roundJsonPath: roundPick[0].fsPath,
    });
    if (res.pairs > 0) {
        vscode.window.showInformationMessage(res.message);
    } else {
        vscode.window.showWarningMessage(res.message);
    }
}
