# 「检查字词」功能规划设计

## 一、需求与数据

### 1.1 数据来源（`data/xh7_tables.json`）

- **五类字词表**（键：需要提示的字词 → 值：更好的字词）：
  - `variant_to_standard`：异形词 → 标准形
  - `variant_to_preferred`：异形词 → 首选形
  - `single_char_traditional_to_standard`：单字繁体 → 标准简体
  - `single_char_yitihuabiao_to_standard`：单字异体（化标）→ 标准
  - `single_char_yiti_other_to_standard`：单字异体（其他）→ 标准

- **注释表**（键：更好的字词 → 值：提示信息数组）：
  - `raw_notes`：原始/字形类注释
  - `usage_notes`：用法类注释

### 1.2 功能目标

1. 命令「检查字词」→ 用户选择检查类型（对应上述五表之一）。
2. 对当前打开文档全文扫描，找出该表中所有「需要提示的字词」的出现位置与次数。
3. 在 TreeView 中展示：每个条目为「需要提示的字词：更好的字词」，并显示该条目在文档中的**累计出现次数**。
4. 每个 TreeView 条目支持：
   - **定位**：点击条目 → 在编辑器中定位到该词的一处出现（或上一处/下一处）。
   - **上一处/下一处**：在条目上通过上下文菜单「上一处」「下一处」在文档中循环定位。
   - **注释**：**方案 A + B** — TreeItem 的 tooltip 中展示简短注释（过长截断 +「详见说明」）；上下文菜单「查看说明」打开 Webview/面板展示完整 raw_notes + usage_notes。
5. **无子节点**：条目可能很多，Tree 仅一级节点（「需要提示的词：更好的词」+ 出现次数），不展开「第 1 处 L12」等每一处；定位与导航通过「上一处/下一处」在条目级完成。
6. **懒加载、不阻塞**：数据与扫描均不阻塞编辑器；见下文「懒加载与不阻塞」。

---

## 二、架构与模块划分

### 2.1 模块职责（建议目录结构）

```
src/
  xh7/
    types.ts              # 五类表名、条目类型、扫描结果类型
    tableLoader.ts        # 加载并解析 xh7_tables.json，按表名取字典
    documentScanner.ts    # 对当前文档全文扫描，返回「词 → 出现位置[]」
    wordCheckTreeProvider.ts  # TreeView 数据：仅一级条目，无子节点
    wordCheckView.ts      # 注册 TreeView、选中回调、聚焦视图
    notesResolver.ts      # 根据「更好的字词」查 raw_notes / usage_notes，拼接展示
  commands/
    wordCheckCommandHandler.ts  # 命令「检查字词」及「上一处/下一处」等
```

- **types**：统一表名常量、`CheckType` 枚举、`WordEntry`（variant, preferred）、`Occurrence`（range, index）、`ScanResult` 等。
- **tableLoader**：**懒加载** — 首次需要时再读取 `extensionContext.asAbsolutePath('data/xh7_tables.json')`，解析 JSON 并缓存；暴露 `getDict(type: CheckType): Record<string, string>` 和 `getNotes(preferred: string): { raw?: string[]; usage?: string[] }`。不在扩展 activate 时同步读大文件。
- **documentScanner**：接收文档全文 + 某表的字典；在**异步/后台**中遍历字典每个 key 查找出现位置，返回 `Map<variant, { preferred, ranges: Range[] }>`。用 `document.positionAt(offset)` 转成 `vscode.Range`。扫描过程放在 `withProgress` 或可取消任务中，避免长时间占用主线程。
- **wordCheckTreeProvider**：  
  - **仅一级节点**：每个「需要提示的词：更好的词」一条，description 显示「出现次数」；`contextValue: 'wordCheckEntry'`。**无子节点**，不展开每一处。  
  - `getChildren` / `getTreeItem` 只读内存中已计算好的条目数组，不做 I/O、不重新扫描，保证不阻塞 UI。  
  - 可选：根级一个汇总节点「共 N 条、M 处」（若实现简单）。  
