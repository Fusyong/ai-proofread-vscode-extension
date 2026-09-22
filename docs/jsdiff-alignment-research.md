# jsdiff 用于句子/词语对齐的调研报告

## 一、调研目的

评估 jsdiff（npm 包名 `diff`）是否适合替代或改进本项目的**句子对齐**功能。当前对齐句子功能存在一些缺陷，希望调研 jsdiff 能否作为替代方案。

## 二、当前对齐实现概览

### 2.1 架构

- **入口**：`diff it with another file` → 选择「对齐句子生成勘误表」
- **核心模块**：`sentenceAligner.ts`（锚点算法）+ `splitter.ts`（中文分句）+ `alignmentReportGenerator.ts`（HTML 报告）
- **流程**：分句 → 锚点对齐 → 后处理（重匹配、合并、移动检测）→ 生成勘误表 HTML

### 2.2 锚点算法特点

| 特性 | 说明 |
|------|------|
| 相似度 | Jaccard（ngram 或词级，可选 jieba 分词） |
| 匹配方式 | 相似度阈值（默认 0.6），非精确匹配 |
| 输出类型 | MATCH、DELETE、INSERT、MOVEIN、MOVEOUT |
| 1 对多 | 支持相邻 DELETE/INSERT 合并后重新匹配 |
| 移动检测 | 基于 b 侧 id 连续性分组，识别句子移动 |
| 中文分句 | 使用 `splitChineseSentencesWithLineNumbers`（标点、空行、Markdown 等） |

### 2.3 当前 jsdiff 使用情况

项目**已在多处使用 jsdiff**，但仅用于**词语级 diff 展示**：

- `differ.ts`：`jsDiffMarkdown`、`jsDiffJsonFiles`，用 `diffWordsWithSpace` + `Intl.Segmenter('zh', { granularity: 'word' })` 生成 HTML
- `alignmentReportGenerator.ts`：勘误表每行懒加载时，用 `diffWordsWithSpace` / `diffWords` 做句内词级高亮（红删绿增）

## 三、jsdiff API 概览

### 3.1 主要方法

| 方法 | 分词单元 | 适用场景 | 中文支持 |
|------|----------|----------|----------|
| `diffChars` | 字符 | 细粒度比较 | ✓ |
| `diffWords` | 词（空格分隔） | 英文词级 | 可选 `intlSegmenter` |
| `diffWordsWithSpace` | 词+空格 | 保留空格变化 | 可选 `intlSegmenter` |
| `diffLines` | 行（`\n` 分隔） | 代码/文档行级 | ✓ |
| `diffSentences` | 句（`. ` 等分隔） | 英文句级 | 需验证 |

### 3.2 返回值结构

```ts
{ value: string; added?: boolean; removed?: boolean; count?: number }[]
```

- `added`：新增内容
- `removed`：删除内容
- 无标记：未变内容

### 3.3 算法

基于 Myers diff，求最小编辑距离（插入/删除），**不做相似度匹配**，只做**精确字符串比较**。

## 四、jsdiff 能否替代句子对齐？

### 4.1 核心结论：**不能直接替代**

| 维度 | 当前锚点算法 | jsdiff |
|------|--------------|--------|
| 匹配逻辑 | 相似度（Jaccard） | 精确字符串 |
| 同义/改写 | 「他去了北京」↔「他去了首都」可匹配 | 视为不同 |
| 标点差异 | 可配置归一化后比较 | 标点不同即不同 |
| 1 对多 | 支持合并匹配 | 不支持 |
| MOVEIN/MOVEOUT | 有专门检测 | 无 |
| 中文分句 | 专用 `splitChineseSentences` | `diffSentences` 面向英文 |
| 相似度分数 | 有 | 无 |

### 4.2 用 diffLines 做「句级对齐」的可行性

思路：把每个句子当作一行，用 `\n` 拼接后调用 `diffLines`。

```ts
const textA = sentencesA.join('\n');
const textB = sentencesB.join('\n');
const changes = Diff.diffLines(textA, textB);
```

