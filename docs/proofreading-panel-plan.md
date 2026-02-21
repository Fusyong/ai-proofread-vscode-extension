# Proofreading Panel 改造计划

将现有 webview 改造为相对完善的**校对流程控制台**，使用户能在该控制台上完成校对相关的主要操作。

---

## 一、现状分析

### 1.1 当前 webview 行为

- **触发时机**：仅在切分或校对完成后创建/更新面板
- **命令**：`ai-proofread.reopenResultPanel`（reopen result panel）
- **限制**：无 `currentProcessResult` 时提示「没有可显示的处理结果」，无法打开空面板
- **内容**：展示切分结果（统计、文件路径、操作按钮）+ 校对结果（同上）+ 进度条
- **操作**：查看 JSON/日志、比较差异、校对 JSON、生成差异文件、生成勘误表

### 1.2 文件命名规则（以 `测试.md` 为例）

| 文件 | 说明 |
|------|------|
| 测试.md | 主文档 |
| 测试.json | 切分结果 |
| 测试.json.md | 切分结果拼合（便于查看） |
| 测试.log | 切分日志 |
| 测试.proofread.json | 校对结果 |
| 测试.proofread.json.md | 校对结果拼合 |
| 测试.proofread.log | 校对日志 |
| 测试.proofread.html | jsdiff 差异文件 |
| 测试.alignment.html | 勘误表 |

### 1.3 配套文档的常见模式

- **合并语境**：用户可选择任意 JSON/Markdown 作为 context/reference 来源，无固定命名
- **可推断的配套**：与主文件同目录、同 basename 的 `.json`、`.proofread.json` 等，可由 basename 自动发现

---

## 二、用户初步设想（已采纳）

1. **命名**：webview 改名为 **Proofreading panel**；命令改名为 **open proofreading panel**
2. **空面板**：允许在无处理结果时打开空面板
3. **空面板功能**：
   - 选择要校对的主文件（Markdown）
   - 展示「切分文档 / 重新切分」按钮
   - 检查是否存在符合命名规则的配套文档（`.json`、`.proofread.json` 等）
   - 若有，则展示切分、校对相关信息和操作按钮
   - 提示用户自行确保文件之间的一致性

---

## 三、改造计划（分阶段）

### 阶段一：基础改造（MVP）

#### 3.1 命名与入口

| 项目 | 原 | 新 |
|------|----|----|
| 面板标题 | AI Proofreader Result Panel | Proofreading panel |
| 命令 ID | `ai-proofread.reopenResultPanel` | `ai-proofread.openProofreadingPanel`（保留旧 ID 作 alias 以兼容） |
| 命令标题 | reopen result panel | open proofreading panel |

#### 3.2 支持空面板

- 修改 `WebviewManager.reopenResultPanel` → `openProofreadingPanel`：
  - 无 `currentProcessResult` 时，创建**空状态**面板，而非提示「没有可显示的处理结果」
- 空状态 HTML：展示「选择主文件」区域 + 简要说明

#### 3.3 主文件选择与配套文档检测

- **主文件选择**：文件选择器，限定 `.md`、`.txt`、`.tex` 等可校对格式
- **配套文档检测**：根据主文件 basename，扫描同目录下是否存在：
  - `{basename}.json`
  - `{basename}.json.md`
  - `{basename}.log`
  - `{basename}.proofread.json`
  - `{basename}.proofread.json.md`
  - `{basename}.proofread.log`
- **展示逻辑**：
  - 无配套：仅显示「切分文档」按钮
  - 有 `.json` 无 `.proofread.json`：显示切分信息 +「重新切分」「校对 JSON 文件」
  - 有 `.proofread.json`：显示切分 + 校对信息 + 全部操作按钮
- **一致性提示**：在展示配套文档时，显示提示：「请自行确保主文件与切分/校对结果文件之间的一致性（如条目数、顺序等）。」

#### 3.4 切分模式选择

- 空面板或仅有主文件时，点击「切分文档」需弹出切分模式选择（复用现有 `split file` 逻辑）
- 「重新切分」：若已有 `.json`，可提示是否覆盖，再执行切分

### 阶段二：流程整合与体验优化

#### 3.5 合并入口

- 当存在 `{basename}.json` 时，在控制台增加「合并语境/参考资料」按钮
- 点击后调用现有 `merge two files` 流程（以当前 JSON 为当前文件，用户选择源文件）

#### 3.6 状态持久化（可选）

