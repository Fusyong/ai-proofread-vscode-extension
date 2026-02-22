# 持续发现与监督校对 — 开发计划

本文档为 AI Proofreader 扩展的「持续发现与监督校对」功能提供需求分析、技术方案和分阶段开发计划。

**功能目标**：从当前位置自动带样例校对一段，人工复核保存后自动收集样例，人工确认后自动继续下一轮，直到用户中断。操作以键盘为主，尽量便捷。

---

## 一、需求与目标

### 1.1 核心流程（用户视角）

```
┌─────────────────────────────────────────────────────────────────────────┐
│  1. 启动：从光标位置取一段（默认长度）                                    │
│  2. 校对：带样例（如有）调用 LLM 校对                                    │
│  3. 复核：diff 展示原文 vs 结果，用户可编辑右侧                          │
│  4. 保存：用户确认 → 写回文档，替换该段                                  │
│  5. 收集：自动提取「原文→修改后」对，作为待选样例                        │
│  6. 确认：用户勾选保留/抛弃哪些样例                                      │
│  7. 继续：自动进入下一段，回到步骤 2；或用户中断                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 1.2 关键约束

| 约束 | 说明 |
|------|------|
| **无样例则忽略** | 若 `.proofread/examples.md` 不存在或为空，仍可校对，但不使用 reference |
| **切分方式（首次选择后固定）** | 首次使用时选择：**按长度**（`defaultSplitLength`，默认 600 字符，在空行处切分）或 **按标题**（`defaultTitleLevels`，以标题为界取整段）；后续轮次不再询问 |
| **从当前位置** | 以光标所在位置为起点，取「从该位置起的第一段」 |
| **键盘优先** | 尽量用快捷键完成：启动、接受、拒绝、继续、中断 |

### 1.3 与现有功能的关系

| 现有功能 | 复用方式 |
|----------|----------|
| `proofreadSelection` | 核心校对逻辑 |
| `proofreadSelectionWithExamples` | 样例作为 reference 的调用方式 |
| `editProofreadingExamples` | 样例格式、保存逻辑可复用 |
| `splitTextByLength` | 需扩展为「从指定偏移起取一段」 |
| `showDiff` | diff 展示，需支持「接受并写回文档」 |
| `defaultSplitLength` | 直接使用 |

---

## 二、技术方案

### 2.1 模块划分

```
src/
├── commands/
│   └── continuousProofreadCommandHandler.ts   # 新建：持续校对命令与流程
├── splitter.ts                                 # 扩展：getSegmentFromPosition
├── differ.ts                                   # 扩展：showDiffAndApply（可选）
└── proofreader.ts                              # 复用：proofreadSelection
```

### 2.2 核心数据结构

```typescript
/** 持续校对会话状态 */
interface ContinuousProofreadSession {
  document: vscode.TextDocument;
  startOffset: number;           // 当前段在文档中的起始偏移
  segmentRange: vscode.Range;    // 当前段的 Range
  originalText: string;
  proofreadText: string;         // 用户可能已编辑
  examplesPath: string | undefined;
  config: {
    cutBy: number;
    platform: string;
    model: string;
    temperature: number;
    contextLevel?: string;
    beforeParagraphs?: number;
    afterParagraphs?: number;
  };
}
```

### 2.3 从当前位置取一段

**新增函数** `getSegmentFromPosition(text, offset, cutBy)`：

- 输入：全文、起始偏移、切分长度
- 逻辑：从 `offset` 起截取子串，用 `splitTextByLength` 的规则（在空行处切分）取第一段
- 输出：`{ segment: string, range: Range }`（range 为在原文中的范围）

实现要点：

- 复用 `splitTextByLength` 的「按行累积、遇空行且超长则切」逻辑
- 仅处理 `text.slice(offset)`，再根据 `offset` 换算回全文的 `Range`

### 2.4 复核与保存流程

1. **展示 diff**：`showDiff(original, proofread)`，右侧可编辑（临时文件可写）
2. **用户操作**：
   - **接受**（如 Ctrl+Enter）：读取 diff 右侧文档的当前内容（含未保存的编辑），用 `TextEditor.edit` 替换文档中对应 `segmentRange`
   - **拒绝**（Esc）：不写回，直接进入「收集样例」步骤（可选：无修改则不收集）
3. **读取右侧内容**：通过 `vscode.workspace.textDocuments` 按 URI 查找 diff 右侧文档，`document.getText()` 可获取含未保存修改的当前内容，**无需用户先保存**
4. **写回文档**：`editor.edit(editBuilder => editBuilder.replace(segmentRange, finalText))`

### 2.5 样例收集与确认

1. **提取待选样例**：先用 `splitChineseSentencesSimple`（split into sentences 默认）分切原文和最终文本，再用 2 个换行符（一个空行）分切，得到 `{ input, output }[]` 句子级对齐
2. **过滤**：`input !== output` 且非空
3. **用户确认**：使用 **Webview** 展示，**每条用 jsdiff 展示 input→output 的变化**（红删绿增，与现有 `jsDiffMarkdown` 一致）
   - 每条：复选框 + jsdiff 渲染区（复用 `Diff.diffWordsWithSpace` + `Intl.Segmenter`）
   - 底部操作：`[全部保留]` `[全部抛弃]` `[确认选择]`
   - 通过 `postMessage` 回传用户勾选的索引，追加到 `examples.md`
4. **写入**：将用户勾选的条目追加到 `.proofread/examples.md`，格式与现有一致

**可行性**：扩展已有 `differ.ts` 中的 jsdiff 逻辑（`diffWordsWithSpace` + `Intl.Segmenter`）和 `WebviewPanel` 用法，将 diff 渲染逻辑嵌入 Webview HTML 即可实现。

### 2.6 继续与中断

- **继续**：`startOffset = segmentRange.end` 的偏移，若已到文档末尾则提示「已校对完毕」并结束
- **中断**：用户随时可 Esc 或执行「停止持续校对」命令

---

## 三、键盘与操作优化

### 3.1 推荐快捷键

| 操作 | 建议快捷键 | 说明 |
|------|------------|------|
| 启动持续校对 | `Ctrl+Alt+P` 或 自定义 | 从光标位置开始 |
| 接受并继续 | `Ctrl+Enter` | 在 diff 或确认步骤时，需配合 `when` 子句 |
| 拒绝/跳过 | `Esc` | 不写回，可选是否收集样例 |
| 停止持续校对 | `Esc`（在非 diff 时）或 命令 | 完全退出流程 |

**when 子句示例**：`aiProofreadContinuousProofreadActive == true`，通过 `setContext` 在会话期间设为 true。

### 3.2 减少弹窗

- **首次启动**：可弹出一次配置确认（平台、模型、温度、上下文），后续轮次使用同一配置
- **每轮**：仅 diff + 底部状态栏提示（如「Ctrl+Enter 接受并继续 | Esc 跳过」）
- **样例确认**：用 Webview 展示，每条 jsdiff 可视化 + 复选框，支持 `Space` 勾选、`Enter` 确认

### 3.3 状态栏

- 持续校对进行中：显示 `持续校对中 (第 N 段) | Ctrl+Enter 接受 Esc 跳过`
- 样例确认时：显示 `选择要保留的样例 (已选 X 条) | Enter 确认`

---

## 四、分阶段开发计划

### 阶段 1：基础流程（MVP）

**目标**：实现「取段 → 校对 → diff → 写回 → 继续」闭环，暂不做样例收集。

1. **扩展 splitter**
   - 新增 `getSegmentFromPosition(document, position, cutBy)`，返回 `{ segment, range }`
   - 处理文档末尾、空文档等边界

2. **新建 ContinuousProofreadCommandHandler**
   - 命令 `ai-proofread.continuousProofread`
   - 从光标取段，无段则提示
   - 调用 `proofreadSelection`（或带 examples 的版本）
   - 使用 `showDiff` 展示，监听 diff 关闭或自定义「接受」命令
   - 实现「接受」：读右侧内容，写回文档，`startOffset = segmentRange.end`，循环下一段
   - 实现「跳过」：不写回，直接下一段
   - 实现「停止」：清理状态，退出

3. **配置与命令**
   - 在 `package.json` 中注册命令
   - 可选：添加快捷键 `Ctrl+Alt+P`

**验收**：从光标开始，能连续校对多段，接受/跳过/停止均正常。

---

### 阶段 2：样例集成与收集

**目标**：带样例校对，并在每轮保存后收集样例。

1. **样例作为 reference**
   - 若存在 `examples.md`，使用 `proofreadSelectionWithExamples` 的 reference 逻辑
   - 否则使用 `proofreadSelection`（无 reference）

2. **自动收集待选样例**
   - 在「接受」后，根据 `originalText` 与 `finalText` 提取 input/output 对
   - 复用 `ExamplesCommandHandler.splitBySeparator` 的切分逻辑
   - 过滤 `input !== output` 且非空

3. **用户确认界面（Webview + jsdiff）**
   - 新建 Webview：每条样例一个区块，含复选框 + jsdiff 渲染（input→output，红删绿增）
   - 复用 `differ.ts` 中的 `Diff.diffWordsWithSpace` + `Intl.Segmenter` 逻辑，在 Webview 内联脚本中渲染
   - 底部按钮：全部保留、全部抛弃、确认选择
   - `postMessage` 回传勾选索引，确认后追加到 `examples.md`

**验收**：带样例校对，保存后能选择并写入样例，下一轮自动使用新样例。

---

### 阶段 3：操作优化与体验

**目标**：键盘优先、减少弹窗、状态栏反馈。

1. **快捷键**
   - 为「接受并继续」「跳过」「停止」绑定快捷键（在 diff 激活时生效）
   - 通过 `when` 限制：仅持续校对会话进行中时可用

2. **配置记忆（仅本流程有效）**
   - 首次启动时询问切分方式、平台、模型、温度、上下文等，存入 `workspaceState`
   - 切分方式可选：按长度（`defaultSplitLength`）或按标题（`defaultTitleLevels`）
   - 本流程内后续轮次直接使用，不再弹窗；**终止后删除配置**，下次启动重新询问

3. **状态栏**
   - 注册 `StatusBarItem`，持续校对时显示进度与操作提示
   - 样例确认时更新文案

4. **边界与错误**
   - 文档末尾、无更多段时的提示
   - API 失败时的重试/跳过选项
   - 中途切换文档时的行为（建议：停止当前会话）

**验收**：全程可用键盘完成，状态清晰，异常有明确提示。

---

### 阶段 4：可选增强

- **进度持久化**：支持「暂停后下次接着校对」，记录 `startOffset` 到文件或 `workspaceState`
- **校对面板集成**：在校对面板增加「持续校对」按钮
- **统计信息**：每轮耗时、总段数、接受/跳过数量等

---

## 五、实现细节补充

### 5.1 getSegmentFromPosition 伪代码

```typescript
function getSegmentFromPosition(
  document: vscode.TextDocument,
  position: vscode.Position,
  cutBy: number
): { segment: string; range: vscode.Range } | null {
  const text = document.getText();
  const offset = document.offsetAt(position);
  const remaining = text.slice(offset);
  if (!remaining.trim()) return null;

  const chunks = splitTextByLength(remaining, cutBy);
  const firstChunk = chunks[0];
  if (!firstChunk) return null;

  const startOffset = offset;
  const endOffset = offset + firstChunk.length;
  const range = new vscode.Range(
    document.positionAt(startOffset),
    document.positionAt(endOffset)
  );
  return { segment: firstChunk, range };
}
```

### 5.2 接受并写回

```typescript
// 从 diff 右侧（modified）读取最终内容
const modifiedDoc = await vscode.workspace.openTextDocument(proofreadUri);
const finalText = modifiedDoc.getText();

