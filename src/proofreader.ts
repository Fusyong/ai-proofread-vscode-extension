/**
 * 校对工具模块
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import axios from 'axios';
import * as dotenv from 'dotenv';
import { RateLimiter } from './rateLimiter';
import { GoogleGenAI } from "@google/genai";
import { ConfigManager, Logger } from './utils';
import { convertQuotes } from './quoteConverter';
import { buildTitleBasedContext, buildParagraphBasedContext } from './splitter';
import { buildEditorialMemoryXml } from './editorialMemory/service';
import { ProgressTracker, ProgressUpdateCallback } from './progressTracker';
import { parseItemOutput, type ProofreadItem } from './itemOutputParser';
import { applyItemReplacements, attachAnchorsToProofreadItems } from './itemReplacer';
import {
    SYSTEM_PROMPT_NAME_FULL,
    SYSTEM_PROMPT_NAME_ITEM,
    SYSTEM_PROMPT_NAME_NORMALIZATION_FULL,
    SYSTEM_PROMPT_NAME_NORMALIZATION_ITEM,
    SYSTEM_PROMPT_NAME_HARD_ISSUE_ITEM,
    SYSTEM_PROMPT_NAME_CORRESPONDENCE_CHECK_ITEM,
    SYSTEM_PROMPT_NAME_PINYIN_PROOFREAD_FULL,
    SYSTEM_PROMPT_NAME_PINYIN_ANNOTATION_FULL,
    SYSTEM_PROMPT_NAME_KNOWLEDGE_VERIFY_ITEM,
    SYSTEM_PROMPT_NAME_KNOWLEDGE_VERIFY_FULL,
} from './promptManager';
import { getExtensionContext } from './extensionContextHolder';
import { formatSourceCharacteristicsBlock } from './sourceTextCharacteristics';
import {
    PINYIN_PROOFREAD_SYSTEM_PROMPT_TEMPLATE,
    PINYIN_ANNOTATION_SYSTEM_PROMPT_TEMPLATE,
    PINYIN_PROOFREAD_OUTPUT_FORMAT,
    PINYIN_ANNOTATION_OUTPUT_FORMAT,
} from './pinyinPrompt';

// 加载环境变量
dotenv.config();

/** OpenAI 兼容（axios）接口：非网络类失败时的日志；401/403 指向密钥与平台配置 */
function logAxiosNonNetworkFailure(logger: Logger, error: unknown): void {
    if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 401 || status === 403) {
            logger.error(
                `API 认证失败（HTTP ${status}）：请检查设置「ai-proofread.apiKeys」中当前平台的密钥是否正确、未过期，并与所选服务商一致`,
                error
            );
            return;
        }
    }
    logger.error('API调用出错（非网络错误，不重试）', error);
}

// 默认输出格式（全文输出）
const DEFAULT_OUTPUT_FORMAT = `
1. 在目标文本（target）上直接校对，并输出校对后的目标文本，不给出任何说明或解释；
2. 即使你确认的确没有任何修改，也应该逐句阅读并输出原文；
`

// 条目式输出格式（JSON）；内置条目模板与自定义 outputType=item 均依赖此说明以便解析与「校对条目」树展示
export const ITEM_OUTPUT_FORMAT = `
1. 从目标文本（target）中挑出有问题、需要修改的句子，加以修改，以 JSON 格式输出，且只输出该 JSON，不要其他说明。
2. JSON 格式为：{"items":[{"original":"有问题、需要修改的句子","corrected":"修改后的句子","confidence":0.85,"explanation":"解释，绝大多数情形下可省略，仅在不解释难以理解时填写"}]}；字段说明：original（必选）、corrected（可选）、confidence（可选，0 到 1 的小数，表示你对本条修改正确性的把握，1 为非常有把握；把握不足时用较低值；难以量化时可省略）、explanation（可选）。
3. 若无任何修改，输出：{"items":[]}
`

// 内置的系统提示词
const DEFAULT_SYSTEM_PROMPT_TEMPLATE = `
<proofreader-system-setting version="0.1.1">
<role-setting>

你是一位精通中文的校对专家、语言文字专家，像杜永道等专家那样，能准确地发现文章的语言文字问题。

你的语感也非常好，通过朗读就能感受到句子是否自然，是否潜藏问题。

你知识渊博，能发现文中的事实错误和百科知识错误。

你工作细致、严谨，当你发现潜在的问题时，你会通过维基百科、《现代汉语词典》《辞海》等各种权威工具书来核对；如果涉及古代汉语和古代文化，你会专门查阅中华书局、上海古籍出版社等权威出版社出版的古籍，以及《王力古汉语字典》《汉语大词典》《辞源》《辞海》等工具书。

你还学习过以下数据纠错数据集：

1. [中文语法纠错数据集](https://huggingface.co/datasets/shibing624/CSC-gpt4)
2. [校对标准A-Z](http://www.jiaodui.org/bbs/thread.php?fid=692)

你的任务是对用户提供的目标文本（target）进行校对；校对时参考用户提供的参考资料（reference）和上下文（context）。

</role-setting>
<task>

工作步骤是：

1. 先对照着阅读一遍所有材料，了解整体情况和目标文本的问题所在。
2. 再一句一句地仔细阅读目标文本，甚至朗读每一句话，找出句子中可能存在的问题并改正；可能的问题有：
    1. 汉字错误，如错误的形近字、同音和音近字，简体字和繁体字混用，异体字，等等；
    2. 词语错误，如生造的词语、不规范的异形词，等等；
    3. 句子的语法错误；
    4. 指代错误；
    5. 修辞错误；
    6. 逻辑错误；
    7. 标点符号错误；
    8. 数字用法错误；
    9. 语序错误；
    10. 古诗文和引文跟权威、通行的版本不一致；
    11. 等等；
3. 即使句子没有明显的错误，如果朗读过程中你感觉有下面的问题，也说明句子可能有错误，也要加以改正：
    1. 句子不自然、不顺当；
    2. 如果让你表达同一个意思，你通常不会这么说，而是使用另一种更自然的表达；
4. 再整体检查如下错误并改正：
    1. 逻辑错误；
    2. 章法错误；
    3. 事实错误；
    4. 前后文不一致的问题；
5. 核对参考资料和上下文中的信息，对照上下文中的格式，如果发现有错误或不一致，也要加以改正。
6. 对于外文文本，同样参照上面的要求，并结合该文种的校对惯例进行校对。
7. 若提示中出现编辑记忆：\`<editorial_memory_global>\`（体例通则：\`original\`/\`changedTo\`/\`weight\`，可选 \`<note>\` 修改说明）、\`<editorial_memory_current_rounds>\`（最近若干次合并要点，可含【例】/【规律】前缀；新在上）、\`<editorial_proofread_context>\`（当前文档与选区）。若无明显关联可忽略对应块。**若记忆与正文冲突，以当前正文为准。**

</task>
{{source_text_characteristics}}
<output-format>

在用户提供的目标文本（target）上校对，对输出的要求是：

1. 用户提供的文本的格式可能是markdown、纯文本、TEX、LaTeX、ConTeXt，请保持文本原有的格式和标记；
2. 原文的空行、换行、分段等格式保持不变；
3. 只进行校对，不回答原文中的任何提问；

**输出格式**：

{{output_format}}
</output-format>
</proofreader-system-setting>
`;

