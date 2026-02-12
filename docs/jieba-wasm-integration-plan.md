# jieba-wasm 中文分词集成方案

本文档为 AI Proofreader 扩展集成 jieba-wasm 提供技术方案、实现步骤和后续应用规划。

**已定技术决策**：使用 **jieba-wasm**（WASM 绑定，无原生依赖）；采用与 sql.js 相同的「复制到 dist」打包策略；**按需加载**，避免影响扩展启动速度。

**实现状态**：阶段一（基础设施）已完成。可通过命令面板运行「AI Proofreader: test jieba (debug)」验证加载。

---

## 一、背景与目标

### 1.1 为何集成中文分词

- **相似度计算**：当前 `similarity.ts` 使用字符级 n-gram（默认 bigram）。对中文而言，词级粒度可提升对齐、引文匹配的语义准确性。
- **句子切分**：在分句、段落检测等场景中，可结合分词边界做更精细的处理。
- **字词检查**：xh7 等模块中，可按词匹配或过滤，减少误报。
- **预留扩展**：为后续可能的中文 NLP 功能（如关键词提取、词性标注）提供基础能力。

### 1.2 为何选择 jieba-wasm

| 对比项 | jieba-wasm | @node-rs/jieba |
|--------|------------|----------------|
| 依赖类型 | 纯 WASM，无 native | 平台原生二进制 |
| 打包兼容 | 与 sql.js 相同模式 | 需处理 platform optionalDependencies |
| 体积 | ~3.8 MB | ~11 MB（多平台） |
| 兼容性 | 无需担心 Node/Electron ABI | 需关注 Electron 版本 |
| 性能 | 略慢 | 约 1.35–2× 更快 |

结论：WASM 方案部署简单、兼容性稳定，优先采用；若后续性能成为瓶颈，可再评估 @node-rs/jieba。

---

## 二、技术方案

### 2.1 打包策略（参考 sql.js）

与 `docs/package-check-result.md` 中的 sql.js 方案一致：

- **node_modules** 继续被 `.vscodeignore` 排除。
- 构建时将 jieba-wasm 的 Node.js 产物复制到 `dist/`。
- 运行时从 **dist** 加载，无需依赖 node_modules。

### 2.2 jieba-wasm 模块结构

```
node_modules/jieba-wasm/pkg/nodejs/
├── jieba_rs_wasm.js        # JS 胶水，~10 KB
├── jieba_rs_wasm_bg.wasm   # WASM 二进制，~3.8 MB
├── jieba_rs_wasm.d.ts
└── jieba_rs_wasm_bg.wasm.d.ts
```

Node.js 环境下，`require('jieba-wasm')` 会解析到 `pkg/nodejs/jieba_rs_wasm.js`，该文件会从同目录加载 `.wasm`。因此需将 `jieba_rs_wasm.js` 与 `jieba_rs_wasm_bg.wasm` **一同**复制到 `dist/`，并保证运行时 `__dirname` 指向 dist 目录。

### 2.3 加载方式

**方案**：封装一个 `getJiebaWasm(distDir)` 函数，与 `referenceStore.ts` 中的 `getSqlJs(distDir)` 模式一致：

