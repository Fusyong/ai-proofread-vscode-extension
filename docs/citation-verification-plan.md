# Markdown 引文核对功能 — 详细开发计划

本文档为 AI Proofreader 扩展的「引文核对」功能提供调研结论、可行性评估和分阶段开发计划。

**已定技术决策**：使用 **sql.js**；首版侧栏用 **TreeView**；引文收集首版仅做 Markdown 的引号与 `>`，**预留扩展能力**（如 LaTeX、其他格式）。

---

## 一、需求与目标回顾

1. **参考文献管理**：用户提供参考文献目录（如 `test/references`，可在工作区外），内含 Markdown/纯文本；可选同路径同名 PDF。对文献做预处理（可选分句）、SQLite 索引与文件监控。
2. **工作面板**：排除不需要的文献；收集当前文档中的引文条目，支持多维度排序/过滤、跳转到文档位置。
3. **引文收集**：从文档中收集引文并记录位置（回溯用）：引号内文本、`>` 缩进块；并标记「可能非引文」（如 4 字以下等）。
4. **相似度匹配**：用高速相似度算法与非阻塞策略在参考文献中找近似片段，支持多条候选；用 **VSCode 内置 diff 编辑器**展示引文与文献原文的异同（临时文件 + `differ.showDiff`）。
5. **其他**：打开文献 PDF 并跳转到对应文字（扩展内已有 `searchSelectionInPDF`）。

---

## 二、对现有想法的评估与建议

### 2.1 参考文献路径（工作区外）

- **可行性**：可行。VSCode 扩展可读写任意绝对路径（Node `fs`/`path`），需在设置中明确为「参考文献根路径」。
- **建议**：
  - 配置项命名如 `ai-proofread.citation.referencesPath`，支持 `${workspaceFolder}` 或绝对路径。
  - 若路径在工作区外，首次使用可提示用户确认；大文献库时考虑「仅扫描指定扩展名」以加快启动。

### 2.2 SQLite 预处理与分句

- **可行性**：SQLite 适合做结构化存储与查询；分句可复用现有 `splitChineseSentencesWithLineNumbers`。
- **注意**：
  - **SQLite FTS5 与中文**：**不用 FTS，只在 SQLite 中存「句子 + 元数据」，在应用层做相似度搜索**。
- **建议（优先）**：  
  - 文献预处理：解析 Markdown/文本 → **按句切分**（复用 `splitter`）→ 每句写入 SQLite 表（如 `reference_sentences(id, file_path, paragraph_idx, sentence_idx, content, normalized, len_norm, ...)`），`normalized` 为去标点/空白，`len_norm = length(normalized)` 用于长度过滤。  
  - **不做** FTS5 全文检索，而是：  
    - 对当前文档收集到的每条「引文句」先用 **len_norm 区间** 从 SQLite 筛候选，再在内存/Worker 中用 **n-gram 或 fuzzy 相似度**（仅比较 normalized）做比对。  
  这样无需 ICU 扩展，跨平台简单；n-gram 思路与现有 `sentenceAligner` 一致，归一化使用 2.10.5 的**统一函数**（与对齐共用）。

### 2.3 文件监控

- **可行性**：可行。使用 `vscode.workspace.createFileSystemWatcher` 时，若路径在工作区外，需用 `vscode.uri.file(absPath)` 创建 watcher；部分环境下对非工作区路径的监控可能有限制，需实测。
- **建议**：监控「参考文献根路径」下的 `.md`/`.txt` 变更（及可选 `.pdf` 仅做存在性检查）；变更时标记「索引脏」，在用户下次打开面板或点击「刷新」时重新预处理并更新 SQLite。

### 2.4 工作面板（排除文献、收集引文、排序过滤、跳转）

- **可行性**：可行。VSCode 提供 TreeView（侧边栏树形）和 WebviewView（侧边栏内嵌 HTML）。
- **建议**：
  - **折中**：主列表用 TreeView，「引文 ↔ 文献 diff」用 **VSCode 内置 diff 编辑器**（临时文件 + `vscode.diff`，与 `differ.showDiff` 一致），无需 Webview。