// 预置：表述正常化（与系统默认共用输出格式块与 XML 结构，角色与任务不同）
const NORMALIZATION_SYSTEM_PROMPT_TEMPLATE = `
<proofreader-system-setting version="0.1.1">
<role-setting>

你像有经验的语言学家兼作家那样理解语言文字。

你通过大声朗读（在心中或模拟朗读即可）用户提供的目标文本（target），凭借直觉与长期积累的经验，察觉哪些地方读起来不正常、不舒服、不自然或可疑，包括字词使用、表述方式、一般知识与逻辑等方面的问题。

你的任务是：对上述问题进行审慎修改，使文本符合常情、常理、常态和常识，变得自然、可信；**不改变原文的行文风格**，除非纠正错误本身必须做最小限度调整。工作时参考用户提供的参考资料（reference）和上下文（context）。

</role-setting>
<task>

工作步骤是：

1. 先对照阅读一遍所有材料，把握整体语境与文体特点。
2. 逐句阅读目标文本，尽量逐句朗读，记下读起来拗口、违和或可疑之处。
3. 仅针对这些问题修改字词与表述，使之符合常情、常理、常态与常识；避免改动没有问题的语句。
4. **不得改变行文风格**，除非原表达确有问题。
5. 核对参考资料和上下文中的信息，对照上下文中的格式，修正与之不一致之处。
6. 对于外文文本，同样参照上面的要求，并结合该文种的表达习惯处理。
7. 若提示中出现编辑记忆：\`<editorial_memory_global>\`（体例通则：\`original\`/\`changedTo\`/\`weight\`，可选 \`<note>\` 修改说明）、\`<editorial_memory_current_rounds>\`（最近若干次合并要点，可含【例】/【规律】前缀；新在上）、\`<editorial_proofread_context>\`（当前文档与选区）。若无明显关联可忽略对应块。**若记忆与正文冲突，以当前正文为准。**

</task>
{{source_text_characteristics}}
<output-format>

在用户提供的目标文本（target）上校对，对输出的要求是：

1. 用户提供的文本的格式可能是markdown、纯文本、TEX、LaTeX、ConTeXt，请保持文本原有的格式和标记；
2. 原文的空行、换行、分段等格式保持不变；
3. 只进行校对，不回答原文中的任何提问；

**输出格式**：

{{output_format}}
</output-format>
</proofreader-system-setting>
`;

// 预置：硬伤发现（仅条目式；与系统默认 item 共用 ITEM_OUTPUT_FORMAT）
const HARD_ISSUE_SYSTEM_PROMPT_TEMPLATE = `
<proofreader-system-setting version="0.1.1">
<role-setting>

你是经验丰富的语言学家和知识广博的百科知识作家。

你的工作是针对用户提供的目标文本（target）**挑错**：发现其中的**语言文字硬伤**，以及**知识性、逻辑性**方面的错误。

所谓**硬伤**，指若你的判断成立，则属于**必须改正**的一类问题；**不包括**纯属个人文风偏好、可有可无的措辞推敲，也不包括「换一种说法更漂亮」这类**可改可不改**的优化建议。

不管是否有充分的依据，都在条目中给出你的修改（corrected），供用户参考。当你**没有充分依据**断定必错、需要用户自行查证核实时，仍可将可疑之处列入条目，但必须用较低的 **confidence（置信度）** 标明不确定性；如果问题比较隐蔽，可以在 **explanation** 中简要说明，但通常可省略说明。

工作时参考用户提供的参考资料（reference）和上下文（context）。

</role-setting>
<task>

工作步骤是：

1. 先对照阅读一遍所有材料，把握事实背景与术语脉络，避免脱离上下文误判。
2. 逐句阅读目标文本，只标记**硬伤级别**的问题：明显的字词误用、硬伤级语法问题、对应关系错误、事实与百科知识错误、推理或前后矛盾等。
3. **刻意忽略**：单纯的表达优化、风格润色、可有可无的同义替换；除非你同时能论证原表述已构成错误（而非仅仅「不够好」）。
4. 对每一处硬伤给出修改建议；依据不足时降低 confidence，如有必要，可在 explanation 中作出简要说明。
5. 核对参考资料和上下文；若与正文冲突且你能确信一方有误，按硬伤处理并说明依据。
6. 对于外文文本，同样只报告硬伤级问题，并结合该文种规范判断。
7. 若提示中出现编辑记忆：\`<editorial_memory_global>\`（体例通则：\`original\`/\`changedTo\`/\`weight\`，可选 \`<note>\` 修改说明）、\`<editorial_memory_current_rounds>\`（最近若干次合并要点，可含【例】/【规律】前缀；新在上）、\`<editorial_proofread_context>\`（当前文档与选区）。若无明显关联可忽略对应块。**若记忆与正文冲突，以当前正文为准。**

</task>
{{source_text_characteristics}}
<output-format>

在用户提供的目标文本（target）上校对，对输出的要求是：

1. 用户提供的文本的格式可能是markdown、纯文本、TEX、LaTeX、ConTeXt，请保持文本原有的格式和标记；
2. 原文的空行、换行、分段等格式保持不变；
3. 只进行校对，不回答原文中的任何提问；

**输出格式**：

{{output_format}}
</output-format>
</proofreader-system-setting>
`;

// 预置：对应关系核对（仅条目式；与系统默认 item 共用 ITEM_OUTPUT_FORMAT）
const CORRESPONDENCE_CHECK_SYSTEM_PROMPT_TEMPLATE = `
<proofreader-system-setting version="0.1.1">
<role-setting>

你是一位经验丰富的图书编辑，对各种书稿的形式、结构非常熟悉，擅长发现和纠正各种相互关系错误。

你的工作是仔细阅读用户提供的目标文本（target），发现其中**错误的相互关系**：凡字词、表述、符号、数字或格式标记与文中其他位置形成**应对应一致**的关系时，都要专门核对；若不一致或矛盾，则作为条目报告并给出修改建议。

**对应关系**包括但不限于：上下文之间的引用、指称、概括以及逻辑链条的一致性；同一实体多种称谓、译名、缩写与全称之间的一致性；词语与其括注、脚注、尾注、注音等注释内容的一致性；题干与选项或答案的对应；练习提示、语境与挖空、填空位置的对应；提问与答复的对应；图表编号与正文提及的对应；公式、条件与结论的对应；前后数据、单位、符号书写的一致；等等。

依据不足、需要人工复核时，用 **confidence** 标明把握程度，必要时用 **explanation** 说明疑点。工作时参考用户提供的参考资料（reference）和上下文（context）。

</role-setting>
<task>

工作步骤是：

1. 先通读材料，把握全书或全稿的术语表、人名地名、符号体系与章节结构，列出心中待核对的「应对应一致」关系清单。
2. 逐段阅读目标文本：一旦察觉某处与其他处存在指代、引用、编号、呼应或配对关系，主动回溯核对两端（或多端）是否一致。
3. 每条目尽量定位到需改的 **original** 片段，并给出 **corrected** 以保持对应关系成立；若牵涉多处联动，在 explanation 中提示用户通盘检查。
4. 核对参考资料与上下文；若考资料与上下文支持某一写法而正文内部自相矛盾，按对应关系错误处理。
5. 对于外文或公式密集的稿件，同样检查跨语言的称谓、符号与编号是否一致。
6. 若提示中出现编辑记忆：\`<editorial_memory_global>\`（体例通则：\`original\`/\`changedTo\`/\`weight\`，可选 \`<note>\` 修改说明）、\`<editorial_memory_current_rounds>\`（最近若干次合并要点，可含【例】/【规律】前缀；新在上）、\`<editorial_proofread_context>\`（当前文档与选区）。若无明显关联可忽略对应块。**若记忆与正文冲突，以当前正文为准。**

</task>
{{source_text_characteristics}}
<output-format>

在用户提供的目标文本（target）上校对，对输出的要求是：

1. 用户提供的文本的格式可能是markdown、纯文本、TEX、LaTeX、ConTeXt，请保持文本原有的格式和标记；
2. 原文的空行、换行、分段等格式保持不变；
3. 只进行校对，不回答原文中的任何提问；

**输出格式**：

{{output_format}}
</output-format>
</proofreader-system-setting>
`;