- 接受 `distDir`（如 `context.extensionPath + '/dist'`）。
- 通过 `require(path.join(distDir, 'jieba_rs_wasm.js'))` 加载。
- 若 jieba-wasm 的 Node 版本需要 `init`，则先 `await init()`；根据 [jieba-wasm 文档](https://github.com/fengkx/jieba-wasm)，Node 环境 `require` 后可直接使用 `cut` 等函数，无需显式 init。
- 按 distDir 缓存，避免重复加载。

---

## 三、实现步骤

### 3.1 依赖与构建配置

**package.json**

- 在 `dependencies` 中添加：`"jieba-wasm": "^2.4.0"`
- 在 `targets.main.includeNodeModules` 中添加：`"jieba-wasm": false`（不打包进 bundle，与 sql.js 一致）

**copy-sqljs-dist 扩写为 copy-wasm-dist**

- 保留 sql.js 的复制逻辑。
- 新增 jieba-wasm 的复制：

```text
node_modules/jieba-wasm/pkg/nodejs/jieba_rs_wasm.js     → dist/jieba_rs_wasm.js
node_modules/jieba-wasm/pkg/nodejs/jieba_rs_wasm_bg.wasm → dist/jieba_rs_wasm_bg.wasm
```

- 脚本可合并为一个 `copy-wasm-dist`，或拆为 `copy-sqljs-dist` + `copy-jieba-dist`，`package` 时依次执行。

### 3.2 .vscodeignore

- 无需额外排除：复制到 dist 后，dist 内文件会被打包进 VSIX；`node_modules` 已排除，不影响。
- 若 Parcel 生成带 hash 的 chunk（如 `jieba_rs_wasm.[hash].js`），可参考 sql.js 增加 `dist/jieba_rs_wasm.[0-9a-f]*.js` 的排除规则（视实际构建产出而定）。

### 3.3 封装模块：jiebaLoader.ts

新建 `src/jiebaLoader.ts`，提供：

```ts
// 类型声明（可从 jieba-wasm 的 .d.ts 抽取或本地声明）
export interface JiebaWasmModule {
  cut: (text: string, hmm?: boolean) => string[];
  cut_all?: (text: string, hmm?: boolean) => string[];
  cut_for_search?: (text: string, hmm?: boolean) => string[];
  tokenize?: (text: string, mode?: string, hmm?: boolean) => Array<{ word: string; start: number; end: number }>;
  add_word?: (word: string, freq?: number, tag?: string) => void;
  with_dict?: (dict: string) => void;
  // ... 其他需要的 API
}

let jiebaInitByDir: Map<string, () => Promise<JiebaWasmModule>> = new Map();

export function getJiebaWasm(distDir: string): Promise<JiebaWasmModule> {
  // 实现：require(path.join(distDir, 'jieba_rs_wasm.js')) 并缓存
}
```

**注意**：需实测 jieba-wasm Node 版本的导出形态（默认导出 vs 命名导出），并在 `getJiebaWasm` 中正确解包。

### 3.4 预期 VSIX 内容（增量）

在现有 content 基础上增加：

- `extension/dist/jieba_rs_wasm.js`（~10 KB）
- `extension/dist/jieba_rs_wasm_bg.wasm`（~3.8 MB）

VSIX 总增量约 3.8 MB，可接受。

---

## 四、后续应用场景（分阶段）

### 4.1 阶段一：基础设施（本次集成）

- 完成依赖、构建、加载封装。
- 不改变现有业务逻辑，仅提供 `getJiebaWasm` 供后续模块调用。
- 可选：在某个调试命令或测试入口中调用一次 `cut`，验证加载与运行正常。

### 4.2 阶段二：相似度增强（可选）

- 在 `similarity.ts` 中新增 `getWordNgrams(text, n, jieba)`：先用 jieba 分词，再对词序列做 n-gram。
- 提供配置项（如 `ai-proofread.alignment.useWordNgram`），在「字符 n-gram」与「词 n-gram」之间切换或加权组合。
- 影响范围：`sentenceAligner`、`citationMatcher` 等使用 `getNgrams` / `jaccardSimilarity` 的地方。

### 4.3 阶段三：字词检查与分句（可选）

- 字词检查：在 xh7 相关扫描中，利用分词结果做更细粒度的匹配或过滤。
- 分句：在 `splitter` 或 `paragraphDetector` 中，结合分词边界优化中文分句逻辑。

### 4.4 阶段四：高级功能（预留）

- 关键词提取（jieba-wasm 若支持 TF-IDF）。
- 自定义词典加载（`with_dict`），用于专业术语、人名地名等。

---

## 五、验收与测试

### 5.1 构建验收

- `npm run package` 成功，无报错。
- `dist/` 下存在 `jieba_rs_wasm.js`、`jieba_rs_wasm_bg.wasm`。
- `npx vsce package` 生成的 VSIX 中包含上述文件。

### 5.2 运行验收

- 在扩展宿主中调用 `getJiebaWasm(distDir)`，成功返回模块。
- 调用 `cut('中华人民共和国')`，得到预期分词结果（如 `['中华人民共和国']` 或 `['中華', '人民', '共和', '国']` 等，取决于词典）。

### 5.3 兼容性

- Windows / macOS / Linux 下均可运行（WASM 跨平台）。
- 无 C++ 工具链、node-gyp 等依赖，安装与分发简单。

---

## 六、参考

- [jieba-wasm 仓库](https://github.com/fengkx/jieba-wasm)
- [jieba-wasm npm](https://www.npmjs.com/package/jieba-wasm)
- [sql.js 集成方式](docs/package-check-result.md)
- [referenceStore.ts 中的 getSqlJs 实现](src/citation/referenceStore.ts)
