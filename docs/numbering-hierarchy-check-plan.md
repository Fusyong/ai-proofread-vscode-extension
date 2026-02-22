# 标题层级与连续性检查功能 — 开发计划

本文档为 AI Proofreader 扩展的「标题层级与连续性检查」功能提供需求分析、技术方案和分阶段开发计划。

**功能目标**：对文档中的标题树进行解析、校验和可视化，支持多种序号体系，检测层级错乱、同级不连续等问题，并通过 TreeView 展示结果、支持批量操作（标记为 Markdown 标题、升级/降级）。

---

## 一、需求与目标

### 1.1 核心需求

1. **标题层级体系**：建立用户可扩展的标题层级体系，支持字符串和正则表达式配置。
2. **检查机制**：检测层级缺失、层级错乱、同级不连续等问题。
3. **TreeView 展示**：以树形结构展示文档标题树，标注潜在错误，支持同级别批量操作。

### 1.2 序号分类

序号分为两大类，检查策略与操作范围有所不同：

| 类别 | 说明 | 典型场景 | 检查与操作 |
|------|------|----------|------------|
| **标题序号** | 作为标题/章节的序号，通常独占一行或行首 | 第一章、1.1 节、§2、## 一、引言 | 参与层级树构建；支持「标记为 Markdown 标题」「升级/降级」 |
| **文中序号** | 出现在正文、列表、段落中的序号 | 列表项 1. 2. 3.；段落内「（1）（2）」；脚注①②③ | 可单独解析与检查；操作范围与标题序号区分（如仅检查、不参与标题标记） |

- 解析时需区分两类：标题序号通常满足「行首/独立行」等条件；文中序号可能出现在行中、缩进列表、段落内。
- 用户可配置检查范围：仅标题序号、仅文中序号、或两者都检查（分别展示或合并展示）。

### 1.3 序号体系预置

#### 1.3.1 序号类型（数字/字母序列）

| 类型 | 示例 | 说明 |
|------|------|------|
| 中文大写 | 壹贰叁肆伍陆柒捌玖拾 | 常用于正式文书 |
| 中文小写 | 一二三四五六七八九十 | 常用 |
| 阿拉伯数字 | 1 2 3 … 10 11 … | 最常用 |
| 罗马数字大写 | ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ | 章节编号 |
| 罗马数字小写 | ⅰⅱⅲⅳⅴ … | 较少用 |
| 拉丁大写 | A B C … Z AA AB … | 多级编号 |
| 拉丁小写 | a b c … z aa ab … | 多级编号 |

#### 1.3.2 序号标记（前缀/后缀）

| 标记类型 | 示例 | 正则思路 |
|----------|------|----------|
| 第 X 章/节 | 第一章、第一节、第1节 | `第[一二三四五六七八九十百千\d]+[章节条款项]` |
| § 符号 | §1、§ 2、§1.2 | `§\s*\d+(\.\d+)*` |
| 顿号分隔 | 一、二、三、 | `[一二三\d]+、` |
| 点号分隔 | 1. 2. 3. 或 1．2．3． | `\d+[.．]\s*` |
| 括号 | (1) (一) （1） | `[(\（][一二三\d]+[)\）]` |
| 半括号 | ⑴⑵⑶ ①②③ | Unicode 带圈/带括号数字 |
| 自带标记 | ㈠㈡㈢ ⒈⒉⒊ | Unicode 特殊序号 |

#### 1.3.3 自带标记序号（Unicode 范围）

| 范围 | 示例 | 说明 |
|------|------|------|
| ㈠-㉟ | ㈠㈡㈢ | 带括号中文数字 |
| ⒈-⒛ | ⒈⒉⒊ | 带点数字 |
| ⑴-⑳ | ⑴⑵⑶ | 带括号数字 |
| ①-㊿ | ①②③ | 带圈数字 |
| ❶-❿ | ❶❷❸ | 实心带圈数字 |

#### 1.3.4 Markdown 兼容

