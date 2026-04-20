import * as vscode from 'vscode';
import { ErrorUtils } from '../utils';
import { prepareReferencesFromLocalDicts } from '../localDict/dictPrepRunner';

export class DictPrepCommandHandler {
    public async handlePrepareLocalDictReferencesCommand(
        editor: vscode.TextEditor,
        context: vscode.ExtensionContext
    ): Promise<void> {
        const doc = editor.document;
        if (doc.languageId !== 'json') {
            vscode.window.showErrorMessage('请选择 JSON 文件执行本地词典参考准备。');
            return;
        }
        const jsonFilePath = doc.uri.fsPath;

        try {
            // 先验证 JSON 格式（避免跑半天才发现不可解析）
            const content = doc.getText();
            const parsed = JSON.parse(content);
            if (!Array.isArray(parsed) || !parsed.every((x) => x && typeof x === 'object' && 'target' in x)) {
                vscode.window.showErrorMessage('JSON 文件格式不正确：需要包含 target 字段的对象数组。');
                return;
            }

            const confirmed = await vscode.window.showInformationMessage(
                `将对该 JSON 逐条生成“本地词典查询 reference”，并写回 reference 字段。\n\n文件：${jsonFilePath}\n条目数：${parsed.length}\n\n是否继续？`,
                { modal: true },
                '继续'
            );
            if (confirmed !== '继续') return;

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: '正在准备本地词典参考资料...',
                    cancellable: false,
                },
                async (progress) => {
                    const stats = await prepareReferencesFromLocalDicts({
                        jsonFilePath,
                        context,
                        onProgress: (m) => progress.report({ message: m.slice(0, 120) }),
                    });
                    vscode.window.showInformationMessage(
                        `本地词典参考准备完成：处理 ${stats.processedItems}/${stats.totalItems} 段，命中 ${stats.totalHits} 条。`
                    );
                }
            );
        } catch (e) {
            ErrorUtils.showError(e, '本地词典参考准备失败：');
        }
    }
}

