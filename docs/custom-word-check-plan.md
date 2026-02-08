# 自定义检查（正则/非正则替换表）技术规划

## 一、需求与格式

### 1.1 功能分支

- **预置检查**：现有逻辑，基于 dict7 / xh7_tables / tgscc 等预置表，选择检查类型后扫描；结果仅作**提示**（TreeView 定位、查看说明），不直接改文档。
- **自定义检查**：基于用户提供的「替换表」文件，每行：查找 → 替换，可选行内注释（跟预置检查一样用于鼠标悬浮提示）。用户加载表后做**缓存**，通过**复选框**确定是否参与本次检查，并提供**删除**按钮。自定义表通过**复选框「正则」**区分为：
  - **正则替换表**：查找/替换为正则表达式（可含 `\c` 等），**每条规则对文档扫描一遍**，收集该规则的所有匹配。
  - **非正则替换表**：查找/替换为字面串，**不重叠应用**（同一段文本只归属一条规则，与预置检查一致）。

### 1.2 应用方式决策（提示 vs 替换）

- **应用为提示**：与预置检查相同的业务逻辑——仅展示在 TreeView，上一处/下一处、查看说明，不修改文档。
- **应用为替换**：直接查找替换。若选择「应用为替换」：
  - 允许用户输入**替换结果的前标记**、**替换结果的后标记**（可为空）；替换时在 preferred 前、后附加这两段字符串。
  - 对本次扫描到的所有匹配（或对选中的自定义表）在文档中执行**直接查找替换**（variant → 前标记 + preferred + 后标记）。

上述「应用为提示 / 应用为替换」在**执行自定义检查时**由用户选择；预置检查目前仅「应用为提示」。

### 1.3 TreeView 条目：快捷键「应用替换」

- **适用范围**：字词检查 TreeView 中的**任意条目**（包括预置检查、自定义检查）。
- **操作**：当焦点在 TreeView 且选中某条目时，按 **Ctrl+Enter** 或 **Ctrl+Shift+Enter** → 对该条目执行**应用替换**：在当前文档中，将该条目的**所有出现**（variant）替换为 preferred。
- **前后标记**：统一使用配置项。

### 1.4 替换表格式（参考 `test/textProReg.txt`）

- **行结构**：`查找=替换` 或 `查找=替换# 注释` / `查找=替换% 注释`。
- **三个格式特殊字符**（在行解析层面，非正则内）：
  - `#`：行注释开始（行首则为整行注释；在 `=` 后则为行内注释）。
  - `%`：同上，另一种注释前缀。
  - `=`：查找与替换的分隔符，仅第一个未转义的 `=` 有效。
- **转义**：`\` 表示转义，如 `\#` `\%` `\=` 表示字面量。当表为**正则**时，行内其余部分（查找/替换）按正则解析；当表为**非正则**时，查找/替换为字面串（仍解析注释与 `=`）。
- **自定义字符集**（仅正则表、在生成正则前展开）：
  - 当前仅支持 `\c`：表示**汉字**（如 `[\u4e00-\u9fff]`）；后续可扩展。

**解析规则简述**：

1. 空行、以及以 `#` 或 `%` 开头且未转义的行：整行忽略。
2. 否则按「未转义的 `=`」拆成两段：前半为查找，后半再按首个未转义的 `#` 或 `%` 拆出「替换」与「注释」。
3. **正则表**：查找中的 `\c` 展开为汉字字符类后交给 `RegExp`；**非正则表**：查找/替换不再做正则展开，直接作字面串。
4. 行注释前的空格无效，其余所有空格有效

### 1.5 与现有业务一致的数据结构

- 每条规则对应：**需要提示的文本**（匹配到的内容，即 variant）→ **更好的文本**（用替换串替换后的结果，即 preferred）。
- 行内注释对应「说明」，与预置的 raw_notes 一致，用于 tooltip 与「查看说明」。
- 扫描结果仍为 `WordCheckEntry[]`（variant, preferred, ranges），可选带 `rawComment` 以承载自定义表内的注释。

---

## 二、数据结构

### 2.1 解析与编译

```ts
// 解析后单条规则（与文件行一一对应）
interface CustomRule {
    find: string;       // 查找串（正则表：正则源，含 \c；非正则表：字面串）
    replace: string;    // 替换串（正则表可含 $1,$2；非正则表字面）
    rawComment?: string;
}

// 正则表：编译后单条规则（用于扫描）
interface CompiledCustomRule {
    regex: RegExp;           // 全局、unicode：new RegExp(expandFind(find), 'gu')
    replaceTemplate: string; // 直接传给 String.prototype.replace(regex, replaceTemplate)
    rawComment?: string;
}

// 非正则表：字面规则，无需编译，扫描时字面匹配
// 可直接复用 CustomRule，扫描逻辑用 documentScanner 式的「先长后短 + 不重叠」

// 一张自定义表（缓存单元）
interface CustomTable {
    id: string;
    name: string;
    filePath?: string;
    enabled: boolean;
    isRegex: boolean;        // 复选框「正则」：true=正则替换表，false=非正则替换表
    rules: CustomRule[];     // 解析结果
    compiled?: CompiledCustomRule[]; // 仅 isRegex 时存在，预编译结果
}
```