- **纯文本模式**：按行解析，行首序号即视为该行层级。
- **Markdown 模式**：可选忽略行首 `#`，将 `## 第一章` 与 `第一章` 视为同级；或 `#` 数量参与层级判断（`#` 为 0 级，`##` 为 1 级，再叠加标题层级）。

---

### 1.4 检查规则

| 规则 | 说明 | 严格程度 |
|------|------|----------|
| **层级缺失** | 允许跳过中间层级（如 1 直接到 1.3）；同一父节点下各子分支的「中段缺失」应一致，**各分支尾部的缺失可不同**（如分支 A 到 1.4 结束、分支 B 到 1.3 结束，允许） | 可配置 |
| **层级错乱** | 子级序号不能大于父级（如 2.1 不能出现在 1.2 之前）；同级不能乱序 | 必须 |
| **同级连续性** | 同级序号应连续（1, 2, 3 或 一、二、三），缺失或重复需提示 | 可配置 |
| **跨分支一致性** | 仅针对「中段缺失」：若某分支有 1.1、1.2、1.4（缺 1.3），其他同级分支若有中段缺失也应一致；尾部缺失不要求一致 | 可选 |

---

### 1.5 TreeView 与操作

- **展示**：树形展示文档标题树，每个节点对应一个序号行；可区分标题序号/文中序号；错误节点用图标/颜色标注。
- **操作**（同级别批量，主要针对标题序号）：
  - **标记为 Markdown 标题**：将选中节点对应的行改为 `## 标题` 等形式。
  - **整体升级**：减少 `#` 数量或提升标题层级。
  - **整体降级**：增加 `#` 数量或降低标题层级。
- 文中序号以检查为主，批量操作（如标记为标题）通常不适用。

---

## 二、标题体系（固定预置）

将「序号类型 × 序号标记」的所有合理组合固定为标题体系，检查时先解析、再简化、最后排定层级序号。

### 2.1 序号类型（7 种）

| 代号 | 类型 | 示例 |
|------|------|------|
| cn-up | 中文大写 | 壹贰叁 |
| cn-lo | 中文小写 | 一二三 |
| ar | 阿拉伯数字 | 1 2 3 |
| rm-up | 罗马数字大写 | ⅠⅡⅢ |
| rm-lo | 罗马数字小写 | ⅰⅱⅲ |
| lat-up | 拉丁大写 | A B C |
| lat-lo | 拉丁小写 | a b c |

### 2.2 序号标记（9 种）

| 代号 | 标记 | 示例 |
|------|------|------|
| 第章 | 第 X 章/节/条/款/项 | 第一章、第1节 |
| § | § 符号 | §1、§1.2 |
| 顿 | 顿号 | 一、二、三、 |
| 点 | 点号（含多级） | 1. 2. 3. 或 1.1 1.2 |
| 括 | 括号 | (1) (一) （1） |
| 圈 | 带圈数字 | ①②③ |
| 括数 | 带括号数字 | ⑴⑵⑶ |
| 括中 | 带括号中文 | ㈠㈡㈢ |
| 点数 | 带点数字 | ⒈⒉⒊ |

### 2.3 标题体系全表（序号类型 × 序号标记，合理组合）

以下为预置的**全部**标题层级定义，每行一种「序号类型 + 序号标记」组合，赋予唯一 `slotId`。解析时按此表匹配，未出现的组合不参与。

| slotId | 级别 | 序号类型 | 序号标记 | 示例 | 多级支持 |
| - |--------|----------|----------|------|----------|
| 1 | 1 | cn-up、 cn-lo、rm-up、ar | 第章 | 第壹章、第一章、第Ⅰ章、第1章 | 否 |
| 2 | 1 | ar | § | §1、§1.2 | 是 |
| 3 | 2 | cn-up、 cn-lo、rm-up、ar | 第节 | 第一节、第贰节、第Ⅱ节、第2节 | 否 |
| 4 | 3 | cn-lo | 顿 | 一、二、三、 | 否 |
| 5 | 4 | cn-lo | 括 | (一) (二) | 否 |
| 6 | 4 | — | 括中 | ㈠㈡㈢ | 否 |
| 7 | 5 | ar | 点 | 1. 2. 3. 或 1.1 1.2 | 是 |
| 8 | 5 | — | 点数 | ⒈⒉⒊ | 否 |
| 9 | 6 | ar | 括 | (1) (2) | 否 |
| 10 | 6 | — | 括数 | ⑴⑵⑶ | 否 |
| 11 | 7 | — | 圈 | ①②③ | 否 |
| 12 | 8 | lat-up | 点 | A. B. C. | 否 |