- **wordCheckView**：`createTreeView`、`onDidChangeSelection` 里记录当前选中的条目与「当前定位索引」，并调用 Handler 的「定位到第 n 处」方法。
- **notesResolver**：`getNotesForPreferred(preferred)` 合并 raw_notes 与 usage_notes；提供「简短版」（用于 tooltip，截断长度如 200 字）+「完整版」（用于「查看说明」）。
- **wordCheckCommandHandler**：  
  - `handleCheckCommand()`：若无活动编辑器则提示；QuickPick 选类型；**在 withProgress（Notification，cancellable）中**调用 tableLoader（懒加载）+ documentScanner；扫描完成后一次性刷新 TreeProvider 并更新 view title；focus TreeView。  
  - `handleGoToPrevOccurrence()` / `handleGoToNextOccurrence()`：根据当前选中条目与 currentIndex，取上一/下一处 range，`editor.revealRange` + `editor.selection`。  
  - `handleShowNotes()`：对当前条目的「更好的字词」调 notesResolver 取完整版，在 **Webview 或面板**中展示（方案 B）。

### 2.2 与现有扩展风格一致

- 参考 **Citation**：`citationView.ts`（注册 TreeView + selection 回调）、`citationTreeProvider.ts`（TreeDataProvider）、`citationCommandHandler.ts`（命令入口、更新 title）。  
- 数据与 UI 分离：扫描结果只存于 Provider 或 Handler 中，不塞进 TreeItem 的 payload；通过 `TreeItem.id` 或 `contextValue` 关联到「条目 + 当前索引」。  
- 大文件扫描可考虑：  
  - 一次性全文档 `getText()` 后按词查找（词不长时足够快）；  
  - 若表很大且文档很大，可只对「在本文档中出现过的词」做次数统计（先遍历文档再与表交集），避免对表中每词都做全文搜索。

---

## 三、交互与 UX

### 3.1 命令与入口

- **命令面板**：注册命令 `ai-proofread.checkWords`，标题「检查字词」或「AI Proofreader: 检查字词」。
- 执行后：QuickPick 选择检查类型（五项对应五张表，label 可用中文简称，如「异形→标准」「异形→首选」「单字繁体→标准」等）。

### 3.2 TreeView 展示

- **View 位置**：与 Citation 并列放在 `views.explorer` 下，例如 `ai-proofread.wordCheck`，名称「字词检查」。
- **根级**：可为空（直接是一组条目）或一个汇总节点「共 N 条、M 处」。
- **条目**：label 为「需要提示的词：更好的词」，description 为「× 3」表示 3 处；点击条目 → 定位到该词「当前处」（默认第 1 处，之后用「上一处/下一处」改变）。
- **当前处**：在 Handler 或 View 中为每个条目维护 `currentIndex`，范围 `[0, ranges.length)`，循环。

### 3.3 定位与导航

- **点击条目**：定位到 `ranges[currentIndex]`，并 `revealRange` + 设置 `editor.selection`。
- **上一处 / 下一处**：  
  - 通过 view/item/context 菜单注册到 `wordCheckEntry`，或标题栏按钮。  
  - 命令：`ai-proofread.wordCheck.prevOccurrence`、`ai-proofread.wordCheck.nextOccurrence`。  
  - 更新 `currentIndex`（循环），再定位到对应 range。

### 3.4 注释信息（方案 A + B）

- **来源**：`raw_notes[preferred]`、`usage_notes[preferred]`，可能为数组，需拼接（如用 `\n` 或分段）。
- **方案 A — Tooltip**：在 TreeItem 的 `tooltip` 中放入**简短注释**（例如截断至 200 字，过长时末尾加「… 详见说明」）。
- **方案 B — 查看说明**：上下文菜单「查看说明」→ 打开 **Webview 或侧边面板**，展示该条目的完整 raw_notes + usage_notes（可保留 HTML 片段，用 Webview 渲染）。

---

## 四、实现要点与边界

### 4.1 扫描与匹配

- **全词匹配**：建议只统计「作为完整词」的出现，避免「人才」把「人才库」里的「人才」也算进去（若表里是「人材→人才」）。可用正则 `new RegExp(escapeRegex(variant), 'g')` 配合词边界或前后非字字符判断（根据中文习惯可简化为：前后不为字母数字即算一词）。  
- **重叠与子串**：若表中既有「人才」又有「人材」，文档中「人材」只算「人材」一条，不重复计入「人才」。按「先长后短」或「按 offset 不重叠」规则可避免重复统计。  
- **性能**：文档 100 万字、表 500 条时，对每个 key 做 `indexOf` 循环是可接受的；若单次 `indexOf` 改为正则 `match` 可一次得到所有位置。