**限制**：

1. **精确匹配**：句子有任何改动（标点、用词）都会变成「删除 + 新增」，无法识别为同一句的修改。
2. **分句一致**：A、B 必须用同一套分句结果；若标点改动导致分句不同，整段都会错位。
3. **无 MOVEIN/MOVEOUT**：只能得到 added/removed，无法区分「删除后插入」与「移动」。

**适用场景**：两版文本几乎相同（如仅改了几个字），且分句完全一致。此时 diffLines 可快速得到句级对应关系，但无法给出「相似度」等元信息。

### 4.3 diffSentences 与中文

`diffSentences` 通常按英文句末标点（`.`、`!`、`?`）分句，对中文的 `。！？` 等支持情况需实测。即便支持，仍面临与 diffLines 相同的问题：**精确匹配**，无法处理同义改写和轻微修改。

## 五、jsdiff 可改进的方面

### 5.1 已在使用：句内词级 diff

勘误表中，每对 (原文, 校对后) 已用 `diffWordsWithSpace` + `Intl.Segmenter` 做词级高亮，效果良好，可继续沿用。

### 5.2 可尝试：混合策略（快速路径）

对「两版几乎相同」的文档，可增加一条快速路径：

1. 用 `diffLines` 做初对齐；
2. 若 added/removed 比例低于某阈值，直接采用该结果；
3. 否则回退到锚点算法。

可减少锚点算法在简单场景下的计算量，但实现和调参成本需权衡。

### 5.3 不建议：用 jsdiff 做句子对齐主算法

用 jsdiff 完全替代锚点算法会丢失：

- 相似度匹配
- MOVEIN/MOVEOUT
- 1 对多合并
- 相似度分数（用于筛选、排序）

这些对勘误表制作都很重要。

## 六、当前对齐功能的可能缺陷（与 jsdiff 无关）

README 和代码中提到的相关问题：

1. **VS Code diff 编辑器**：长文本段落无法对齐，需加空行辅助（这是 diff 编辑器的问题，不是句子对齐算法）。
2. **锚点算法本身**：窗口大小、相似度阈值、分句差异等会影响对齐质量，需通过参数和分句逻辑优化，而非换用 jsdiff。

## 七、建议

1. **句子对齐主算法**：继续使用锚点算法，不改为 jsdiff。
2. **句内 diff 展示**：保持现有 `diffWordsWithSpace` + `Intl.Segmenter` 方案。
3. **可选优化**：在「两版高度相似」的场景下，可试验 `diffLines` 作为快速路径，但需明确触发条件和回退逻辑。
4. **改进方向**：针对锚点算法的缺陷，可考虑：
   - 调整 `windowSize`、`similarityThreshold`、`consecutiveFailThreshold` 等参数；
   - 优化分句逻辑（标点、空行、Markdown）；
   - 引入其他相似度算法（如编辑距离、fastest-levenshtein）作为辅助或替代 Jaccard。

## 八、diffLines 实测（a-sentences.md vs b-sentences.md）

### 8.1 测试条件

- 文件：`test/a-sentences.md`（24560 行）、`test/b-sentences.md`（25810 行），每句一行
- 预处理：统一换行符（CRLF→LF），否则 0% 匹配
- 脚本：`test/diffLines-test.mjs`，运行 `node test/diffLines-test.mjs [--full]`

### 8.2 完整文件结果

| 指标 | 数值 |
|------|------|
| 完全匹配（unchanged） | 21907 行 |
| 仅 A 有（removed） | 2652 行 |
| 仅 B 有（added） | 3903 行 |
| 对齐率（以 A 为基准） | 89.2% |
| 对齐率（以 B 为基准） | 84.9% |

### 8.3 能对齐的行

- **完全一致**的句子：标点、空格、用词均相同
- 空行、标题（如「内容简介」「# 目  录」）等未改动部分
- 正文中未修改的句子

### 8.4 不能对齐的行（典型原因）

