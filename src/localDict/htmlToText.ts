/**
 * 去掉 MDX/词典释义中常见的 NUL 等 C0 控制字符（保留 \\t \\n）。
 * js-mdict 等返回的 definition 末尾常带 \\u0000。
 */
export function sanitizeDictControlChars(text: string): string {
    return String(text ?? '')
        .replace(/\u0000/g, '')
        .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

export function stripHtmlToText(html: string): string {
    const s = String(html ?? '');
    if (!s) return s;

    // Remove script/style blocks entirely
    let out = s.replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '');

    // Preserve "newline semantics" for common tags first
    out = out.replace(/<\s*br\s*\/?\s*>/gi, '\n');
    out = out.replace(/<\s*\/\s*p\s*>/gi, '\n');
    out = out.replace(/<\s*\/\s*div\s*>/gi, '\n');

    // Replace remaining tags with a space to avoid concatenating adjacent nodes
    out = out.replace(/<[^>]+>/g, ' ');

    // Decode a small set of common HTML entities
    out = out
        .replace(/&nbsp;/gi, ' ')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/g, "'");

    // Normalize newlines and collapse whitespace
    out = out.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    out = out.replace(/[ \t\f\v]+/g, ' ');
    out = out
        .split('\n')
        .map((line) => line.trim())
        .join('\n');
    out = out.replace(/\n{3,}/g, '\n\n');

    return sanitizeDictControlChars(out).trim();
}