### 2.5 引文收集：引号内、`>` 块

- **可行性**：可行。用正则或基于状态的解析即可。
- **建议**：
  - **引号**：匹配中文 `「」`、`『』`、`“”`、`‘’` 等；注意嵌套（如「……『……』……」）取最外层）。正则示例：`/[「『]([^」』]*)[」』]|[“‘]([^"']*)[”’]/g`，需根据实际排版约定微调。
  - **块引用 `>`**：按行解析，连续以 `>` 开头的行合并为一块，去掉前导 `>` 和空格后作为一条「引文」；可记录起始行号与内容，便于跳转。
  - **位置信息**：每条引文保存 `(uri, startLine, endLine, startOffset?, endOffset?)`，便于 `TextEditor.revealRange` 和打开时选中。

### 2.6 标记「可能不是引文」的规则

- **4 字以下**：合理，可配置阈值（如 4/6/8 字符）。
- **其他建议**：
  - 纯数字或绝大部分为数字/标点。
  - 纯英文且长度极短（如 1–2 个单词），且不在「英文文献引用」场景下。
  - 以常见非引文前缀开头（如「第」「图」「表」「注：」等），可配置排除列表。
  - 与某条「参考文献标题」高度重合的短句（可能是书名/篇名而非正文引文），可标为「疑似标题」由用户确认。
  - 引文所在句子的末尾（引号后或句末标点前或后）有带圈数字①②等、[^...]等标记时确信为引文。
- 实现上：在「引文收集」阶段给每条打上 `confidence: 'citation' | 'maybe' | 'likely_not'` 及原因，便于面板中过滤和排序。

### 2.7 相似度算法与搜索策略

- **可行性**：现有 `sentenceAligner` 已有基于 n-gram 的 Jaccard 相似度，可直接复用或抽成公共函数；长文本可先按句/段切分再匹配。
- **建议**：
  - **算法**：  
    - 与现有一致：**Jaccard n-gram**（如 bigram）适合中长句，对错别字、少量增删有一定容忍度。  
    - 若需更强容错：可引入 **fast-fuzzy**（Levenshtein 系）做「单条引文 vs 多条候选」的排序；或先用 n-gram 粗筛，再用 Levenshtein 精排 Top-K。
  - **搜索策略**：  
    - 从 SQLite 按文献/按段落批量读出候选句（或先按「文献 ID」分片），在 Worker 或 `setImmediate` 分片中做相似度计算，避免主线程卡顿。  
    - 非阻塞：用 `vscode.window.withProgress` + 可取消的 Promise；大批量时用 Web Worker 或 `setImmediate` 分批处理，进度条显示「已比对 m/n 条」。
  - **结果**：每条引文保留 Top-K（如 3–5）条候选，每条带相似度分数与来源（文件 + 行号/段落号），供 diff 展示。

### 2.8 引文 ↔ 文献 diff 展示

- **可行性**：扩展已在 `differ.ts` 中提供 `showDiff(context, originalText, proofreadText, fileExt)`：将两段文本写入临时文件后调用 `vscode.diff`，打开 **VSCode 内置 diff 编辑器**（与「校对选段」后的 diff 一致）。
- **建议**：**优先使用内置 diff 编辑器**。在「引文–匹配结果」中提供「查看 diff」时，直接调用 `showDiff(context, citationText, referenceText, '.md')`，左为当前文档中的引文（句/块），右为文献中的匹配句/段；无需自建 HTML，风格与编辑器一致，且支持内置的 word-level 高亮与可访问性。若后续需要更定制的中文分词级 diff（如勘误表式的表格），再保留 jsdiff HTML 作为可选。

### 2.9 打开 PDF 并定位

- **可行性**：已有 `searchSelectionInPDF`（SumatraPDF），只需确定「文献 PDF」路径约定（如与 md 同路径同名 `.pdf`）。
- **建议**：在引文面板中，当某条匹配来自某文献且该文献有同名 PDF 时，提供「在 PDF 中搜索该段文字」按钮，调用现有逻辑或封装成「给定文献路径 + 选中文本」的通用方法。