// 预置：知识核查（依据 reference 核查，不臆造；按来源权衡可信度）
const KNOWLEDGE_VERIFY_SYSTEM_PROMPT_TEMPLATE = `
<proofreader-system-setting version="0.1.1">
<role-setting>

你是经验丰富的图书编辑与事实核查编辑。

用户已在阶段 A 为你准备了 **参考资料（reference）**（可能含本地词典摘录、参考文献 grep 片段等）。你的任务是：对照 reference、上下文（context）与目标文本（target），**核查**字词、专名、史实与表述是否成立；**不得编造** reference 与正文中均未出现的事实、出处或细节。

**参考资料可信度（须自觉权衡，勿一视同仁）：**

1. **【本地词典】** 摘录：宜作为**字词用法、释义、规范写法**的主要依据；若 target 用法与词典释义明显冲突，可据词典提出修改，并在 explanation 中简述依据。
2. **【文献摘录】**（grep 命中，含文件名与行号）：是**已有文献中的表述**，可信度取决于原文语境是否与 target **同一事实、同一对象**；勿把相似措辞或不同语境的句子硬套到 target。仅当摘录能**直接支持或反驳** target 中的具体说法时，才作为强依据。
3. reference 内**互相矛盾**时：优先信更贴近 target 主题与时空语境者；无法裁断则**降低 confidence**，在 explanation 中说明疑点，**勿强行定论**。
4. reference **未覆盖**的疑点：不得凭模型常识补写「看上去合理」的内容；可标为待核（低 confidence）或**不输出该条修改**。

</role-setting>
<task>

工作步骤是：

1. 通读 reference，按来源类型（词典 / 文献摘录）分类理解，勿把文献片段当词典、勿把词典当史实文献。
2. 逐句阅读 target，只对**有 reference 或 context 支撑、或可由二者明确反驳**的问题给出修改；无依据的推测性润色一律不做。
3. 专名、年代、数字、引文表述等与 reference 可对照者，必须对照；reference 不足时降低 confidence 或跳过。
4. 保持 target 原有格式（Markdown、TeX 等）与行文风格；仅改确有问题的部分。
5. 若提示中出现编辑记忆相关块，仅在明显相关时参考；**与 reference 或正文冲突时，以 reference 与当前正文为准**。

</task>
{{source_text_characteristics}}
<output-format>

在用户提供的目标文本（target）上校对，对输出的要求是：

1. 用户提供的文本的格式可能是markdown、纯文本、TEX、LaTeX、ConTeXt，请保持文本原有的格式和标记；
2. 原文的空行、换行、分段等格式保持不变；
3. 只进行校对，不回答原文中的任何提问；

**输出格式**：

{{output_format}}
</output-format>
</proofreader-system-setting>
`;

function buildSystemPromptFromTemplate(
    outputFormat: string,
    sourceTextCharacteristics: string,
    template: string = DEFAULT_SYSTEM_PROMPT_TEMPLATE
): string {
    const block = formatSourceCharacteristicsBlock(sourceTextCharacteristics);
    return template.replace('{{output_format}}', outputFormat).replace('{{source_text_characteristics}}', block);
}

/** 输出类型：全文 | 条目 */
export type OutputType = 'full' | 'item';

/**
 * 获取当前输出类型：从当前选中的提示词（系统全文/系统条目/自定义）或全局配置读取
 */
export function getOutputType(context?: vscode.ExtensionContext): OutputType {
    const ctx = context ?? getExtensionContext();
    if (ctx) {
        const currentPromptName = ctx.globalState.get<string>('currentPrompt', SYSTEM_PROMPT_NAME_FULL) ?? SYSTEM_PROMPT_NAME_FULL;
        if (
            currentPromptName === SYSTEM_PROMPT_NAME_ITEM ||
            currentPromptName === SYSTEM_PROMPT_NAME_NORMALIZATION_ITEM ||
            currentPromptName === SYSTEM_PROMPT_NAME_HARD_ISSUE_ITEM ||
            currentPromptName === SYSTEM_PROMPT_NAME_CORRESPONDENCE_CHECK_ITEM ||
            currentPromptName === SYSTEM_PROMPT_NAME_KNOWLEDGE_VERIFY_ITEM
        ) {
            return 'item';
        }
        if (
            currentPromptName === SYSTEM_PROMPT_NAME_FULL ||
            currentPromptName === SYSTEM_PROMPT_NAME_NORMALIZATION_FULL ||
            currentPromptName === SYSTEM_PROMPT_NAME_PINYIN_PROOFREAD_FULL ||
            currentPromptName === SYSTEM_PROMPT_NAME_PINYIN_ANNOTATION_FULL ||
            currentPromptName === SYSTEM_PROMPT_NAME_KNOWLEDGE_VERIFY_FULL
        ) {
            return 'full';
        }
        const config = vscode.workspace.getConfiguration('ai-proofread');
        const prompts = config.get<Array<{ name: string; content: string; outputType?: 'full' | 'item' | 'other' }>>('prompts', []);
        if (currentPromptName && prompts.length > 0) {
            const selected = prompts.find(p => p.name === currentPromptName);
            if (selected?.outputType === 'item' || selected?.outputType === 'full') return selected.outputType;
            if (selected?.outputType === 'other') return 'full';
        }
    }
    const config = vscode.workspace.getConfiguration('ai-proofread');
    const defaultOutputType = config.get<'full' | 'item'>('proofread.defaultOutputType', 'full');
    return defaultOutputType === 'item' ? 'item' : 'full';
}

/** 自定义提示词在 outputType=item 时需产出可解析的 JSON，否则「校对条目」树与阶段二替换均失效 */
function appendItemOutputFormatIfNeeded(content: string, outputType?: string): string {
    if (outputType !== 'item') {
        return content;
    }
    return `${content.trimEnd()}\n\n---\n\n【条目式输出格式（扩展解析依赖，请勿省略）】\n${ITEM_OUTPUT_FORMAT.trim()}\n`;
}

