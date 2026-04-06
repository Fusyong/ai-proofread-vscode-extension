/**
 * 系统默认提示词专用的「源文本特性提示词」内置条目（写死在代码中，用户不可删改）。
 */

/** 注入特性正文前固定附加的说明句（与新建/编辑界面展示一致） */
export const SOURCE_TEXT_CHARACTERISTICS_INTRO =
    '目标文本（target）是一个更大的源文本的一部分。对这个源文本的整体说明如下：';

export interface BuiltinSourceTextCharacteristic {
    readonly id: string;
    readonly name: string;
    readonly content: string;
}

export const BUILTIN_SOURCE_TEXT_CHARACTERISTICS: readonly BuiltinSourceTextCharacteristic[] = [
    {
        id: 'primary-school-chinese-workbook',
        name: '小学语文练习册',
        content: "这是一本小学语文练习册。校对时要注意：（1）注意练习册具有的提问、挖空等特有形式，以及提问、挖空与多种语境元素如拼音、前后文、题干、材料、参考答案等的照印与一致。（2）注意练习指导语言、练习材料语言和引文的不同，指导语要准确、简介、自然，避免误解，练习材料语要与练习意图匹配，引文要与原文相同。（3）若正文含拼音，拼音须与汉字对应正确。（4）避免暴力、歧视、孤立他人、粗俗、尖刻等类表述。（5）核查并修正历史事实和历史观念上的错误。（6）文本来源于PDF，格式上可能有不准确的地方。"
    },
    {
        id: 'children-reading',
        name: '少儿读物',
        content: "这是一本少儿读物。校对时要注意：（1）语言应符合目标年龄段阅读习惯：句子宜短，用词宜具体，避免过度书面化、艰涩、成语堆砌。（2）若正文含拼音，拼音须与汉字对应正确。（3）避免暴力、歧视、孤立他人、粗俗、尖刻等类表述。（4）核查并修正历史事实和历史观念上的错误。（5）文本来源于PDF，格式上可能有不准确的地方。"
    },

];

/** 用户可在设置中维护的自定义特性提示（结构与主提示词列表区分存放） */
export interface UserSourceTextCharacteristicPrompt {
    name: string;
    content: string;
}

export function formatSourceCharacteristicsBlock(raw: string): string {
    const t = raw.trim();
    if (!t) {
        return '';
    }
    return `\n<source-text-hints>\n\n${SOURCE_TEXT_CHARACTERISTICS_INTRO}\n\n${t}\n</source-text-hints>\n`;
}

/** 输入「特性说明正文」时与 showInputBox 共用的说明（含固定句 + 操作提示） */
export function getSourceCharacteristicContentInputPrompt(): string {
    return (
        `${SOURCE_TEXT_CHARACTERISTICS_INTRO}\n\n` +
        '请在下方填写接续的整体说明正文；上一句在校对注入时会自动置于文首，此处不必重复输入。'
    );
}

export function summarizeSourceCharacteristicsForLog(raw: string, maxLen = 72): string {
    const t = raw.trim();
    if (!t) {
        return '无';
    }
    const oneLine = t.replace(/\s+/g, ' ');
    return oneLine.length <= maxLen ? oneLine : `${oneLine.slice(0, maxLen)}…`;
}