说明：

- 带圈、带括号、带点等「自带标记」序号无独立序号类型，标记即类型。
- 第章、§、顿、点、括 可与多种序号类型组合；表中仅列常用组合，用户可通过 `customLevels` 扩展。
- 「多级支持」指该形式可表达层级（如 1.1、1.1.1），每增加一层，降低一级。

### 2.4 检查流程：解析 → 排定层级 → 构建树

1. **解析**：按标题体系全表逐行匹配，记录每行对应的 `slotId`、`baseLevel` 及在该 slot 内的序号值、多级深度（如有）。
2. **排定层级序号**：`assignedLevel = baseLevel - 1 + subLevel`，由 slot 的「级别」列决定，用于树结构、TreeView 展示和「标记为标题」时的 `#` 数量。
3. **同级别多风格检查**：若同一 assignedLevel 出现多种 slotId（如级别 1 同时使用「第章」与「§」），生成 `mixed_style_at_level` 类型问题并提示用户统一。

示例：文档仅有「第一章」「1.1」「1.2」「1.1.1」，则 slot 1（第章，baseLevel 1）→ assignedLevel 0；slot 7（点+ar，baseLevel 5）的 1.1、1.2 为 subLevel 1 → assignedLevel 5；1.1.1 为 subLevel 2 → assignedLevel 6。

### 2.5 用户扩展

- `customLevels` 可新增 slot，或覆盖同 slotId 的预置定义。
- 简化与排定逻辑对用户扩展的 slot 同样适用。

---

## 三、架构与模块划分

### 3.1 建议目录结构

```
src/
  numbering/
    types.ts                 # 标题层级类型、检查结果类型
    hierarchySchema.ts       # 预置与用户扩展的标题层级定义
    numberPatterns.ts        # 各类序号的匹配正则（预置 + 用户正则）
    documentParser.ts       # 文档解析：按行识别序号行，构建树结构
    hierarchyChecker.ts     # 检查逻辑：连续性、层级、缺失一致性
    numberingTreeProvider.ts # TreeView 数据提供者
    numberingView.ts        # 注册 TreeView、选中回调
  commands/
    numberingCheckCommandHandler.ts  # 命令入口、操作命令
data/
  numbering-schema.json     # 预置标题层级配置（可被用户覆盖/扩展）
```

### 3.2 模块职责

| 模块 | 职责 |
|------|------|
| **types** | `NumberingNode`（行号、文本、层级、序号值、子节点）、`CheckIssue`（类型、描述、位置）、`HierarchyLevel`（层级定义） |
| **hierarchySchema** | 加载/合并预置与用户配置；提供「当前生效的层级体系」 |
| **numberPatterns** | 为每种序号类型生成正则；支持用户添加自定义正则 |
| **documentParser** | 输入文档全文，按行解析，识别序号行并区分标题/文中，输出 `NumberingNode` 树 |
| **hierarchyChecker** | 输入 `NumberingNode` 树，输出 `CheckIssue[]` |
| **numberingTreeProvider** | TreeDataProvider，将树 + 问题列表转为 TreeItem |
| **numberingView** | 注册 View、selection 回调、与 Handler 联动 |
| **numberingCheckCommandHandler** | 执行检查、刷新、应用操作（标记标题、升级、降级） |

---

## 四、数据模型设计

### 4.1 标题层级定义（HierarchyLevel）

```typescript
interface HierarchyLevel {
  level: number;           // 层级深度，0 为最顶层
  name: string;            // 显示名称，如 "章"
  pattern: string | RegExp; // 匹配模式：字符串或正则
  sequenceType?: 'chinese-upper' | 'chinese-lower' | 'arabic' | 'roman-upper' | 'roman-lower' | 'latin-upper' | 'latin-lower' | 'custom';
  customSequence?: string[]; // sequenceType 为 custom 时的序列
}
```

