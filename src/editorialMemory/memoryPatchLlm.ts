import { editorialMemoryChat, stripJsonFence } from './llmChat';
import type {
    ActiveMemoryV2,
    GlobalMemoryPatchOp,
    MemoryPatchResponse,
    MemoryRoundContext,
} from './schemaV2';
import { clipText, formatCurrentRoundsForPrompt, formatMemoryEntryLine } from './schemaV2';

const PATCH_SYSTEM = `你是图书编辑助理，维护两类编辑记忆：

1) **全局 global**：体例级、跨文档通则。每条为结构化字段：original / changedTo 表「忌/原 → 宜/终」，**repeated** 表示同类问题在稿中反复出现的强度（整数 ≥1），**weight** 为优先级（0–1000）。
2) **本轮扁平 current_round_flat**：用自然语言或短 bullet **只写本次校对值得记住的要点合并稿**（不要把整段 target 贴入）。此段将写入「最近 d 次校对」栈供下次参考，与历史轮次 **去重**：若与上一轮合并稿归一化后完全相同，程序会丢弃，故请写出有信息量的差异表述。

你只输出 **一个 JSON 对象**（勿用围栏外文字）。字段：
- substantive: boolean — 本轮是否有值得写入记忆的新知。
- global_ops: 数组，**仅**作用于 global：
  { "op":"add","entry":{ "original":"…","changedTo":"…","repeated":1,"weight":5 } }
  { "op":"remove","id":"…" }
  { "op":"set_weight","id":"…","weight":10 }
  { "op":"bump_weight","id":"…","delta":3 }
  add 时不要填 id。**repeated** 在 global 表示重复强度；若仅是复现已知全局点，优先 bump_weight / 调 repeated 而非堆 duplicate 条目。
  remove 的条目会进存档。
- current_round_flat: 字符串，本轮合并后的扁平校对记忆（可多行）。若 substantive 为 false 可给空串或极短说明。

禁止粘贴大段书稿原文；简洁为主。`;

/** 将旧版 tier ops 中 global 部分转为 global_ops（忽略 recent/current/move） */
function legacyOpsToGlobalOps(raw: unknown[]): GlobalMemoryPatchOp[] {
    const out: GlobalMemoryPatchOp[] = [];
    for (const o of raw) {
        if (!o || typeof o !== 'object' || typeof (o as { op?: string }).op !== 'string') {
            continue;
        }
        const op = (o as { op: string }).op;
        const tier = (o as { tier?: string }).tier;
        if (op === 'add' && tier === 'global' && (o as { entry?: unknown }).entry) {
            const ent = (o as { entry: Record<string, unknown> }).entry;
            if (typeof ent.original === 'string' && typeof ent.changedTo === 'string') {
                out.push({
                    op: 'add',
                    entry: {
                        original: ent.original as string,
                        changedTo: ent.changedTo as string,
                        repeated: typeof ent.repeated === 'number' ? ent.repeated : undefined,
                        weight: typeof ent.weight === 'number' ? ent.weight : undefined,
                    },
                });
            }
        } else if (op === 'remove' && tier === 'global' && typeof (o as { id?: string }).id === 'string') {
            out.push({ op: 'remove', id: (o as { id: string }).id });
        } else if (op === 'set_weight' && tier === 'global' && typeof (o as { id?: string }).id === 'string') {
            const w = (o as { weight?: number }).weight;
            if (typeof w === 'number') {
                out.push({ op: 'set_weight', id: (o as { id: string }).id, weight: w });
            }
        } else if (op === 'bump_weight' && tier === 'global' && typeof (o as { id?: string }).id === 'string') {
            const d = (o as { delta?: number }).delta;
            if (typeof d === 'number') {
                out.push({ op: 'bump_weight', id: (o as { id: string }).id, delta: d });
            }
        }
    }
    return out;
}

export function buildMemoryPatchUserPrompt(params: {
    activeSnapshot: ActiveMemoryV2;
    round: MemoryRoundContext;
    globalMax: number;
    maxProofreadRounds: number;
    globalPromptMaxChars: number;
    currentRoundsPromptMaxChars: number;
}): string {
    const { activeSnapshot, round, globalMax, maxProofreadRounds, globalPromptMaxChars, currentRoundsPromptMaxChars } =
        params;
    const linesGlobal = activeSnapshot.global.map(formatMemoryEntryLine).join('\n');
    const linesCur = formatCurrentRoundsForPrompt(activeSnapshot.currentRounds);

    return `【约束】global 条数硬上限≤${globalMax}（程序会挤低权重条目入存档）；本轮记忆栈保留最近 ${maxProofreadRounds} 次校对（程序按轮去重、FIFO）。

【全局 global】（每行一条）
${clipText(linesGlobal, globalPromptMaxChars) || '(空)'}

【最近 d 次·扁平校对记忆】（供本轮整理参考；新在上）
${clipText(linesCur, currentRoundsPromptMaxChars) || '(尚无)'}

【本轮校对材料 JSON】
${JSON.stringify(round, null, 2)}

请只输出 JSON：substantive、global_ops、current_round_flat。`;
}

export async function runMemoryPatchLlm(
    platform: string,
    model: string,
    user: string,
    temperature: number = 0.25
): Promise<MemoryPatchResponse | null> {
    const raw = await editorialMemoryChat(platform, model, PATCH_SYSTEM, user, temperature);
    if (!raw) {
        return null;
    }
    try {
        const j = JSON.parse(stripJsonFence(raw)) as MemoryPatchResponse & { ops?: unknown[] };
        if (!j || typeof j !== 'object') {
            return null;
        }
        let global_ops: GlobalMemoryPatchOp[] = Array.isArray(j.global_ops) ? (j.global_ops as GlobalMemoryPatchOp[]) : [];
        if (global_ops.length === 0 && Array.isArray(j.ops)) {
            global_ops = legacyOpsToGlobalOps(j.ops);
        }
        const current_round_flat =
            typeof j.current_round_flat === 'string' ? j.current_round_flat : '';
        return {
            substantive: Boolean(j.substantive),
            global_ops,
            current_round_flat,
        };
    } catch {
        return null;
    }
}