---

## 2.10 引文分句作为核对单元、长度过滤、标点与布隆过滤（补充设计）

### 2.10.1 引文与文献均分句后作为核对单元

- **结论**：**建议采用**。引文块和文献内容都按句切分后，以「句」为核对单元，整体会更快、更稳。
- **更快的原因**：
  1. **长度过滤**：引文错误多为个别字词，正确匹配句的长度与当前句应接近。在 SQLite 中为每条文献句存储 `length(normalized)`（或 `len_norm`），查询时用 `WHERE len_norm BETWEEN citation_len - k AND citation_len + k`（k 可配置，如 5 或 10%）先筛候选，再做相似度，可大幅减少比对次数。
  2. **有序匹配**：一条引文块若对应文献中连续多句，可按顺序「第 1 句对第 1 句、第 2 句对第 2 句」在候选空间内做局部搜索，避免整块与全文暴力比对。
  3. **粒度一致**：文献侧已按句入库，引文侧也按句拆开，相似度在「句对句」上做，与 `sentenceAligner` 的 n-gram 设计一致，便于复用与调参。
- **实现要点**：
  - **文献侧**：预处理时用 `splitChineseSentencesWithLineNumbers` 分句，每句一行记录，字段含 `content`、`normalized`、`len_norm`（归一化后长度）、`file_path`、`paragraph_idx`、`sentence_idx`。
  - **引文侧**：收集到引文块（引号内或 `>` 块）后，对块内文本用**同一套分句逻辑**再切一次，得到多条「引文句」；每条引文句带其在文档中的位置（起止行/偏移），便于跳转与 diff。匹配时以「引文句」为单位在文献句中找 Top-K。

### 2.10.2 利用长度信息

- **结论**：**建议使用**。
- **存储**：SQLite 表增加 `len_norm INT`（或 `length_norm`），写入时 `length(normalized)`。
- **查询**：对每条引文句，先算其 `len_norm`，再从 SQLite 查 `WHERE len_norm BETWEEN citation_len_norm - delta AND citation_len_norm + delta`。`delta` 可配置（如固定 10 字，或按长度比例 10%），兼顾错别字、漏字、多字。
- **效果**：文献句数量较大时，可先排除长度相差过大的句子，再做 Jaccard/fuzzy，显著减少相似度计算次数。

### 2.10.3 引文改动原文标点导致分句变化、相似度计算

- **现象**：用户修改标点（如句号改叹号、加逗号）会改变分句结果，同一段引文可能从「1 句」变成「2 句」或反之，影响核对单元划分。
- **相似度计算**：**一律在归一化文本上做**。定义 `normalized` 为按 2.10.5 **统一归一化函数**处理后的版本，相似度只比较 `normalized`。若配置为去掉标点，则「张三说，你好。」与文献「张三说你好」会匹配（标点差异不进入相似度）；默认保留标点时，标点参与比较。分句边界仍只受「当前文档内容」影响。
- **分句边界随文档走**：不持久化「上次的引文句边界」；每次刷新/重新收集时，都用**当前文档内容**重新做「引文收集 + 引文块内分句」。这样用户改标点后，下次刷新就按新标点重新分句，无需额外逻辑。若一条引文块从 1 句变成 2 句，就变成 2 个核对单元，各自去文献里找最佳匹配即可。
- **实现**：文献句的 `normalized` 写入时、引文句在匹配前，均使用**统一归一化函数**（2.10.5，与对齐共用）；用 `normalized` 做长度过滤与 Jaccard/fuzzy。

### 2.10.4 布隆过滤（Bloom filter）是否有意义

