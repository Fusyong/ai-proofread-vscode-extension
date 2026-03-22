import * as vscode from 'vscode';

const ANCIENTBOOKS_SEARCH_PREFIX = 'https://jingdian.ancientbooks.cn/6/search?txt=';
const ANCIENTBOOKS_SEARCH_SUFFIX = '&useSynonyms=';
/** 查询字符串字符数上限，避免 URL 过长导致浏览器无法打开 */
const MAX_QUERY_CHARS = 2000;

function normalizeQuery(raw: string): string {
    return raw.replace(/\s+/g, ' ').trim();
}

/**
 * 在中华经典古籍库（jingdian.ancientbooks.cn）全文检索当前选中文本（系统默认浏览器打开搜索页）
 */
export async function searchSelectionInAncientbooks(editor: vscode.TextEditor): Promise<void> {
    const selection = editor.document.getText(editor.selection);
    if (!selection) {
        vscode.window.showInformationMessage('请先选择要搜索的文本');
        return;
    }
    let query = normalizeQuery(selection);
    if (!query) {
        vscode.window.showInformationMessage('请先选择要搜索的文本');
        return;
    }
    let truncated = false;
    if (query.length > MAX_QUERY_CHARS) {
        query = query.slice(0, MAX_QUERY_CHARS);
        truncated = true;
    }
    const url = ANCIENTBOOKS_SEARCH_PREFIX + encodeURIComponent(query) + ANCIENTBOOKS_SEARCH_SUFFIX;
    if (truncated) {
        vscode.window.showWarningMessage(`搜索文本过长，已截断为前 ${MAX_QUERY_CHARS} 个字符`);
    }
    await vscode.env.openExternal(vscode.Uri.parse(url));
}
