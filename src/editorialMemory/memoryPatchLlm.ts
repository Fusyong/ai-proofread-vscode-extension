import { editorialMemoryChat, stripJsonFence } from './llmChat';
import type {
    ActiveMemoryV2,
    GlobalMemoryPatchOp,
    MemoryPatchResponse,
    MemoryRoundContext,
} from './schemaV2';
import { clipText, formatCurrentRoundsForPrompt, formatMemoryEntryLine } from './schemaV2';

/** 合并模型输出的本轮扁平稿上限（程序截断） */
const CURRENT_ROUND_FLAT_OUTPUT_MAX = 6000;

const PATCH_SYSTEM = `你是图书编辑助理，维护两类编辑记忆：

1) **全局 global**（体例级、可跨片段复用）
   - 每条：**original** / **changedTo** 表示「忌/原 → 宜/终」；**weight** 为优先级（0–1000）。
   - **note**（可选）：**修改说明**。语法、逻辑、承接、体例通则类：优先在 note 里写**规律与适用条件**（可一句话）；original/changedTo 可用极简对照或典型短语。
   - **字词、专名、标点等字面错误**：可直接把 **original/changedTo 写成例词或很短例句**，note 可省略或仅点睛。
   - 同类问题反复出现：**bump_weight** / **set_weight**，勿新增语义重复的 add。

2) **本轮扁平 current_round_flat**（写入「最近 d 次校对」栈，与历史归一化去重）
   - 不要粘贴整段 target。
   - 建议用前缀区分类型（可选但推荐）：行首 **【例】** 字词/专名等可直接写例；**【规律】** 语法、逻辑、体例等写规则要点（可附极简例，勿堆砌）。
   - 一条 bullet 一件事；宁可少而准。

【否定示例 — 禁止】
- 把半段、整段书稿抄进 original/changedTo 或 current_round_flat。
- 空泛废话：「注意通顺」「认真校对」等无操作价值的话。
- 与已有 global **语义重复**仍再 add 一条（应 bump_weight）。
- current_round_flat 只有「已修改」「无」而无实质要点（若无新知则 substantive=false 且 flat 可空）。

你只输出 **一个 JSON 对象**（勿用围栏外文字）。字段：
- substantive: boolean
- global_ops: 数组，**仅**作用于 global：
  { "op":"add","entry":{ "original":"…","changedTo":"…","weight":5,"note":"可选，修改说明" } }
  { "op":"remove","id":"…" }
  { "op":"set_weight","id":"…","weight":10 }
  { "op":"bump_weight","id":"…","delta":3 }
  add 时不要填 id。remove 的条目会进存档。
- current_round_flat: 字符串（可多行）。substantive 为 false 时可 "" 或极短说明。`;

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
                        weight: typeof ent.weight === 'number' ? ent.weight : undefined,
                        note: typeof ent.note === 'string' ? ent.note : undefined,
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
        const current_round_flat = clipText(
            typeof j.current_round_flat === 'string' ? j.current_round_flat : '',
            CURRENT_ROUND_FLAT_OUTPUT_MAX
        );
        return {
            substantive: Boolean(j.substantive),
            global_ops,
            current_round_flat,
        };
    } catch {
        return null;
    }
}
