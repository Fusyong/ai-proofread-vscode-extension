/**
 * 引号转换工具模块
 */

/**
 * 将拉丁半角引号转换为中文全角引号
 * @param text 要转换的文本
 * @returns 转换后的文本
 */
export function convertQuotes(text: string): string {
    // 定义引号映射
    const quoteMap = {
        '"': '“”', // 双引号
        "'": "‘’"  // 单引号
    };

    // 按段落分割文本
    const paragraphs = text.split(/\n/);
    let result = '';

    for (const paragraph of paragraphs) {
        // 处理每个段落
        let convertedParagraph = paragraph;
        let quoteStack: string[] = []; // 用于跟踪引号的嵌套关系

        // 遍历段落中的每个字符
        for (let i = 0; i < convertedParagraph.length; i++) {
            const char = convertedParagraph[i];

            // 检查是否是引号
            if (char in quoteMap) {
                // 检查是否是转义引号
                if (i > 0 && convertedParagraph[i - 1] === '\\') {
                    continue;
                }

                // 获取对应的中文引号
                const chineseQuotes = quoteMap[char as keyof typeof quoteMap];

                // 确定是上引号还是下引号
                const isOpeningQuote = quoteStack.length === 0 ||
                    quoteStack[quoteStack.length - 1] !== char;

                // 替换引号
                const replacement = isOpeningQuote ? chineseQuotes[0] : chineseQuotes[1];
                convertedParagraph = convertedParagraph.substring(0, i) +
                    replacement +
                    convertedParagraph.substring(i + 1);

                // 更新引号栈
                if (isOpeningQuote) {
                    quoteStack.push(char);
                } else {
                    quoteStack.pop();
                }
            }
        }

        // 添加处理后的段落到结果
        result += convertedParagraph + '\n';
    }

    // 移除末尾多余的换行符
    return result.trim();
}