- **结论**：**首版可不实现，但预留接口**；在文献库很大（如十万级句子）时再考虑接入。
- **用途简述**：布隆过滤器可快速回答「这个字符串**一定不在**集合里」（无漏报，有少量误报）。用于引文核对时，可对「归一化后的文献句集合」建 Bloom，对每条引文句的 `normalized` 先问 Bloom；若 Bloom 说「不在」，则无需做相似度（可直接标为「未找到精确/高相似匹配」或只做轻量 fuzzy）；若 Bloom 说「可能在」，再走长度过滤 + 相似度。
- **何时有意义**：
  - **精确匹配**：若只关心「是否有一模一样的文献句」，用 `Set<normalized>` 即可，不必上 Bloom。
  - **大规模候选**：当文献句数量很大（例如 10 万+），且希望**在未命中时快速跳过**相似度计算，Bloom 可减少大量无效比对；此时 Bloom 里可存「所有 normalized 的 hash」或「n-gram 集合的 hash」。
- **建议**：首版只做「长度过滤 + 相似度」；在 `citationMatcher` 里设计一个 **可插拔的候选过滤接口**（例如 `preFilter(citationNormalized, citationLenNorm) => refSentenceIds[]` 或先返回候选列表再由上层过滤），后续若要加 Bloom，只需实现该接口：先 Bloom 过滤再按长度筛。这样既不增加首版复杂度，又保留扩展能力。

### 2.10.5 归一化规则（统一函数，对齐与引文共用）

文稿与文献中常含对核对意义不大的字符（如 PDF 导出产生的句内分行、多余空白、标点、数字、拉丁字符）。**归一化**（用于相似度与长度过滤）采用**同一套函数**，**对齐功能**（勘误表等）与**引文核对**共用，规则如下：

| 项目                    | 规则                                                                       |
| ----------------------- | -------------------------------------------------------------------------- |
| **前后空白**            | 去掉                                                                       |
| **句中空白 / 句内分行** | **默认**去掉（可配置保留）                                                 |
| **标点**                | **默认**保留（可配置去掉）                                                 |
| **阿拉伯数字（包括带圈数字）**          | **默认**保留（引文核对功能中默认配置为去掉） |
| **拉丁字符**            | **默认**保留（引文核对功能中默认配置为去掉） |
| **Markdown注码和上标注码**|**默认**保留（引文核对功能中默认配置为去掉）|

**配置**：句中空白由对齐配置 `removeInnerWhitespace` 控制（默认去掉）。标点共用 `ai-proofread.citation.normalizeIgnorePunctuation`（默认 `false`，即保留）。数字与拉丁**按功能区分**：**句子对齐**使用 `ai-proofread.alignment.normalizeIgnoreDigits` / `normalizeIgnoreLatin`（默认 `false`，即保留）；**引文核对**使用 `ai-proofread.citation.normalizeIgnoreDigits` / `normalizeIgnoreLatin`（默认 `true`，即去掉）。

**适用范围**：上述规则同时用于 (1) 对齐功能（sentenceAligner）的相似度计算；(2) 引文核对的文献预处理写入 SQLite 的 `normalized` 与 `len_norm`；(3) 引文句在匹配前的现场归一化。对齐与引文共用同一归一化函数，保证行为一致。

**实现**：提供**统一归一化函数**（如 `similarity.ts` 的 `normalizeForSimilarity(text, options)`），内部顺序：trim → 可选去句中空白（默认去）→ 按配置去标点（默认不去）→ 按配置去数字 → 按配置去拉丁字符。分句仍在**原始文本**上做，归一化只作用于「分句后的句子文本」用于比对与长度计算。**对齐**调用时从 `ai-proofread.alignment` 读取数字/拉丁（默认保留）；**引文核对**调用时从 `ai-proofread.citation` 读取数字/拉丁（默认去掉）。

---

## 三、技术选型小结

