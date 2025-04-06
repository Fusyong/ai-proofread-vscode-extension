一个用于文档和图书校对、基于大语言模型的VS Code插件，支持选中文本直接校对和长文档切分后校对两种工作流，[这里是代码库](https://github.com/Fusyong/ai-proofread-vscode-extension)。本插件与[相应的Python校对工具库](https://github.com/Fusyong/ai-proofread)的功能大致相同。

A VS Code extension for document and book proofreading based on LLM services, supporting two workflows: proofreading selected text directly and proofreading long documents after segmentation. [Here is the code repository](https://github.com/Fusyong/ai-proofread-vscode-extension). This extension has roughly the same functions as [the corresponding Python proofreading tool library](https://github.com/Fusyong/ai-proofread).

## 1. 安装和必要配置

在VS Code中插件界面（Ctrl+Shift+X）搜索AI Proofreader，点击安装按钮install安装。

安装后点击设置按钮⚙️，选中弹出菜单中的设置项Settings，选择下面的一个大语言模型服务平台并填写其秘钥（须到这些平台中注册以获得秘钥）：[Deepseek开放平台](https://platform.deepseek.com/)、[阿里云百炼](https://bailian.console.aliyun.com/)、[Google Gemini](https://aistudio.google.com/)。

## 2. 功能便览

1. **直接校对：**
   1. 打开markdown等文本文件，选中一段文字
   2. 打开右键菜单，使用其中的AI proofreader: proofread selection项校对选中文本
   3. 其间可选上下文范围、参考文本和温度
   4. 最后会自动展示校对前后的差异

2. **切分后校对：**
   1. 打开markdown文档，打开右键菜单，使用其中的AI proofreader: split ... 选项中的一个，把当前的切分为JSON文档
   2. 打开上述JSON文档，打开右键菜单，使用其中的AI proofreader: proofread file选项，批量校对切分好的片段
   3. 最后会提示你查看结果：前后差异、差异文件、JSON结果、日志文件

打开命令面板（Ctrl+Shift+P）能查看和使用所有命令：

![所有命令](https://blog.xiiigame.com/img/2025-03-28-%E7%94%A8%E4%BA%8EAI%E5%9B%BE%E4%B9%A6%E6%A0%A1%E5%AF%B9%E7%9A%84vscod%E6%89%A9%E5%B1%95/Code_LzE5PiE7EW.png)

## 3. 使用说明

### 3.1. 配置

请在 VS Code 设置中进行配置（Ctrl+, 打开设置）。

1. **平台选择**：
   * `ai-proofread.proofread.platform`: 选择大模型服务平台（deepseek/aliyun/google）

2. **API密钥配置**（**以上选中平台必须配置**）：
   * `ai-proofread.apiKeys.deepseek`: Deepseek开放平台 API 密钥
   * `ai-proofread.apiKeys.aliyun`: 阿里云百炼平台 API 密钥
   * `ai-proofread.apiKeys.google`: Google Gemini API 密钥

3. **模型选择**
   * `ai-proofread.proofread.models.deepseek`: Deepseek开放平台模型选择（deepseek-chat/deepseek-reasoner）
   * `ai-proofread.proofread.models.aliyun`: 阿里云百炼模型选择（deepseek-v3/deepseek-r1/qwen-max-2025-01-25/qwen-plus）
   * `ai-proofread.proofread.models.google`: Google Gemini模型选择（gemini-2.0-flash/gemini-2.0-flash-lite/gemini-2.0-flash-thinking-exp-01-21/gemini-2.5-pro-exp-03-25）

1. **校对相关**：
   * `ai-proofread.proofread.rpm`: 每分钟最大请求数（默认15）
   * `ai-proofread.proofread.maxConcurrent`: 最大并发请求数（默认3）
   * `ai-proofread.proofread.temperature`: 模型温度（默认1.0，取值范围[0:2)）
   * `ai-proofread.proofread.defaultContextLevel`: 校对选中文本时默认使用的标题级别，作为上下文范围（默认0，表示不使用）

2. **文档切分相关**：
   * `ai-proofread.defaultSplitLength`: 默认的文本切分长度（默认600字符）
   * `ai-proofread.defaultTitleLevels`: 默认的标题切分级别（默认[2]，表示按二级标题切分）
   * `ai-proofread.contextSplit.cutBy`: 带上下文切分模式下的切分长度（默认600）
   * `ai-proofread.titleAndLengthSplit.threshold`: 标题加长度切分时的段落长度阈值（默认1500）
   * `ai-proofread.titleAndLengthSplit.cutBy`: 标题加长度切分时的目标长度（默认800）
   * `ai-proofread.titleAndLengthSplit.minLength`: 标题加长度切分时的最小长度（默认120）

3. **提示词管理**：
   * 必须通过命令面板选择提示词
   * 一般用户建议通过命令面板（Ctrl+Shift+P）设置提示词
   * 或通过设置项`ai-proofread.prompts`设置:
     - 每个提示词必须包含名称和内容
     - 内容必须对目标文本（target）、参考资料（reference）、上下文（context）进行说明

4. **调试**：
   * `ai-proofread.debug`: 是否显示调试日志（默认false）

### 3.2. 切分文档

打开markdown文件，右键点击编辑器，可以看到以下切分选项（或通过命令面板查找）：

![切分文档](https://blog.xiiigame.com/img/2025-03-28-%E7%94%A8%E4%BA%8EAI%E5%9B%BE%E4%B9%A6%E6%A0%A1%E5%AF%B9%E7%9A%84vscod%E6%89%A9%E5%B1%95/Code_1w0X1wqgyf.png)

1. **按标题切分** (Split File by Title)
   * 输入标题级别（如：1,2）
2. **按长度切分** (Split File by Length)
   * 输入目标切分长度
3. **按标题和长度切分** (Split File by Title and Length)
   * 可配置标题级别、阈值（过大则切分）、切分长度和最小长度（过小则合并）
4. **带上下文切分** (Split File with Context)
   * 输入标题级别作为上下文范围，输入切分长度

切分后都生成同名的 `.json`（用于校对） 和 `.json.md`（可查看切分情况） 两个结果文件。
切分操作都会生成日志文件（`.log`），记录切分统计信息。

**请注意，文档切分依赖文本中的两种标记：**（一）空行。在markdown中，一个或多个空行表示分段，没有空行的断行在渲染时被忽略。（二）各级标题。如`## `开头的是二级标题。没有这些标记的文本就无法切分。

### 3.3. 合并JSON

打开JSON文件，右键点击编辑器，可以看到以下切分选项（或通过命令面板查找）：

![校对功能](https://blog.xiiigame.com/img/2025-03-28-%E7%94%A8%E4%BA%8EAI%E5%9B%BE%E4%B9%A6%E6%A0%A1%E5%AF%B9%E7%9A%84vscod%E6%89%A9%E5%B1%95/Code_K2nKGGM9Nj.png)

**合并 JSON 文件** (Merge Two Files)：

1. 打开已切分的 JSON 文件
2. 右键选择Merge Two Files，选择要合并的文件
3. 确定要更新的字段和来源字段

假设你校对一本书，这时可以按相同的切分结构准备上下文文本和参考文本，同样切分后，上下文文本、参考文本中的target作为context、reference合并。这样，大模型就会参考context、reference来校对你书稿中的target。

### 3.4. 校对文档和选段

菜单见上两图。

1. **校对 JSON 文件** (Proofread File)
    1. 打开已切分的 JSON 文件
    2. 右键选择Proofread File
    3. 自动使用配置的默认值进行校对
    4. 支持进度显示和取消操作
    5. 最后会提示你查看结果
    6. 并生成日志

2. **校对选中文本** (Proofread Selection)
    1. 打开文本文件（支持常见文本文件，推荐使用Markdown）
    2. 选中要校对的段落
    3. 从右键菜单中选择 Proofread Selection
    4. 可选择上下文范围、参考文件和温度
    5. 最后会自动展示校对前后的差异
    6. 并生成日志

### 3.5. 管理提示词

通过命令面板（Ctrl+Shift+P）可以**管理提示词** (AI Proofreader: set prompts)和**选择当前使用的提示词** (AI Proofreader: select prompt)

在自定义提示词中，必须对要处理的目标文本（target）、参考资料（reference）、上下文（context）进行说明，如果用不到后两者也可以不说明。

本插件的工作原理是，为三种文本添加标签（target、reference、context），然后提交给大语言模型进行处理。而处理的方法和目的则由提示词来定义。这就是说，**你可以通过自己的提示词，让AI根据三种文本做你期望的任何处理，** 比如撰写大意、插图脚本、练习题、注释，绘制图表，注音，翻译，进行专项核查（专名统一性、内容安全、引文、年代、注释等）……尽情发挥你的想象力吧！

也可以在配置文件中处理提示词，但不适合没有编程知识的用户使用。

### 3.6. 日志

切分和校对会生成对应的.log文件，方便检查。

### 3.7. 模型温度

每个模型用于校对的最佳温度需要耐心测试才能得到。

以往的经验是，温度为1时极少有错误和无效改动。

提高模型温度可以增加随机性，如此多次尝试有可能提高召回率，同时也增加不稳定和错误率。

以下是官方资料：

#### 3.7.1. deepseek

`temperature` 参数默认为 1.0。

官方建议根据如下表格，按使用场景设置 `temperature`。

| 场景                | 温度 |
| ------------------- | ---- |
| 代码生成/数学解题   | 0.0  |
| 数据抽取/分析       | 1.0  |
| 通用对话            | 1.3  |
| 翻译                | 1.3  |
| 创意类写作/诗歌创作 | 1.5  |

#### 3.7.2. 阿里云百炼平台

* deepseek v3/r1: temperature：0.7（取值范围是`[0:2)`）
* qwen系列: 取值范围是`[0:2)`

#### 3.7.3. Google Gemini

默认为1

### 3.8. 注意事项

1. 确保在使用前已正确配置必要 API 密钥
2. 长文本建议先切分后校对
3. 校对过程可以随时取消，已处理的内容会得到保存，重新校对时不会重复处理
4. 注意所用模型 API 调用频率限制，可通过配置调整


## 4. 开发命令

```bash
# 安装依赖
npm install

# 开发时实时编译
npm run watch

# 打包
npm run package

# 构建 vsix 扩展安装文件用
npm run package-vsix

# 发布
npm run publish
```