### 4.2 解析结果节点（NumberingNode）

```typescript
interface NumberingNode {
  lineNumber: number;
  lineText: string;        // 原始行文本
  category: 'heading' | 'intext';  // 标题序号 | 文中序号
  headingPrefix?: string;  // Markdown 的 # 部分，如 "##"
  numberingText: string;   // 序号部分，如 "第一章"
  numberingValue: number;  // 可比较的数值（用于连续性检查）
  level: number;
  children: NumberingNode[];
  range?: vscode.Range;    // 文档中的范围，用于定位与编辑
}
```

### 4.3 检查问题（CheckIssue）

```typescript
interface CheckIssue {
  type: 'gap' | 'duplicate' | 'order' | 'level_mismatch' | 'inconsistent_gaps';
  message: string;
  node: NumberingNode;
  severity: 'error' | 'warning' | 'info';
}
```

---

## 五、序号匹配策略

### 5.1 预置正则示例

- **阿拉伯数字 + 点号**：`/^\s*(#{1,6}\s+)?(\d+)[.．]\s*(.*)$/`
- **中文数字 + 顿号**：`/^\s*(#{1,6}\s+)?([一二三四五六七八九十百千]+)、\s*(.*)$/`
- **第 X 章**：`/^\s*(#{1,6}\s+)?第([一二三四五六七八九十百千\d]+)[章节条款项]\s*(.*)$/`
- **带圈数字**：`/^\s*(#{1,6}\s+)?([①②③④⑤⑥⑦⑧⑨⑩])\s*(.*)$/`

### 5.2 用户扩展

- 配置项 `ai-proofread.numbering.customLevels`：数组，每项含 `level`、`pattern`（字符串转正则）、`name`、`sequenceType`（可选）。
- 与预置合并时，用户定义优先覆盖同 level 的预置。

#### 自定义 pattern 写法

**匹配规则**：自定义层级匹配时，会先去掉原文中所有空白字符（`\s+` → 空），再与 pattern 匹配。因此 `第 1 章`、`第1章` 在 pattern 中可统一按 `第1章` 处理。

**格式**：
- 普通字符串：`第(\\d+)章`（JSON 中需双反斜杠）或 `第(\d+)章`
- 正则字面量：`/第(\d+)章/` 或 `/第(\d+)章/i`（支持 i、g、m 等标志）

**捕获数字**：必须用**捕获组** `(...)` 包住序号部分，系统会取 `match[1]` 或 `match[2]` 作为 `numberingValue`：
- 若 pattern 只有一个捕获组，用 `(数字部分)` 即可，如 `第(\d+)章`
- 若有可选前缀（如 `#{1,6}`），第一个捕获组可能是前缀，第二个才是数字，如 `(#{1,6})?第(\d+)章` 中的 `(\d+)`

**sequenceType**（可选）：决定如何把捕获到的字符串转为数值，默认 `arabic`。可选值：
- `arabic`：阿拉伯数字
- `chinese-lower` / `chinese-upper`：中文小写/大写
- `roman-upper` / `roman-lower`：罗马数字
- `latin-upper` / `latin-lower`：拉丁字母（A=1, B=2…）
- `circled`：带圈数字 ①②③

**示例**：

| 用途       | pattern           | sequenceType   | 匹配示例              |
|------------|-------------------|----------------|-----------------------|
| 第 N 章    | `第(\d+)章`       | arabic         | 第1章、第 2 章        |
| 第 N 节    | `第([一二三四五六七八九十百千]+)节` | chinese-lower | 第一节、第 二 节       |
| Part N     | `[Pp]art(\d+)`    | arabic         | Part 1、part2（匹配时已去空白） |
| 附录 A     | `附录([A-Z])`     | latin-upper    | 附录A、附录 B         |

---

## 六、检查算法要点

### 6.1 同级连续性

