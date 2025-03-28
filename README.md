# AI Proofreader VS Code Extension

这是[一个基于AI的文档/图书校对VS Code插件](https://github.com/Fusyong/ai-proofread-vscode-extension)，支持文档切分和AI校对功能；与[相应的Python工具库](https://github.com/Fusyong/ai-proofread)的功能大致相同。

## 使用说明

### 1. 初始配置

1. 在 VS Code 设置中配置 API 密钥（必需）：
   * `ai-proofread.apiKeys.deepseekChat`: deepseek API 密钥
   * `ai-proofread.apiKeys.aliyun`: 阿里云 aliyun API 密钥(未充分测试)
   * `ai-proofread.apiKeys.google`: Google API 密钥(未充分测试)

2. 可选配置项：
   * `ai-proofread.proofread.model`: 选择默认校对模型（deepseek/aliyun/google，后两者未充分测试）
   * `ai-proofread.proofread.rpm`: 设置每分钟最大请求数（默认15）
   * `ai-proofread.proofread.maxConcurrent`: 设置最大并发请求数（默认3）
   * `ai-proofread.defaultSplitLength`: 设置默认切分长度（默认600字符）
   * `ai-proofread.defaultTitleLevels`: 设置默认标题切分级别（默认[2]）
   * `ai-proofread.currentPrompt`: 当前使用的提示词名称（空字符串表示使用系统默认提示词）
   * `ai-proofread.prompts`: 自定义AI校对提示词列表，最多5个。每个提示词必须包含名称和内容，内容必须对要校对的“目标文本（target）”“参考资料（reference）”“上下文（context）”进行说明

### 2. 提示词管理

通过命令面板（Ctrl+Shift+P）可以使用以下命令管理提示词：

1. **管理提示词** (AI Proofreader: set prompts)
   * 添加新的提示词
   * 编辑现有提示词
   * 清空所有提示词
   * 查看提示词内容预览

2. **选择提示词** (AI Proofreader: select prompt)
   * 在系统默认提示词和自定义提示词之间切换
   * 当前使用的提示词会显示勾号（✓）标记
   * 选择后会自动保存到配置中

### 3. 文档切分功能

右键点击编辑器，可以看到以下切分选项（或通过命令面板查找）：

1. **按长度切分** (Split File by Length)
   * 输入目标切分长度

2. **按标题切分** (Split File by Title)
   * 输入标题级别（如：1,2）

3. **带上下文切分** (Split File with Context)
   * 输入标题级别（即上下文范围）和切分长度

4. **高级切分** (Split File by Title and Length)
   * 可配置标题级别、阈值（过大则切分）、切分长度和最小长度（过小则合并）

切分后都生成同名的 `.json`（用于校对） 和 `.json.md`（用户查看切分情况） 两个结果文件。
所有切分操作都会生成日志文件（`.log`），记录切分统计信息。

### 4. JSON合并功能

1. **合并 JSON 文件** (Merge Two Files)
   * 打开已切分的 JSON 文件
   * 右键选择 "Merge Two Files"，选择要合并的文件
   * 确定要更新的字段和来源字段

### 5. AI 校对功能

1. **校对 JSON 文件** (Proofread File)
   * 打开已切分的 JSON 文件
   * 右键选择 "Proofread File"
   * 自动使用配置的默认模型进行校对
   * 支持进度显示和取消操作
   * 结果保存为 `.proofread.json` 文件

2. **校对选中文本** (Proofread Selection)
   * 仅支持 Markdown 或 ConTeXt 文件
   * 选中要校对的文本
   * 右键选择 "Proofread Selection"
   * 可选择是否使用上下文和参考文件
   * 结果在新窗口中显示

### 6. 日志和统计

* 所有操作都会生成详细的日志文件
* 日志包含：
  * 操作时间戳
  * 处理字数统计
  * 切分/校对详情
  * 错误信息（如果有）

### 7. 注意事项

1. 确保在使用前已正确配置 API 密钥
2. 长文本建议先切分后校对
3. 校对过程可以随时取消，已处理的内容会被保存
4. 注意 API 调用频率限制，可通过配置调整

## 开发命令

```bash
# 安装依赖
npm install

# 打包
npm run package

# 开发时实时编译
npm run watch

# 构建 vsix 扩展安装文件用
npm run package-vsix
```