| 项目          | 建议选型                                                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite 实现   | **sql.js**（纯 JS，无 native 依赖）                                                                                                           |
| 文献存储      | SQLite 表存「文件路径 + 句 + content + normalized + len_norm」，句为最小单元                                                                  |
| 核对单元      | **引文与文献均分句**；以「句」为核对单元，利用长度过滤加速                                                                                    |
| 分句          | 复用 `splitter.splitChineseSentencesWithLineNumbers`（文献与引文块内均用）                                                                    |
| 相似度        | 仅在 **归一化文本**上计算：统一归一化函数（前后空白去掉；句中空白默认去掉、可配置保留；标点/数字/拉丁默认保留、均可配置去掉）；对齐与引文共用 |
| 长度过滤      | SQLite 存 `len_norm`；查询时 `WHERE len_norm BETWEEN c - delta AND c + delta` 缩小候选                                                        |
| 标点/分句漂移 | 每次刷新按当前文档重新收集+分句，不持久化句边界；相似度用 normalized 不受标点影响                                                             |
| 布隆过滤      | 首版不实现；**预留候选过滤接口**，便于后续对超大文献库接入 Bloom                                                                              |
| 文件监控      | `vscode.workspace.createFileSystemWatcher`（工作区外路径用 `uri.file`）                                                                       |
| 侧边栏列表    | **TreeView**（文献树 + 引文列表）；首版不做 WebviewView                                                                                       |
| 引文收集      | 首版：正则/行解析 **引号 + `>` 块**；预留扩展点（如 LaTeX）                                                                                   |
| Diff 展示     | **VSCode 内置 diff 编辑器**：`differ.showDiff(context, 引文文本, 文献文本, '.md')`，临时文件 + `vscode.diff`；可选保留 jsdiff HTML            |
| PDF 跳转      | 复用 `pdfSearcher.searchSelectionInPDF`，扩展为「指定文献路径 + 文本」                                                                        |

---

## 四、分阶段开发计划

### 阶段 0：准备（约 0.5–1 天）

- 在 `package.json` 中增加「引文核对」相关配置项占位与命令占位；包含 **归一化** 配置：`normalizeIgnorePunctuation`、`normalizeIgnoreDigits`、`normalizeIgnoreLatin`（均默认 `false`，即标点/数字/拉丁默认保留）。
- 新建模块目录，例如 `src/citation/`，并约定与现有 `commands`、`utils`、`splitter`、`differ` 的依赖关系。
- 实现**统一归一化函数**（如 `normalizeForSimilarity(text, options)`）：前后空白去掉；句中空白默认去掉（可配置保留）；标点/数字/拉丁默认保留（均可配置去掉）。对齐与引文共用该函数。
- 若引入 `fast-fuzzy`，在本阶段加入依赖并做一次简单比对测试（与现有 Jaccard 对比）。

### 阶段 1：参考文献预处理与 SQLite（约 2–3 天）

1. **配置**：`ai-proofread.citation.referencesPath`（支持变量与绝对路径）。
2. **SQLite**：使用 **sql.js**；数据库文件放在 `context.globalStorageUri` 下（如 `citation-refs.db`）。
3. **文献扫描**：递归扫描该路径下 `.md`/`.txt`，列出文件列表；可选：同路径同名 `.pdf` 仅记录路径，供后续「在 PDF 中搜索」使用。
4. **解析与分句**：  
   - 按文件读取内容，用 `splitChineseSentencesWithLineNumbers` 分句（或先按空行分段再对每段分句）；  
   - **归一化**：对每句使用**统一归一化函数**（2.10.5）——前后空白去掉；句中空白默认去掉（可配置保留）；标点/数字/拉丁默认保留（可配置去掉），得到 `normalized`；  
   - 写入 SQLite：表结构 `reference_sentences(id, file_path, paragraph_idx, sentence_idx, content, normalized, len_norm, created_at)`，其中 `len_norm = length(normalized)`，用于长度过滤。
5. **文件监控**：对 `referencesPath` 下的 `.md`/`.txt` 创建 FileSystemWatcher，变更时写「脏」标记；提供「重新构建索引」命令/按钮。

### 阶段 2：引文收集与位置回溯（约 2 天）