- 遍历同级节点，按 `numberingValue` 排序后检查是否连续。
- 若存在缺失（如 1, 2, 4），记录 `gap` 类型问题。
- 若存在重复（如 1, 2, 2, 3），记录 `duplicate` 类型问题。

### 6.2 层级错乱

- 深度优先遍历，维护「当前路径上的序号栈」。
- 若子节点 `level` 小于等于父节点，或序号值逆序，记录 `level_mismatch` / `order`。

### 6.3 中段缺失一致性（尾部缺失可不同）

- **中段缺失**：序号序列中间有缺号，如 1.1、1.2、1.4 缺 1.3。
- **尾部缺失**：某分支在最大序号之前结束，如分支 A 有 1.1–1.4，分支 B 只有 1.1–1.3。
- **规则**：同一父节点下，各子分支的「中段缺失集合」应一致；**各分支的尾部缺失可不同**（不要求所有分支都到同一最大序号）。
- **算法**：对每个父节点，收集各子分支的「中段缺失位置」（排除尾部）；比较兄弟分支的中段缺失是否一致；不一致则记录 `inconsistent_gaps`。

---

## 七、TreeView 设计

### 7.1 节点展示

- **正常节点**：`L{行号} {序号} {标题摘要}`，如 `L12 第一章 引言`。
- **有问题节点**：description 或 icon 显示问题类型；tooltip 展示详细说明。
- **层级结构**：父子关系与文档结构一致，可展开/折叠。

### 7.2 操作命令

| 命令 | 说明 | 适用对象 |
|------|------|----------|
| `ai-proofread.numbering.check` | 执行序号检查 | 当前文档 |
| `ai-proofread.numbering.markAsTitle` | 将选中节点（及其同级）标记为 Markdown 标题 | 选中节点 |
| `ai-proofread.numbering.promote` | 整体升级（减少 # 或提升层级） | 选中节点 |
| `ai-proofread.numbering.demote` | 整体降级 | 选中节点 |
| `ai-proofread.numbering.reveal` | 定位到文档对应行 | 选中节点 |

### 7.3 package.json 贡献点

- **commands**：上述命令。
- **views.explorer**：`ai-proofread.numbering`，名称「标题树」。
- **menus.view/item/context**：当 `view == ai-proofread.numbering` 时显示「标记为标题」「升级」「降级」「定位」。
- **configuration**：`ai-proofread.numbering.ignoreMarkdownPrefix`、`ai-proofread.numbering.customLevels`、`ai-proofread.numbering.allowGaps` 等。

---

## 八、与现有代码的集成

### 8.1 可复用模块

- **normalizeLineEndings**（utils.ts）：文档解析前统一换行符。
- **splitter** 中的按行处理逻辑：可参考 `splitMarkdownByTitle` 的按行遍历方式。
- **titleMarker**：`mark titles from table of contents` 与「标记为 Markdown 标题」有相似性，可复用 `cleanTitle` 等工具函数；但序号检查的「标记」是反向的（从序号行生成 `#`），逻辑需独立实现。

### 8.2 扩展入口

- 在 `extension.ts` 中注册 `NumberingCheckCommandHandler`，按需显示 `ai-proofread.numbering` TreeView（与字词检查、引文核对一致，默认隐藏，由命令打开）。

---

## 九、实施顺序建议

### 阶段 0：标题体系（待审定后开发）

0. **标题体系全表**：按 2.3 节实现固定 slot 定义；**解析**：按 slot 逐行匹配；**简化**：删除文档中未出现的 slot；**排定**：按首次出现顺序分配层级序号 0, 1, 2, …。

### 阶段 1：基础解析（约 1–2 周）

1. **types + numberPatterns**：定义 `NumberingNode`、`CheckIssue`、`HierarchyLevel`、`SlotId`；实现预置序号类型的正则（至少支持阿拉伯数字、中文数字、第 X 章、带圈数字）。
2. **hierarchySchema**：实现 JSON 配置加载，支持预置 + 用户扩展。
3. **documentParser**：按行解析文档，识别序号行，构建 `NumberingNode` 树；支持「忽略 Markdown 前缀」选项。
4. **单元测试**：对 `documentParser` 用典型文档（纯文本、Markdown）做测试，确保树结构正确。

