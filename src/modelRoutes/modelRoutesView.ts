import * as vscode from 'vscode';
import {
    MODEL_ROUTE_METAS,
    MODEL_ROUTES_VIEW_ID,
    type ModelRouteId,
} from './modelRouteRegistry';
import { isRouteInherited, resolveModelRoute } from './modelRouteResolver';

export interface ModelRouteTreeItem {
    routeId: ModelRouteId;
    label: string;
    description: string;
    canInherit: boolean;
}

export class ModelRoutesTreeDataProvider implements vscode.TreeDataProvider<ModelRouteTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getChildren(): ModelRouteTreeItem[] {
        return MODEL_ROUTE_METAS.map((m) => ({
            routeId: m.id,
            label: m.label,
            description: m.description,
            canInherit: m.canInherit,
        }));
    }

    getTreeItem(element: ModelRouteTreeItem): vscode.TreeItem {
        const resolved = resolveModelRoute(element.routeId);
        const inherited = element.canInherit && isRouteInherited(element.routeId);
        const platformLabel = resolved.platform;
        const modelLabel = resolved.model;
        const summary = inherited
            ? '跟随校对 · ' + platformLabel + ' / ' + modelLabel
            : platformLabel + ' / ' + modelLabel;

        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.description = summary;
        item.tooltip = element.description + '\n' + summary + '\n\n点击配置平台与模型';
        item.contextValue = element.canInherit ? 'modelRouteInheritable' : 'modelRouteProofread';
        item.command = {
            command: 'ai-proofread.modelRoutes.configure',
            title: '配置模型路由',
            arguments: [element],
        };
        item.iconPath = inherited
            ? new vscode.ThemeIcon('link')
            : new vscode.ThemeIcon('server-environment');
        return item;
    }
}

export function registerModelRoutesView(
    context: vscode.ExtensionContext
): { provider: ModelRoutesTreeDataProvider; treeView: vscode.TreeView<ModelRouteTreeItem> } {
    const provider = new ModelRoutesTreeDataProvider();
    const treeView = vscode.window.createTreeView(MODEL_ROUTES_VIEW_ID, {
        treeDataProvider: provider,
        showCollapseAll: false,
    });
    context.subscriptions.push(treeView);

    const refresh = () => provider.refresh();
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (
                e.affectsConfiguration('ai-proofread.proofread.platform') ||
                e.affectsConfiguration('ai-proofread.proofread.models') ||
                e.affectsConfiguration('ai-proofread.modelRoutes') ||
                e.affectsConfiguration('ai-proofread.referencePrep.platform') ||
                e.affectsConfiguration('ai-proofread.referencePrep.models') ||
                e.affectsConfiguration('ai-proofread.editorialMemory.mergeModelOverride')
            ) {
                refresh();
            }
        })
    );

    return { provider, treeView };
}
