/**
 * 去掉行首空白与 Markdown 引用标记 `>`，便于直接选中块引用后核对。
 */
export function stripLeadingBlockquoteMarkers(text: string): string {
    return text
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split('\n')
        .map((line) => line.replace(/^[\s>]+/, ''))
        .join('\n')
        .replace(/^\s+/, '');
}
