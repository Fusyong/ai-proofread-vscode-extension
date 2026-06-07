# 统一参考资料工作流（知识核查）

## 概述

将原「dictPrep + 校对」双步流程合并为：

1. **阶段 0 — 资源范围**（`ResourceScope`）：目录缓存、条件式 LLM 预筛词典/文件/标题；命中不足时 `fallbackWiden`
2. **阶段 A — 参考资料准备**（`referencePrep`）：多轮 LLM 规划 + 多通道检索（dict / grep / BM25 / 轻量向量）
3. **阶段 A′ — LLM 精排**：`refTag` 标注候选，打分、去重、裁剪
4. **阶段 B — 校对**：复用现有 `proofreadSelection` / `processJsonFileAsync`

## 命令

| 命令 | 说明 |
|------|------|
| `AI Proofreader: knowledge verify selection` | 选段：准备参考资料，可选接着校对 |
| `AI Proofreader: prepare references for JSON file` | JSON 批量准备 `reference` |
| `AI Proofreader: LLM-enhanced grep search` | 仅文献检索（grep + BM25 + vector） |
| `AI Proofreader: open reference prep results` | 打开「参考资料命中」TreeView |
| 校对面板 **准备参考资料** | 与 JSON 命令相同 |

## 过程文件

- `{basename}.referenceprep.json` — **v0.2.0**：轮次、结构化 `corpus`、`resourceScope`、`indexVersions`
- `{basename}.referenceprep.log` — 运行日志
- `{workspace}/.proofread/reference-catalog.json` — 参考文献目录缓存
- `{workspace}/.proofread/reference-vectors.json` — 轻量向量索引（字符 n-gram）

## 配置（节选）

- `ai-proofread.referencePrep.enabledSources` — 默认 `["dict","grep_md","bm25","vector"]`
- `ai-proofread.referencePrep.scope.*` — 预筛阈值与 fallbackWiden
- `ai-proofread.referencePrep.rerank.*` — 精排开关与候选上限
- `ai-proofread.referencePrep.bm25.topK` / `vector.*` — 检索通道
- `ai-proofread.referencePrep.grep.maxHitsPerRound` / `maxSnippetChars` / `maxFiles` — 已接通代码
- 模型路由：`referencePrep`（规划）、`referencePrepRerank`（精排，可 inherit）

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
      "grep": {
        "patterns": ["李白"],
        "searchPhrases": ["李白 籍贯"],
        "unit": "sentence",
        "contextLines": 2,
        "scopePaths": ["tang-dynasty/"]
      }
    }
  ],
  "prune": [{ "hitId": "h-grep-2", "reason": "无关" }]
}
```

### 检索单位 `unit`

| 值 | 说明 |
|----|------|
| `line_context` | 行 ± contextLines（默认） |
| `sentence` | `splitChineseSentencesWithLineNumbers` |
| `md_paragraph` | Markdown 空行分段 |
| `heading_section` | 标题至下一同级标题 |
| `file_outline` | 仅目录/标题 → `navigation_hint` |

### CorpusHit（v0.2 结构化字段）

`refTag`, `source`, `kind`, `unit`, `startLine`/`endLine`, `headingPath`, `grepPatterns`, `rgCommand`, `bm25Score`, `vectorScore`, `finalScore`, `rerankScore`, `fileMtimeMs`, `rerankReason` 等。

## TreeView

侧栏 **参考资料命中**：`轮次 → 查询 → 命中项`。支持打开文件跳转、复制 reference 块、手动 prune/restore。

## 索引依赖

- **BM25**：需先执行「建立引文索引」（`citation-refs.db` + FTS5）
- **向量**：首次启用时懒构建 `reference-vectors.json`；失败时降级为 grep+BM25

## 终止条件

程序 `maxRounds`、查词预算、grep 字符预算；`sufficient: true` 且 queries 为空可提前结束；精排与混合打分后的阈值 prune。