### 4.2 注释内容

- `raw_notes` 中可能含 HTML 片段（如 `<sup>、<small>`）；在 VS Code 的 MarkdownString 或 Webview 中可保留；若只做纯文本 tooltip，可先 strip 标签或做简单转换。

### 4.3 状态与刷新

- 检查结果与「当前条目 / 当前处」状态保存在 Provider 或 CommandHandler 中；**切换文档或重新执行「检查字词」**时清空并重新扫描。  
- 若用户编辑了文档，可提示「文档已修改，请重新执行检查字词」或提供「重新检查」按钮，不自动后台重扫，以保持实现简单。

### 4.4 懒加载与不阻塞编辑器

- **数据懒加载**：`xh7_tables.json` 在**首次执行「检查字词」或首次需要 getDict/getNotes 时**再加载并缓存；不在 `activate()` 里同步读取，避免拖慢扩展启动与编辑器响应。
- **扫描不阻塞**：执行「检查字词」时，将「加载表 + 全文扫描」放在 `vscode.window.withProgress({ location: ProgressLocation.Notification, title: '字词检查', cancellable: true })` 中执行；扫描循环内可配合 `cancelToken` 和适度 `setImmediate`/分块，避免单次长时间占用主线程，保证输入、滚动等不卡顿。
- **TreeView 不阻塞**：Provider 的 `getChildren(element)`、`getTreeItem(element)` 仅基于**已缓存的扫描结果数组**做过滤/映射，不进行文件 I/O、不重新扫描、不执行重计算；数据在扫描完成后一次性写入 Provider，Tree 只做展示。VS Code 会按需懒加载可见节点，条目再多也只渲染当前展开的。
- **注释懒加载**：tooltip 所需简短注释可在 `getTreeItem` 中从已缓存的 notes 数据读取（内存），或首次展开时由 notesResolver 从缓存取；「查看说明」仅在用户点击时再取完整内容并打开 Webview，不在 Tree 渲染时预加载。

### 4.5 package.json 贡献点

- **commands**：`ai-proofread.checkWords`、`ai-proofread.wordCheck.prevOccurrence`、`ai-proofread.wordCheck.nextOccurrence`、`ai-proofread.wordCheck.showNotes`（可选）。  
- **views.explorer**：新增 `ai-proofread.wordCheck`，name「字词检查」。  
- **menus.view/item/context**：当 `view == ai-proofread.wordCheck && viewItem == wordCheckEntry` 时显示「上一处」「下一处」「查看说明」。

---

## 五、实施顺序建议

1. **types + tableLoader**：定义类型，实现 JSON 加载与按表名/按 preferred 查注释。  
2. **documentScanner**：实现「文档全文 + 字典 → 词条及 ranges」的扫描逻辑（先全词匹配、不处理重叠）。  
3. **wordCheckTreeProvider**：只做一级节点（条目 + 出现次数），无子节点；id 可用 `variant` 或 `variant|preferred`。  
4. **wordCheckView + 命令「检查字词」**：注册 View、执行命令时选类型、扫描、刷新、聚焦。  
5. **点击条目定位**：选中条目后定位到该条目的第一处（或当前处）。  
6. **上一处/下一处**：维护 currentIndex，实现两条命令并绑定到菜单。  
7. **注释**：notesResolver + tooltip（简短，方案 A）+「查看说明」命令打开 Webview/面板（完整，方案 B）。  
8. **优化**：大文档/大表时扫描分块或可取消、tooltip 截断长度与「详见说明」提示。

---

## 六、与现有代码的集成

- 在 **extension.ts** 中：  
  - 调用 `registerWordCheckView(context)` 得到 provider 与 treeView。  
  - 实例化 `WordCheckCommandHandler(context, provider, treeView)`，在 `context.subscriptions` 中注册 `checkWords`、`prevOccurrence`、`nextOccurrence`、`showNotes`。  
- 数据文件路径：使用 `context.asAbsolutePath('data/xh7_tables.json')`，打包时通过 `.vscodeignore` 确保 `data/xh7_tables.json` 被包含（若需发布）。

按上述模块逐步实现，可保持与 Citation 功能类似的风格，并便于后续扩展（如导出报告、批量替换建议等）。
