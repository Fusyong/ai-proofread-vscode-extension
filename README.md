
这是[一个基于AI的文档/图书校对VS Code插件](https://github.com/Fusyong/ai-proofread-vscode-extension)，支持文档切分和AI校对功能；与[相应的Python工具库](https://github.com/Fusyong/ai-proofread)的功能大致相同。

## 功能概览

1. **直接校对：** 选中markdown等文本文件中的一段文字，并可选上下文和参考文本，提交大语言模型进行处理
2. **切分后校对：**
   1. **切分markdown为JSON：** 把markdown等文本文件切分为JSON文件，并生成带切分标记的markdown文件以便检查
   2. **合并JSON（可选）：** 把JSON文件的target、context或reference材料，作为target、context或reference合并到另一个JSON文件中
   3. **校对JSON：** 把上述JSON文件提交大语言模型进行处理

打开命令面板（Ctrl+Shift+P）能查到所有命令：

![所有命令](https://blog.xiiigame.com/img/2025-03-28-%E7%94%A8%E4%BA%8EAI%E5%9B%BE%E4%B9%A6%E6%A0%A1%E5%AF%B9%E7%9A%84vscod%E6%89%A9%E5%B1%95/Code_LzE5PiE7EW.png)

## 使用说明

### 初始配置

请在vscode的Setting中进行配置。

1. 在 VS Code 设置中配置 API 密钥（**必需**）：
   * `ai-proofread.apiKeys.deepseek`: deepseek API 密钥
   * `ai-proofread.apiKeys.aliyun`: 阿里云百炼平台 API 密钥(**未充分测试**)
   * `ai-proofread.apiKeys.google`: Google Gemini API 密钥(**未充分测试**)
2. 可选配置略


### 切分文档

右键点击编辑器，可以看到以下切分选项（或通过命令面板查找）：

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
所有切分操作都会生成日志文件（`.log`），记录切分统计信息。

请注意，文档切分依赖文本中的两种标记：（一）空行（在markdown中表示分段，没有空行的断行在渲染时被忽略）；（二）各级标题（如`## `开头的是二级标题）。没有这些标记的文本就无法切分。

### 合并JSON

![校对功能](https://blog.xiiigame.com/img/2025-03-28-%E7%94%A8%E4%BA%8EAI%E5%9B%BE%E4%B9%A6%E6%A0%A1%E5%AF%B9%E7%9A%84vscod%E6%89%A9%E5%B1%95/Code_K2nKGGM9Nj.png)

1. **合并 JSON 文件** (Merge Two Files)
   * 打开已切分的 JSON 文件
   * 右键选择 "Merge Two Files"，选择要合并的文件
   * 确定要更新的字段和来源字段

假设你校对一本书，这时可以按相同的切分结构准备参考文本，同样切分后，参考文本中target作为reference合并。这样，大模型就会参考reference来校对你书稿中的target。

### 校对文档和选段

菜单见上两图。

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

### 管理提示词

通过命令面板（Ctrl+Shift+P）可以**管理提示词** (AI Proofreader: set prompts)和**选择当前使用的提示词** (AI Proofreader: select prompt)

在自定义提示词中，必须对要处理的“目标文本（target）”“参考资料（reference）”“上下文（context）”进行说明，如果用不到后两者也可以不说明。

本插件的工作原理是，为三种文本添加标签（target、reference、context），然后提交给大语言模型进行处理。而处理的方法和目的则由提示词来定义。这就是说，**你可以通过自己的提示词，让AI根据三种文本做你期望的任何处理，比如撰写大意、插图脚本、练习题、注释，绘制图表，注音，翻译，进行专项核查（专名统一性、内容安全、引文、年代、注释等）……尽情发挥你的想象力吧！**

也可以在配置文件中处理提示词，但不适合没有编程知识的用户使用。

### 统计和日志

* 所有操作都会生成详细的日志文件
* 日志包含：
  * 操作时间戳
  * 处理字数统计
  * 切分/校对详情
  * 错误信息（如果有）

### 注意事项

1. 确保在使用前已正确配置 API 密钥
2. 长文本建议先切分后校对
3. 校对过程可以随时取消，已处理的内容会得到保存，不会重复处理
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