await editor.edit(editBuilder => {
  editBuilder.replace(session.segmentRange, finalText);
});
```

### 5.3 样例格式

与 `examplesCommandHandler` 一致：

```xml
<example><input>原文</input><output>校对后</output></example>
```

### 5.4 样例确认 Webview（jsdiff 展示）

**结构**：每条样例一个 `<div class="example-item">`，内含：
- `<input type="checkbox">` 默认勾选
- `<pre class="diff-display">` 用于渲染 diff（与 `differ.ts` 样式一致：红删绿增）

**渲染逻辑**（内联在 Webview 的 `<script>` 中）：
```javascript
// 加载 diff 库（与现有 jsDiffMarkdown 相同）
// 对每条 { input, output } 调用 Diff.diffWordsWithSpace(a, b, segmenter)
// 遍历 diff 结果，生成 span（added=绿+下划线，removed=红+虚下划线）
```

**通信**：`panel.webview.onDidReceiveMessage` 监听 `confirmExamples`，payload 为 `{ selectedIndices: number[] }`。

---

## 六、风险与注意事项

1. **diff 临时文件**：`showDiff` 使用临时文件，用户编辑右侧后需在「接受」时读取，注意文件可能被关闭或未保存
2. **大文档**：若文档很大，频繁 `document.getText()` 可能有性能影响，可考虑按需读取
3. **并发**：同一文档不建议多个持续校对会话，需加锁或状态检查

---

## 七、参考

- 现有 `proofreadCommandHandler.ts`：`executeProofreadSelectionFlow`
- 现有 `examplesCommandHandler.ts`：`splitBySeparator`、`handleExampleEditSave`
- 现有 `splitter.ts`：`splitTextByLength`
- 现有 `differ.ts`：`showDiff`
- 配置：`ai-proofread.defaultSplitLength`（默认 600）