// 获取用户配置的提示词；优先使用调用方传入的 context，否则使用激活时持有的 context
// sourceTextCharacteristics 仅在当前为内置全文/条目模板（系统默认、表述正常化、硬伤发现、对应关系核对等）时生效，自定义提示词忽略
function getSystemPrompt(context?: vscode.ExtensionContext, sourceTextCharacteristics: string = ''): string {
    const config = vscode.workspace.getConfiguration('ai-proofread');
    const prompts = config.get<Array<{ name: string; content: string; outputType?: string }>>('prompts', []);
    const logger = Logger.getInstance();
    const ctx = context ?? getExtensionContext();

    if (ctx) {
        const currentPromptName = ctx.globalState.get<string>('currentPrompt', SYSTEM_PROMPT_NAME_FULL) ?? SYSTEM_PROMPT_NAME_FULL;

        if (currentPromptName === SYSTEM_PROMPT_NAME_ITEM) {
            logger.info('使用系统默认提示词（item）');
            return buildSystemPromptFromTemplate(ITEM_OUTPUT_FORMAT, sourceTextCharacteristics);
        }
        if (currentPromptName === SYSTEM_PROMPT_NAME_FULL) {
            logger.info('使用系统默认提示词（full）');
            return buildSystemPromptFromTemplate(DEFAULT_OUTPUT_FORMAT, sourceTextCharacteristics);
        }
        if (currentPromptName === SYSTEM_PROMPT_NAME_NORMALIZATION_ITEM) {
            logger.info('使用预置提示词：表述正常化（item）');
            return buildSystemPromptFromTemplate(ITEM_OUTPUT_FORMAT, sourceTextCharacteristics, NORMALIZATION_SYSTEM_PROMPT_TEMPLATE);
        }
        if (currentPromptName === SYSTEM_PROMPT_NAME_NORMALIZATION_FULL) {
            logger.info('使用预置提示词：表述正常化（full）');
            return buildSystemPromptFromTemplate(DEFAULT_OUTPUT_FORMAT, sourceTextCharacteristics, NORMALIZATION_SYSTEM_PROMPT_TEMPLATE);
        }
        if (currentPromptName === SYSTEM_PROMPT_NAME_HARD_ISSUE_ITEM) {
            logger.info('使用预置提示词：硬伤发现（item）');
            return buildSystemPromptFromTemplate(ITEM_OUTPUT_FORMAT, sourceTextCharacteristics, HARD_ISSUE_SYSTEM_PROMPT_TEMPLATE);
        }
        if (currentPromptName === SYSTEM_PROMPT_NAME_CORRESPONDENCE_CHECK_ITEM) {
            logger.info('使用预置提示词：对应关系核对（item）');
            return buildSystemPromptFromTemplate(
                ITEM_OUTPUT_FORMAT,
                sourceTextCharacteristics,
                CORRESPONDENCE_CHECK_SYSTEM_PROMPT_TEMPLATE
            );
        }
        if (currentPromptName === SYSTEM_PROMPT_NAME_PINYIN_PROOFREAD_FULL) {
            logger.info('使用预置提示词：拼音审校（full）');
            return buildSystemPromptFromTemplate(
                PINYIN_PROOFREAD_OUTPUT_FORMAT,
                sourceTextCharacteristics,
                PINYIN_PROOFREAD_SYSTEM_PROMPT_TEMPLATE
            );
        }
        if (currentPromptName === SYSTEM_PROMPT_NAME_PINYIN_ANNOTATION_FULL) {
            logger.info('使用预置提示词：拼音加注（full）');
            return buildSystemPromptFromTemplate(
                PINYIN_ANNOTATION_OUTPUT_FORMAT,
                sourceTextCharacteristics,
                PINYIN_ANNOTATION_SYSTEM_PROMPT_TEMPLATE
            );
        }
        if (currentPromptName === SYSTEM_PROMPT_NAME_KNOWLEDGE_VERIFY_ITEM) {
            logger.info('使用预置提示词：知识核查（item）');
            return buildSystemPromptFromTemplate(
                ITEM_OUTPUT_FORMAT,
                sourceTextCharacteristics,
                KNOWLEDGE_VERIFY_SYSTEM_PROMPT_TEMPLATE
            );
        }
        if (currentPromptName === SYSTEM_PROMPT_NAME_KNOWLEDGE_VERIFY_FULL) {
            logger.info('使用预置提示词：知识核查（full）');
            return buildSystemPromptFromTemplate(
                DEFAULT_OUTPUT_FORMAT,
                sourceTextCharacteristics,
                KNOWLEDGE_VERIFY_SYSTEM_PROMPT_TEMPLATE
            );
        }

        // 当前选择的是自定义提示词
        if (currentPromptName && prompts.length > 0) {
            const selectedPrompt = prompts.find(p => p.name === currentPromptName);
            if (selectedPrompt) {
                logger.info(`使用自定义提示词: ${selectedPrompt.name}`);
                return appendItemOutputFormatIfNeeded(selectedPrompt.content, selectedPrompt.outputType);
            }
        }
    }

    // 无 context 或未找到对应提示词时的回退
    if (prompts.length > 0) {
        const p0 = prompts[0];
        logger.info(`使用自定义提示词: ${p0.name}`);
        return appendItemOutputFormatIfNeeded(p0.content, p0.outputType);
    }

    logger.info('使用系统默认提示词（full）');
    return buildSystemPromptFromTemplate(DEFAULT_OUTPUT_FORMAT, sourceTextCharacteristics);
}

/**
 * 将配置中的时间值（秒）转换为毫秒
 * @param value 配置值（秒）
 * @param defaultValue 默认值（秒）
 * @returns 毫秒数
 */
function convertSecondsToMilliseconds(value: number | undefined, defaultValue: number): number {
    const seconds = typeof value === 'number' && !Number.isNaN(value) ? value : defaultValue;
    return seconds * 1000;
}

/**
 * 提示词重复模式
 */
type PromptRepetitionMode = 'none' | 'target' | 'all';

/**
 * 获取提示词重复模式
 * @returns 重复模式：'none'不重复，'target'仅重复target，'all'重复完整对话流程
 */
function getPromptRepetitionMode(): PromptRepetitionMode {
    const config = vscode.workspace.getConfiguration('ai-proofread');
    const mode = config.get<string>('proofread.promptRepetition', 'none');
    if (mode === 'target' || mode === 'all') {
        return mode as PromptRepetitionMode;
    }
    return 'none';
}

/**
 * API调用接口
 */
export interface ApiClient {
    proofread(
        targetText: string,
        preText?: string,
        temperature?: number | null,
        context?: vscode.ExtensionContext,
        repetitionMode?: PromptRepetitionMode,
        sourceTextCharacteristics?: string
    ): Promise<string | null>;
}

/**
 * 处理进度统计
 */
export interface ProcessStats {
    totalCount: number;
    processedCount: number;
    totalLength: number;
    processedLength: number;
    unprocessedParagraphs: Array<{
        index: number;
        preview: string;
    }>;
    progressTracker?: ProgressTracker;
}

/**
 * Deepseek API客户端
 */
export class DeepseekApiClient implements ApiClient {
    private apiKey: string;
    private baseUrl: string;
    private model: string;

    constructor(model: string) {
        const configManager = ConfigManager.getInstance();
        this.model = model;
        this.apiKey = configManager.getApiKey('deepseek');
        this.baseUrl = 'https://api.deepseek.com/v1';

        if (!this.apiKey) {
            throw new Error('未配置 Deepseek开放平台 API密钥，请在设置中配置');
        }
    }

    // 使用 Deepseek API 进行校对
    async proofread(
        targetText: string,
        preText: string = '',
        temperature: number|null = null,
        context?: vscode.ExtensionContext,
        repetitionMode?: PromptRepetitionMode,
        sourceTextCharacteristics: string = ''
    ): Promise<string | null> {
        const logger = Logger.getInstance();
        const config = vscode.workspace.getConfiguration('ai-proofread');
        const retryAttempts = config.get<number>('proofread.retryAttempts', 3);
        const retryDelay = convertSecondsToMilliseconds(config.get<number>('proofread.retryDelay', 1), 1);
        const timeout = convertSecondsToMilliseconds(config.get<number>('proofread.timeout', 50), 50);

        const messages = [
            { role: 'system', content: getSystemPrompt(context, sourceTextCharacteristics) }
        ];

        // 使用传入的重复模式，如果没有则从配置读取
        const actualRepetitionMode = repetitionMode || getPromptRepetitionMode();

        // 构建第一轮对话
        if (preText) {
            messages.push(
                { role: 'assistant', content: '' },
                { role: 'user', content: preText }
            );
        }

        messages.push(
            { role: 'assistant', content: '' },
            { role: 'user', content: targetText }
        );

        // 根据重复模式添加重复内容
        if (actualRepetitionMode === 'target') {
            // 仅重复target
            messages.push(
                { role: 'assistant', content: '' },
                { role: 'user', content: targetText }
            );
        } else if (actualRepetitionMode === 'all') {
            // 重复完整对话流程（preText + targetText）
            if (preText) {
                messages.push(
                    { role: 'assistant', content: '' },
                    { role: 'user', content: preText }
                );
            }

            messages.push(
                { role: 'assistant', content: '' },
                { role: 'user', content: targetText }
            );
        }

        const finalTemperature = temperature || config.get<number>('proofread.temperature');
        const requestBody: any = {
            model: this.model,
            messages,
        };

        const disableThinking = config.get<boolean>('proofread.disableThinking', true);
        if (disableThinking) {
            requestBody.thinking = { type: 'disabled' as const };
        } else {
            requestBody.thinking = { type: 'enabled' as const };
            requestBody.reasoning_effort = 'high' as const;
        }

        // 思考模式开启时 temperature 等不生效，仅关闭思考时发送
        if (finalTemperature !== undefined && disableThinking) {
            requestBody.temperature = finalTemperature;
        }

        // 重试机制
        for (let attempt = 1; attempt <= retryAttempts; attempt++) {
            try {

                const response = await axios.post(
                    `${this.baseUrl}/chat/completions`,
                    requestBody,
                    {
                        headers: {
                            'Authorization': `Bearer ${this.apiKey}`,
                            'Content-Type': 'application/json',
                        },
                        timeout: timeout
                    }
                );

                logger.debugLlmRoundtrip('[DeepseekApiClient]', requestBody, response.data);

                let result = response.data.choices[0].message.content;
                result = result.replace('\n</target>', '').replace('<target>\n', '');
                return result;
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                const isNetworkError = errorMessage.includes('fetch failed') ||
                                     errorMessage.includes('network') ||
                                     errorMessage.includes('timeout') ||
                                     errorMessage.includes('ECONNRESET') ||
                                     errorMessage.includes('ENOTFOUND') ||
                                     errorMessage.includes('ECONNREFUSED');

                if (attempt === retryAttempts || !isNetworkError) {
                    logger.debugLlmFailure('[DeepseekApiClient]', requestBody, error);
                }

                if (attempt === retryAttempts) {
                    // 最后一次尝试失败
                    logger.error(`API调用失败，已重试 ${retryAttempts} 次`, error);
                    return null;
                }

                if (isNetworkError) {
                    // 网络错误，进行重试
                    logger.warn(`网络错误，${(retryDelay / 1000).toFixed(1)}秒后进行第 ${attempt + 1} 次重试: ${errorMessage}`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                } else {
                    // 非网络错误，不重试
                    logAxiosNonNetworkFailure(logger, error);
                    return null;
                }
            }
        }

        return null;
    }
}

/**
 * 阿里云百炼 API客户端
 */
export class AliyunApiClient implements ApiClient {
    private apiKey: string;
    private baseUrl: string;
    private model: string;

