# 统一参考资料准备（referencePrep）

> **文档定位**：实现/设计说明。用户入门请先看 [README §3.1.5](../README.md) 与 [命令速查](commands-cheatsheet.md)。  
> **「知识核查」**：仅为预置校对提示词（item / full），在校对面板选用；不是独立命令或工作流名。

## 概述

将原「dictPrep + 校对」双步流程收敛为资料准备管线；校对与检索解耦：

1. **阶段 0 — 资源范围**（`ResourceScope`）：目录缓存、条件式 LLM 预筛词典/文件/标题；命中不足时 `fallbackWiden`
2. **阶段 A — 资料准备**（`referencePrep`）：多轮 LLM 规划 + 多通道检索（dict / grep / BM25 / 轻量向量 / 可选 wikipedia）
3. **阶段 A′ — LLM 精排**：`refTag` 标注候选，打分、去重、裁剪
4. **阶段 B — 校对**（可选，在**校对面板**）：选用「知识核查」等提示词，复用 `proofreadSelection` / `processJsonFileAsync`

## 命令

| 命令 | 共用流程 | 规划提示词（targetKind） | 是否校对 |
|------|----------|--------------------------|----------|
| `Prepare References for Selection（资料准备·选段）` | 预筛 → 规划 → 检索 → 精排 → TreeView / 检索面板 | `manuscript` | 否 |
| `Prepare References for JSON File（资料准备·JSON）` / 校对面板 **准备参考资料** | 同上（批量；**只写过程文件，不自动写源 JSON**） | `manuscript` | 否 |
| `Intent Search（意图检索）` | 同上 | `search_intent` | 否 |
| `Verify Selected Citation（核对选中引文）` | 同上 | `citation_selection` | 否 |
| 单源：`search.dictPrep` / `search.refsGrep` / `refsBm25` / `refsVector` / `wikipedia` / `web` | 固定 `enabledSources` 跑同一流水线 | `search_intent` | 否 |
| `Open Reference Search Panel（检索面板）` | Webview：配置多源、执行、展示规划过程与命中 | — | — |
| `Open 资料检索 View` | 打开 TreeView | — | — |

**正式资料来源**：本地词典、本地参考资料（grep / BM25 / 向量）、维基百科、Web（尚未实现）。  
**便捷工具（不进入 corpus）**：同名 PDF 搜索、识典古籍、中华经典古籍库。

**核对全文引文**（`Verify Citations（核对全文引文）`）仍走引文索引 + 相似度匹配 + 侧栏 **引文核查** 树，与上表不同。详见 [citation-verification-plan.md](citation-verification-plan.md)。

复合准备默认来源：**词典 + grep + BM25 + 向量**；**维基百科**需勾选；**Web** 不可用。

过程事件：`referencePrepRunner` 通过结构化 `PrepEvent`（phase / plan / query / hits / process）推送给检索面板 Webview；TreeView 仍经 `onProcessUpdated` 同步。

## 过程文件

- `{basename}.referenceprep.json` — **v0.3.0**：一文一文件，内含多条选区/`target` 记录（`records[]` + `activeRecordId`）；单条展示时兼容由 v0.2 升级
- `{basename}.referenceprep.log` — 运行日志
- `{workspace}/.proofread/reference-catalog.json` — 参考资料目录缓存
- `{workspace}/.proofread/reference-vectors.json` — 轻量向量索引（字符 n-gram）
- `{workspace}/.proofread/wiki-cache.json` — 维基百科/Wikidata 响应缓存（启用 wikipedia 来源时）
- `{workspace}/.proofread/retrieval-cache.json` — **项目级检索命中缓存**（dict/grep/bm25/vector/wikipedia；**v2**：`hitStore` 按 digest 共享正文，`entries` 只存引用；可读 v1 并写回 v2；TTL / maxEntries 可配）

### 检索面板与过程文件

- **MD 选段** 与 **JSON 条目** 相互独立：过程记录带 `prepOrigin`（`selection` / `json_item`）；选段不可在 JSON 文件上运行，也不可把选段结果合并进 JSON
- **重放过程文件**：按锚点类型只列出对应来源的记录；多条时可选择一条，或不选（Esc）分组展示全部（MD 称「选区」，JSON 称「条目」）
- **选段准备**：与命令面板一致，可续跑本选区 / 新建 / 切换同文档其它选区
- **JSON 批量**：每条 `target` 独立 `json_item` 记录；**不自动改写源 JSON 的 `reference`**；结束后面板按条目分组；用户勾选后「合并选中到源 JSON」（可按 target 写入对应条目）是写回源文件的唯一正式路径
- **JSON 续跑**：「继续未完成部分」按过程记录（`jsonItemIndex` 已有 corpus/rounds）跳过，不依赖源 JSON 是否已有 `reference`
- 导出：选段结果 → md；JSON 结果 → json / 合并到源 JSON（由「当前结果来源」决定按钮）。校对请到校对面板

## 配置（节选）

- `ai-proofread.referencePrep.enabledSources` — 默认 `["dict","grep_md","bm25","vector"]`（不含 wikipedia）
- `ai-proofread.referencePrep.retrievalCache.enabled` / `ttlHours` / `maxEntries` — 项目检索命中缓存
- `ai-proofread.referencePrep.wikipedia.*` — User-Agent 联系 URL、语言、速率限制、会话预算、缓存 TTL
- `ai-proofread.referencePrep.scope.*` — 预筛阈值与 fallbackWiden
- `ai-proofread.referencePrep.rerank.*` — 精排开关与候选上限
- `ai-proofread.referencePrep.bm25.topK` / `vector.*` — 检索通道
- `ai-proofread.referencePrep.grep.maxHitsPerRound` / `maxSnippetChars` — **已弃用**；实际由**检索强度**预设（`strengthPresets`）主导
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

侧栏 **资料检索**：`轮次 → 查询 → 命中项`。支持打开文献文件跳转、**维基条目在浏览器打开**、复制 reference 块、手动 prune/restore。

## 续跑

- 若当前锚点（或工作区最近会话）存在 `.referenceprep.json`，启动时可选择 **继续上次**（默认追加 1 规划轮，保留 corpus）或 **重新开始**
- 选区/检索描述与 `userInput` 不一致时会二次确认；续跑其它文档时使用该过程文件中的 target
- 最近会话列表保存在 workspaceState（最多 10 条）；配置 `referencePrep.continuation.maxRounds` 可调续跑轮次

## 索引依赖

- **BM25**：需先执行「建立引文索引」（`citation-refs.db` + **应用层 BM25 / jieba**；非 FTS5——sql.js 默认未启用 FTS5）
- **向量**：首次启用时懒构建 `reference-vectors.json`；失败时降级为 grep+BM25

## 终止条件

程序 `maxRounds`、查词预算、grep 字符预算、**Wikipedia HTTP 预算**（`.referenceprep.log` 记录 `wiki HTTP=` 与 cache hit/miss）；`sufficient: true` 且 queries 为空可提前结束；精排与混合打分后的阈值 prune。

## 维基百科通道（合规要点）

- 扩展维护者 User-Agent（`referencePrep.wikipedia.userAgentContactUrl`），串行请求，软限速默认 30/min
- 429/503 退避；连续 429 暂停该会话维基检索
- 缓存命中不计入 HTTP 预算；详见 README「维基百科资料来源」