### 2.2 条目与注释

- 扫描得到的每条结果仍为 `WordCheckEntry`，为兼容自定义注释，扩展为：
  - 可选 `rawComment?: string`：来自自定义表规则时填入，供 tooltip / 查看说明使用。
- 展示时：若 `entry.rawComment` 存在，则与预置 `getNotes(preferred, variant)` 合并（或仅用 rawComment）；否则仅用预置 notes。

---

## 三、技术路线

### 3.1 正则预编译（提高条目多时效率）

- **时机**：在「加载/添加表」时解析文件得到 `CustomRule[]`，立即展开 `\c` 并生成 `CompiledCustomRule[]`，存入 `CustomTable.compiled`。
- **展开规则**：遍历查找串与替换串，将 `\c` 替换为 `[\u4e00-\u9fff]`（或可配置的 CJK 范围）；注意不要破坏正则中已有的 `\d`、`\s` 等，仅识别 `\c`。
- **编译**：对每条 `find` 使用 `new RegExp(expandedFind, 'gu')`。若某条编译失败，可记录错误并跳过该条或整表，并在 UI 提示。
- **扫描时**：只遍历 `compiled` 数组，直接 `regex.exec(text)`，不再在扫描循环内做 `new RegExp` 或字符串替换解析，保证条目多时性能。

### 3.2 自定义字符集扩展

- 当前仅实现 `\c` → 汉字。
- 建议在解析/编译层集中处理：`expandCustomClasses(source: string): string`，后续可在此增加 `\C`、`\w` 等占位，便于扩展。

### 3.3 扫描算法

- **正则替换表**（`isRegex === true`）：**每条规则对文档扫描一遍**。对每条 `CompiledCustomRule` 在全文（或选中范围）上执行 `regex.exec`，收集该规则的所有匹配；可选：跨规则仍维护 `consumed` 实现不重叠（先匹配到的先占用），避免同一段文本被多条规则重复替换。每条匹配生成 `WordCheckEntry`（variant = match[0], preferred = 应用 replaceTemplate）。
- **非正则替换表**（`isRegex === false`）：**不重叠应用**。将 rules 视为字面字典（find → replace），复用与预置一致的逻辑：按键长「先长后短」排序，维护 `consumed`，每段文档只归属最先匹配到的一条规则；扫描接口可与现有 `documentScanner` 一致（传入 `Record<string, string>`）。

### 3.4 缓存与持久化

- **内存**：扩展内维护 `CustomTable[]`，每次「检查字词 → 自定义检查」时只读该列表与各表 `enabled`、`compiled`。
- **持久化**：使用 `context.globalState` 或 `context.workspaceState` 存储：
  - 表列表：`{ id, name, filePath?, enabled }`（不存 rules/compiled，以节省空间）；
  - 激活时根据 `filePath` 重新读取文件并解析、编译；若文件不存在则标记为无效并提示。
- 若希望完全离线可用，可额外在 globalState 里缓存「规则源码」（rules 的 find/replace/rawComment），这样无文件时也能用上次解析结果（可选）。

### 3.5 UI 与交互

- **检查字词命令**：
  1. 第一步：QuickPick 选择 **预置检查** 或 **自定义检查**。
  2. **预置检查**：保持现有流程（多选检查类型 → 扫描 → 展示）；仅**应用为提示**（不直接改文档）。
  3. **自定义检查**：
     - QuickPick 多选：列出所有已缓存的自定义表（label = 表名，description 可显示「正则/非正则」或规则数），并增加「加载新表…」「管理自定义表…」。
     - 多选结果 = 本次要应用的各表；若选「加载新表…」则文件选择 → 解析 → 需选择**是否勾选「正则」**（区分正则/非正则表）→ 加入缓存。
     - **应用方式**：确认表后，再选 **应用为提示** 或 **应用为替换**。
       - **应用为提示**：与预置一致，仅刷新 TreeView，不修改文档。
       - **应用为替换**：弹出输入「替换结果前标记」「替换结果后标记」（可为空）→ 对本次扫描到的所有匹配在文档中**直接查找替换**（variant → 前标记 + preferred + 后标记）。
     - 确认后：对每个选中的表按 `isRegex` 走正则或非正则扫描，合并结果，刷新 TreeView；若选的是「应用为替换」，再执行上述批量替换。
- **删除**：通过「管理自定义表」命令或 QuickPick 项进入，列出表，每项可「删除」或切换启用/禁用。
- **TreeView 条目：应用替换快捷键**：
  - 当焦点在字词检查 TreeView 且选中某条目时，**Ctrl+Enter**（或 **Ctrl+Shift+Enter**）→ 执行「对该条目应用替换」：在当前文档中把该条目的**所有出现**（variant）替换为 preferred。
  - 前后标记：Ctrl+Enter 可约定为无标记；Ctrl+Shift+Enter 可弹出输入框输入本次前/后标记；或统一使用「上次应用为替换时输入的标记」/ 配置项（实现时择一或都支持）。
  - 需在 `package.json` 的 `keybindings` 中为该命令绑定 `when: 'focus == ai-proofread.wordCheck'`（或对应 view 的 when 子句），命令 id 如 `ai-proofread.wordCheck.applyReplaceForEntry`。