1. **引号内文本**：实现 `collectQuotedCitations(document: TextDocument): CitationEntry[]`，支持常见中英文引号，返回 `{ text, startLine, endLine, range, type: 'quote' }`。**预留**：接口或配置支持扩展（如 LaTeX 引文）。
2. **`>` 块**：实现 `collectBlockquoteCitations(document: TextDocument): CitationEntry[]`，连续 `>` 行合并，记录起止行与内容。
3. **合并**：`collectAllCitations(document)` 合并两类，并统一生成 `CitationEntry { uri, text, startLine, endLine, range?, type, confidence?, reason? }`（块级）。
4. **引文块内分句**：对每条引文块的 `text` 用 **同一套** `splitChineseSentencesWithLineNumbers`（或同规则的简单分句）切分为多句；对每句用**统一归一化**（2.10.5）得到 `normalized` 与 `lenNorm`；得到 `CitationSentence { blockId, sentenceIndex, text, normalized, lenNorm, startLine, endLine, range? }`，用于匹配与 diff。块级信息保留，便于 UI 跳转到整块。
5. **「可能非引文」标记**：在收集阶段或后处理中，对每条**块**应用规则（长度、数字、排除前缀等），写入 `confidence` 与 `reason`。
6. **单元测试**：用 2–3 个示例 md 文件覆盖引号嵌套、多块引用、边界情况。

### 阶段 3：相似度匹配与非阻塞执行（约 2–3 天）

1. **相似度**：抽出 `sentenceAligner` 中的 n-gram/Jaccard 为独立工具（如 `similarity.ts`）；归一化使用**统一归一化函数**（2.10.5，与对齐共用），**仅在 normalized 文本上**计算相似度；可选：对单条引文句用 fast-fuzzy 对候选精排。
2. **长度过滤**：对每条引文句，用 `len_norm` 从 SQLite 查 `WHERE len_norm BETWEEN citation_len_norm - delta AND citation_len_norm + delta`（`delta` 可配置），得到候选文献句后再做相似度。
3. **候选过滤接口**：抽象一层「候选获取」（如 `getCandidates(citationNormalized, citationLenNorm): Promise<RefSentence[]>`），首版实现为「SQL 按 len_norm 过滤」；**预留**在内部或上层接入布隆过滤等逻辑，不改变调用方。
4. **查询流程**：对当前文档的每条**引文句**（见阶段 2），先长度过滤取候选，再在 Worker 或分批 `setImmediate` 中计算相似度，取 Top-K（如 5）条候选；块级结果可聚合（如「该块内各句的最佳匹配」）。
5. **非阻塞**：`withProgress` + 可取消 Token；大批量时每 N 条 yield 一次，更新进度。
6. **结果结构**：`MatchResult { citationBlock, citationSentences: { sentence, matches: { refSentence, filePath, paragraphIdx, score }[] }[] }`（或等价），供面板与 diff 使用。

### 阶段 4：工作面板（TreeView + 基础交互）（约 2–3 天）

1. **视图注册**：在 `package.json` 的 `contributes.views` 中注册「引文核对」视图（如放在 `explorer` 或单独容器）。
2. **TreeDataProvider**：  
   - 第一层：当前文档的引文列表（显示短摘要、行号、confidence 图标）。  
   - 第二层（或平铺）：每条引文下展示 Top-K 匹配结果（文献名 + 相似度）。
3. **交互**：  
   - 点击引文 → 打开文档并 `revealRange` 选中该引文；  
   - 点击某条匹配 → 打开对应文献文件并定位到该句/段（若需 diff，见阶段 5）。
4. **过滤/排序**：在 TreeView 上方或通过 context 提供「仅显示未匹配/低置信度」「按相似度排序」等（由 data provider 过滤排序后刷新）。

### 阶段 5：Diff 展示与 PDF 跳转（约 1–2 天）

1. **Diff**：在「引文–匹配结果」中增加「查看 diff」：调用 **`differ.showDiff(context, citationText, referenceText, '.md')`**，用 VSCode 内置 diff 编辑器展示引文句/块与文献匹配句；与校对选段后的 diff 体验一致。可选：若需勘误表式表格再提供 jsdiff HTML。
2. **PDF**：若匹配结果来自某文献且存在同名 `.pdf`，在面板中提供「在 PDF 中搜索」；封装 `pdfSearcher` 为「给定文献根路径 + 文件名 + 要搜索的文本」，调用 SumatraPDF。
3. **文献排除**：在设置或面板中维护「排除的文献列表」（如文件名或路径列表），扫描与匹配时跳过这些文件；排除列表可存 `workspaceState` 或配置项。

