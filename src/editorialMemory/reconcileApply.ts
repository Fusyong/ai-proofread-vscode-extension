import * as vscode from 'vscode';

/** v2：已取消「按文档 path 对齐」；保留命令以提示迁移说明。 */
export async function runReconcileForActiveDocument(
    _memPath: string,
    _docUri: vscode.Uri,
    _platform: string,
    _model: string
): Promise<void> {
    await vscode.window.showInformationMessage(
        '编辑记忆 v2 已取消与章节 path 绑定的 reconcile。活跃记忆见 .proofread/editorial-memory.json，扁平存档见 editorial-memory-archive.json。'
    );
}
