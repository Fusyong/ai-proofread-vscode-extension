/**
 * Activity Bar 欢迎视图：概览入口与使用提示
 */

import * as vscode from 'vscode';

const VIEW_ID = 'ai-proofread.welcome';

const CHEATSHEET_URL = 'https://github.com/Fusyong/ai-proofread-vscode-extension/blob/main/docs/commands-cheatsheet.md';
const EXTENSION_ID = 'HuangFusyong.ai-proofreader';
/** 扩展详情页（编辑器内打开失败时用浏览器打开） */
const EXTENSION_MARKETPLACE_URL = `https://marketplace.visualstudio.com/items?itemName=${EXTENSION_ID}`;

function getHtml(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            padding: 12px 8px;
            line-height: 1.5;
            box-sizing: border-box;
        }
        .btn {
            display: block;
            width: 100%;
            margin-bottom: 8px;
            padding: 8px 12px;
            text-align: left;
            cursor: pointer;
            border: 1px solid var(--vscode-button-border, transparent);
            border-radius: 4px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            font-size: inherit;
        }
        .btn:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .hint {
            margin-top: 16px;
            padding-top: 12px;
            border-top: 1px solid var(--vscode-widget-border);
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }
        .hint ol {
            margin: 8px 0 0 0;
            padding-left: 20px;
        }
        .hint li {
            margin-bottom: 4px;
        }
    </style>
</head>
<body>
    <button class="btn" data-action="openPanel">打开校对面板</button>
    <button class="btn" data-action="showExtension">查看说明文档</button>
    <button class="btn" data-action="openCheatsheet">命令速查与业务流程图</button>
    <button class="btn" data-action="managePrompts">管理提示词</button>
    <div class="hint">
        可通过三种方式使用本扩展：
        <ol>
            <li>打开校对面板 (open Proofreading panel)，使用按钮</li>
            <li>打开命令面板 (Ctrl+Shift+P)，输入 AI Proofreader … 筛查命令并使用</li>
            <li>在编辑窗口使用鼠标右键菜单，使用 AI Proofreader 开头的选项</li>
        </ol>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        document.querySelectorAll('.btn').forEach(btn => {
            btn.addEventListener('click', () => {
                vscode.postMessage({ action: btn.dataset.action });
            });
        });
    </script>
</body>
</html>`;
}

/** 在编辑器内打开扩展视图并定位到本扩展，并主动打开 README 预览页；失败则用浏览器打开 Marketplace */
async function showExtensionInEditor(extensionContext: vscode.ExtensionContext): Promise<void> {
    try {
        await vscode.commands.executeCommand('workbench.view.extensions');
        await vscode.commands.executeCommand('workbench.extensions.search', `@id:${EXTENSION_ID}`);
        // 主动打开本扩展 README 的 Markdown 预览，等效于在扩展详情里看到说明页
        const readmeUri = vscode.Uri.joinPath(extensionContext.extensionUri, 'README.md');
        await vscode.commands.executeCommand('markdown.showPreview', readmeUri);
    } catch {
        await vscode.env.openExternal(vscode.Uri.parse(EXTENSION_MARKETPLACE_URL));
    }
}

export function registerWelcomeView(context: vscode.ExtensionContext): void {
    const provider: vscode.WebviewViewProvider = {
        resolveWebviewView(
            webviewView: vscode.WebviewView,
            _context: vscode.WebviewViewResolveContext,
            _token: vscode.CancellationToken
        ) {
            webviewView.webview.options = {
                enableScripts: true,
                localResourceRoots: []
            };
            webviewView.webview.html = getHtml();
            webviewView.webview.onDidReceiveMessage((message: { action: string }) => {
                switch (message.action) {
                    case 'openPanel':
                        vscode.commands.executeCommand('ai-proofread.openProofreadingPanel');
                        break;
                    case 'showExtension':
                        showExtensionInEditor(context);
                        break;
                    case 'openCheatsheet':
                        vscode.env.openExternal(vscode.Uri.parse(CHEATSHEET_URL));
                        break;
                    case 'managePrompts':
                        vscode.commands.executeCommand('ai-proofread.managePrompts');
                        break;
                }
            });
        }
    };
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(VIEW_ID, provider)
    );
}