### 阶段 6：打磨与文档（约 1 天）

- 错误处理：路径不存在、SQLite 不可用、无参考文献等提示。
- 配置项说明与 README 中「引文核对」小节。
- 可选：国际化（中英文字符串）。

---

## 五、文件与模块结构建议

```
src/
  citation/
    index.ts              # 对外导出
    referenceStore.ts     # 文献扫描、分句、SQLite 读写
    citationCollector.ts   # 引文收集（引号、块引用）
    citationMatcher.ts     # 相似度匹配、Top-K、非阻塞
    citationTreeProvider.ts # TreeView DataProvider
    citationView.ts        # 视图注册、命令绑定
  commands/
    citationCommandHandler.ts  # 命令入口（打开面板、刷新索引等）
```

- `referenceStore` 依赖 `splitter`、`path`、`fs`、**sql.js**（纯 JS，无 native 依赖）。
- `citationMatcher` 依赖 `sentenceAligner` 中抽出的 **Jaccard/n-gram 相似度**（或独立 `similarity.ts`）；**归一化**使用与对齐功能共用的**统一归一化函数**（2.10.5）。通过「候选获取」接口使用 `referenceStore` 的按 `len_norm` 查询，并预留布隆等过滤扩展。
- `citationView` 依赖 `citationTreeProvider`、`citationMatcher`、`differ`、`pdfSearcher`。

---

## 六、风险与缓解

| 风险                        | 缓解                                                                         |
| --------------------------- | ---------------------------------------------------------------------------- |
| 工作区外路径监控不可靠      | 提供「手动刷新索引」；文档说明推荐把文献放在工作区内子目录                   |
| sql.js 内存与性能           | sql.js 将 DB 载入内存；大文献库时注意体积；可选「仅索引最近修改的 N 个文件」 |
| 大文献库导致首次索引慢      | 进度条 + 可取消；长度过滤 + 预留布隆接口以利后续优化                         |
| 引号/块引用格式因出版社不同 | 配置化：允许用户自定义引号正则或「块引用」行前缀；首版仅 Markdown，预留扩展  |

---

## 七、后续可扩展点

- 支持 LaTeX `\cite`、`\begin{quote}` 等更多格式的引文收集（首版已预留接口/配置）。
- 导出「引文–文献对应表」为 CSV/Excel，便于审校记录。
- 与现有「校对」流程结合：如将「未匹配或低相似度」的引文列为待人工复核项。
- **布隆过滤**：文献句数量极大（如 10 万+）时，在「候选获取」层接入 Bloom，对 normalized 或 n-gram 做快速排除，再走长度 + 相似度。
- **文献库索引存放位置**：见下节。

---

## 七.1 文献数据库存放位置与索引策略（已实现）

**当前实现**：

1. **存放位置**：索引数据库 **强制**存放在用户指定的文献根目录下，文件名为 `citation-refs.db`（路径 = `参考文献根路径/citation-refs.db`）。未配置文献根时无法打开/创建 DB，会提示用户先配置并执行「重建引文索引」。
2. **不再监控文献变动**：不创建 FileSystemWatcher；更新文献后需用户**手动执行「重建引文索引」**以刷新索引。可在成功提示中说明「更新文献后请手动执行重建引文索引」。
3. **增量索引**：索引时在表 `indexed_files` 中记录每个已索引文件的 `file_path`、`mtime_ms`、`size`。重建时：
   - **仅新文件与变更**（默认选项）：比对当前文件列表与 `indexed_files`，只对新增或 mtime/size 变化的文件重新索引，并删除已不存在的文件对应记录。
   - **全部重新索引**（用户可选）：清空 `indexed_files` 与 `reference_sentences` 后，重新扫描并索引所有文献。
4. **路径变更**：用户修改文献根路径后，`getDbPath()` 随当前根路径计算；若检测到与已打开的 DB 路径不同，先关闭旧 DB 再按新路径打开/创建。

---

以上计划可直接作为迭代开发的依据；建议从阶段 1 和阶段 2 开始实现，再逐步接入面板与匹配逻辑。
