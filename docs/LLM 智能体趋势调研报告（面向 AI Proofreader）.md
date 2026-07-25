# LLM 智能体趋势调研报告（面向 AI Proofreader）

**调研日期**：2026 年 7 月  
**对象项目**：[ai-proofread-vscode-extension](https://github.com/Fusyong/ai-proofread-vscode-extension)  
**调研范围**：OpenWorker、Work Buddy、开源智能体框架、MCP 基础工具、Agentic RAG、Cursor Skills 等

---

## 总览：2026 年智能体设计的几条主线

当前主流智能体产品/框架，虽面向场景不同（编程、知识工作、桌面自动化），但架构上已收敛到若干共同模式：

| 模式 | 含义 | 典型代表 |
|------|------|----------|
| **交付物导向** | 不只聊天，而是产出文档、补丁、结构化结果 | OpenWorker |
| **网关 + 能力注册表** | 少量固定工具入口，运行时动态发现能力 | Work Buddy `wb_*` |
| **Plan → Execute → Verify** | 规划、执行、验证分阶段，可续跑 | 本项目的 referencePrep |
| **混合检索 + LLM 精排** | BM25/向量/grep 融合，再用小模型打分 | Agentic RAG、本项目 v1.11 |
| **多模型路由** | 不同管线用不同模型，控制成本 | aisuite、本项目 modelRoutes |
| **分级权限 / 人工审批** | read / write / exec / external 分层 | OpenWorker |
| **渐进式上下文加载** | Skills 只按需加载，省 token | Cursor Agent Skills |
| **过程文件 + 可恢复状态** | 长任务持久化、续跑、审计 | 本项目 `.referenceprep.json` |

**对本项目的定位**：AI Proofreader 已具备「轻量 Agentic RAG + 编辑记忆 + 多模型路由」雏形，与通用 coding agent 不同，其核心是**出版编辑工作流**而非开放式工具调用。以下分系统逐一报告，末尾给出可落地的改进建议。

---

## 报告一：OpenWorker（Andrew Ng，MIT，2026.7）

**定位**：本地优先的桌面 AI 同事，强调**交付成品**（报告、日历更新、Slack 回复），而非对话 transcript。

### 架构（四层，全本地）

1. **Desktop Shell**：Tauri 2 + React 18，监督 Python 服务进程  
2. **Local Agent Server**：Python 3.10+ / FastAPI / uvicorn，`127.0.0.1:8765`，默认最多 **12 轮** model↔tool 迭代  
3. **Capability Layer**：文件、git、ripgrep、shell、todo + MCP 连接器  
4. **Model Router**：基于 **aisuite**，统一 OpenAI 风格接口，支持云端 API 与 Ollama 本地模型  

### 安全模型

四级权限：`read` → `write_local` → `exec` → `external`；`exec` 和 `external` 须人工批准。

### 值得参考的模块

| 模块 | 做法 | 对本项目的启示 |
|------|------|----------------|
| **迭代上限** | 默认 12 轮 tool loop | referencePrep 的 `maxRounds`、强度预设可显式展示「预算已用/剩余」 |
| **aisuite 模型路由** | `provider:model` 字符串切换 | 与现有 `modelRoutes` 思路一致，可借鉴「继承链」的可视化 |
| **Tool Policy** | 工具策略与权限绑定 | 校对写回、批量替换等「有副作用」操作，可分级确认 |
| **交付物导向 UI** | 展示 artifact 而非 raw chat | TreeView + diff 已是正确方向；可强化「本轮产出摘要」 |
| **MCP 原生支持** | 能力层标准接入 | 未来可把 MDict、grep、维基百科封装为 MCP server，供其他 agent 复用 |

### 不太适合直接照搬的部分

- Tauri 桌面壳：本项目已是 VS Code 扩展，无需另起桌面应用  
- 25+ 通用连接器：编辑场景连接器应更专（词典、古籍库、引文库）  
- 定时自动化 / cron：出版校对多为交互式，优先级较低  

---

## 报告二：Work Buddy（KadenMc，GPL-3.0）

**定位**：面向知识工作者的**个人 agent 运行时**，构建于 Claude Code + Obsidian，强调跨会话记忆与多工具协调。

### 架构要点

```
Claude Code Session
       ↓
MCP Gateway (localhost:5126)  ← 仅 6 个 wb_* 固定工具
       ↓
Capability Registry + Workflow Conductor
       ↓
Core Services (Messaging / Embedding / Dashboard / Telegram)
       ↓
Integrations (Obsidian / Hindsight Memory / Calendar / Chrome)
```

### 核心设计：网关模式（Gateway Pattern）

不把上百个工具直接暴露给 LLM，而是：

| 工具 | 作用 |
|------|------|
| `wb_init` | 注册会话（必须首调） |
| `wb_search` | 自然语言搜索能力/工作流 |
| `wb_run` | 执行能力或启动工作流 |
| `wb_advance` | 推进多步工作流到下一步 |
| `wb_status` | 进度/健康状态 |
| `wb_step_result` / `wb_capability_result` | 大结果按需拉取（对话内只留摘要） |

**Workflow Conductor**：多步工作流是有向依赖图；**纯数据步骤确定性执行**，只在需要判断时才调用 LLM。

### 值得参考的模块

| 模块 | 做法 | 对本项目的启示 |
|------|------|----------------|
| **能力注册表 + 语义搜索** | `wb_search` 动态发现 | 校对面板命令很多；可做「意图 → 命令/工作流」路由层 |
| **Conductor 分离** | 代码步骤 vs LLM 步骤 | referencePrep 的检索/融合/去重已是代码步骤；规划/精排是 LLM 步骤——架构清晰，可文档化 |
| **结果 elision** | 大响应不进对话，按需 fetch | TreeView 命中项 + `referenceprep.json` corpus 已是此模式；可统一「摘要进 prompt、全文进 corpus」规范 |
| **Knowledge Store 自描述** | 文档与 agent 知识同源生成 | 可把 `docs/knowledge-verify-plan.md` 等计划文档作为 agent 可读知识库 |
| **Session Ledger** | 会话账本、可审计 | `.referenceprep.log` + 过程 JSON 可扩展为完整 trace |
| **Sidecar Supervisor** | 服务健康检查、自动重启 | 若未来拆出独立检索服务（如向量索引），可参考 |

### 与本项目的天然对应

Work Buddy 的 Obsidian vault ≈ 本项目的 Markdown 参考文献库 + 工作区文档  
Work Buddy 的 embedding 服务 ≈ 本项目的 BM25 + 轻量向量索引  
Work Buddy 的 Hindsight Memory ≈ 本项目的 `editorial-memory.json`

---

## 报告三：WorkBuddy Bench（Tencent）与评测基础设施

**说明**：与 KadenMc 的 Work Buddy **不是同一产品**。Tencent 的 WorkBuddy Bench 是**编码 agent 评测框架**，基于 Harbor，用 Docker 沙箱跑任务、打分、产出轨迹报告。

### 架构

- 任务数据集（HuggingFace）  
- Agent CLI harness 注入沙箱  
- 捕获 patch、trajectory、测试结果、效率指标  
- 内置 `wbbench-run-setup` skill 引导端到端配置  

### 对本项目的启示（评测而非产品架构）

| 做法 | 可借鉴之处 |
|------|------------|
| **角色化任务集** | 编辑、审校、引文核对、知识核查各建 benchmark 片段 |
| **结构化评分** | EM/F1 式指标 → 校对可改为「应改未改 / 误改 / 漏改」三元组 |
| **Trajectory 记录** | 记录 planning JSON、检索 hit、精排分、最终 diff |
| **Skill 驱动 setup** | 为新用户提供 `/setup-knowledge-verify` 式引导 skill |

本项目 README TODO 中的「memo 管理智能体」若落地，**应先有评测集再迭代架构**，WorkBuddy Bench 提供了方法论参考。

---

## 报告四：MCP（Model Context Protocol）生态

MCP 已成为 2025–2026 年 agent 与外部工具连接的**事实标准**（JSON-RPC，Host → Client → Server）。

### 2026 生产实践要点

1. **工具设计**：单职责、5–15 个工具/服务器；JSON Schema 严格类型；明确标注 read vs write  
2. **网关/代理模式**：集中鉴权、日志、限流  
3. **身份传播**：CABP 等扩展解决「confused deputy」问题  
4. **有状态 vs 无状态**：2026 RC 支持无状态模式，便于水平扩展  
5. **Tasks 扩展**：长任务不阻塞连接  

### 对本项目的 MCP 化建议

当前能力（MDict 查词、grep 文献库、BM25/向量检索、维基百科 API）都在扩展内部。可考虑：

```
ai-proofread-mcp-server/
  tools/
    lookup_dict       # 读
    grep_references   # 读
    search_bm25       # 读
    search_vector     # 读
    search_wikipedia  # 读（external，需限速）
    prepare_reference # 组合工具（plan 仍由宿主 LLM 做）
```

**好处**：
- 能力可被 Cursor / Claude Code / OpenWorker 等复用  
- 与 VS Code 扩展解耦，Python/Node 各自选型  
- 权限边界清晰（全为 read，写操作留在扩展 UI）  

**优先级**：中等——适合 v2 架构，短期可在扩展内继续迭代。

---

## 报告五：OpenHands / 编程 Agent SDK

**定位**：开源编程 agent 平台，模块化 SDK（`openhands.sdk` + tools + workspace + agent_server）。

### 核心架构

| 组件 | 设计 |
|------|------|
| **Agent** | 无状态 reasoning loop：LLM → tool → observation → 循环 |
| **Tool System** | Action → Observation，Pydantic 类型安全 |
| **Condenser** | 上下文压缩，接近 token 上限时触发 |
| **Security Analyzer** | 执行前风险评估 |
| **Skills (Microagents)** | 行为模块，修改 agent 行为 |
| **MCP** | 原生集成，运行时 discovery |
| **Workspace** | Local / Docker / Remote 抽象 |

### 值得参考的模块

| 模块 | 对本项目的启示 |
|------|----------------|
| **Condenser** | 编辑记忆超限时，除 weight 淘汰外，可做 LLM 摘要压缩（README TODO「存档、压缩工作流」） |
| **Security Analyzer** | 批量替换、写回选区前做风险分析（已有 caution，可程序化） |
| **无状态 Agent + 有状态 Conversation** | referencePrep runner 已是此模式：runner 无状态，`.referenceprep.json` 持有状态 |
| **Tool Registry 动态发现** | 资料来源（dict/grep/bm25/vector/wiki）可注册为统一 adapter 接口（已基本实现） |

### 不太相关部分

Docker 沙箱、bash 执行、GitHub workflow——与图书校对关系弱。

---

## 报告六：Agent 框架对比（LangGraph / CrewAI / aisuite / Microsoft Agent Framework）

### 架构范式三分法

| 框架 | 协调原语 | 适用场景 |
|------|----------|----------|
| **LangGraph** | 有向图 + 共享 typed state + checkpoint | 复杂分支、人工介入、生产级状态机 |
| **CrewAI** | Role + Task + Crew，任务输出传递 | 快速原型、角色分工（Researcher/Writer） |
| **AutoGen / MAF** | Actor 异步消息传递 | .NET/Azure 企业、对话式多 agent |
| **aisuite** | 轻量 Agent + Runner + max_turns | 最小依赖、多 provider 切换 |

### 与本项目 referencePrep 的映射

本项目的知识核查流程**已接近 LangGraph 的 plan-and-execute**：

```
Phase 0 资源范围 → Phase A 多轮规划 → 多通道检索 → 融合 → LLM 精排 → Phase B 校对
```

Agentic RAG 消融研究（HotpotQA，2026）的关键发现与本项目高度相关：

1. **固定混合检索** 往往优于规则自适应路由（过度路由 BM25 会损失 dense 信号）  
2. **2 轮检索** 通常捕获 95% 增益，更深循环收益递减  
3. **查询分解 + cross-encoder 精排** 各贡献显著但增量较小  
4. **简单查询走经典 RAG，复杂查询走 agent loop** 的混合路由是生产最佳实践  

**对本项目的建议**：
- 保持「强度预设」（轻量/标准/深入）控制轮次，而非无限 agent loop  
- 预筛（Phase 0）已有；可加强「简单段落跳过规划，直接 grep 关键词」的 fast path  
- 精排可用更小模型（已在 modelRoutes 中支持 inherit）  

### aisuite 特别值得注意

aisuite 是 OpenWorker 的底层，三层堆叠：

```
Chat Completions（统一 API）
    ↓
Agent API（tools + max_turns + tracing）
    ↓
OpenWorker（桌面 harness）
```

若未来把 referencePrep 抽成独立 Python 服务（便于测试、复用），**aisuite 是比 LangGraph 更轻的起手点**——本项目已是 TypeScript，但 Python 侧词典/grep 管道可考虑。

---

## 报告七：Agentic RAG 与检索增强趋势

### 2026 标准 pipeline

```
Query → [Classifier: simple vs complex]
         ├─ simple → single-pass retrieval → answer
         └─ complex → Decompose → Hybrid Retrieve (BM25+Vector+RRF)
                      → Rerank → Synthesize → Critic/Judge
                      → (insufficient?) → Rewrite query → loop (budgeted)
```

### 本项目已实现的 Agentic RAG 组件

| 组件 | 本项目实现 | 行业最佳实践 |
|------|------------|--------------|
| 资源预筛 | Phase 0 ResourceScope | ✓ 对齐 |
| 查询规划 | LLM plan JSON | ✓ 对齐 |
| 混合检索 | dict + grep + BM25 + vector + wiki | ✓ 对齐 |
| 融合 | fusion.ts | RRF 是标准做法 |
| 精排 | LLM rerank | cross-encoder 更省 token，LLM rerank 更灵活——可 A/B |
| 结构化 corpus | `.referenceprep.json` v0.2 | ✓ 优于纯 chat history |
| 续跑 | continuation 追加 1 轮 | ✓ 对齐 checkpoint 思想 |
| Critic loop | 精排 + prune + sufficient 标志 | 部分对齐；缺独立的「证据不足 → 重写查询」环 |

### 可改进方向

1. **Critic / Judge 节点**：精排后增加轻量「证据是否足够支撑核查」判断，触发续跑而非一律进入校对  
2. **Cross-encoder 精排选项**：对高 volume 候选，先用本地 cross-encoder（如 ms-marco-MiniLM）再 LLM 精排 top-K  
3. **Adaptive routing 谨慎使用**：消融研究显示规则路由易 over-route；本项目多通道并行 + 融合更稳妥  
4. **Trace / 可观测性**：DuckDB 式 per-item trace（agentic-rag-eval 做法）便于调试「为何漏检」  

---

## 报告八：Cursor Agent Skills 与开放标准

### Skills 三层渐进加载

1. **Discovery**：仅 name + description 进上下文（~100 tokens/skill）  
2. **Activation**：任务匹配时加载完整 SKILL.md  
3. **On demand**：scripts/、references/ 执行时才加载  

### Skills vs Rules vs MCP

| 层 | 作用 | 例子 |
|----|------|------|
| **Rules** | 全局静态约束 | 校对风格、禁用词 |
| **Skills** | 按需工作流剧本 | 「知识核查选段」「引文核对」「拼音审校」 |
| **MCP** | 工具/数据连接 | 词典、文献库、维基百科 |

### 对本项目的启示

本项目的**预置提示词 + 命令组合**本质上已是 skill 雏形，但未标准化：

| 现有能力 | 可封装为 Skill |
|----------|----------------|
| knowledge verify selection | `knowledge-verify-selection/SKILL.md` |
| prepare references for JSON | `batch-reference-prep/SKILL.md` |
| proofread selection with memory | `proofread-with-memory/SKILL.md` |
| verify selected citation | `citation-verify/SKILL.md` |

**Skill 内容应包含**：何时使用、步骤顺序、选哪些资料来源、强度预设、预期 token 费用警告、结果查看方式（TreeView 路径）。

README TODO 中的「memo 管理智能体」非常适合做成 **Category 3 Skill（MCP Enhancement）**：MCP 提供记忆读写，Skill 提供「三段式原文/改后/说明 + 分类标签 + 压缩存档」流程。

---

## 报告九：编辑记忆（Editorial Memory）与持久化 Agent 记忆趋势

### 行业做法对比

| 系统 | 记忆模型 |
|------|----------|
| Work Buddy / Hindsight | 跨会话向量 + 结构化 ledger |
| OpenWorker | todo + 文件 artifact |
| LangGraph | Checkpointer（SQLite/Postgres） |
| **本项目** | `editorial-memory.json`：global（weight/note）+ currentRounds 栈 |

### 本项目优势

- **结构化 patch**（`global_ops` + `current_round_flat`）而非纯 chat log  
- **weight 淘汰 + archive** 已有雏形  
- **与校对流程绑定**（accept 后 merge）  

### 与 README TODO 的对照

TODO 第 2 项「memo 管理智能体」的行业对标：

```
三段式：原文 / 改后 / 说明          → 已有 schemaV2 基础
分类、加标签                        → 需扩展 intent/tag 字段
字词层穷尽 / 句段层格式说明          → 可参考 Work Buddy 的 knowledge unit
存档、压缩工作流                    → 参考 OpenHands Condenser + LangGraph checkpoint
```

**建议架构**：独立 `EditorialMemoryAgent` 管线（modelRoute: `editorialMemoryMerge` 已有），增加：
- 周期性 **compress** 命令（LLM 合并相似 global 条目）  
- **tag 路由**（注入时按当前任务类型筛选 memory 子集）  
- **human-in-the-loop** 审批新 global 规则（类似 OpenWorker external 审批）  

---

## 综合建议：按优先级排列的改进路线图

### P0 — 低成本、高对齐（1–2 个版本）

1. **工作流 Skill 化文档**：为知识核查、引文核对、带记忆校对写标准 SKILL.md，供 Cursor 用户与内部测试复用  
2. **Agent 预算可视化**：referencePrep 在 TreeView/面板显示「规划轮次 / 检索次数 / token 估算 / 续跑状态」  
3. **Fast path 路由**：短段落、单一专名 → 跳过完整规划，直接 dict lookup  
4. **Critic 节点**：`sufficient: false` 且 corpus 为空时，自动建议续跑或降强度，而非静默进入校对  

### P1 — 架构增强（中期）

5. **MCP Server 抽取**：只读检索能力 MCP 化，扩展作 Host  
6. **Cross-encoder 精排选项**：与 LLM rerank 并列，用户可选  
7. **Editorial Memory Agent 完整化**：压缩、标签、审批流（对应 README TODO #2）  
8. **Trace 导出**：`.referenceprep.json` 增加 per-query 决策链，便于复盘漏检  

### P2 — 探索性（长期）

9. **aisuite / 独立 Python agent 服务**：若检索逻辑继续膨胀，抽服务 + VS Code 作 UI  
10. **WorkBuddy Bench 式评测集**：建立 50–100 段标准书稿 + 期望改动，回归测试 prompt/检索变更  
11. **MCP external 连接器**：识典古籍、读秀等（README TODO #7）作 external 级，需明确限速与 ToS  

---

## 结论

AI Proofreader 在 v1.11 的 **referencePrep（Agentic RAG）+ modelRoutes + editorial memory** 已走在行业主线上，与 OpenWorker、Work Buddy、LangGraph 式 agent 共享大量设计 DNA，但场景更垂直（出版校对而非通用 automation）。

**最值得借鉴的不是某个产品的 UI**，而是：

1. **Work Buddy 的网关 + conductor** → 简化用户面对的命令面，复杂工作流后台编排  
2. **OpenWorker 的权限分级与迭代预算** → 写回/批量操作的安全感  
3. **Agentic RAG 消融结论** → 固定混合检索 + 有限轮次 + 精排，避免 over-engineer  
4. **Cursor Skills 标准** → 把已有提示词/命令包装为可发现、可复用的 skill  
5. **MCP** → 检索能力外化，扩展专注编辑 UX  

若你希望，我可以把本报告保存为 `docs/agent-landscape-research-2026.md`，或针对某一节（例如「仅 MCP 化方案」或「Editorial Memory Agent 详细设计」）展开成独立设计文档。