---

## 四、模块与文件

| 模块 | 职责 |
|------|------|
| `src/xh7/customTableParser.ts` | 解析替换表文件：行解析（转义、`=#%`）、拆出 find/replace/注释，返回 `CustomRule[]`；`expandCustomClasses(source)`（仅正则表，`\c`→汉字）。 |
| `src/xh7/customTableCompiler.ts` | 仅当 `isRegex` 时：将 `CustomRule[]` 编译为 `CompiledCustomRule[]`（展开 `\c`、`new RegExp(..., 'gu')`，捕获编译错误）。非正则表不编译。 |
| `src/xh7/customTableCache.ts` | 内存中的 `CustomTable[]`（含 `isRegex`）；增删改查；持久化表元数据；按 filePath 加载并解析，按 `isRegex` 决定是否编译。 |
| `src/xh7/documentScannerCustom.ts` | **正则表**：接收 `CompiledCustomRule[]`，每条规则对文档扫描一遍，收集匹配（可选跨规则 consumed）；**非正则表**：将 rules 转为 `Record<string, string>` 后复用现有 `scanDocument`（不重叠）。返回 `WordCheckEntry[]`（含 rawComment）。 |
| `src/xh7/applyReplace.ts`（或合入 handler） | **应用替换**：给定条目（或条目列表）、文档、可选前后标记，在文档中执行 variant → 前标记+preferred+后标记 的替换；需按 range 从后往前替换避免偏移错位。 |
| `src/xh7/types.ts` | 扩展 `WordCheckEntry`：可选 `rawComment?: string`；新增 `CustomRule`、`CompiledCustomRule`、`CustomTable`（含 `isRegex`）。 |
| `src/xh7/wordCheckTreeProvider.ts` | 展示时若 `entry.rawComment` 存在则合并使用；无改动时也可支持「应用替换」命令的调用方。 |
| `src/xh7/notesResolver.ts` | 可选 `customRawComment` 与预置 notes 合并。 |
| `src/commands/wordCheckCommandHandler.ts` | 检查字词入口：预置/自定义；自定义多选表 + 加载新表（含「正则」勾选）+ 应用为提示/应用为替换（后者输入前后标记并执行替换）；注册「对当前条目应用替换」命令，供 Ctrl+Enter 调用。 |
| 命令与 keybinding | `ai-proofread.manageCustomTables`：管理自定义表；`ai-proofread.wordCheck.applyReplaceForEntry`：对 TreeView 当前选中条目应用替换；在 `package.json` 中绑定 Ctrl+Enter（及可选 Ctrl+Shift+Enter），`when` 为焦点在字词检查视图。 |

---

## 五、实现顺序建议

1. **Phase 1**：格式解析与编译  
   - `customTableParser.ts`：行解析、转义；支持「正则/非正则」两种输出（非正则不做 `\c` 展开）。  
   - `customTableCompiler.ts`：仅当 `isRegex` 时生成 `CompiledCustomRule[]`；非正则表仅保留 `CustomRule[]`。  
   - 用 `test/textProReg.txt` 验证正则表；另备非正则样例验证。

2. **Phase 2**：自定义扫描  
   - `documentScannerCustom.ts`：正则表 = 每条规则扫描一遍（可选 consumed）；非正则表 = 转成 dict 调用现有 `scanDocument`。  
   - 与现有 TreeView 兼容（同一 refresh 接口）。

3. **Phase 3**：缓存与持久化  
   - `customTableCache.ts`：增删、按 path 加载、持久化表元数据（含 `isRegex`）。  
   - 加载新表时提供「正则」复选框。

4. **Phase 4**：应用方式与替换逻辑  
   - **应用为提示**：仅刷新 TreeView（现有逻辑）。  
   - **应用为替换**：输入前后标记 → 对本次扫描结果在文档中执行替换（`applyReplace`：按 range 从后往前替换，避免偏移错位）。  
   - 自定义检查流程中增加「应用为提示 / 应用为替换」选择；若选替换则再弹输入框（前/后标记）并执行替换。

5. **Phase 5**：TreeView 条目应用替换  
   - 注册命令 `ai-proofread.wordCheck.applyReplaceForEntry`：取当前选中条目，在当前文档中将该条目的所有 variant 替换为 preferred（可选前后标记：无标记或使用上次/配置）。  
   - 在 `package.json` 中绑定 **Ctrl+Enter**（及可选 **Ctrl+Shift+Enter**），`when` 为焦点在字词检查视图。  
   - 预置检查与自定义检查的条目均支持该快捷键。

6. **Phase 6**：注释展示  
   - `WordCheckEntry.rawComment`；TreeView / 查看说明 中合并或优先显示 rawComment。

按此顺序可实现：**正则/非正则替换表**、**应用为提示 / 应用为替换（含前后标记）**、**TreeView 条目 Ctrl+Enter 应用替换**，并与现有预置检查共享同一套结果展示与定位逻辑。