### 阶段 2：检查逻辑（约 1 周）

5. **hierarchyChecker**：实现同级连续性检查（gap、duplicate）；实现层级错乱检查。
6. **中段缺失一致性**（可选）：若时间允许，实现 `inconsistent_gaps` 检测。
7. **单元测试**：构造含错误的文档，验证问题能被正确识别。

### 阶段 3：TreeView 与命令（约 1–2 周）

8. **numberingTreeProvider**：实现 TreeDataProvider，将 `NumberingNode` 树 + `CheckIssue[]` 转为 TreeItem；错误节点高亮。
9. **numberingView + numberingCheckCommandHandler**：注册 View、命令「执行序号检查」；执行时解析文档、运行检查、刷新 TreeView、聚焦视图。
10. **定位命令**：点击节点或「定位」命令，在编辑器中 `revealRange` 并选中对应行。

### 阶段 4：批量操作（约 1 周）

11. **标记为 Markdown 标题**：对选中节点及其同级，在行首插入或替换为 `#` 前缀；需处理已有 `#` 的情况。
12. **升级/降级**：调整 `#` 数量或标题层级；需明确「升级」「降级」的语义（仅改 `#` 还是改序号格式）。
13. **配置项**：在 package.json 中增加 `ai-proofread.numbering.*` 配置，支持用户扩展层级、开关检查规则。

### 阶段 5：优化与文档（约 0.5 周）

14. **性能**：大文档（如 10 万行）时，解析与检查放在 `withProgress` 中，支持取消。
15. **文档**：在 README 中补充「标题层级与连续性检查」使用说明；更新 TODO 列表。

---

## 十、边界与注意事项

### 10.1 标题序号与文中序号的识别

- **标题序号**：通常为行首（含可选 `#`）、独立成行、或 Markdown 列表项行首；可配置「行首最大缩进」等阈值。
- **文中序号**：出现在行中、段落内、缩进较深的列表中等；与标题序号的边界可配置。
- 同一模式可能在不同位置分别作为标题或文中序号，以位置/上下文判断。

### 10.2 歧义处理

- 同一行可能匹配多种序号模式（如 `1. 引言` 既可能是「1.」也可能是「1. 引言」中的小节号）。采用「最长匹配优先」或「按层级顺序尝试」，先匹配到的生效。
- 混合序号（如 `第一章 1.1 节`）可解析为两级，需在 pattern 设计时考虑。

### 10.3 性能

- 解析与检查均为 CPU 密集型，大文档时用 `withProgress` + 可取消；必要时分块解析（如每次处理 1000 行）。
- TreeView 的 `getChildren` 仅基于已解析的树结构，不重复解析。

### 10.4 与 mark titles from table of contents 的关系

- **mark titles from table of contents**：根据目录表在正文中查找并标记标题，是「目录 → 正文」的匹配。
- **序号检查**：解析正文中的标题树，检查其合理性，并可「序号行 → 添加 #」。
- 两者互补，不冲突；可考虑在序号检查的「标记为标题」时，与目录表逻辑做可选联动（如根据目录表确定 `#` 数量），作为后续增强。

---

## 十一、配置项草案

| 配置键 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `ai-proofread.numbering.ignoreMarkdownPrefix` | boolean | true | 解析时是否忽略行首 `#` 以识别序号 |
| `ai-proofread.numbering.allowGaps` | boolean | true | 是否允许同级序号缺失（允许则仅 warning） |
| `ai-proofread.numbering.checkGapConsistency` | boolean | false | 是否检查各分支中段缺失一致性（尾部缺失可不同） |
| `ai-proofread.numbering.customLevels` | array | [] | 用户自定义层级，每项含 level、pattern、name |
| `ai-proofread.numbering.checkScope` | string | 'heading' | 检查范围：`heading` 仅标题序号、`intext` 仅文中序号、`both` 两者都检查 |

---

按上述模块与阶段逐步实现，可保持与字词检查、引文核对等功能一致的架构风格，并便于后续扩展（如导出检查报告、与目录表联动等）。
