# 统一参考资料工作流（知识核查）

## 概述

将原「dictPrep + 校对」双步流程合并为：

1. **阶段 0 — 资源范围**（`ResourceScope`）：目录缓存、条件式 LLM 预筛词典/文件/标题；命中不足时 `fallbackWiden`
2. **阶段 A — 参考资料准备**（`referencePrep`）：多轮 LLM 规划 + 多通道检索（dict / grep / BM25 / 轻量向量 / 可选 wikipedia）
3. **阶段 A′ — LLM 精排**：`refTag` 标注候选，打分、去重、裁剪
4. **阶段 B — 校对**：复用现有 `proofreadSelection` / `processJsonFileAsync`

## 命令

| 命令 | 共用流程 | 规划提示词（targetKind） | 是否校对 |
|------|----------|--------------------------|----------|
| `knowledge verify selection`（仅准备 / 准备并验证） | 预筛 → 规划 → 检索 → 精排 → **参考资料命中** TreeView | `manuscript`（默认） | 可选 |
| `LLM-enhanced grep search` | 同上 | `search_intent` | 否 |
| `verify selected citation` | 同上 | `citation_selection` | 否 |
| `prepare references for JSON file` / 校对面板 **准备参考资料** | 同上（批量） | `manuscript` | 可选 |
| `open reference prep results` | 打开 TreeView | — | — |

**全文引文核对**（`verify citations`）仍走引文索引 + 相似度匹配 + **Citation** 树，与上表三条不同。

三条「参考资料准备」命令默认资料来源均为：**词典 + grep + BM25 + 向量**（需引文索引与词典配置）；**维基百科**需在选来源时手动勾选。差异仅在输入语义（提示词）与是否进入阶段 B 校对。

## 过程文件

- `{basename}.referenceprep.json` — **v0.2.0**：轮次、结构化 `corpus`、`resourceScope`、`indexVersions`
- `{basename}.referenceprep.log` — 运行日志
- `{workspace}/.proofread/reference-catalog.json` — 参考文献目录缓存
- `{workspace}/.proofread/reference-vectors.json` — 轻量向量索引（字符 n-gram）
- `{workspace}/.proofread/wiki-cache.json` — 维基百科/Wikidata 响应缓存（启用 wikipedia 来源时）

## 配置（节选）

- `ai-proofread.referencePrep.enabledSources` — 默认 `["dict","grep_md","bm25","vector"]`（不含 wikipedia）
- `ai-proofread.referencePrep.wikipedia.*` — User-Agent 联系 URL、语言、速率限制、会话预算、缓存 TTL
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
      },
      "wikipedia": {
        "searchTerms": ["李白"],
        "lang": "zh",
        "includeWikidata": true
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

`refTag`, `source`, `kind`, `unit`, `startLine`/`endLine`, `headingPath`, `grepPatterns`, `rgCommand`, `bm25Score`, `vectorScore`, `finalScore`, `rerankScore`, `fileMtimeMs`, `rerankReason`, `pageTitle`, `pageUrl`, `wikiLang`, `wikidataId`, `wikidataClaims` 等。

## TreeView

侧栏 **参考资料命中**：`轮次 → 查询 → 命中项`。支持打开文献文件跳转、**维基条目在浏览器打开**、复制 reference 块、手动 prune/restore。

## 续跑（仅准备 / LLM grep）

- 若当前锚点（或工作区最近会话）存在 `.referenceprep.json`，启动时可选择 **继续上次**（默认追加 1 规划轮，保留 corpus）或 **重新开始**
- **准备并校对** 始终全新开始，不提示续跑
- 选区/检索描述与 `userInput` 不一致时会二次确认；续跑其它文档时使用该过程文件中的 target
- 最近会话列表保存在 workspaceState（最多 10 条）；配置 `referencePrep.continuation.maxRounds` 可调续跑轮次

## 索引依赖

- **BM25**：需先执行「建立引文索引」（`citation-refs.db` + FTS5）
- **向量**：首次启用时懒构建 `reference-vectors.json`；失败时降级为 grep+BM25

## 终止条件

程序 `maxRounds`、查词预算、grep 字符预算、**Wikipedia HTTP 预算**（`.referenceprep.log` 记录 `wiki HTTP=` 与 cache hit/miss）；`sufficient: true` 且 queries 为空可提前结束；精排与混合打分后的阈值 prune。

## 维基百科通道（合规要点）

- 扩展维护者 User-Agent（`referencePrep.wikipedia.userAgentContactUrl`），串行请求，软限速默认 30/min
- 429/503 退避；连续 429 暂停该会话维基检索
- 缓存命中不计入 HTTP 预算；详见 README「维基百科资料来源」
