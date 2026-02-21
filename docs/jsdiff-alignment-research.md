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