| 类型 | 示例 | 说明 |
|------|------|------|
| 空格/格式差异 | A: `社  址` / B: `社址`；A: `渊源关 系` / B: `渊源关系` | 空格数量、全角/半角不同 |
| 标点/断行 | A: `cnhttp://www.` / B: `cn http://www.` | 标点或空格导致分句不同 |
| 内容增删 | A: `你等等我。` / B: `NANSONG JINGXUE SHI` | 顺序不同或一方有、一方无 |
| 用词改写 | A: `进行分析` / B: `进行 分析` | 仅空格差异，但 diffLines 视为不同 |

### 8.5 结论

diffLines 对**完全一致**的句子能正确对齐，但任何**细微差异**（空格、标点、格式）都会导致无法匹配。校对场景下常见空格、标点调整，因此约 10% 的句子无法对齐。若需容忍这些差异，应使用锚点算法等基于相似度的匹配。

## 九、参考资料

- [jsdiff GitHub](https://github.com/kpdecker/jsdiff)
- [diff - npm](https://www.npmjs.com/package/diff)
- 项目内：`src/sentenceAligner.ts`、`src/alignmentReportGenerator.ts`、`src/differ.ts`
- 对比实验：`src/jsdiffAlignmentCompare.test.ts`

## 十、补充实验（2026-03）：词流观感 vs 句级对齐 vs 段→句

测试文件：`src/jsdiffAlignmentCompare.test.ts`  
运行：`npx vitest run src/jsdiffAlignmentCompare.test.ts`

### 10.1 你感觉「长篇中文很好用」时，jsdiff 在做什么？

**不是按句/按段对齐。** 扩展里「生成 jsDiff 结果文件」调用的是：

```ts
Diff.diffWordsWithSpace(a, b, new Intl.Segmenter('zh', { granularity: 'word' }))
```

即把**整篇**切成中文词 token，再跑 Myers 最长公共子序列。未改动的词连成黑色连续流，改动处红删绿增——观感像「整篇对齐」，本质是**词流 LCS**，不是句子配对，也不是「把一段当一句」。

因此：

| 体验 | 原因 |
|------|------|
| 长文微调看起来很好 | 大部分词 token 公共，unchanged 比例高 |
| 勘误表需要「第 i 句 ↔ 第 j 句」 | 词流**不提供**句索引 / 行号 / MATCH 行 |
| 大段调序 | 词流仍可能「大部分字没变」，但句级序列 diff 会变成删+增 |

### 10.2 「先对齐段落，再拆句」可行吗？

**可行，且对 PDF 碎片稿值得做预处理**，但要注意边界：

1. **预处理**：`formatParagraphs`（合并硬换行）能改善分句边界；但若合并后仍留空格差异，**精确** `diffArrays` 仍可能 0 匹配，需配合空白归一化或相似度门槛。
2. **段级 exact**：段内任意改动 → 整段 removed+added，再在段内做句级 diff（本实验 `hierarchical-exact`）。
3. **段级 similar**：用 Jaccard 决定是否进入段内句对齐；**段内大插入**会严重拉低段相似度，出现「整段放弃、全部删增」（见「插入」用例的 `hierarchical-similar`）。
4. 推荐形态：**formatParagraphs → 段级 diffArrays → 配对段内用「相似门槛的句对齐」（或直接锚点）**，而不是裸 adjacent 硬配。

### 10.3 边界用例实测摘要（match / del+ins / lowSim）

| 场景 | 词流 unchanged | anchor | jsdiff-exact | pair-adjacent | pair-similar(≥0.6) | 要点 |
|------|----------------|--------|--------------|---------------|-------------------|------|
| 微调 | ~57% | m3 | m2 | m4 | m3 | exact 把改写句拆成删+增；adjacent 多配 1 对 |
| 仅空白 | ~83% | m2 | **m0** | m2 | m2 | exact 完全挂；锚点/相似配对正常 |
| 同义改写 | ~50% | m1 | m1 | m2(**lowSim1**) | m1 | adjacent 硬配无关改写（sim≈0.19） |
| 无关句替换 | ~35% | m1 | m1 | m2(**lowSim1**) | m1 | 「苹果↔量子」被 adjacent 误配（sim≈0.07） |
| 句子调序 | ~59% | **move=4** | del+ins | del+ins | del+ins | 仅锚点标 MOVE；jsdiff 无移动语义 |
| 段中插入 | ~37% | m2/ins1 | 同左 | 同左 | 同左 | 句级序列 diff 此处表现正常 |
| PDF 碎行 | ~84% | m3 | **m0** | m3 | m3 | 分句边界不一致时 exact 崩；相似/锚点仍可配 |

### 10.4 结论（更新）

1. **词流好用 ≠ 句对齐好用**；二者解决不同问题。勘误表仍需要句级配对算法。
2. **jsdiff 句级 exact** 适合「几乎逐字相同」；空白/标点/分句不一致即失效。
3. **adjacent 配对必须加相似度门槛**，否则编辑场景会误配。
4. **段→句分层**值得作为可选路径，但段相似门槛与段内大插入是已知边界；PDF 应先 `formatParagraphs`。
5. **移动检测、1 对多**仍是锚点算法优势；jsdiff 路径做可选「精确/近精确」模式即可。

## 十一、词流反解句对（已落地）

**配置**

- `ai-proofread.alignment.algorithm`：`anchor`（默认）| `wordDiff`
- `ai-proofread.alignment.wordDiffFallbackToAnchor`：默认 `true`（句袋相同但顺序不同，或同句既删又增时回退锚点）

**入口**：生成勘误表时 QuickPick 可选算法；`alignDocuments()`（`src/documentAligner.ts`）统一分发。

**实现**

- `src/wordDiffSentenceProjection.ts` — 词流投影 + 相似门槛拆删增
- `src/documentAligner.ts` — 算法分发与调序回退
- `src/alignmentUi.ts` — 算法选择 UI

**适用**：长文小改、空白/微调；大段调序自动回退锚点。

## 十二、碎句防护与缺口精炼（已落地）

针对分句误切（`.md` / `I.V.`）、头尾包含按短侧抢配、以及一对多标点错位缺口，在**锚点主算法**上收敛为三处改动（**不以整篇词流替代主循环**）。

### 12.1 分句防碎

- `splitChineseSentencesSimple`：英文 `.` 后为常见扩展名、或 `I.V.` 类缩写点号时不切
- 切完后按 `minSentenceChars`（默认 8）合并过短碎片；不以 `。！？…` 结尾的碎片才并（完整短中文句保留）；不跨 Markdown 标题边界
- 配置：`ai-proofread.alignment.minSentenceChars`

### 12.2 头尾包含分母改为较长侧

- `endContainmentScore`：`min(lenA, lenB, prefix+suffix) / max(lenA, lenB)`
- 短半截不再轻易以 ≈0.5 抢锁长参考文献句

### 12.3 缺口精炼（替换多句合并类后处理）

流水线：

```text
主循环 → 相邻/不相邻 1:1 rematch → refineAlignmentGaps（双侧缺口 → 邻接并入）→ movements
```

- 模块：`src/alignmentGapRefine.ts`
- 双侧连续 delete/insert 拼接后 `diffWordsWithSpace` + `Intl.Segmenter('zh')`，`equalRatio ≥ gapEqualRatio`（默认 0.55）收成一条 MATCH
- **邻接并入**：双侧缺口之后，将紧邻 MATCH 的 DELETE/INSERT 自近及远试并入（`absorbUnmatchedIntoMatches`）；仅当词流 equalRatio **严格高于**原相似度才吸收。覆盖「对侧无 INSERT 的 N:1 半截抢配」（旧 `mergeDeleteIntoMatch` / `mergeInsertIntoMatch`）
- 真替换（equalRatio 低 / 并入不升分）保持删/增
- 配置：`ai-proofread.alignment.gapEqualRatio`
