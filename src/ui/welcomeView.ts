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
            padding: 8px 6px;
            line-height: 1.35;
            box-sizing: border-box;
        }
        .btn-primary {
            display: block;
            width: 100%;
            margin-bottom: 4px;
            padding: 4px 8px;
            min-height: 26px;
            text-align: left;
            cursor: pointer;
            border: 1px solid var(--vscode-button-border, transparent);
            border-radius: 3px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            font: inherit;
            line-height: 1.3;
        }
        .btn-primary:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .btn-row {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 4px;
            margin-bottom: 4px;
        }
        .btn-row .btn-primary {
            margin-bottom: 0;
            text-align: left;
        }
        .action-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 4px;
            margin-bottom: 4px;
        }
        .cell {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 4px;
            min-height: 26px;
            padding: 3px 8px;
            box-sizing: border-box;
            border: 1px solid var(--vscode-widget-border);
            border-radius: 3px;
            background: var(--vscode-sideBar-background);
            min-width: 0;
        }
        .cell-action {
            width: 100%;
            margin: 0;
            cursor: pointer;
            font: inherit;
            color: inherit;
            text-align: left;
            line-height: 1.3;
        }
        .cell-action:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .cell-action:focus-visible {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: -1px;
        }
        .cell-label {
            flex: 1;
            min-width: 0;
            user-select: none;
        }
        .hint {
            margin-top: 10px;
            padding-top: 8px;
            border-top: 1px solid var(--vscode-widget-border);
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }
        .hint ol {
            margin: 4px 0 0 0;
            padding-left: 18px;
        }
        .hint li {
            margin-bottom: 2px;
        }
    </style>
</head>
<body>
    <div class="btn-row">
        <button type="button" class="btn-primary" data-action="openPanel" title="打开校对面板">校对面板</button>
        <button type="button" class="btn-primary" data-action="openSearchConsole" title="打开参考资料检索控制台">检索面板</button>
    </div>
    <div class="action-grid">
        <button type="button" class="cell cell-action" data-action="toggleSidebar" data-key="modelRoutes" title="显示或隐藏模型路由 TreeView">
            <span class="cell-label">模型路由</span>
        </button>
        <button type="button" class="cell cell-action" data-action="toggleSidebar" data-key="prompts" title="显示或隐藏提示词相关 TreeView">
            <span class="cell-label">提示词</span>
        </button>
    </div>
    <div class="action-grid">
        <button type="button" class="cell cell-action" data-action="toggleSidebar" data-key="wordCheck" title="显示或隐藏字词检查相关 TreeView">
            <span class="cell-label">字词检查</span>
        </button>
        <button type="button" class="cell cell-action" data-action="toggleSidebar" data-key="referenceHit" title="显示或隐藏资料检索命中 TreeView">
            <span class="cell-label">资料检索</span>
        </button>
    </div>
    <div class="action-grid">
        <button type="button" class="cell cell-action" data-action="toggleSidebar" data-key="citations" title="显示或隐藏引文核查 TreeView">
            <span class="cell-label">引文核查</span>
        </button>
        <button type="button" class="cell cell-action" data-action="toggleSidebar" data-key="duplicates" title="显示或隐藏重文检查 TreeView">
            <span class="cell-label">重文检查</span>
        </button>
    </div>
    <div class="action-grid">
        <button type="button" class="cell cell-action" data-action="toggleSidebar" data-key="numbering" title="显示或隐藏标题树 TreeView">
            <span class="cell-label">标题树</span>
        </button>
        <button type="button" class="cell cell-action" data-action="toggleSidebar" data-key="numberingSegments" title="显示或隐藏段内序号 TreeView">
            <span class="cell-label">段内序号</span>
        </button>
    </div>
    <div class="action-grid">
        <button type="button" class="cell cell-action" data-action="toggleSidebar" data-key="proofreadItems" title="显示或隐藏校对条目 TreeView">
            <span class="cell-label">校对条目</span>
        </button>
        <button type="button" class="cell cell-action" data-action="openSettings" title="打开扩展设置">
            <span class="cell-label">设置</span>
        </button>
    </div>
    <div class="action-grid">
        <button type="button" class="cell cell-action" data-action="showExtension" title="查看说明文档">
            <span class="cell-label">说明文档</span>
        </button>
        <button type="button" class="cell cell-action" data-action="openCheatsheet" title="命令速查与业务流程图">
            <span class="cell-label">命令速查…</span>
        </button>
    </div>
    <div class="hint">
        可通过三种方式使用本扩展：
        <ol>
            <li>打开校对面板 / 搜索面板，使用按钮</li>
            <li>打开命令面板 (Ctrl+Shift+P)，输入 AI Proofreader … 筛查检索命令</li>
            <li>在编辑窗口使用鼠标右键菜单</li>
        </ol>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        document.querySelectorAll('[data-action]').forEach(el => {
            el.addEventListener('click', () => {
                vscode.postMessage({ action: el.dataset.action, key: el.dataset.key });
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
                localResourceRoots: [],
                retainContextWhenHidden: true,
            };
            webviewView.webview.html = getHtml();

            webviewView.webview.onDidReceiveMessage(async (message: { action: string; key?: string }) => {
                switch (message.action) {
                    case 'openPanel':
                        await vscode.commands.executeCommand('ai-proofread.openProofreadingPanel');
                        break;
                    case 'openSearchConsole':
                        await vscode.commands.executeCommand('ai-proofread.referencePrep.openConsole');
                        break;
                    case 'toggleSidebar': {
                        const key = message.key;
                        const cmdByKey: Record<string, string> = {
                            modelRoutes: 'ai-proofread.modelRoutes.toggleView',
                            prompts: 'ai-proofread.prompts.toggleViews',
                            wordCheck: 'ai-proofread.wordCheck.toggleViews',
                            referenceHit: 'ai-proofread.referencePrep.toggleResultsView',
                            citations: 'ai-proofread.citation.toggleView',
                            duplicates: 'ai-proofread.duplicate.toggleView',
                            numbering: 'ai-proofread.numbering.toggleView',
                            numberingSegments: 'ai-proofread.numberingSegments.toggleView',
                            proofreadItems: 'ai-proofread.proofreadItems.toggleView',
                        };
                        const cmd = key ? cmdByKey[key] : undefined;
                        if (cmd) {
                            await vscode.commands.executeCommand(cmd);
                        }
                        break;
                    }
                    case 'showExtension':
                        await showExtensionInEditor(context);
                        break;
                    case 'openCheatsheet':
                        await vscode.env.openExternal(vscode.Uri.parse(CHEATSHEET_URL));
                        break;
                    case 'openSettings':
                        await vscode.commands.executeCommand('workbench.action.openSettings', 'ai-proofread');
                        break;
                }
            });
        },
    };
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(VIEW_ID, provider));
}
