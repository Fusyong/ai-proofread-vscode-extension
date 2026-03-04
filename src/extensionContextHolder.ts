/**
 * 扩展激活时的 context 持有器。当调用方未传入 context 时，校对等逻辑可由此获取
 * 当前扩展 context，用于读取「当前提示词」等 globalState。调用方传入的 context 优先使用。
 */

import * as vscode from 'vscode';

let extensionContext: vscode.ExtensionContext | undefined;

export function setExtensionContext(ctx: vscode.ExtensionContext): void {
    extensionContext = ctx;
}

export function getExtensionContext(): vscode.ExtensionContext | undefined {
    return extensionContext;
}