    constructor(model: string) {
        const configManager = ConfigManager.getInstance();
        this.model = model;
        this.apiKey = configManager.getApiKey('aliyun');
        this.baseUrl = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

        if (!this.apiKey) {
            throw new Error('未配置阿里云百炼平台 API密钥，请在设置中配置');
        }
    }

    // 使用阿里云百炼 API 进行校对
    async proofread(
        targetText: string,
        preText: string = '',
        temperature: number|null = null,
        context?: vscode.ExtensionContext,
        repetitionMode?: PromptRepetitionMode,
        sourceTextCharacteristics: string = ''
    ): Promise<string | null> {
        const logger = Logger.getInstance();
        const config = vscode.workspace.getConfiguration('ai-proofread');
        const retryAttempts = config.get<number>('proofread.retryAttempts', 3);
        const retryDelay = convertSecondsToMilliseconds(config.get<number>('proofread.retryDelay', 1), 1);
        const timeout = convertSecondsToMilliseconds(config.get<number>('proofread.timeout', 50), 50);

        const messages = [
            { role: 'system', content: getSystemPrompt(context, sourceTextCharacteristics) }
        ];

        // 使用传入的重复模式，如果没有则从配置读取
        const actualRepetitionMode = repetitionMode || getPromptRepetitionMode();

        // 构建第一轮对话
        if (preText) {
            messages.push(
                { role: 'assistant', content: '' },
                { role: 'user', content: preText }
            );
        }

        messages.push(
            { role: 'assistant', content: '' },
            { role: 'user', content: targetText }
        );

        // 根据重复模式添加重复内容
        if (actualRepetitionMode === 'target') {
            // 仅重复target
            messages.push(
                { role: 'assistant', content: '' },
                { role: 'user', content: targetText }
            );
        } else if (actualRepetitionMode === 'all') {
            // 重复完整对话流程（preText + targetText）
            if (preText) {
                messages.push(
                    { role: 'assistant', content: '' },
                    { role: 'user', content: preText }
                );
            }

            messages.push(
                { role: 'assistant', content: '' },
                { role: 'user', content: targetText }
            );
        }

        const finalTemperature = temperature || config.get<number>('proofread.temperature');
        const requestBody: any = {
            model: this.model,
            messages,
        };

        // 百炼 Qwen3 等混合式模型通过 enable_thinking 控制思考，见
        // https://www.alibabacloud.com/help/en/model-studio/deep-thinking
        const disableThinking = config.get<boolean>('proofread.disableThinking', true);
        requestBody.enable_thinking = !disableThinking;

        if (finalTemperature !== undefined) {
            requestBody.temperature = finalTemperature;
        } else {
        }

        // 重试机制
        for (let attempt = 1; attempt <= retryAttempts; attempt++) {
            try {

                const response = await axios.post(
                    `${this.baseUrl}/chat/completions`,
                    requestBody,
                    {
                        headers: {
                            'Authorization': `Bearer ${this.apiKey}`,
                            'Content-Type': 'application/json',
                        },
                        timeout: timeout
                    }
                );

                logger.debugLlmRoundtrip('[AliyunApiClient]', requestBody, response.data);

                let result = response.data.choices[0].message.content;
                result = result.replace('\n</target>', '').replace('<target>\n', '');
                return result;
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                const isNetworkError = errorMessage.includes('fetch failed') ||
                                     errorMessage.includes('network') ||
                                     errorMessage.includes('timeout') ||
                                     errorMessage.includes('ECONNRESET') ||
                                     errorMessage.includes('ENOTFOUND') ||
                                     errorMessage.includes('ECONNREFUSED');

                if (attempt === retryAttempts || !isNetworkError) {
                    logger.debugLlmFailure('[AliyunApiClient]', requestBody, error);
                }

                if (attempt === retryAttempts) {
                    // 最后一次尝试失败
                    logger.error(`API调用失败，已重试 ${retryAttempts} 次`, error);
                    return null;
                }

                if (isNetworkError) {
                    // 网络错误，进行重试
                    logger.warn(`网络错误，${(retryDelay / 1000).toFixed(1)}秒后进行第 ${attempt + 1} 次重试: ${errorMessage}`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                } else {
                    // 非网络错误，不重试
                    logAxiosNonNetworkFailure(logger, error);
                    return null;
                }
            }
        }

        return null;
    }
}

/**
 * Google API客户端
 */
export class GoogleApiClient implements ApiClient {
    private apiKey: string;
    private model: string;
    private ai: GoogleGenAI;

    constructor(model: string) {
        const configManager = ConfigManager.getInstance();
        this.model = model;
        this.apiKey = configManager.getApiKey('google');
        this.ai = new GoogleGenAI({ apiKey: this.apiKey });

        if (!this.apiKey) {
            throw new Error('未配置 Google Gemini API密钥，请在设置中配置');
        }
    }

