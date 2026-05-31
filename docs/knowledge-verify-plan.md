# 统一参考资料工作流（知识核查）

## 概述

将原「dictPrep + 校对」双步流程合并为：

1. **阶段 A — 参考资料准备**（`referencePrep`）：多轮 LLM 规划 + 本地词典 / 参考文献 grep
2. **阶段 B — 校对**：复用现有 `proofreadSelection` / `processJsonFileAsync`

## 命令

| 命令 | 说明 |
|------|------|
| `AI Proofreader: knowledge verify selection` | 选段：准备参考资料，可选接着校对 |
| `AI Proofreader: prepare references for JSON file` | 对当前 JSON 切分文件批量准备 `reference` |
| 校对面板 **准备参考资料** | 与上者相同（JSON） |

已移除：`prepare references from local dictionaries (JSON)`、面板「LLM 生成查词计划」「查词并入 JSON」。

## 过程文件

- `{basename}.referenceprep.json` — 轮次、corpus、mergedReference
- `{basename}.referenceprep.log` — 运行日志

旧版 `.dictprep.json` 不再由面板写入；词典查词逻辑仍可通过 `dictPrepRunner` 内部模块复用。

## 配置

- `ai-proofread.referencePrep.enabledSources` — 默认 `["dict","grep_md"]`
- `ai-proofread.referencePrep.maxRounds` — 默认 3
- `ai-proofread.referencePrep.useEditorialMemory` — 选段「准备并校对」时是否注入编辑记忆
- `ai-proofread.referencePrep.grep.*` — grep 截断
- `ai-proofread.dictPrep.*` — 仍用于词典查询上限、缓存（`referencePrep.dict.*` 可覆盖）

## Plan JSON（阶段 A）

```json
{
  "sufficient": false,
  "queries": [
    {
      "queryId": "q1",
      "intent": "entity_name",
      "priority": 0.9,
      "dict": { "dictId": "cidian", "candidates": ["李白"] },
      "grep": { "patterns": ["李白"], "contextLines": 2 }
    }
  ],
  "prune": [{ "hitId": "h-grep-2", "reason": "无关" }]
}
```

- **终止**：程序 `maxRounds`、查词预算、corpus 字符上限；`sufficient: true` 且 queries 为空可提前结束
- **来源**：用户勾选 `dict` / `grep_md`；LLM 只写 intent，执行器按 intent 映射来源

## 二期

- `citation` — 引文 DB 匹配
- `web` — 结构化联网检索