- 将「上次选择的主文件」存入 `workspaceState` 或 `globalState`
- 下次打开空面板时，可默认选中该文件并自动检测配套文档

### 阶段三：增强功能（建议）

#### 3.7 工作区扫描

- 提供「从工作区选择」：列出工作区内所有 `.md` 文件，用户点选作为主文件
- 或「最近使用」：记录最近 N 个主文件，便于快速切换

#### 3.8 校验与告警

- 当 `.json` 与 `.proofread.json` 条目数不一致时，在控制台显示醒目警告
- 提示用户：可删除 `.proofread.json` 重新校对，或使用合并/对齐功能手动处理

#### 3.9 进度与取消

- 切分、校对进行中，在控制台内展示进度条和「取消」按钮（复用现有 `ProgressTracker`）
- 避免用户只能通过通知或等待完成

#### 3.10 侧边栏视图（WebviewView）可选

- 调研将 Proofreading panel 改为 `WebviewView`，嵌入侧边栏
- 优点：常驻可见，不占主编辑区；缺点：空间较小，需适配布局

---

## 四、技术实现要点

### 4.1 数据结构扩展

- `ProcessResult` 增加可选字段 `mainFilePath`，用于空面板状态下「已选主文件但未执行切分」的场景
- 新增 `CompanionFiles` 接口，描述检测到的配套文档及其状态

### 4.2 配套文档检测函数

```typescript
// 伪代码
function detectCompanionFiles(mainFilePath: string): CompanionFiles {
  const dir = path.dirname(mainFilePath);
  const base = path.basename(mainFilePath, path.extname(mainFilePath));
  return {
    json: exists(path.join(dir, `${base}.json`)),
    jsonMd: exists(...),
    log: exists(...),
    proofreadJson: exists(...),
    proofreadJsonMd: exists(...),
    proofreadLog: exists(...),
  };
}
```

### 4.3 消息协议扩展

- 新增 webview 消息：`selectMainFile`、`splitDocument`、`resplitDocument`、`mergeContext` 等
- extension 侧根据当前状态（是否有主文件、是否有配套）响应不同逻辑

### 4.4 兼容性

- 保留 `ai-proofread.reopenResultPanel` 为 `ai-proofread.openProofreadingPanel` 的别名，避免旧快捷键/配置失效

---

## 五、建议与补充

### 5.1 建议一：流程状态机

将校对流程抽象为状态：`无主文件` → `有主文件` → `已切分` → `已校对`。控制台根据当前状态展示对应的操作按钮，避免无效操作（如未切分就点「校对 JSON」）。

### 5.2 建议二：一键式「切分 → 校对」

在用户确认切分参数后，提供「切分并校对」选项，自动完成切分后立即启动校对，减少点击次数。

### 5.3 建议三：差异查看入口前置

在控制台显眼位置放置「比较前后差异」「生成勘误表」入口，而不是藏在二级操作中，方便用户快速核验结果。

### 5.4 建议四：文档准备快捷入口

在空面板或主文件区域，增加「文档准备」折叠区，链接到：
- 整理段落（format paragraphs）
- 根据目录标记标题（mark titles from toc）
- 转换 docx/PDF 为 Markdown

便于用户在同一界面完成「准备 → 切分 → 校对 → 查看」的完整流程。

### 5.5 建议五：提示词与配置快捷入口

在控制台底部或设置区域，提供「当前提示词」「当前模型/温度」的简要展示，以及「管理提示词」「打开设置」的快捷链接，减少切换到命令面板的次数。

---

## 六、实施顺序建议

1. **阶段一**：命名、空面板、主文件选择、配套检测、切分/重新切分按钮 ✅
2. **阶段二**：合并入口、状态持久化 ✅
3. **阶段三**：工作区扫描、校验告警、进度展示优化 ✅
4. **已实现**：文档准备快捷入口、提示词与配置快捷入口、重新切分覆盖确认
5. **可选**：侧边栏 WebviewView、一键切分并校对

---

## 七、相关文件

- `src/ui/webviewManager.ts`：核心改造
- `src/extension.ts`：命令注册
- `src/commands/fileSplitCommandHandler.ts`：切分逻辑复用
- `src/commands/proofreadCommandHandler.ts`：校对逻辑复用
- `package.json`：命令与菜单配置
- `src/utils.ts`：`FilePathUtils.getFilePath` 等路径工具

---

*文档版本：v1.0 | 创建日期：2025-02*
