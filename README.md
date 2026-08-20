*QQ群“ai-proofreader 校对插件”：1055031650*

一个用于文档和图书校对、基于大语言模型服务的VS Code扩展，支持选中文本直接校对、长文档切分后批量校对、带记忆地校对选段（实验功能）三种工作流，并集成了一些跟校对相关的辅助功能。[这里是代码库](https://github.com/Fusyong/ai-proofread-vscode-extension)。本扩展的原型基于一个Python校对工具库[Fusyong/ai-proofread](https://github.com/Fusyong/ai-proofread)。

另外，你也可以设置自己的提示词，用于其他文本处理场景，比如翻译、注释、编写练习题等；还可以自定义替换表、检查表，支持批量正则查找替换，或仅作为提示。

A VS Code extension for document and book proofreading based on LLM services, supporting three workflows: proofreading selected text directly, proofreading long documents after segmentation, and proofreading selected text with editorial memory (experimental). It also integrates proofreading-related auxiliary features. [Here is the code repository](https://github.com/Fusyong/ai-proofread-vscode-extension). The prototype of this extension is based on a Python proofreading tool library [Fusyong/ai-proofread](https://github.com/Fusyong/ai-proofread).

Additionally, you can set your own prompts for other text processing scenarios, such as translation, annotation, and creating exercises; you can also customize replacement tables and checklists, run batch regex find-and-replace, or use them as prompts only.

## 最近更新

当前版本 v1.12.9

- 更新文档
- 特性：在按钮提示中显示对应命令

完整更新日志见 [docs/changelog.md](docs/changelog.md)。

## 1. 安装和必要配置

**本文档仅以Windows系统为例**

1. [安装VS Code](https://blog.xiiigame.com/2022-01-10-给文字工作者的VSCode入门教程/#_1)，用VSCode打开一个空文件夹，通过VS Code界面左侧的扩展按钮打开扩展管理窗口（Ctrl+Shift+X）
2. 搜索AI Proofreader，点击安装按钮`install`安装
3. 到大语言模型服务平台（默认为[阿里云百炼](https://bailian.console.aliyun.com/)），通过注册、实名认证、充值、生成API秘钥等操作，获得有效的秘钥，复制秘钥
4. 回到AI Proofreader扩展界面，后点击设置按钮⚙️，选中弹出菜单中的设置项Settings，把秘钥粘贴到对应平台的API秘钥框中

## 2. 快速上手

### 2.1. 校对文档中的选段

1. Ctrl+N新建文档，后缀设为`.md`（markdown文档），把你需要校对的文字粘贴到这里，选中其中的一段文字
2. 在所选文字上打开右键菜单，使用其中的 `AI Proofreader: proofread selection` 校对选中文本
3. 弹出选项对话框时全部回车，即使用默认值
4. 最后会自动展示校对前后的差异，效果如下，深红表示原文变动，深绿表示结果变动：

![前后差异](https://blog.xiiigame.com/img/2025-02-07-比较AI模型校对效果/20252507-160022-52.png)

### 2.2. 切分文档后批量校对

![/result_panel](https://blog.xiiigame.com/img/2025-03-28-用于AI图书校对的vscode扩展/ui_overview.png)

1. 通过左侧活动栏图标的指引，或命令面板中的`open proofreading panel`命令打开校对面板。稿件一般为 Markdown（段落后须有空行，作为允许切分的标记）
2. 在 **切分与合并** 区块选择主文件，点 **切分文档**（默认按长度），得到 JSON
3. 同一区块点 **LLM 校对 JSON**，批量校对切分好的片段
4. 在 **校对结果** 区块点 **比较前后差异**，可以看到和上文相同的校对结果

### 2.3. 尝试所有命令

本扩展主要有四种操作入口：

1. **活动栏 overview**：打开 **校对面板** / **检索面板**，并开关侧栏 TreeView（资料检索、引文核查、重文检查、标题树等）
2. **校对面板**四块：**文档整理** → **切分与合并** → **校对结果** → **专项检查**；底部为选段校对。切分与合并可进入资料检索分支（「准备参考资料」）
3. **检索面板**：资料检索分支——多源准备、命中勾选与导出/合并、引文核对；**不做校对**
4. **命令面板**（Ctrl+Shift+P）与**右键菜单**：可访问全部命令

![所有命令](https://blog.xiiigame.com/img/2025-03-28-用于AI图书校对的vscode扩展/command_palette.png)

用`open proofreading panel`打开校对面板，用`Open Reference Search Panel（检索面板）`打开检索面板。

更详细的命令速查与业务流程图见 [docs/commands-cheatsheet.md](docs/commands-cheatsheet.md)；完整版本历史见 [docs/changelog.md](docs/changelog.md)。

#### 术语简表（资料检索相关）

| 术语 | 含义 |
|------|------|
| **资料准备** | 多源检索，结果写入过程文件与侧栏「资料检索」；不自动校对 |
| **知识核查** | 预置校对提示词（item / full）；在**校对面板**校对时选用，依据已准备的 reference 核查事实 |
| **意图检索** | 用自然语言描述要查什么，再多源检索 |
| **核对选中引文** | 对选中引文片段做出处检索 → 侧栏「资料检索」 |
| **核对全文引文** | 批量相似度匹配 → 侧栏「引文核查」（须先建立引文索引） |
| **直接查词典** | 无 LLM，整词查本地 MDX |

## 3. 使用说明

日常工作按校对面板的四块，加上「切分与合并」分出的资料检索来组织：

1. **文档整理**：转换格式、整理段落/空白/标点用字、标记或对齐标题、分句分词、比较文件。作用于**当前编辑窗口**。
2. **切分与合并**：选定主文件后切分；切出 JSON 后可合并语境，并可 **准备参考资料** 或 **LLM 校对 JSON**。
3. **资料检索**（切分与合并的分支）：在**检索面板**找资料、勾选导出或合并进 JSON；**不做校对**。
4. **校对 / 校对结果**：选段校对在面板底部；JSON 校对入口在切分区块；进度与 diff / 勘误表在「校对结果」。
5. **专项检查**：字词、标题树、段内序号、对齐标题、重文、引文核对。结果多在左侧栏。

- [3.1 文档整理](#31-文档整理)
- [3.2 切分与合并](#32-切分与合并)
- [3.3 校对 / 校对结果](#33-校对--校对结果)
- [3.4 专项检查](#34-专项检查)
- [3.5 管理提示词](#35-管理提示词)
- [3.6 日志等过程文件](#36-日志等过程文件)
- [3.7 注意事项](#37-注意事项)

### 3.1. 文档整理

校对面板第一块。请先打开稿件，再点按钮（焦点可留在本面板）。

#### 3.1.1. 转换为 Markdown

目前作者端稿件多为docx类。排版端可能导出活文字PDF、死文字PDF（文字转曲转光栅，方正书版常见）、方正书版大样文件（常用于过黑马、方正审校）、纯文本（text，多数排版软件能导出）等。

本扩展[默认支持Markdown文档](https://blog.xiiigame.com/2022-01-10-给文字工作者的VSCode入门教程/#vscode_markdown)，另支持text、ConTeXt、TeX、LaTeX（**对后三者的支持没有经过充分测试**），其他文档需要先转换为Markdown。此类转换工具很多，本扩展集成了两种。

* **文本文件**只需要把后缀（比如纯文本的`.txt`）改成`.md`即可
* **docx文档**（Word、WPS的通常格式），可以通过命令面板（Ctrl+Shift+P），使用convert docx to Markdown命令转换后进行校。本功能依赖[多功能文档格式转换工具Pandoc](https://pandoc.org/installing.html)，需要预先正确安装。安装后可能需要重启才能生效。
* **活文字PDF文档**，可以通过命令面板，使用convert PDF to Markdown命令转换后进行校对。**Windows 用户无需另行安装**：扩展已内置 [Xpdf](https://www.xpdfreader.com/download.html) 4.06 的 `pdftotext.exe`（GPL，见扩展内 `vendor/xpdf/COPYING`）。macOS/Linux 仍需自行安装 Xpdf 命令行工具并加入 PATH。pdftotext 可忽略四周无用文字，如页码、页眉，尺寸单位是磅（pt），五号字是 10.5 pt，x mm = x/25.4*72 pt 。
* **死文字PDF**，需要通过OCR处理成活文字PDF、docx、text、Markdown等后进一步处理。QQ交流群中上传了一个OCR命令行工具rapiddoc.exe。加密码限制提取文字的活文字PDF，也如此处理，或尝试用[SumatraPDF](https://www.sumatrapdfreader.org/free-pdf-reader)打开后复制文字。
* **方正书版大样文档**，如果有方正智能审校工具，用它处理后即为活文字PDF（没有图），再进一步处理。另外，方正书版本身有一些间接导出活文字PDF的办法，但有各种问题，常常比不上用OCR工具处理。PDF 转出后若带圈序号变成乱码或私用区字符，可用命令 `replace Founder circled numbers`（校对面板「方正带圈序号」）：可选转为 Unicode 带圈符号（①–㊿，大于 50 用 `[n]`）或一律方头扩注 `[1]`、`[2]`…，并顺带清除常见分页/换行杂质。

#### 3.1.2. 整理文档

文档转换后还有[一些整理技巧](https://blog.xiiigame.com/2022-01-10-给文字工作者的VSCode入门教程/#vscode)，不过对于使用本扩展进行校对而言，进一步的整理工作通常不是必须的。常见的例外情形是，你希望按篇、章、节、标题等结构来切分、校对，以便保持语境连贯，那么你需要学习更多整理技巧，或者使用其他工具，以便得到有标题的Markdown文档。

1. 本扩展命令`mark titles from table of contents`，可以根据一个目录表文件（Markdown分级列表的形式），逐行比较当前文档，把标题行标记出来；匹配时会忽略行头已有的 `#` 标记（不限级数，如 `## `、`####### `），并按目录级别重写，因此可用来调整已经标记过的标题。比较时还会自动忽略数字（如页码）、英文句点和省略号（页码前导符号）、空格、带圈数字①-㉟、Markdown形式的注码如 `[^1] [^abc]`、上标注码如 `^1^ ^abc^`。
2. PDF导出的文本，如果没有使用空行分段，无法切分，可以使用整理段落命令`format paragraphs`中的“段末加空行”选项加以处理。
3. Markdown中的段内断行是合法的，即使句子被断开，对大模型的影响也不大。当然，也可以用上述命令`format paragraphs`中的“删除段内分行”选项处理后再校对。
4. 过多的无效字符影响输出速度，如长串的表格分割线`-`、空格、链接等，可以通过查找替换、Ctrl+Shift+L选中所有相同项目等办法简化、删除。方正系排版软件可能使用半角标点，校对后通常会被改成全角；也可用校对面板中的 **半角标点转全角** / **全角标点转半角**（命令 `half-width punctuation to full-width` / `full-width punctuation to half-width`），仅处理 `，；：？！` 与 `,;:!?` 五对（不含引号；引号仍用 `convert quotes to Chinese`）。请参考上述讲整理技巧的文章。
5. **对齐标题**：命令 `align headings`（校对面板「对齐标题」）。请先并排打开两个 Markdown 窗口（如练习题与答案、目录与正文），再运行本命令；可指定要对齐的标题级别（如 `1，2`），并选择「有序号则只比序号，否则比全文」或「比较全文」。一旦对不齐，会在两侧窗口跳到差异处，处理后可再次运行。
6. 更强大、通用的文本整理技术是正则表达式查找替换，这需要专门学习，可参考[给编辑朋友的正则表达式课程](https://blog.xiiigame.com/2020-05-31-给编辑朋友的正则表达式课程/)。

!!! caution 批量替换有风险
    批量替换的结果可能超出你的预期，即使你不准备原样使用处理后的文本，也有掩盖错误的风险。补强措施是：（一）备份文件。（二）先查找全部，复制到一个新文档中确认无误，然后再进行替换。（三）如果替换逻辑较为复杂，替换后还要比较文件（后文会提到），从头到尾确认所有更改。

段落整理命令 `format paragraphs` 基于文档行长众数计算，适合整体较长、以长段落为主的文档；短小、段落零碎时准确率会比较低。也可使用 `delete inline whitespace` 删除汉字和中文标点内部过短的空白；`convert quotes to Chinese` 将半角引号转为全角（可在设置中改为校对后自动执行）；`opencc` / `opencc selection` 做繁简或地区用字转换。

#### 3.1.3. 分句、分词与比较文件

同在文档整理区块：

* **切分为句子**（`split into sentences`）：对整篇或选区重新分句并插入分隔符；默认用两个分行符（一个空行）分隔。
* **分词与统计**（`segment file` / `segment selection`）：可选分词后替换原文、输出词频统计表（词语、词性、词频）或字频统计表。分词使用 [jieba-wasm](https://github.com/fengkx/jieba-wasm)。
* **与另一文件比较**（`diff it with another file`）：整理阶段也可用来对照两个稿本。校对完成后的差异、勘误表见 [3.3.5](#335-比较与勘误表)。vscode 资源管理器右键亦可比较文件。

### 3.2. 切分与合并

校对面板第二块：先 **选择主文件**（或从工作区选择），再 **切分文档**。切出 JSON 后露出配套文件，以及 **合并 JSON**、**准备参考资料**、**LLM 校对 JSON**。

#### 3.2.1. 文档切分

我的经验，在一般语言文字和知识校对场景中，大语言模型一次输出六百到八百字会有比较好的效果。因此，一本十来万字的书稿需要切分成三百多段，然后交给大模型校对。

而校对前后一致性，比如多个人名、正文与注释、前后表述的一致性，则需要完整的语境，这时最好按章节切分、校对。

打开markdown文件，在编辑器窗口中打开右键菜单，可以看到切分选项 `AI proofreader: split file`

或通过命令面板查找更具体的选项：

1. **按长度切分** (Split File by Length)，可输入目标切分长度（字符数）。
2. **按标题切分** (Split File by Title)，可输入标题级别（如：1,2），适合有标题且题下正文长度合适（建议不要超过1500）的文档。
3. **按标题和长度切分** (Split File by Title and Length)，适合有标题，但题下正文过长的情况。可配置标题级别、阈值（过大则切分）、切分长度和最小长度（过小则合并）。
4. **按长度切分，以标题范围为上下文** (Split File with Title Based Context)，会给每一个片段配上所在标题范围的正文作为上下文，适合对上下文语境要求高的情景。可输入切分长度、题级级别。
    > !!! caution 费用警告
    >     这样有可能极大地增加token数，增加输入服务费用——尽管在Deepseek等平台中，重复提交的上下文会记为“缓存命中”，并降低费率。注意查看切分后的JSON文档的字符数，以权衡利弊。
5. **按长度切分，扩展前后段落为上下文** (Split File with Paragraph Based Context)，即在片段基础上添加前后段落，用作上下文。适合关注局部语境一致性的情形。可输入切分长度、前文段落数和后文段落数。
    > !!! caution 费用警告
    >     这样可能较大地增加token数，增加输入服务费用。这样生成的上下文是变动的，因此无法享受“缓存命中”的低费率。注意查看切分后的JSON文档的字符数，以权衡利弊。

切分后都会生成同名的 `.json`（用于校对） 和 `.json.md`（可查看切分情况）两个结果文件。
还会生成日志文件（`.log`），记录切分统计信息，并摘要呈现在校对面板中；**如有过长（如超过1500字符）片段时，可以手动加空行分段，然后再次切分。**

切分完成后，本区块会列出 JSON / JSON.md / 切分日志，并可 **比较前后差异**（用分割线表示切分位置）、**合并 JSON**、**准备参考资料**（进入资料检索分支）、**LLM 校对 JSON**（结果出现在「校对结果」区块；面板失效后也可打开 JSON 用右键菜单开始校对）。

!!! note 切分文档依赖两种标记
    本扩展默认用户需要校对的文档为[markdown格式](https://www.markdownguide.org/basic-syntax/)，文档切分依赖markdown文档中的两种标记：（1）空行。在markdown中，一个或多个空行表示分段，没有空行的断行在渲染时被忽略，即合并为一段。**至少要有合适的空行，否则无法切分。**（2）各级标题。如`## `开头的是二级标题。

#### 3.2.2. 合并 JSON，组织语境

跟人工校对一样，要想提交校对质量，大语言模型也需要了解上下文语境，还需要工具书、参考资料等。

本扩展每次调用大语言模型时能提交三种文本：**要处理的目标文本（target，必须）、参考资料（reference，可选）、上下文（context，可选）**。比如以一篇文章中的一部分作为target，那么整篇就可以作为context，而在处理中有参考价值的资料，如相关词条，就可以作为reference。

假设你校对一本书，切分后得到包含300个target的JSON文件。那么可以准备相同数量、一一对应的上下文和参考资料，切分成包含相同数量target的JSON文件。然后使用合并命令，将上下文文本中的target作为context合并，将参考文本中的target作为reference合并。

也可以选择**任意 Markdown 文件**作为来源，让每个 JSON 项都合并一次该文件（常用于统一下发同一段体裁说明、用词规范等参考全文）。

**合并 JSON 文件 (Merge Two Files)：**

1. 打开已切分的要校对的 JSON 文件
2. 打开右键菜单，选择`AI proofreader: Merge Two Files`（或通过命令面板）命令
3. 选择要合并的文件
4. 确定要处理的字段和资料来源字段，以及拼接模式或更新（覆盖）模式。比如你想把试题及其答案合并后校对，那么可用拼接模式，拼接到同一个target中。
5. 可输入当前文件要**忽略的标题级别**（如 `1，2，4`，兼容全角逗号；默认留空不忽略）。以这些级别 ATX 标题开头的单元会跳过：JSON 来源时不取对应单元且有效个数须相同；Markdown 来源时不向这些单元写入同一全文。
6. 确定是否更新对应的Markdown文件（默认是），更新时会备份原文件。

组织校对语境是一个看起来有些麻烦，但非常有效的工作。比如校对练习册，有必要把练习和答案拼成语境（拼在一个target中更能节省费用）。而对一首古诗的解释如果不可靠，可以用一篇可靠的作为reference。包含人物的内容，则可以用词典中的任务条目作为reference。

JSON 切分后若要检索参考资料，见 [3.2.3](#323-资料检索切分与合并的分支实验功能)。

#### 3.2.3. 资料检索（切分与合并的分支，实验功能）

这是「切分与合并」的分支：切出 JSON 后，校对面板该区块内点 **「准备参考资料」** 即打开检索面板（也可从 overview 或命令 `Open Reference Search Panel（检索面板）` 打开）。选段检索不必先切分。

**检索面板只负责找资料与导出/合并；校对一律回到校对面板完成。**

在检索面板中可：

1. 选择检索强度（轻量 / 标准 / 深入），勾选资料来源：
    1. 本地mdx词典
    2. 本地参考资料目录中的md文件： grep / BM25 / 向量
    3. 维基百科
    4. Web（暂未实现，按钮灰显）
2. 对当前选段或当前 JSON 执行多轮 LLM 规划检索；过程显示在时间线，命中同步到侧栏「资料检索」
3. 勾选命中后：选段可**导出 md**；JSON 可**导出 JSON**或**合并选中到源 JSON**（JSON 准备成功后不会自动改写源文件）
4. 使用底部快捷命令：单源检索、意图检索、直接查词典、PDF/识典/古籍库、引文核对、清除检索缓存

过程文件为 `文档.referenceprep.json` / `.referenceprep.log`。项目级查询缓存位于 `.proofread/retrieval-cache.json`（可清除）。

**本地词典配置**：在设置中配置 `ai-proofread.localDicts`（可配置多本词典，按 `priority` 控制回退顺序；数值越小越优先）：

- **id**: 词典 ID（稳定标识，用于路由与缓存键）
- **name**: 词典名称（展示用）
- **mdxPath**: `.mdx` 词典路径（支持绝对路径；也支持 `${workspaceFolder}`）
- **priority**: 优先级（越小越优先）
- **tags/whenToUse**: 辅助 LLM 选择词典（可选）

**配置示例（三本词典）**：下面假定三部 MDX 均在您机器上的固定目录；`priority` 越小，在未命中 LLM 指定词典、或需按序回退时越靠前。路径在 JSON 中可用正斜杠 `/`，与 Windows 路径等价。

```json
    "ai-proofread.localDicts": [
        {
            "id": "cidian...",
            "name": "...",
            "mdxPath": ".../...mdx",
            "priority": 10,
            "tags": ["现代汉语", "古代汉语", "百科知识"],
            "whenToUse": "百科性条目、通用词语。查找专名、百科知识类词条优先。"
        },
        {
            "id": "cidian...",
            "name": "...",
            "mdxPath": ".../...mdx",
            "priority": 20,
            "tags": ["古汉语", "字源", "典故"],
            "whenToUse": "古汉语、典故、字源与书面文言。查找语言、文学、文字类词条优先。"
        },
        {
            "id": "cidian...",
            "name": "...",
            "mdxPath": ".../...mdx",
            "priority": 30,
            "tags": ["古汉语", "现代汉语", "书证"],
            "whenToUse": "需长条释义或较多书证时可与...、...互为补充。"
        }
    ]
```

将上述键值对并入 `settings.json` 里 `ai-proofread` 对应配置即可（若已有 `localDicts`，可整段替换或手工合并）。若希望随仓库携带相对路径，可把 `mdxPath` 写成 `"${workspaceFolder}/…/词典.mdx"`。

**资料准备与相关命令**：

在批量校对或选段校对前，可先做资料准备：经资源范围解析（大库时 LLM 预筛词典/目录/标题）与多轮 LLM 规划，从本地词典、grep、BM25（应用层，非 FTS5）、轻量向量（字符 n-gram）、可选维基百科/Wikidata API 检索，经混合打分与 LLM 精排后写入过程文件与侧栏「资料检索」。日常操作优先用检索面板。

推荐路径（选段）：检索面板「开始准备」→ 勾选命中 → **导出 md** → 打开**校对面板** → `proofread selection` → 选用预置提示词「知识核查（item）」并指定刚导出的参考文件。

推荐路径（JSON）：资料准备·JSON → 勾选命中 → **合并选中到源 JSON** → 校对面板校对 JSON 并选用「知识核查」提示词。

- 选段准备：`Prepare References for Selection（资料准备·选段）`，或检索面板目标「Markdown 选段」
- 意图检索：`Intent Search（意图检索）`（自然语言检索意图；共用预筛 / 规划 / 精排与侧栏「资料检索」；默认词典 + grep + BM25 + 向量）
- 核对选中引文：`Verify Selected Citation（核对选中引文）`（结果在「资料检索」树，不校对）
- 核对全文引文：`Verify Citations（核对全文引文）` + 侧栏「引文核查」树（须先建立引文索引）
- JSON：校对面板「准备参考资料」，或 `Prepare References for JSON File（资料准备·JSON）`（**不自动写入** `item.reference`）
- 结果查看：侧栏「资料检索」（overview 可开关；命令 `Open 资料检索 View`）；可打开文件跳转、复制块、手动 prune；检索面板内勾选导出/合并
- 续跑：资料准备、意图检索、核对选中引文、检索面板选段若已有过程文件，可选择继续上次（追加 1 轮）或重新开始；JSON「继续未完成部分」按过程记录跳过已完成条目
- 过程文件：`文档.referenceprep.json`（v0.3 一文多记录，含 `prepOrigin`：`selection` / `json_item`）、`文档.referenceprep.log`（详见 `docs/knowledge-verify-plan.md`）
- 检索面板：Markdown 选段与 JSON 条目检索严格分离（选段结果不可合并进 JSON）
- 重放：按锚点只重放对应来源记录；多条时可点选，或不选（Esc）分组展示
- 合并到源 JSON：仅 JSON 条目结果可用；可按 target 写入对应条目，或覆盖/追加全部条目——**这是把资料写入源 JSON 的唯一正式路径**
- 运行前可勾选资料来源（词典 / grep / BM25 / 向量 / 维基百科）；检索强度（轻量 / 标准 / 深入）控制轮次与查询上限
- 维基百科资料来源（默认不勾选）：只读访问 MediaWiki + Wikidata；串行限速（默认 30 次/分钟）、会话 HTTP 预算、工作区缓存 `.proofread/wiki-cache.json`；TreeView 命中项可在浏览器打开条目 URL。配置见 `ai-proofread.referencePrep.wikipedia.*`
- BM25 需先「建立引文索引」（该索引亦供核对全文引文使用）；向量索引首次使用时懒构建
- 检索缓存：`.proofread/retrieval-cache.json`（`referencePrep.retrievalCache.*`）；可用检索面板「清除检索缓存」

**参考资料规划提示词**（侧栏 `prompts for reference prep`）：可自定义；须要求模型只输出 JSON（`sufficient` / `queries` / `prune`；grep 块可含 `unit`、`searchPhrases`）。未选择时使用内置规划提示词。

**检索面板底部外跳 / 即时工具**（不写入 reference corpus，除非走资料准备）：

* **从 md 反查 PDF**：`Search Selection In PDF`（需 [SumatraPDF](https://www.sumatrapdfreader.org/free-pdf-reader)；建议 `ReuseInstance = true`）
* **在参考资料库中搜索**：`search selection in References`（Find in Files）
* **连线搜索[中华经典古籍库](https://jingdian.ancientbooks.cn)**：`search selection in Ancientbooks (jingdian)`
* **连线搜索[识典古籍](https://www.shidianguji.com/)**：`search selection in Shidianguji`
* **直接查词典**：精确整词查 MDX；查段落、多词请用检索面板「开始准备」或意图检索

### 3.3. 校对 / 校对结果

JSON 批量校对的按钮在 **切分与合并** 区块（「LLM 校对 JSON」）；**选段校对**在校对面板底部。进度、未完成提示、比较前后差异、生成差异文件 / 勘误表在 **校对结果** 区块。

#### 3.3.1. 对文档选段进行校对

1. 打开Markdown文档（其他纯文本文档可改为.md后缀，即为Markdown文档）
2. 选中要校对的段落，不宜过长
3. 从校对面板底部 **校对选中文本**，或右键菜单、命令面板中选择 Proofread Selection
4. 可选择上下文范围、参考文件和温度。加入上下文是为大语言模型提供语境，以便参考，并保持一致性。参考文件可以是相关的词条、更权威的文献等。模型温度较低时，随机性、创造性、稳定性较低；反之则随机性、创造性、不稳定性变高。可以参考模型文档进行测试。**使用不同温度多遍校对，或许可以覆盖不同的问题，值得尝试。**
5. 校对结束后会打开 diff；**关闭右侧校对结果文档时**可选择是否将结果**写回选区**。**普通 Proofread Selection** 不会读写编辑记忆 JSON。**Proofread Selection with Memory** 会在接受写回后更新 **`.proofread/editorial-memory.json`**：**全局**为结构化条目（`original` / `changedTo` / **`weight`**；可选 **`note`** 修改说明；超员时**低 weight**先入存档）；**最近 d 次（默认 3）**校对的**扁平合并稿**栈 `currentRounds`（轮次间归一化完全相同则去重，单轮内不限条数）。注入：`<editorial_memory_global>`、`<editorial_memory_current_rounds>`、`<editorial_proofread_context>`。写回时 LLM 产出 `global_ops` + `current_round_flat`（或由程序摘要压栈），详见 `mergeAfterAccept` 等 `ai-proofread.editorialMemory.*` 设置。


#### 3.3.2. 对切分好的JSON文档进行校对（批处理）

1. 打开已切分的 JSON 文件（或在校对面板 **切分与合并** 已选定主文件并切分完成）
2. 通过该区块 **「LLM 校对 JSON」**，或右键菜单 / 命令面板选择 Proofread File
3. 显示当前配置请你确认。配置说明见上文。
4. 在校对面板中有进度、结果等信息。可中途取消校对。下次接着校对，会根据校对结果`文档.proofread.json`文件中的记录，跳过已经完成的部分；如果切分结果`文档.json`与校对结果`文档.proofread.json`条目数不一致，则会提示你手动对齐，或删除结果文档，从头重新校对。
5. 最后会提示你查看结果：JSON结果、前后差异、日志文件，以及生成差异文件（类似带修改标记的Word文档）。
6. 如有未完成的条目，可重新校对，重新校对时只处理未完成的条目

#### 3.3.3. 对文档选段进行带记忆的校对，并自动维护项目级编辑记忆（实验功能）

本功能是在`Proofread Selection`基础上增加收集、处理、使用校对记忆的工作流。

!!! caution 费用警告
    本工作模式比起Proofread Selection来，每次都要提交编辑记忆给大模型参考，并合并新的编辑记忆，因此会消耗多得多的token。

1. 选中要校对的文本，运行 `Proofread Selection with Memory`命令面板：会把已有项目级编辑记忆注入请求供模型参考；接受写回后按设置更新记忆（普通 `Proofread Selection` 不读写记忆 JSON）
2. 与普通 `Proofread Selection` 不同，本命令从工作区配置文件 `<工作区根>/.proofread/proofread-selection-with-memory.json` 读取设置。若文件不存在，扩展会生成一份默认模板
   - `contextMode`（字符串，三选一）
    - `"none"` — 不使用上下文
    - `"adjacentParagraphs"` — 前后邻段，须配合以下参数：
        - `beforeParagraphs` / `afterParagraphs`（整数）：取值 `0`～`10`
    - `"headingScope"` — 按 Markdown 标题包裹范围，须配合以下参数：
        - `headingLevel`（整数）： `1`～`6`，对应一级～六级标题上下文
   - `referenceFiles`（字符串数组）：相对工作区根的路径，建议正斜杠（如 `"notes/ref.md"`）；空数组 `[]` 表示不用参考文件；若有多项仅第一项参与注入
   - `temperature`（数字）：`[0, 2)`（大于等于 0、小于 2）
   - `repetitionMode`（字符串，三选一）
        - `"none"`（不重复）
        - `"target"`（仅重复 target）
        - `"all"`（重复参考+语境+target 整段流程）
   - `sourceTextHint`（字符串，可选）：省略或 `""` 或 `"none"` — 不注入源文本特性。否则须为源文本特性提示词的内置 id或名称。可通过「管理提示词」维护提示词后再写进 JSON
3. 编辑记忆文件路径：`<工作区根>/.proofread/editorial-memory.json`（活跃）、`editorial-memory-archive.json`（存档）。

#### 3.3.4. 用「知识核查」提示词校对（实验功能）

*参考：[3.2.3 资料检索](#323-资料检索切分与合并的分支实验功能)*

「知识核查」是**预置校对提示词**（item / full），不是独立命令。请先在检索面板完成资料准备并导出 md（选段）或合并到源 JSON，再到**校对面板**执行选段/JSON 校对，并选用「知识核查（item）」（推荐）或「知识核查（full）」。可选在选段校对时指定参考文件。会消耗比一般校对更多的 token。

#### 3.3.5. 比较与勘误表

在当前markdown或json界面，使用右键菜单`diff it with another file`，如果当前是markdown则有三种模式：

1. 调用vscode内置的diff editor比较校对前后md文件。校对面板“前后差异”按钮的功能与此相同。对于长文本，diff editor有段落无法对齐的问题。此时，可以通过加空行或删除空行来帮助对齐。
2. 用jsdiff比较两个文件，生成HTML形式的结果，类似带修改标记的Word文档。本模式还支持JSON文件，自动拼接JSON一级元素或`target`字段内容进行比较，支持每次比较的片段数量（默认0表示所有片段），生成多个有序的差异文件，避免过长文本无法渲染的问题；校对面板“生成差异文件”按钮的功能与此相同（**注意：这个按钮使用的也是JSON中的文本，而不是md中的文本**）。
3. 逐句对齐两个md文件，生成一个有筛选和比较功能的HTML文件，从而可用于制作审校记录、勘误表。校对面板“生成勘误表”按钮的功能与此相同。生成勘误表时可选择**同时收集常用词语错误**，输出为 CSV 格式（错误词语,正确词语,错误词语所在小句,错词长度,正词长度），保存为 `{主文件名}.word-errors.csv`，便于筛选和积累个人常用错词表、自定义替换表。

### 3.4. 专项检查

校对面板第四块，作用于当前编辑窗口；部分结果出现在左侧栏。对齐标题与文档整理区块按钮相同。

![树视图（提示词管理、字词检查、引文检查）](https://blog.xiiigame.com/img/2025-03-28-用于AI图书校对的vscode扩展/special_checks.png)

1. **字词检查**（`check words`）：三个分支——基于词典数据；基于《通用规范汉字表》；自定义替换表（预置简繁异对照、《第一批异形词整理表》、《古籍印刷通用字规范字形表》、规范人名与年号等）。可用 `manage custom tables` 加载自制正则/字面替换表，支持插入与按词语边界匹配。
2. **标题树与段内序号**（`check numbering hierarchy`）：检查标题序号和段内序号的层级与连续性；在侧栏「标题树」中可定位、批量标记为 Markdown 标题、升级、降级。
3. **对齐标题**（`align headings`）：并排两个 Markdown 后按指定级别检查是否一一对应。详见 [3.1.2](#312-整理文档)。
4. **重文检查**（`scan duplicate sentences in document` / `selection`）：侧栏 **重文检查**。归一化与相似度相关配置与引文核对共用 `ai-proofread.citation`。
5. **引文核对**：专项检查区可启动 **核对选中引文** / **核对全文引文**；详细流程与索引见 [3.2.3](#323-资料检索切分与合并的分支实验功能)。须先在检索面板 **建立引文索引**（`citation.referencesPath`，默认为工作区 `references`）。

### 3.5. 管理提示词

#### 3.5.1 提示词管理

**本扩展目前默认提示词的功能是校对一般的语言文字错误和知识性错误**，具体内容见代码库中的proofreader.ts文件。你可以设置自己的提示词，不限于校对工作。

通过命令面板（Ctrl+Shift+P）使用manage prompts命令可以打开提示列表视图，管理提示词。可增、删、改，选择当前使用的提示词。没有编辑界面，请写好后贴入。

也可以在配置文件中处理提示词，但不适合没有编程知识的用户使用。

#### 3.5.2 预置提示词说明

除 **系统默认提示词（full）**、**系统默认提示词（item）** 外，扩展在代码中内置了若干预置提示词。在「管理提示词」打开的 prompts 侧栏中可直接点选为当前提示词。

| 名称 | 输出类型 | 适用场景 |
|------|----------|----------|
| 系统默认提示词（full） | 全文 | 常规语言文字与知识性校对；**默认项** |
| 系统默认提示词（item） | 条目 | 同上，仅输出需改句子（JSON），省 token，见 [3.5.4](#354-提示词输出类型) |
| 表述正常化（full） | 全文 | 凭语感修改违和处，使表述符合常情常理 |
| 表述正常化（item） | 条目 | 同上，条目式输出 |
| 硬伤发现（item） | 条目 | 只报必须改的硬伤（字词、语法、事实、逻辑等）；依据不足时标记较低 confidence |
| 对应关系核对（item） | 条目 | 专查应对应一致的关系：指代、称谓、注释、题答、图表编号、数据单位等 |
| 知识核查（item） | 条目 | **推荐**：依据已准备的 reference 核查事实，区分词典与文献摘录可信度，不臆造 |
| 知识核查（full） | 全文 | 同上，全文输出 |
| 拼音审校（full） | 全文 | 按部编版小学语文教材注音规则审校已有拼音（行间拼音、括注拼音等），包括读音、轻声、儿化、「啊/呀/哇/哪」用字 |
| 拼音加注（full） | 全文 | 以同上标准在行间加注拼音 |
| 段内重组与重述（full） | 全文 | 理顺段内逻辑与表述；默认只在段内调句序，必要时才改分段；不附说明 |

#### 3.5.3 提示词原理与撰写示范

为了写好提示词，你需要了解本扩展的工作原理：

1. 把你的提示词作为系统命令/系统提示词交给大模型
2. 在第一轮对话中提交`<reference>${reference}</reference>`和`<context>${context}</context>`；若启用编辑记忆，还会附带 `<editorial_memory_global>`（全局通则，含 **weight**、可选修改说明 **note**）、`<editorial_memory_current_rounds>`（可含 **【例】** / **【规律】** 前缀）、`<editorial_proofread_context>`；
3. 在第二轮对话中提交`<target>${target}</target>`
4. 接收、处理第二轮对话的输出作为结果

整个过程没有魔法，处理的目的和方法完全由提示词和三种文本及其标签（reference、context、target）来定义。这就是说，**你可以通过自己的提示词，让AI根据三种文本做你期望的任何处理工作，** 比如撰写大意、插图脚本、练习题、注释，绘制图表，注音，翻译，进行专项核查（专名统一性、内容安全、引文、年代、注释等），收集信息（如名词术语）……

需要注意的是，在自定义提示词中，必须对要处理的目标文本（target）、参考资料（reference）、上下文（context）进行说明，如果用不到后两者也可以不说明。并且这种**说明应尽可能与三种标签的字面意义相协调，**比如target可以用作“要处理的目标文本”，也可以用作“要得到的具体目标”（作为系统提示词的补充），但不宜作为参考文本、样例等类。

自定义提示词名称不得使用系统保留名（如 `__system_item__`、`__preset_*__` 等），否则无法保存。

提示词示例：

> 你是一位专业的儿童文学翻译家……
> 用户会提供一段需要翻译的目标文本（target），你的任务是把这段文本翻译成适合孩子阅读的汉语作品……
>
> 用户如果供参考文本（reference），翻译时请模仿参考文本的语言风格，遵照参考文本中的人名、地名、术语等实体的指定译法……
>
> 用户如果提供上下文（context），翻译时要根据上下文确定目标文本（target）的具体含义，确保翻译的准确性和连贯性……
>
> 输出要求：
> 1. 翻译目标文本（target）后输出;
> 2. 不要给出任何解释、说明；
> 3. ……

本扩展计划预置更多提示词，也欢迎用户通过用户群等渠道交流、分享提示词。

本人有一个[开源提示词库](https://github.com/Fusyong/LLM-prompts-from-a-book-editor)，但不是针对本扩展的，改造（对三种标签进行说明）后才能用于本扩展。

#### 3.5.4 提示词输出类型

本扩展支持三种提示词输出类型：full（全文输出）；item（条目式输出）；other（其他）。

**要求全文输出等于强制大模型显式内省，从而防止偷懒与不过脑子，`系统默认提示词（full）`生成的改动要明显比`系统默认提示词（item）`多**。

而条目式输出，每个问题输出 original（原文）、corrected（修改后）、confidence（置信度，可选）、explanation（解释，可选）等字段，其中只有 original 是必需的；confidence 为 0–1 的小数，表示模型对本条修改正确性的把握，用于侧栏「校对条目」视图中的展示、排序与筛选。输出后要用于定位和（如果有 corrected）替换，可以节省输出 token，适用于预期修改比较少的情形，例如专项审校。

other类型输出的后续处理暂时跟全文输出相同，可用于收集自定义的结构化数据。

前面所说的提示词例子的输出类型是full（全文输出）。下面是`系统默认提示词（item）`中对输出格式的指令，供参考：

```markdown
**输出格式**：
1. 从目标文本（target）中挑出需要修改的句子，加以修改，以 JSON 格式输出，且只输出该 JSON，不要其他说明。
2. JSON 格式为：{"items":[{"original":"需要修改的句子","corrected":"修改后的句子","explanation":"解释，绝大多数情形下可省略，仅在不解释难以理解时填写"}]}
3. 若无任何修改，输出：{"items":[]}
```

请注意，输出形式选item（条目式输出）时，JSON、items、original、corrected、explanation这些词语，对于大模型的理解和输出后的处理都有用，因此不要改变它们的形式。如果你对JSON格式了解不多，我建议直接在这个模版上改写。corrected和explanation两项可以省略。

#### 3.5.5 源文本特性提示词注入

系统默认与预置提示词（见 [3.5.2](#352-预置提示词说明)）可注入源文本（如整本书）特性、校对重点等提示词，目的在于说明整本书的独特之处，提醒 LLM 注意；自定义提示词不会自动注入。请注意，系统会在你注入的提示词之前附加“目标文本（target）是一个更大的源文本的一部分。对这个源文本的整体说明如下：”。逻辑上你可以注入任何内容，但要考虑注入后的整体逻辑。

使用命令 `AI Proofreader: manage prompts` 会同时打开侧栏中的 prompts 与 source characteristics 视图；在后者中可查看内置条目并增删改自定义源文本特性提示词。

#### 3.5.6 提示词重复功能

本扩展支持基于谷歌研究的提示词重复功能，以提高准确度。其原理是：重复用户输入（reference、context、target），让模型在真正处理时已经获得全局信息，从而获得更好的上下文理解。

**重复模式**：在设置中配置 `ai-proofread.proofread.promptRepetition` 选项：
- **不重复**（none，默认）：不启用重复功能
- **仅重复目标文档**（target）：只重复要修改的目标文档
- **重复完整对话流程**（all）：重复参考文档、语境和目标文档，保持完整的对话流程，效果最好但成本最高

**注意事项**：
- 会增加输入token，重复部分翻倍，输出token不变。如果API支持缓存（如Deepseek），重复部分可能享受缓存命中的低价
- 重复发生在可并行化的prefill阶段，不增加延迟
- 建议先在少量文本上测试效果，再决定是否启用。经初步测试，对于较长的文本效果更好

### 3.6. 日志等过程文件

为了让用户能够核验、控制每一个步骤，扩展会以要校对的文档的文件名（以“测试.md”为例）为基础，生成一些中间文件，各自的作用如下：

1. 测试.md，要校对的文档
2. 测试.json，切分上述文档的结果，供检查后用于校对；可以进一步与别的切分结果进行合并，以便搭配target + context + reference一起提交处理
3. 测试.json.md，拼合上项JSON文件中的target的结果，用于查看或比较原始markdown文件，比JSON直观
4. 测试.log，切分日志，用来检查切分是否合理
5. 测试.proofread.json，校对上述JSON文件的直接结果，其中的`null`项表示还没有校对结果，重新校对时只处理`null`对应的条目，而不会重复处理已经完成的条目；校对前后的JSON长度不一致时（比如切分标准不一导致）会提示备份
6. 测试.proofread.json.md，拼合上项JSON文件中的结果，比较最初的markdown文件即可看出改动处；如果这个文件已经存在，则自动备份，并加时间戳
7. 测试.diff.html：通过jsdiff库比较校对前后markdown文件所得的结果，与Word近似的行内标记，可通过浏览器打印成PDF。需要联网调用jsdiff库，并等待运算完成
8. 测试.proofread.log，校对日志，**校对文本选段的结果也会存在这里**
9. 测试.alignment.html，逐句对齐勘误表（通过 diff 命令选择「对齐句子生成勘误表」或校对面板「生成勘误表」生成）
10. 测试.word-errors.csv，常用词语错误收集结果（生成勘误表时选择「同时收集」可得），CSV 格式（错误词语,正确词语,错误词语所在小句,错词长度,正词长度），便于筛选

**请特别注意：除自动累加的日志文件和提示备份的`测试.proofread.json`、自动备份的`测试.proofread.json.md`，其余中间文件，每次操作都将重新生成！如有需要，请自行备份。**

### 3.7. 注意事项

1. 确保在使用前已正确配置必要的 API 密钥。**请妥善保存你的秘钥！**
2. **一般的语言文字校对依赖丰富的知识、语料，建议使用大规模、非推理模型。某些推理模型、混合模型可能因为运行时间过长而导致错误，而服务器端可能已经实际运行并计费！**
3. 长文本建议先切分后校对，文本长度过程会影响校对质量，并增加失败的几率
4. 注意所用模型 API 调用频率和并发数的限制，可通过配置调整
5. 启用提示词重复功能会增加输入token成本，请根据实际效果权衡使用

## 4. 配置

从VS Code界面左下角或扩展界面的⚙️，或从命令面板（Ctrl+Shift+P）查找命令Preferences: Open Settings (UI)都能进入扩展配置界面。

配置项的意义请参考本文档相关的部分，以及对应模型的文档。

参考：

* 阿里云百炼平台[限流规则](https://help.aliyun.com/zh/model-studio/rate-limit)：qwen-max系列稳定版的rpm通常为600甚至更高，带日期的快照版通常为60，没有并发限制（建议为10，经验100以内通常没有问题）
* Deepseek[限速](https://api-docs.deepseek.com/zh-cn/quick_start/rate_limit)：没有并发限制，但服务器在高流量时会延迟（需要注意观察）
* 谷歌[rate-limits](https://ai.google.dev/gemini-api/docs/rate-limits)

### 4.1. 大语言模型

目前支持这些大语言模型服务：

1. [阿里云百炼](https://bailian.console.aliyun.com/)，（默认） [模型列表](https://bailian.console.aliyun.com/?tab=model#/model-market)
2. [Deepseek开放平台](https://platform.deepseek.com/)
3. [Google Gemini](https://aistudio.google.com/)，[模型列表](https://ai.google.dev/gemini-api/docs/models)
4. [Ollama本地模型](https://ollama.ai/)，对计算机性能、专业知识要求较高

### 4.2. 模型路由

默认隐藏；overview「模型路由」或命令 `open model routes view` 打开侧栏 `model routes`：

为不同 LLM 管线分别指定平台、模型与**思考模式**。默认继承关系：

| 管线（侧栏顺序） | 默认跟随 | 说明 |
|------------------|----------|------|
| 校对 | — | `proofread.platform` / `proofread.models.*`；思考由 `proofread.disableThinking` 控制（默认关） |
| 参考资料预筛 | 参考资料规划 | 大目录时筛选词典与文献（规划前，条件触发） |
| 参考资料规划 | 校对 | 多轮生成检索计划 JSON |
| 参考资料精排 | 参考资料规划 | 每轮检索后打分去重 |
| 编辑记忆合并 | 校对 | 带记忆校对写回后整理 |

精排与预筛可在配置中选择跟随「校对」或「参考资料规划」。点击树中某一项即可选择平台、填写模型、切换跟随，或**单独开关思考模式**（可在跟随平台/模型的同时覆盖思考）。配置思考时侧栏与菜单会提示：当前生效、产品默认、开启的收益与负担。

高级用户可编辑 `ai-proofread.modelRoutes`（支持 `inheritFrom`: `proofread` | `referencePrep`，以及 `disableThinking`）。示例：仅为规划开启思考：`{ "referencePrep": { "disableThinking": false } }`。

**推荐模型组合**（DeepSeek 示例，可按平台替换）：

- **校对**：`qwen3.8-max`（质量优先）；日常建议关闭思考
- **参考资料规划**：`deepseek-v4-flash` （多轮 JSON 规划，成本适中）；复杂书稿可单独开思考
- **预筛 / 精排**：跟随参考资料规划，建议保持关思考
- **编辑记忆合并**：跟随校对；需要时再开思考

### 4.3. 模型温度

每个模型用于校对的最佳温度需要耐心测试才能得到。

以往的经验是，温度为1时极少有错误和无效改动。

提高模型温度可以增加随机性，如此多次尝试有可能提高召回率，同时也增加不稳定和错误率。

以下是官方资料：

1. 阿里云百炼平台

    * qwen系列: 取值范围是`[0:2)`

2. deepseek

    `temperature` 参数默认为 1.0。

    官方建议根据如下表格，按使用场景设置 `temperature`。

    | 场景                | 温度 |
    | ------------------- | ---- |
    | 代码生成/数学解题   | 0.0  |
    | 数据抽取/分析       | 1.0  |
    | 通用对话            | 1.3  |
    | 翻译                | 1.3  |
    | 创意类写作/诗歌创作 | 1.5  |


3. Google Gemini

    默认为1

## 5. TODO

1. 优化资料查询：接入 web 搜索服务
2. 分词连写检查提示词
3. 优化memo管理智能体
    1. 三段式：原文；改后；说明
    2. 自动分类，加类别说明
        1. 特例穷尽列举（如大多数孤立的字形词形问题）
        2. 字词搭配、句段问题举出典型例子，可替换、精简
    3. 存档、压缩工作流……
4. 本地视觉模型图像校对工作流（专注于图像审查、版式和空间关系）
5. 尝试用思考模型校对
6. 预置更多提示词
    1. 习题试做：试做，就地回答，增加必要的格式标记
    2. PDF/OCR文本整理
7. 预置自定义表
    1. 查找数字：分类查找，以便检查一致性
    2. 找到时间：分类查找年代、时间，以便检查一致性
8.  读秀在线引文核对
9.  人看的相似度使用编辑距离：fastest-levenshtein，在对齐完成后，快速计算两个相似句子的“修改程度”百分比。它是 JS 环境下编辑距离运算的最快实现
10. 勘误表改为JSON加web viewer
11. 内部git版本管理
12. 在按长度切分的基础上调用LLM辅助切分（似乎仅仅在没有空行分段文本上有必要）

## 6. 开发命令

<!--
Windows 若在 **PowerShell** 里直接运行 `npm` 报错「禁止运行脚本」（`PSSecurityException`），可任选其一：命令行改用 **`npm.cmd`**（例如 `npm.cmd run compile`）；或在 VS Code / Cursor 中按 **`Ctrl+Shift+B`** 使用本仓库自带的默认生成任务（`.vscode/tasks.json` 调用 `npm.cmd run compile`）；或在当前用户下执行 `Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser` 后再使用 `npm run …`。
-->

```bash
# 安装依赖
npm install

# 首次开发需先执行一次打包，确保 sql.js 和 jieba-wasm 已复制到 dist
npm run package

# 单次编译扩展（等价于 Ctrl+Shift+B 默认生成任务）
npm run compile

# 开发时实时编译
npm run watch

# 打包
npm run package

# 构建 vsix 扩展安装文件用
npm run package-vsix

# 发布
npm run publish
```
