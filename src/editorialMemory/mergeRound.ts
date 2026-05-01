import type { MergeLlmResult, MergeRoundPayload } from './types';
import { editorialMemoryChat, stripJsonFence } from './llmChat';

const MERGE_SYSTEM = `你是图书编辑助理。你的任务是：根据「既有记忆窗口」和「本轮校对材料」，输出**可机械合并**到 editorial-memory.md 的 JSON。

硬性规则：
1. 只输出**一个** JSON 对象，不要 Markdown 围栏以外的文字。
2. JSON 键：global_md（字符串，对应 ## 全局 下的 bullet 正文，**不要**写 ## 全局 标题行）、sections（数组，每项 { path, body_md }；path 必须与下面给出的允许 path 之一**完全一致**，或是当前 heading_path）、classification_notes（可选）、recent_append（可选单行，写入 ## 近期记忆 首条；若输出须与全局/结构化记忆一致：单行 bullet、忌转至宜句式或句式前后对照等**短条目**，写出**真正有改动的句式要点**即可；**严禁**粘贴本轮 target 全文或长段原文/终稿；与程序自动生成的时间线摘要去重，可省略）。
3. body_md 只含该 path 下的 bullet 行（以 - 开头），不要写 ### path 行。
4. **禁止**把本应属于全书体例的内容只写在某一节 path 下：能上升全局的写入 global_md。
5. **禁止**在输出中改写与本轮无关的 path 标题；禁止输出整份 markdown 文件。
6. 禁止大段复述书稿原文；条目优先忌转至宜句式或与 global_md、sections bullet 同源风格的短句（语义与知识为主，少纯标点版式）。recent_append 尤其遵守：**只写句式级摘要**，不写整段。
7. sections 中 path 若本轮无新要点可返回空数组或省略该 path。`;

export function buildMergeUserPrompt(
    windowGlobal: string,
    windowPathsMarkdown: string,
    payload: MergeRoundPayload,
    allowedPaths: string[]
): string {
    return `【允许出现的 path 字符串】（sections[].path 必须从中择一或等于 heading_path）：
${JSON.stringify(allowedPaths, null, 0)}

【既有记忆窗口 — 全局】
${windowGlobal || '(空)'}

【既有记忆窗口 — 相关 path 块】
${windowPathsMarkdown || '(空)'}

【本轮结构化材料 JSON】
${JSON.stringify(payload, null, 2)}

请输出 JSON 对象。`;
}

export async function runMergeLlm(
    platform: string,
    model: string,
    windowGlobal: string,
    windowPathsMarkdown: string,
    payload: MergeRoundPayload,
    allowedPaths: string[]
): Promise<MergeLlmResult | null> {
    const user = buildMergeUserPrompt(windowGlobal, windowPathsMarkdown, payload, allowedPaths);
    const raw = await editorialMemoryChat(platform, model, MERGE_SYSTEM, user, 0.25);
    if (!raw) {
        return null;
    }
    try {
        const j = JSON.parse(stripJsonFence(raw)) as MergeLlmResult;
        if (j.global_md === undefined || j.global_md === null) {
            j.global_md = '';
        }
        if (typeof j.global_md !== 'string') {
            return null;
        }
        if (!Array.isArray(j.sections)) {
            j.sections = [];
        }
        return j;
    } catch {
        return null;
    }
}

export function validateSectionPaths(sections: MergeLlmResult['sections'], allowed: Set<string>): MergeLlmResult['sections'] {
    return sections.filter((s) => s && typeof s.path === 'string' && allowed.has(s.path.trim()));
}