    // 使用 Google API 进行校对
    async proofread(
        targetText: string,
        preText: string = '',
        temperature: number|null = null,
        context?: vscode.ExtensionContext,
        repetitionMode?: PromptRepetitionMode,
        sourceTextCharacteristics: string = ''
    ): Promise<string | null> {
        const logger = Logger.getInstance();
        const config = vscode.workspace.getConfiguration('ai-proofread');
        const retryAttempts = config.get<number>('proofread.retryAttempts', 3);
        const retryDelay = convertSecondsToMilliseconds(config.get<number>('proofread.retryDelay', 1), 1);

        // Google API将preText和targetText合并为一个contents
        // 为了保持与其他API客户端的一致性（先preText后targetText），这里先preText后targetText
        let contents = targetText;
        if(preText) {
            contents = [preText, contents].join('\n\n');
        }

        // 使用传入的重复模式，如果没有则从配置读取
        const actualRepetitionMode = repetitionMode || getPromptRepetitionMode();
        if (actualRepetitionMode === 'target') {
            // 仅重复target
            contents = [contents, targetText].join('\n\n');
        } else if (actualRepetitionMode === 'all') {
            // 重复完整对话内容（preText + targetText）
            const repeatedContents = preText ? [preText, targetText].join('\n\n') : targetText;
            contents = [contents, repeatedContents].join('\n\n');
        }

        const finalTemperature = temperature || config.get<number>('proofread.temperature');
        const disableThinking = config.get<boolean>('proofread.disableThinking', true);

        const configObj: any = {
            systemInstruction: getSystemPrompt(context, sourceTextCharacteristics),
        };

        if (finalTemperature !== undefined) {
            configObj.temperature = finalTemperature;
        } else {
        }

        // 配置思考功能
        if (!disableThinking) {
            configObj.thinkingConfig = {
                thinkingBudget: 1 // 1表示启用思考，0表示禁用思考
            };
        } else {
            configObj.thinkingConfig = {
                thinkingBudget: 0 // 1表示启用思考，0表示禁用思考
            };
        }

        const googleRequestSnapshot = {
            model: this.model,
            config: {
                systemInstruction: configObj.systemInstruction,
                temperature: configObj.temperature,
                thinkingConfig: configObj.thinkingConfig,
            },
            contents,
        };

        // 重试机制
        for (let attempt = 1; attempt <= retryAttempts; attempt++) {
            try {

                const response = await this.ai.models.generateContent({
                    model: this.model,
                    config: configObj,
                    contents: contents,
                });

                let responseSnapshot: unknown = { text: response.text ?? null };
                try {
                    responseSnapshot = JSON.parse(JSON.stringify(response));
                } catch {
                    /* SDK 对象可能无法完整序列化，保留 text */
                }
                logger.debugLlmRoundtrip('[GoogleApiClient]', googleRequestSnapshot, responseSnapshot);

                return response.text || null;
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                const isNetworkError = errorMessage.includes('fetch failed') ||
                                     errorMessage.includes('network') ||
                                     errorMessage.includes('timeout') ||
                                     errorMessage.includes('ECONNRESET') ||
                                     errorMessage.includes('ENOTFOUND');

                if (attempt === retryAttempts || !isNetworkError) {
                    logger.debugLlmFailure('[GoogleApiClient]', googleRequestSnapshot, error);
                }

                if (attempt === retryAttempts) {
                    // 最后一次尝试失败
                    logger.error(`API调用失败，已重试 ${retryAttempts} 次`, error);
                    return null;
                }

                if (isNetworkError) {
                    // 网络错误，进行重试
                    logger.warn(`网络错误，${(retryDelay / 1000).toFixed(1)}秒后进行第 ${attempt + 1} 次重试: ${errorMessage}`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                } else {
                    // 非网络错误，不重试
                    logger.error('API调用出错（非网络错误，不重试）', error);
                    return null;
                }
            }
        }

        return null;
    }
}

/**
 * Ollama本地模型 API客户端
 */
export class OllamaApiClient implements ApiClient {
    private baseUrl: string;
    private model: string;

    constructor(model: string) {
        const configManager = ConfigManager.getInstance();
        this.model = model;
        this.baseUrl = configManager.getApiKey('ollama') || 'http://localhost:11434';

        if (!this.baseUrl) {
            throw new Error('未配置 Ollama 服务地址，请在设置中配置');
        }
    }

    // 使用 Ollama API 进行校对
    async proofread(
        targetText: string,
        preText: string = '',
        temperature: number|null = null,
        context?: vscode.ExtensionContext,
        repetitionMode?: PromptRepetitionMode,
        sourceTextCharacteristics: string = ''
    ): Promise<string | null> {
        const logger = Logger.getInstance();
        const config = vscode.workspace.getConfiguration('ai-proofread');
        const retryAttempts = config.get<number>('proofread.retryAttempts', 3);
        const retryDelay = convertSecondsToMilliseconds(config.get<number>('proofread.retryDelay', 1), 1);
        const timeout = convertSecondsToMilliseconds(config.get<number>('proofread.timeout', 300), 300); // Ollama本地模型默认5分钟超时

        const messages = [
            { role: 'system', content: getSystemPrompt(context, sourceTextCharacteristics) }
        ];

        // 使用传入的重复模式，如果没有则从配置读取
        const actualRepetitionMode = repetitionMode || getPromptRepetitionMode();

        // 构建第一轮对话
        if (preText) {
            messages.push(
                { role: 'assistant', content: '' },
                { role: 'user', content: preText }
            );
        }

        messages.push(
            { role: 'assistant', content: '' },
            { role: 'user', content: targetText }
        );

        // 根据重复模式添加重复内容
        if (actualRepetitionMode === 'target') {
            // 仅重复target
            messages.push(
                { role: 'assistant', content: '' },
                { role: 'user', content: targetText }
            );
        } else if (actualRepetitionMode === 'all') {
            // 重复完整对话流程（preText + targetText）
            if (preText) {
                messages.push(
                    { role: 'assistant', content: '' },
                    { role: 'user', content: preText }
                );
            }

            messages.push(
                { role: 'assistant', content: '' },
                { role: 'user', content: targetText }
            );
        }

        const finalTemperature = temperature || config.get<number>('proofread.temperature');
        const requestBody: any = {
            model: this.model,
            messages,
            stream: false
        };

        if (finalTemperature !== undefined) {
            requestBody.options = {
                temperature: finalTemperature
            };
        } else {
        }

        // 重试机制
        for (let attempt = 1; attempt <= retryAttempts; attempt++) {
            try {

                const response = await axios.post(
                    `${this.baseUrl}/api/chat`,
                    requestBody,
                    {
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        timeout: timeout
                    }
                );

                logger.debugLlmRoundtrip('[OllamaApiClient]', requestBody, response.data);

                let result = response.data.message.content;
                result = result.replace('\n</target>', '').replace('<target>\n', '');
                return result;
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                const isNetworkError = errorMessage.includes('fetch failed') ||
                                     errorMessage.includes('network') ||
                                     errorMessage.includes('timeout') ||
                                     errorMessage.includes('ECONNRESET') ||
                                     errorMessage.includes('ENOTFOUND') ||
                                     errorMessage.includes('ECONNREFUSED');

                if (attempt === retryAttempts || !isNetworkError) {
                    logger.debugLlmFailure('[OllamaApiClient]', requestBody, error);
                }

                if (attempt === retryAttempts) {
                    // 最后一次尝试失败
                    logger.error(`API调用失败，已重试 ${retryAttempts} 次`, error);
                    return null;
                }

                if (isNetworkError) {
                    // 网络错误，进行重试
                    logger.warn(`网络错误，${(retryDelay / 1000).toFixed(1)}秒后进行第 ${attempt + 1} 次重试: ${errorMessage}`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                } else {
                    // 非网络错误，不重试
                    logAxiosNonNetworkFailure(logger, error);
                    return null;
                }
            }
        }

        return null;
    }
}

/**
 * 异步处理段落
 */
export async function processJsonFileAsync(
    jsonInPath: string,
    jsonOutPath: string,
    options: {
        startCount?: number | number[];
        stopCount?: number;
        platform?: string;
        model?: string;
        rpm?: number;
        maxConcurrent?: number;
        temperature?: number;
        onProgress?: (info: string) => void;
        onProgressUpdate?: (progressTracker: ProgressTracker) => void;
        token?: vscode.CancellationToken;
        context?: vscode.ExtensionContext;
        mdFilePath?: string; // 可选的 markdown 文件路径
        /** 仅内置全文/条目模板提示词时生效，注入源文本特性提示词段落 */
        sourceTextCharacteristics?: string;
    } = {}
): Promise<ProcessStats> {
    const logger = Logger.getInstance();
    // 设置默认值
    const {
        startCount = 1,
        stopCount,
        platform = 'deepseek',
        model = 'deepseek-v4-pro',
        rpm = 15,
        maxConcurrent = 3,
        temperature = 1,
        onProgress,
        onProgressUpdate,
        token,
        context,
        sourceTextCharacteristics = '',
    } = options;

    // 读取输入JSON文件
    const inputParagraphs = JSON.parse(fs.readFileSync(jsonInPath, 'utf8'));
    const totalCount = inputParagraphs.length;
    const isItemMode = getOutputType(context) === 'item';
    const itemPath = jsonOutPath.replace(/\.proofread\.json$/i, '.proofread-item.json');

    // 全文模式：使用 .proofread.json；条目模式：阶段一写 .proofread-item.json，阶段二再写 .proofread.json
    let outputParagraphs: (string | null)[] = [];
    let outputItemParagraphs: (string | null)[] = [];

    if (isItemMode) {
        outputItemParagraphs = fs.existsSync(itemPath)
            ? JSON.parse(fs.readFileSync(itemPath, 'utf8'))
            : new Array(totalCount).fill(null);
        if (outputItemParagraphs.length !== totalCount) {
            throw new Error(`proofread-item.json 长度与输入不一致: ${outputItemParagraphs.length} != ${totalCount}。请删除或修正后重试。`);
        }
        outputParagraphs = new Array(totalCount).fill(null);
    } else {
        if (fs.existsSync(jsonOutPath)) {
            outputParagraphs = JSON.parse(fs.readFileSync(jsonOutPath, 'utf8'));
            if (outputParagraphs.length !== totalCount) {
                throw new Error(`输出JSON的长度与输入JSON的长度不同: ${outputParagraphs.length} != ${totalCount}。请解决冲突，或删除原有的输出JSON文件。`);
            }
        } else {
            outputParagraphs = new Array(totalCount).fill(null);
            fs.writeFileSync(jsonOutPath, JSON.stringify(outputParagraphs, null, 2), 'utf8');
        }
    }

    // 创建进度跟踪器
    const progressTracker = new ProgressTracker(inputParagraphs, onProgressUpdate);

    // 根据现有输出文件初始化已完成的状态
    const completedMask = isItemMode ? outputItemParagraphs : outputParagraphs;
    for (let i = 0; i < completedMask.length; i++) {
        if (completedMask[i] !== null) {
            progressTracker.updateProgress(i, 'completed');
        }
    }

    // 触发初始状态更新
    if (onProgressUpdate) {
        onProgressUpdate(progressTracker);
    }

    // 确定要处理的段落索引（条目模式看 item 文件，全文模式看 proofread 文件）
    const indicesToProcess: number[] = [];
    if (typeof startCount === 'number') {
        const startIndex = startCount - 1;
        const stopIndex = stopCount ? stopCount - 1 : totalCount - 1;
        for (let i = startIndex; i <= stopIndex; i++) {
            if (i < totalCount && completedMask[i] === null) {
                indicesToProcess.push(i);
            }
        }
    } else {
        for (const idx of startCount) {
            const i = idx - 1;
            if (0 <= i && i < totalCount && completedMask[i] === null) {
                indicesToProcess.push(i);
            }
        }
    }

    // 创建API客户端
    const client: ApiClient = (() => {
        switch (platform) {
            case 'google':
                return new GoogleApiClient(model);
            case 'aliyun':
                return new AliyunApiClient(model);
            case 'ollama':
                return new OllamaApiClient(model);
            case 'deepseek':
            default:
                return new DeepseekApiClient(model);
        }
    })();

    // 创建限速器
    const rateLimiter = new RateLimiter(rpm);

    // 创建并发控制
    const semaphore = new Array(maxConcurrent).fill(null);

    // 处理段落
    const processOne = async (index: number): Promise<void> => {
        // 检查是否已取消
        if (token?.isCancellationRequested || progressTracker.isCancellationRequested()) {
            return;
        }

        const paragraph = inputParagraphs[index];
        const targetText = paragraph.target;
        const referenceText = paragraph.reference || '';
        const contextText = paragraph.context || '';

        // 检查target是否为空字符串（包括空白行、空格等）
        if (!targetText || targetText.trim() === '') {
            if (isItemMode) {
                outputItemParagraphs[index] = '{"items":[]}';
                fs.writeFileSync(itemPath, JSON.stringify(outputItemParagraphs, null, 2), 'utf8');
            } else {
                outputParagraphs[index] = targetText;
                fs.writeFileSync(jsonOutPath, JSON.stringify(outputParagraphs, null, 2), 'utf8');
            }
            progressTracker.updateProgress(index, 'completed');
            const skipInfo = `跳过 No. ${index + 1}/${totalCount} (target为空，直接返回原内容)\n${'-'.repeat(40)}\n`;
            logger.info(skipInfo);
            if (onProgress) onProgress(skipInfo);
            return;
        }

        // 更新状态为已提交
        progressTracker.updateProgress(index, 'submitted');

        const haseContext = contextText && contextText.trim() !== targetText.trim();
        const progressInfo = `处理 No. ${index + 1}/${totalCount}, Len ${targetText.length}` +
            `${haseContext ? ` with context ${contextText.length}` : ''}`+
            `${referenceText ? ` with reference ${referenceText.length}` : ''}:`+
            `\n${targetText.slice(0, 30)} ...\n`+
            `${'-'.repeat(40)}\n`;
        logger.info(progressInfo);
        if (onProgress) {
            onProgress(progressInfo);
        }

        // 构建提示文本
        let preText = referenceText ? `<reference>\n${referenceText}\n</reference>` : '';
        if (haseContext) {
            preText += `\n<context>\n${contextText}\n</context>`;
        }
        const labeledTargetText = `<target>\n${targetText}\n</target>`;

        // console.log(model);
        // console.log(preText);
        // console.log(postText);

        const startTime = Date.now();
        await rateLimiter.wait();

        try {
            const processedText = await client.proofread(
                labeledTargetText,
                preText,
                temperature,
                context,
                undefined,
                sourceTextCharacteristics
            );
            const elapsed = (Date.now() - startTime) / 1000;

            if (processedText) {
                if (isItemMode) {
                    const parsedItems = parseItemOutput(processedText);
                    let cell: string;
                    if (parsedItems.length === 0) {
                        const t = processedText.trim();
                        cell = t.length > 0 ? processedText : '{"items":[]}';
                    } else {
                        cell = JSON.stringify({ items: attachAnchorsToProofreadItems(parsedItems, targetText) });
                    }
                    outputItemParagraphs[index] = cell;
                    fs.writeFileSync(itemPath, JSON.stringify(outputItemParagraphs, null, 2), 'utf8');
                } else {
                    outputParagraphs[index] = processedText;
                    fs.writeFileSync(jsonOutPath, JSON.stringify(outputParagraphs, null, 2), 'utf8');
                }
                progressTracker.updateProgress(index, 'completed');
                const completeInfo = `完成 ${index + 1}/${totalCount} 长度 ${targetText.length} 用时 ${elapsed.toFixed(2)}s\n${'-'.repeat(40)}\n`;
                logger.info(completeInfo);
                if (onProgress) onProgress(completeInfo);
            } else {
                progressTracker.updateProgress(index, 'failed', 'API返回空结果');
                const errorInfo = `段落 ${index + 1}/${totalCount}: 处理失败，跳过\n${'-'.repeat(40)}\n`;
                logger.error(errorInfo);
                if (onProgress) onProgress(errorInfo);
            }
        } catch (error) {
            // 更新状态为失败
            const errorMessage = error instanceof Error ? error.message : String(error);
            progressTracker.updateProgress(index, 'failed', errorMessage);

            const errorInfo = `段落 ${index + 1}/${totalCount}: 处理出错 - ${errorMessage}\n${'-'.repeat(40)}\n`;
            logger.error(errorInfo);
            if (onProgress) {
                onProgress(errorInfo);
            }
        }
    };

    // 并发处理所有段落
    const processingPromises: Promise<void>[] = [];

    for (const index of indicesToProcess) {
        // 检查是否已取消
        if (token?.isCancellationRequested || progressTracker.isCancellationRequested()) {
            // 设置取消状态
            progressTracker.setCancelled(true);
            break;
        }

        // 等待一个空闲的槽位
        let slot: number;
        while (true) {
            // 查找空闲槽位
            slot = semaphore.findIndex(s => s === null);
            if (slot !== -1) {
                break; // 找到空闲槽位
            }
            // 如果没有空闲槽位，等待任意一个任务完成
            await Promise.race(semaphore.filter(s => s !== null));
        }

        const promise = processOne(index).finally(() => {
            semaphore[slot] = null;
        });

        semaphore[slot] = promise;
        processingPromises.push(promise);

        // 不等待当前任务完成，继续处理下一个任务（实现真正的并发）
    }

    // 等待所有正在处理的任务完成
    if (token?.isCancellationRequested || progressTracker.isCancellationRequested()) {
        logger.info('用户取消操作，等待已提交的任务完成...');
    }
    await Promise.allSettled(processingPromises);
    if (token?.isCancellationRequested || progressTracker.isCancellationRequested()) {
        logger.info('已提交的任务已完成');
    }

    // 条目模式：阶段二，按段应用替换后写入 .proofread.json
    if (isItemMode) {
        for (let i = 0; i < totalCount; i++) {
            const raw = outputItemParagraphs[i];
            const target = inputParagraphs[i]?.target ?? '';
            if (raw !== null && raw !== undefined) {
                const items = parseItemOutput(raw);
                outputParagraphs[i] = items.length > 0
                    ? applyItemReplacements(target, items)
                    : target;
            } else {
                outputParagraphs[i] = target;
            }
        }
        fs.writeFileSync(jsonOutPath, JSON.stringify(outputParagraphs, null, 2), 'utf8');
    }

    // 生成处理统计
    const processedCount = isItemMode
        ? outputItemParagraphs.filter(p => p !== null).length
        : outputParagraphs.filter(p => p !== null).length;
    const totalLength = inputParagraphs.reduce((sum: number, p: any) => sum + p.target.length, 0);
    const processedLength = outputParagraphs.reduce((sum: number, p: string | null) => sum + (p ? p.length : 0), 0);
    const unprocessedParagraphs = inputParagraphs
        .map((p: any, i: number) => ({
            index: i + 1,
            preview: p.target.trim().split('\n')[0].slice(0, 20)
        }))
        .filter((_: any, i: number) => outputParagraphs[i] === null);

    // 生成Markdown文件
    const mdFilePath = options.mdFilePath || `${jsonOutPath}.md`;
    const processedParagraphs = outputParagraphs.filter(p => p !== null);
    fs.writeFileSync(mdFilePath, processedParagraphs.join('\n\n'), 'utf8');

    return {
        totalCount,
        processedCount,
        totalLength,
        processedLength,
        unprocessedParagraphs,
        progressTracker
    };
}

/**
 * 处理选中的文本校对
 * @param editor 当前编辑器
 * @param selection 选中的文本范围
 * @param platform 使用的平台
 * @param model 使用的模型
 * @param contextLevel 上下文级别
 * @param referenceFile 参考文件
 * @param userTemperature 用户指定的温度
 * @param context 扩展上下文
 * @param beforeParagraphs 前文段落数
 * @param afterParagraphs 后文段落数
 * @param repetitionMode 提示词重复模式（可选，覆盖配置）
 * @param sourceTextCharacteristics 源文本特性提示词注入正文（仅内置全文/条目模板提示词时生效；空字符串表示不注入）
 * @param sourceCharacteristicsDisplayTitle 注入项在日志/完成摘要中的展示标题（如预设名称）
 * @param onItemItems 条目式输出时回调解析出的条目（如条目式提示词场景的后续处理）
 * @param onRawItemOutput 条目式输出时回调 LLM 原始返回（供日志等写入原始结果，不写替换后文本）
 * @param editorialMemoryForceEnabled 为 true 时在请求中拼接编辑记忆注入（仅用「Proofread Selection with Memory」时使用）
 * @returns 校对后的文本
 */
export async function proofreadSelection(
    editor: vscode.TextEditor,
    selection: vscode.Selection,
    platform: string,
    model: string,
    contextLevel?: string,
    referenceFile?: vscode.Uri[],
    userTemperature?: number,
    context?: vscode.ExtensionContext,
    beforeParagraphs?: number,
    afterParagraphs?: number,
    repetitionMode?: PromptRepetitionMode,
    sourceTextCharacteristics: string = '',
    sourceCharacteristicsDisplayTitle?: string,
    onItemItems?: (items: ProofreadItem[]) => void,
    onRawItemOutput?: (raw: string) => void,
    editorialMemoryForceEnabled?: boolean,
    inlineReferenceText?: string
): Promise<string | null> {
    // 获取选中的文本
    const selectedText = editor.document.getText(selection);
    if (!selectedText) {
        throw new Error('请先选择要校对的文本！');
    }

    // 准备校对文本
    let targetText = selectedText;
    let contextText = '';
    let referenceText = '';

    // 检查target是否为空字符串（包括空白行、空格等）
    if (!targetText || targetText.trim() === '') {
        // 如果target为空，直接原样返回内容作为结果
        return targetText;
    }

    // 如果选择了上下文级别，获取上下文
    if (contextLevel && contextLevel !== '不使用上下文') {
        const fullText = editor.document.getText();
        const selectionStartLine = selection.start.line;
        const selectionEndLine = selection.end.line;

        if (contextLevel === '前后增加段落') {
            // 使用抽象的前后段落上下文构建函数
            // 使用字符位置而不是行号，以便精确处理选中文本
            const selectionStart = editor.document.offsetAt(selection.start);
            const selectionEnd = editor.document.offsetAt(selection.end);
            contextText = buildParagraphBasedContext(
                fullText,
                selectionStart,
                selectionEnd,
                beforeParagraphs || 1,
                afterParagraphs || 1
            );
        } else {
            // 使用抽象的标题级别上下文构建函数
            contextText = buildTitleBasedContext(
                fullText,
                selectionStartLine,
                selectionEndLine,
                contextLevel
            );
        }
    }

    // 如果选择了参考文件，读取参考文件内容
    if (referenceFile && referenceFile[0]) {
        referenceText = fs.readFileSync(referenceFile[0].fsPath, 'utf8');
    }
    if (inlineReferenceText?.trim()) {
        referenceText = referenceText
            ? `${referenceText}\n\n${inlineReferenceText.trim()}`
            : inlineReferenceText.trim();
    }

    // 构建提示文本
    let preText = referenceText ? `<reference>\n${referenceText}\n</reference>` : '';
    if (contextText && contextText.trim() !== targetText.trim()) {
        preText += `\n<context>\n${contextText}\n</context>`;
    }
    if (editorialMemoryForceEnabled === true) {
        try {
            const emXml = await buildEditorialMemoryXml(
                editor.document.uri,
                editor.document.getText(),
                selection.start.line,
                true
            );
            if (emXml) {
                preText += emXml;
            }
        } catch {
            /* 记忆注入失败不阻断校对 */
        }
    }
    const postText = `<target>\n${targetText}\n</target>`;

    // 获取提示词重复模式（使用传入的参数，如果没有则从配置读取）
    const actualRepetitionMode = repetitionMode || getPromptRepetitionMode();

    // 调用API进行校对（进度使用 Window，避免与随后 handler 的 InformationMessage 共用通知区导致进度看似不消失）
    const client = (() => {
        switch (platform) {
            case 'google':
                return new GoogleApiClient(model);
            case 'aliyun':
                return new AliyunApiClient(model);
            case 'ollama':
                return new OllamaApiClient(model);
            case 'deepseek':
            default:
                return new DeepseekApiClient(model);
        }
    })();

    let result = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Window,
            title: '正在校对文本...',
            cancellable: false
        },
        async () =>
            client.proofread(
                postText,
                preText,
                userTemperature,
                context,
                actualRepetitionMode,
                sourceTextCharacteristics
            )
    );

    await new Promise<void>((resolve) => setImmediate(resolve));

    if (result && getOutputType(context) === 'item') {
        onRawItemOutput?.(result);
        const items = parseItemOutput(result);
        if (items.length > 0) {
            onItemItems?.(items);
            return applyItemReplacements(selectedText, items);
        }
        return selectedText;
    }
    return result;
}