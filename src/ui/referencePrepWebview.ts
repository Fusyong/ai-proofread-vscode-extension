/**
 * 参考资料复合查询控制台：配置来源、执行选段/JSON 准备、展示 LLM 规划过程与命中结果。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ReferencePrepCommandHandler } from '../commands/referencePrepCommandHandler';
import type { ReferencePrepResultsProvider } from '../referencePrep/referencePrepResultsView';
import { loadReferencePrepLastRun, saveReferencePrepLastRun } from '../referencePrep/runPreferences';
import { getDefaultEnabledSources } from '../referencePrep/referencePrepRunner';
import { REFERENCE_SOURCE_OPTIONS } from '../referencePrep/referencePrepSession';
import { loadProcessFile } from '../referencePrep/processFile';
import type { PrepEvent } from '../referencePrep/prepEvents';
import type {
    CorpusHit,
    ReferencePrepProcessFileV020,
    ReferencePrepStrength,
    ReferenceSourceId,
} from '../referencePrep/schema';
import { canOpenHitInBrowser, canOpenHitInEditor } from '../referencePrep/referencePrepResultsTree';
import { isWebSearchConfigured } from '../referencePrep/retrieval/webAdapter';
import {
    cleanBlockForLlm,
    formatSelectedHitsAsJsonDocument,
    formatSelectedHitsAsMarkdown,
    formatSelectedHitsAsReferenceField,
    sortHitsForLlm,
} from '../referencePrep/exportSelectedHits';
import { getWorkingTextEditor, focusWorkingTextEditor } from './lastActiveTextEditor';
import { FilePathUtils } from '../utils';
import type { ProofreadCommandHandler } from '../commands/proofreadCommandHandler';
import { setReferenceHitVisible } from './sidebarViewVisibility';

const PANEL_ID = 'ai-proofread.referencePrepConsole';
const PANEL_TITLE = 'References searching panel';
/** 递增以在扩展更新后强制刷新已打开面板的 HTML（避免旧界面缺导出提示条）。 */
const WEBVIEW_HTML_REVISION = 6;

export class ReferencePrepWebview {
    private panel: vscode.WebviewPanel | undefined;
    private cancelSource: vscode.CancellationTokenSource | undefined;
    private lastAnchorPath: string | undefined;
    private lastProcess: ReferencePrepProcessFileV020 | undefined;
    private panelListeners: vscode.Disposable[] = [];
    private appliedHtmlRevision = 0;

    constructor(
        private context: vscode.ExtensionContext,
        private prepHandler: ReferencePrepCommandHandler,
        private resultsProvider?: ReferencePrepResultsProvider,
        private proofreadHandler?: ProofreadCommandHandler
    ) {}

    open(): void {
        if (this.panel) {
            if (this.appliedHtmlRevision !== WEBVIEW_HTML_REVISION) {
                this.panel.webview.html = this.getHtml();
                this.appliedHtmlRevision = WEBVIEW_HTML_REVISION;
            }
            this.panel.reveal(vscode.ViewColumn.Beside);
            this.postState();
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            PANEL_ID,
            PANEL_TITLE,
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            }
        );
        this.panel.webview.html = this.getHtml();
        this.appliedHtmlRevision = WEBVIEW_HTML_REVISION;
        this.panel.webview.onDidReceiveMessage(
            (msg) => this.handleMessage(msg),
            undefined,
            this.context.subscriptions
        );
        this.panel.onDidDispose(
            () => {
                this.panel = undefined;
                this.appliedHtmlRevision = 0;
                this.cancelSource?.cancel();
                this.cancelSource = undefined;
                for (const d of this.panelListeners) d.dispose();
                this.panelListeners = [];
            },
            undefined,
            this.context.subscriptions
        );
        this.panelListeners.push(
            vscode.window.onDidChangeTextEditorSelection(() => {
                if (this.panel?.visible) this.postState();
            }),
            vscode.window.onDidChangeActiveTextEditor(() => {
                if (this.panel?.visible) this.postState();
            })
        );
        this.postState();
    }

    /** 先亮起搜索面板提示，再弹出可点击的通知；避免先打开文件抢走焦点导致看不到提示。 */
    private async notifyExportDone(tip: string, openUri?: vscode.Uri): Promise<void> {
        this.post({ type: 'exportDone', message: tip });
        this.panel?.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Beside, false);
        const choice = await vscode.window.showInformationMessage(tip, '打开文件', '知道了');
        if (choice === '打开文件' && openUri) {
            const doc = await vscode.workspace.openTextDocument(openUri);
            await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
        }
    }

    private post(message: Record<string, unknown>): void {
        void this.panel?.webview.postMessage(message);
    }

    private postState(): void {
        const last = loadReferencePrepLastRun(this.context);
        const defaults = getDefaultEnabledSources();
        const enabledSources =
            last.enabledSources.length > 0 ? last.enabledSources : defaults;
        const editor = getWorkingTextEditor();
        const selection = editor?.document.getText(editor.selection)?.trim() ?? '';
        const isJson = editor?.document.languageId === 'json';
        this.post({
            type: 'state',
            sources: REFERENCE_SOURCE_OPTIONS.map((o) => ({
                ...o,
                stub: o.stub || (o.id === 'web' && !isWebSearchConfigured()),
            })),
            enabledSources,
            strength: last.strength,
            hasSelection: Boolean(selection),
            selectionPreview: selection.slice(0, 200),
            isJson,
            jsonPath: isJson ? editor?.document.uri.fsPath : undefined,
            webConfigured: isWebSearchConfigured(),
            documentLabel: editor
                ? `${editor.document.languageId} · ${editor.document.uri.fsPath.split(/[/\\]/).pop()}`
                : undefined,
        });
        if (this.lastProcess && this.lastAnchorPath) {
            this.postProcess(this.lastProcess, this.lastAnchorPath);
        }
    }

    private postEvent(event: PrepEvent): void {
        this.post({ type: 'event', event });
        if (event.type === 'process') {
            this.lastProcess = event.process;
            this.lastAnchorPath = event.anchorPath;
            this.postProcess(event.process, event.anchorPath);
        }
    }

    private postProcess(process: ReferencePrepProcessFileV020, anchorPath: string): void {
        const hits = sortHitsForLlm(process.corpus).map((h) => this.serializeHit(h));
        this.post({
            type: 'process',
            anchorPath,
            rounds: process.rounds.map((r) => ({
                roundId: r.roundId,
                startedAt: r.startedAt,
                finishedAt: r.finishedAt,
                queryCount: r.queryCount,
                plan: r.plan,
                wikiRequestsUsed: r.wikiRequestsUsed,
            })),
            hits,
            mergedReference: process.mergedReference ?? '',
            enabledSources: process.enabledSources,
            strength: process.strength,
        });
    }

    private serializeHit(h: CorpusHit): Record<string, unknown> {
        const exportText = cleanBlockForLlm(h.referenceBlock || h.snippet || '');
        return {
            hitId: h.hitId,
            source: h.source,
            status: h.status,
            kind: h.kind,
            snippet: h.snippet?.slice(0, 240) ?? '',
            refTag: h.refTag,
            file: h.relPath ?? h.file,
            line: h.startLine ?? h.line,
            endLine: h.endLine,
            headingPath: h.headingPath,
            pageUrl: h.pageUrl,
            pageTitle: h.pageTitle,
            dictId: h.dictId,
            matchedKey: h.matchedKey,
            finalScore: h.finalScore ?? h.aggregatedValue,
            canOpenEditor: canOpenHitInEditor(h),
            canOpenBrowser: canOpenHitInBrowser(h),
            /** 导出正文的字符数（与导出洗净规则一致） */
            charCount: exportText.length,
            /** 默认勾选：active 且非导航提示 */
            defaultChecked: h.status === 'active' && h.kind !== 'navigation_hint',
        };
    }

    private resolveSelectedHits(hitIds?: string[]): CorpusHit[] {
        if (!this.lastProcess || !hitIds?.length) return [];
        const want = new Set(hitIds);
        return this.lastProcess.corpus.filter((h) => want.has(h.hitId));
    }

    private resolveJsonPathForMerge(): string | undefined {
        const editor = getWorkingTextEditor();
        if (editor?.document.languageId === 'json' && editor.document.uri.fsPath) {
            return editor.document.uri.fsPath;
        }
        if (this.lastAnchorPath?.toLowerCase().endsWith('.json')) {
            return this.lastAnchorPath;
        }
        return undefined;
    }

    /**
     * 准备勾选命中的 Markdown 导出内容。
     * 有锚点文档时写入 `.selected-refs.md`；否则仅返回正文供预览（校对流程需要落盘文件）。
     */
    private prepareSelectedMdExport(
        hitIds?: string[]
    ):
        | { kind: 'file'; uri: vscode.Uri; tip: string; md: string }
        | { kind: 'preview'; tip: string; md: string }
        | undefined {
        const hits = this.resolveSelectedHits(hitIds);
        if (!hits.length) {
            vscode.window.showWarningMessage('请先勾选要导出的命中。');
            return undefined;
        }
        const md = formatSelectedHitsAsMarkdown(hits);
        const charCount = md.length;
        const anchor = this.lastAnchorPath ?? getWorkingTextEditor()?.document.uri.fsPath;
        if (anchor) {
            const outPath = FilePathUtils.getFilePath(anchor, '.selected-refs', '.md');
            fs.writeFileSync(outPath, md, 'utf8');
            return {
                kind: 'file',
                uri: vscode.Uri.file(outPath),
                tip: `导出完成：${hits.length} 条、${charCount} 字符 → ${path.basename(outPath)}`,
                md,
            };
        }
        return {
            kind: 'preview',
            tip: `导出完成：${hits.length} 条、${charCount} 字符（未落盘）`,
            md,
        };
    }

    private async exportSelectedAsMd(hitIds?: string[]): Promise<void> {
        const prepared = this.prepareSelectedMdExport(hitIds);
        if (!prepared) return;
        if (prepared.kind === 'file') {
            await this.notifyExportDone(prepared.tip, prepared.uri);
            return;
        }
        this.post({ type: 'exportDone', message: prepared.tip });
        this.panel?.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Beside, false);
        const choice = await vscode.window.showInformationMessage(prepared.tip, '打开预览', '知道了');
        if (choice === '打开预览') {
            const doc = await vscode.workspace.openTextDocument({ content: prepared.md, language: 'markdown' });
            await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
        }
    }

    /**
     * 导出勾选命中为 md，并以该文件为参考文件调用 Proofread selection（其余交互不变）。
     */
    private async proofreadSelectionWithExportedMd(hitIds?: string[]): Promise<void> {
        if (!this.proofreadHandler) {
            vscode.window.showErrorMessage('校对模块未就绪，无法启动选段校对。');
            return;
        }
        const prepared = this.prepareSelectedMdExport(hitIds);
        if (!prepared) return;
        if (prepared.kind !== 'file') {
            vscode.window.showWarningMessage('请先打开文稿，以便将参考资料保存为 md 并用于校对。');
            return;
        }

        this.post({ type: 'exportDone', message: prepared.tip + '；开始校对选段…' });
        this.panel?.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Beside, true);

        const editor = await focusWorkingTextEditor();
        if (!editor) {
            vscode.window.showWarningMessage('请先打开并选中要校对的文稿选段。');
            return;
        }
        if (editor.selection.isEmpty) {
            vscode.window.showWarningMessage('请先在文稿中选中要校对的文本。');
            return;
        }

        await this.proofreadHandler.handleProofreadSelectionCommand(editor, this.context, {
            presetReferenceFile: prepared.uri,
        });
    }

    private async exportSelectedAsJson(hitIds?: string[]): Promise<void> {
        const hits = this.resolveSelectedHits(hitIds);
        if (!hits.length) {
            vscode.window.showWarningMessage('请先勾选要导出的命中。');
            return;
        }
        const payload = formatSelectedHitsAsJsonDocument(hits);
        const text = JSON.stringify(payload, null, 2);
        const jsonPath = this.resolveJsonPathForMerge();
        const anchor = jsonPath ?? this.lastAnchorPath ?? getWorkingTextEditor()?.document.uri.fsPath;
        if (anchor) {
            const outPath = FilePathUtils.getFilePath(anchor, '.selected-refs', '.json');
            fs.writeFileSync(outPath, text, 'utf8');
            await this.notifyExportDone(
                `已导出 ${hits.length} 条为 JSON：${path.basename(outPath)}`,
                vscode.Uri.file(outPath)
            );
        } else {
            const tip = `已导出 ${hits.length} 条为 JSON（未保存）`;
            this.post({ type: 'exportDone', message: tip });
            this.panel?.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Beside, false);
            const choice = await vscode.window.showInformationMessage(tip, '打开预览', '知道了');
            if (choice === '打开预览') {
                const doc = await vscode.workspace.openTextDocument({ content: text, language: 'json' });
                await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
            }
        }
    }

    private async mergeSelectedIntoSourceJson(hitIds?: string[]): Promise<void> {
        const hits = this.resolveSelectedHits(hitIds);
        if (!hits.length) {
            vscode.window.showWarningMessage('请先勾选要合并的命中。');
            return;
        }
        const jsonPath = this.resolveJsonPathForMerge();
        if (!jsonPath || !fs.existsSync(jsonPath)) {
            vscode.window.showErrorMessage('请先打开切分 JSON 文件（目标选「当前 JSON 文件」）。');
            return;
        }

        let items: unknown;
        try {
            items = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        } catch (e) {
            vscode.window.showErrorMessage(`无法解析 JSON：${e instanceof Error ? e.message : String(e)}`);
            return;
        }
        if (!Array.isArray(items) || !items.every((x) => x && typeof x === 'object')) {
            vscode.window.showErrorMessage('JSON 格式不正确：需要对象数组（含 target 字段）。');
            return;
        }

        const merged = formatSelectedHitsAsReferenceField(hits);
        if (!merged.trim()) {
            vscode.window.showWarningMessage('选中命中没有可写入的 reference 正文。');
            return;
        }

        const mode = await vscode.window.showQuickPick(
            [
                {
                    label: '覆盖写入全部条目的 reference',
                    description: '每条 item.reference 替换为选中资料',
                    value: 'overwrite_all' as const,
                },
                {
                    label: '仅写入尚无 reference 的条目',
                    description: '已有 reference 的条目跳过',
                    value: 'fill_empty' as const,
                },
                {
                    label: '追加到全部条目的 reference',
                    description: '在已有内容后追加',
                    value: 'append_all' as const,
                },
            ],
            { title: '合并选中资料到源 JSON', ignoreFocusOut: true }
        );
        if (!mode) return;

        let touched = 0;
        for (const raw of items as Array<Record<string, unknown>>) {
            if (!('target' in raw)) continue;
            const prev = typeof raw.reference === 'string' ? raw.reference : '';
            if (mode.value === 'fill_empty' && prev.trim()) continue;
            if (mode.value === 'append_all' && prev.trim()) {
                raw.reference = `${prev}\n\n${merged}`;
            } else {
                raw.reference = merged;
            }
            touched++;
        }

        fs.writeFileSync(jsonPath, JSON.stringify(items, null, 2), 'utf8');
        const doc = await vscode.workspace.openTextDocument(jsonPath);
        await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
        vscode.window.showInformationMessage(
            `已将 ${hits.length} 条选中资料合并到源 JSON（更新 ${touched} 个条目）。`
        );
    }

    private async handleMessage(msg: {
        command?: string;
        commandId?: string;
        enabledSources?: ReferenceSourceId[];
        strength?: ReferencePrepStrength;
        targetMode?: 'selection' | 'json';
        hitId?: string;
        hitIds?: string[];
        anchorPath?: string;
    }): Promise<void> {
        switch (msg.command) {
            case 'ready':
                this.postState();
                break;
            case 'refreshState':
                this.postState();
                break;
            case 'cancel':
                this.cancelSource?.cancel();
                break;
            case 'replay':
                await this.replayFromAnchor(msg.anchorPath);
                break;
            case 'openHit':
                await vscode.commands.executeCommand(
                    'ai-proofread.referencePrep.openHit',
                    this.findHit(msg.hitId)
                );
                break;
            case 'copyBlock':
                if (msg.hitId) {
                    const hit = this.findHit(msg.hitId);
                    if (hit?.referenceBlock) {
                        await vscode.env.clipboard.writeText(hit.referenceBlock);
                        vscode.window.showInformationMessage('已复制 reference 块');
                    }
                }
                break;
            case 'exportSelectedMd':
                await this.exportSelectedAsMd(msg.hitIds);
                break;
            case 'proofreadSelectionWithExportedMd':
                await this.proofreadSelectionWithExportedMd(msg.hitIds);
                break;
            case 'exportSelectedJson':
                await this.exportSelectedAsJson(msg.hitIds);
                break;
            case 'mergeSelectedIntoJson':
                await this.mergeSelectedIntoSourceJson(msg.hitIds);
                break;
            case 'run':
                await this.runPrep(msg);
                break;
            case 'runCommand':
                await this.runQuickSearchCommand(msg.commandId);
                break;
            default:
                break;
        }
    }

    /** 常用检索命令：先聚焦文稿编辑器，再执行（与校对面板快捷栏一致） */
    private async runQuickSearchCommand(commandId?: string): Promise<void> {
        if (!commandId || typeof commandId !== 'string') return;
        const allowed = new Set([
            'ai-proofread.prepareReferencesSelection',
            'ai-proofread.llmGrepSearchReferences',
            'ai-proofread.search.dictPrep',
            'ai-proofread.search.refsGrep',
            'ai-proofread.search.refsBm25',
            'ai-proofread.search.refsVector',
            'ai-proofread.search.wikipedia',
            'ai-proofread.search.web',
            'ai-proofread.queryLocalDictSelection',
            'ai-proofread.searchSelectionInPDF',
            'ai-proofread.searchSelectionInShidianguji',
            'ai-proofread.searchSelectionInAncientbooks',
            'ai-proofread.searchSelectionInReferences',
            'ai-proofread.citation.verifySelection',
            'ai-proofread.citation.openView',
            'ai-proofread.citation.rebuildIndex',
            'ai-proofread.referencePrep.clearRetrievalCache',
        ]);
        if (!allowed.has(commandId)) {
            vscode.window.showWarningMessage(`未允许的命令：${commandId}`);
            return;
        }
        await focusWorkingTextEditor();
        await vscode.commands.executeCommand(commandId);
    }

    private findHit(hitId?: string): CorpusHit | undefined {
        if (!hitId || !this.lastProcess) return undefined;
        return this.lastProcess.corpus.find((h) => h.hitId === hitId);
    }

    private async replayFromAnchor(anchorPath?: string): Promise<void> {
        const editor = getWorkingTextEditor();
        const path = anchorPath || editor?.document.uri.fsPath;
        if (!path) {
            vscode.window.showWarningMessage('请先打开带有 .referenceprep.json 的文档，或传入锚点路径。');
            return;
        }
        const proc = loadProcessFile(path);
        if (!proc) {
            vscode.window.showWarningMessage('未找到过程文件（.referenceprep.json）。');
            return;
        }
        this.lastProcess = proc;
        this.lastAnchorPath = path;
        this.resultsProvider?.refresh(proc, path);
        await setReferenceHitVisible(true);
        this.post({ type: 'clearTimeline' });
        this.postProcess(proc, path);
        for (let i = 0; i < proc.rounds.length; i++) {
            const r = proc.rounds[i];
            this.postEvent({ type: 'plan', round: i, plan: r.plan });
            for (const q of r.plan.queries) {
                this.postEvent({ type: 'query', round: i, queryId: q.queryId, detail: q });
            }
        }
        this.postEvent({ type: 'phase', name: 'done', message: '已从过程文件重放' });
    }

    private async runPrep(msg: {
        enabledSources?: ReferenceSourceId[];
        strength?: ReferencePrepStrength;
        targetMode?: 'selection' | 'json';
    }): Promise<void> {
        const enabledSources = (msg.enabledSources ?? []).filter((s) => s !== 'web' || isWebSearchConfigured());
        if (!enabledSources.length) {
            vscode.window.showErrorMessage('请至少选择一个可用的资料来源。');
            return;
        }
        const strength = msg.strength ?? 'standard';
        await saveReferencePrepLastRun(this.context, { enabledSources, strength });
        await this.prepHandler.maybeShowWikipediaNotice(this.context, enabledSources);

        const editor = getWorkingTextEditor();
        if (!editor) {
            vscode.window.showErrorMessage('请先打开并选中目标文档（焦点可在检索面板上）。');
            return;
        }

        this.cancelSource?.cancel();
        this.cancelSource = new vscode.CancellationTokenSource();
        const token = this.cancelSource.token;
        this.post({ type: 'clearTimeline' });
        this.post({ type: 'running', running: true });

        const onEvent = (event: PrepEvent) => this.postEvent(event);

        try {
            if (msg.targetMode === 'json') {
                if (editor.document.languageId !== 'json') {
                    vscode.window.showErrorMessage('当前文件不是 JSON，请切换到切分 JSON 或改用选段模式。');
                    return;
                }
                await this.prepHandler.handlePrepareReferencesJson(
                    editor.document.uri.fsPath,
                    this.context,
                    {
                        skipPicks: true,
                        enabledSources,
                        strength,
                        runProofread: false,
                        onEvent,
                    }
                );
            } else {
                const selectedText = editor.document.getText(editor.selection);
                if (!selectedText.trim()) {
                    vscode.window.showErrorMessage('请先选择要准备参考资料的文本。');
                    return;
                }
                await this.prepHandler.runPrepForSelection({
                    target: selectedText,
                    anchorPath: editor.document.uri.fsPath,
                    context: this.context,
                    enabledSources,
                    strength,
                    freshProcess: true,
                    onEvent,
                    token,
                    openMergedPreview: false,
                    showInformationMessage: true,
                });
            }
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            this.postEvent({ type: 'error', message });
        } finally {
            this.post({ type: 'running', running: false });
            this.cancelSource = undefined;
        }
    }

    private getHtml(): string {
        const nonce = String(Date.now());
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  padding: 12px 16px 24px;
  line-height: 1.45;
  box-sizing: border-box;
}
h2 { font-size: 1.1em; margin: 16px 0 8px; font-weight: 600; }
h2:first-child { margin-top: 0; }
.row { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; margin-bottom: 8px; }
label.source {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 0; cursor: pointer;
}
label.source.stub { opacity: 0.5; cursor: not-allowed; }
button {
  font: inherit; cursor: pointer;
  padding: 6px 12px;
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: 2px;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
button.secondary {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
}
button:disabled { opacity: 0.5; cursor: not-allowed; }
select, textarea {
  font: inherit; color: inherit;
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, var(--vscode-widget-border));
  padding: 4px 8px; border-radius: 2px;
}
.preview {
  width: 100%; min-height: 48px; max-height: 100px;
  resize: vertical; opacity: 0.9;
}
#timeline {
  border: 1px solid var(--vscode-widget-border);
  border-radius: 4px;
  max-height: 280px; overflow: auto;
  padding: 8px; background: var(--vscode-editor-background);
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 12px; white-space: pre-wrap; word-break: break-word;
}
.tl-item { margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px solid var(--vscode-widget-border); }
.tl-item .tag { color: var(--vscode-descriptionForeground); margin-right: 6px; }
#hits { list-style: none; padding: 0; margin: 0; }
#hits li {
  border: 1px solid var(--vscode-widget-border);
  border-radius: 4px; padding: 8px; margin-bottom: 8px;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 8px 10px;
  align-items: start;
}
#hits li.pruned { opacity: 0.55; }
#hits li .hit-check { margin-top: 2px; }
.hit-body { min-width: 0; }
.hit-meta { font-size: 0.9em; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
.hit-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.hit-actions button { padding: 2px 8px; font-size: 0.9em; }
.export-bar {
  display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  margin: 8px 0 12px; padding: 8px 0;
  border-bottom: 1px solid var(--vscode-widget-border);
}
.export-bar .mode-only { display: none; }
.export-bar.mode-selection .for-selection { display: inline-block; }
.export-bar.mode-json .for-json { display: inline-block; }
.status { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-left: 8px; }
.export-done {
  margin: 8px 0;
  padding: 8px 10px;
  border-radius: 4px;
  background: var(--vscode-inputValidation-infoBackground, rgba(0,120,212,0.15));
  border: 1px solid var(--vscode-inputValidation-infoBorder, var(--vscode-focusBorder));
  color: var(--vscode-foreground);
}
.warn { color: var(--vscode-errorForeground); }
.panel-footer-commands {
  margin-top: 20px;
  padding-top: 12px;
  border-top: 1px solid var(--vscode-widget-border);
}
.header-commands-hint {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  margin: 0 0 6px;
}
.header-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 0;
  line-height: 1.5;
}
.link-button {
  background: none;
  border: none;
  color: var(--vscode-textLink-foreground);
  cursor: pointer;
  font-size: 12px;
  line-height: 1.4;
  padding: 1px 2px;
  text-decoration: underline;
  white-space: normal;
  text-align: left;
  max-width: 100%;
}
.link-button:hover { color: var(--vscode-textLink-activeForeground); }
.cmd-sep {
  color: var(--vscode-descriptionForeground);
  margin: 0 4px;
  user-select: none;
  font-size: 12px;
}
.cmd-sep--between-groups { margin: 0 8px; opacity: 0.7; }
</style>
</head>
<body>
<h2>配置</h2>
<div class="row" id="sources"></div>
<div class="row">
  <label>强度
    <select id="strength">
      <option value="light">轻量</option>
      <option value="standard" selected>标准</option>
      <option value="thorough">深入</option>
    </select>
  </label>
  <label>目标
    <select id="targetMode">
      <option value="selection">当前选段</option>
      <option value="json">当前 JSON 文件</option>
    </select>
  </label>
</div>
<div class="row">
  <textarea class="preview" id="selectionPreview" readonly placeholder="选区预览…"></textarea>
</div>
<div class="row">
  <span class="status" id="targetDoc"></span>
</div>
<div class="row">
  <button id="btnRun">开始准备</button>
  <button class="secondary" id="btnCancel" disabled>取消</button>
  <button class="secondary" id="btnReplay">重放过程文件</button>
  <button class="secondary" id="btnRefresh">刷新状态</button>
  <span class="status" id="runStatus"></span>
</div>

<h2>过程</h2>
<div id="timeline"><div class="tl-item"><span class="tag">就绪</span>选择来源后点击「开始准备」</div></div>

<h2>结果</h2>
<div class="export-bar mode-selection" id="exportBar">
  <button type="button" class="secondary" id="btnSelectAll">全选</button>
  <button type="button" class="secondary" id="btnSelectNone">全不选</button>
  <button type="button" class="mode-only for-selection" id="btnExportMd">导出选中为 md</button>
  <button type="button" class="mode-only for-selection" id="btnProofreadWithMd" title="导出选中为 md，并以该文件为参考调用 Proofread selection">参考选中校对当前选段</button>
  <button type="button" class="mode-only for-json" id="btnExportJson">导出选中为 JSON</button>
  <button type="button" class="mode-only for-json" id="btnMergeJson">合并选中到源 JSON</button>
  <span class="status" id="selectedCount"></span>
</div>
<div class="export-done" id="exportDone" style="display:none" role="status"></div>
<ul id="hits"></ul>

<div class="panel-footer-commands">
  <p class="header-commands-hint">常用检索命令（作用于当前编辑器选区/文档；Ctrl+Shift+P 可查全部）</p>
  <div class="header-actions">
    <button type="button" class="link-button" data-cmd="ai-proofread.prepareReferencesSelection" title="Prepare References for Selection">准备选段参考资料</button>
    <span class="cmd-sep" aria-hidden="true">|</span>
    <button type="button" class="link-button" data-cmd="ai-proofread.llmGrepSearchReferences" title="LLM-Enhanced Grep Search">LLM 增强检索</button>
    <span class="cmd-sep cmd-sep--between-groups" aria-hidden="true">||</span>
    <button type="button" class="link-button" data-cmd="ai-proofread.search.dictPrep" title="Search with Local Dictionary">词典</button>
    <span class="cmd-sep" aria-hidden="true">|</span>
    <button type="button" class="link-button" data-cmd="ai-proofread.search.refsGrep" title="Search References with Grep">Grep</button>
    <span class="cmd-sep" aria-hidden="true">|</span>
    <button type="button" class="link-button" data-cmd="ai-proofread.search.refsBm25" title="Search References with BM25">BM25</button>
    <span class="cmd-sep" aria-hidden="true">|</span>
    <button type="button" class="link-button" data-cmd="ai-proofread.search.refsVector" title="Search References with Vector">向量</button>
    <span class="cmd-sep" aria-hidden="true">|</span>
    <button type="button" class="link-button" data-cmd="ai-proofread.search.wikipedia" title="Search Wikipedia">维基</button>
    <span class="cmd-sep" aria-hidden="true">|</span>
    <button type="button" class="link-button" data-cmd="ai-proofread.search.web" title="Search the Web">Web</button>
    <span class="cmd-sep cmd-sep--between-groups" aria-hidden="true">||</span>
    <button type="button" class="link-button" data-cmd="ai-proofread.queryLocalDictSelection" title="Look Up Selection in Local Dictionary">按选文查词典</button>
    <span class="cmd-sep" aria-hidden="true">|</span>
    <button type="button" class="link-button" data-cmd="ai-proofread.searchSelectionInPDF" title="search selection in PDF">PDF 搜索</button>
    <span class="cmd-sep" aria-hidden="true">|</span>
    <button type="button" class="link-button" data-cmd="ai-proofread.searchSelectionInShidianguji" title="search selection in Shidianguji">识典古籍</button>
    <span class="cmd-sep" aria-hidden="true">|</span>
    <button type="button" class="link-button" data-cmd="ai-proofread.searchSelectionInAncientbooks" title="search selection in Ancientbooks">中华经典古籍库</button>
    <span class="cmd-sep" aria-hidden="true">|</span>
    <button type="button" class="link-button" data-cmd="ai-proofread.searchSelectionInReferences" title="search selection in References">References 搜索</button>
    <span class="cmd-sep cmd-sep--between-groups" aria-hidden="true">||</span>
    <button type="button" class="link-button" data-cmd="ai-proofread.citation.verifySelection" title="Verify Selected Citation">核对选中引文</button>
    <span class="cmd-sep" aria-hidden="true">|</span>
    <button type="button" class="link-button" data-cmd="ai-proofread.citation.openView" title="Verify Citations">核对全文引文</button>
    <span class="cmd-sep" aria-hidden="true">|</span>
    <button type="button" class="link-button" data-cmd="ai-proofread.citation.rebuildIndex" title="Build Citation Reference Index">建立引文索引</button>
    <span class="cmd-sep cmd-sep--between-groups" aria-hidden="true">||</span>
    <button type="button" class="link-button" data-cmd="ai-proofread.referencePrep.clearRetrievalCache" title="Clear Project Retrieval Cache">清除检索缓存</button>
  </div>
</div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const sourcesEl = document.getElementById('sources');
const strengthEl = document.getElementById('strength');
const targetModeEl = document.getElementById('targetMode');
const previewEl = document.getElementById('selectionPreview');
const targetDocEl = document.getElementById('targetDoc');
const timelineEl = document.getElementById('timeline');
const hitsEl = document.getElementById('hits');
const exportBar = document.getElementById('exportBar');
const exportDoneEl = document.getElementById('exportDone');
const selectedCountEl = document.getElementById('selectedCount');
const runStatus = document.getElementById('runStatus');
const btnRun = document.getElementById('btnRun');
const btnCancel = document.getElementById('btnCancel');

/** @type {Map<string, boolean>} */
const checkedByHitId = new Map();

function showExportDone(message) {
  const text = message || '导出完成';
  if (exportDoneEl) {
    exportDoneEl.style.display = 'block';
    exportDoneEl.textContent = text;
    exportDoneEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  appendTimeline('export', text);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function appendTimeline(tag, text) {
  const div = document.createElement('div');
  div.className = 'tl-item';
  div.innerHTML = '<span class="tag">' + esc(tag) + '</span>' + esc(text);
  timelineEl.appendChild(div);
  timelineEl.scrollTop = timelineEl.scrollHeight;
}

function clearTimeline() {
  timelineEl.innerHTML = '';
}

function setRunning(running) {
  btnRun.disabled = running;
  btnCancel.disabled = !running;
  runStatus.textContent = running ? '运行中…' : '';
}

function updateExportBarMode() {
  const mode = targetModeEl.value === 'json' ? 'json' : 'selection';
  exportBar.className = 'export-bar mode-' + mode;
}

function updateSelectedCount() {
  const boxes = hitsEl.querySelectorAll('input.hit-check');
  let n = 0;
  let selectedChars = 0;
  let totalChars = 0;
  boxes.forEach(cb => {
    const chars = Number(cb.dataset.chars || 0) || 0;
    totalChars += chars;
    if (cb.checked) {
      n++;
      selectedChars += chars;
    }
  });
  selectedCountEl.textContent = boxes.length
    ? ('已选 ' + n + ' / ' + boxes.length + ' · 选中 ' + selectedChars + ' / ' + totalChars + ' 字符')
    : '';
}

function getSelectedHitIds() {
  return Array.from(hitsEl.querySelectorAll('input.hit-check:checked')).map(el => el.value);
}

function renderSources(sources, enabled) {
  sourcesEl.innerHTML = '';
  for (const s of sources) {
    const label = document.createElement('label');
    label.className = 'source' + (s.stub ? ' stub' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = s.id;
    cb.disabled = !!s.stub;
    cb.checked = !s.stub && enabled.includes(s.id);
    label.appendChild(cb);
    label.appendChild(document.createTextNode(s.label + (s.stub ? '（未实现）' : '')));
    label.title = s.description || '';
    sourcesEl.appendChild(label);
  }
}

function getEnabledSources() {
  return Array.from(sourcesEl.querySelectorAll('input[type=checkbox]:checked')).map(el => el.value);
}

function renderHits(hits) {
  hitsEl.innerHTML = '';
  if (!hits || !hits.length) {
    hitsEl.innerHTML = '<li class="hit-meta" style="display:block">暂无命中</li>';
    updateSelectedCount();
    return;
  }
  const seen = new Set(hits.map(h => h.hitId));
  for (const id of [...checkedByHitId.keys()]) {
    if (!seen.has(id)) checkedByHitId.delete(id);
  }
  for (const h of hits) {
    if (!checkedByHitId.has(h.hitId)) {
      checkedByHitId.set(h.hitId, h.defaultChecked !== false);
    }
    const li = document.createElement('li');
    if (h.status === 'pruned') li.className = 'pruned';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'hit-check';
    cb.value = h.hitId;
    cb.dataset.chars = String(h.charCount || 0);
    cb.checked = checkedByHitId.get(h.hitId) !== false;
    cb.addEventListener('change', () => {
      checkedByHitId.set(h.hitId, cb.checked);
      updateSelectedCount();
    });
    li.appendChild(cb);

    const body = document.createElement('div');
    body.className = 'hit-body';
    body.innerHTML =
      '<div class="hit-meta">' + esc(h.source) +
      (h.refTag ? ' · ' + esc(h.refTag) : '') +
      (h.matchedKey ? ' · ' + esc(h.matchedKey) : '') +
      (h.file ? ' · ' + esc(h.file) + (h.line != null ? ':' + h.line : '') : '') +
      (h.pageTitle ? ' · ' + esc(h.pageTitle) : '') +
      (h.finalScore != null ? ' · score ' + Number(h.finalScore).toFixed(2) : '') +
      (h.status === 'pruned' ? ' · pruned' : '') + '</div>' +
      '<div>' + esc(h.snippet) + '</div>';
    const actions = document.createElement('div');
    actions.className = 'hit-actions';
    if (h.canOpenEditor || h.canOpenBrowser) {
      const b = document.createElement('button');
      b.className = 'secondary';
      b.textContent = '打开';
      b.onclick = () => vscode.postMessage({ command: 'openHit', hitId: h.hitId });
      actions.appendChild(b);
    }
    const copy = document.createElement('button');
    copy.className = 'secondary';
    copy.textContent = '复制';
    copy.onclick = () => vscode.postMessage({ command: 'copyBlock', hitId: h.hitId });
    actions.appendChild(copy);
    body.appendChild(actions);
    li.appendChild(body);
    hitsEl.appendChild(li);
  }
  updateSelectedCount();
}

function postExport(command) {
  vscode.postMessage({ command: command, hitIds: getSelectedHitIds() });
}

btnRun.onclick = () => {
  vscode.postMessage({
    command: 'run',
    enabledSources: getEnabledSources(),
    strength: strengthEl.value,
    targetMode: targetModeEl.value
  });
};
btnCancel.onclick = () => vscode.postMessage({ command: 'cancel' });
document.getElementById('btnReplay').onclick = () => vscode.postMessage({ command: 'replay' });
document.getElementById('btnRefresh').onclick = () => vscode.postMessage({ command: 'refreshState' });
targetModeEl.addEventListener('change', updateExportBarMode);
document.getElementById('btnSelectAll').onclick = () => {
  hitsEl.querySelectorAll('input.hit-check').forEach(cb => {
    cb.checked = true;
    checkedByHitId.set(cb.value, true);
  });
  updateSelectedCount();
};
document.getElementById('btnSelectNone').onclick = () => {
  hitsEl.querySelectorAll('input.hit-check').forEach(cb => {
    cb.checked = false;
    checkedByHitId.set(cb.value, false);
  });
  updateSelectedCount();
};
document.getElementById('btnExportMd').onclick = () => postExport('exportSelectedMd');
document.getElementById('btnProofreadWithMd').onclick = () => postExport('proofreadSelectionWithExportedMd');
document.getElementById('btnExportJson').onclick = () => postExport('exportSelectedJson');
document.getElementById('btnMergeJson').onclick = () => postExport('mergeSelectedIntoJson');
document.querySelectorAll('.panel-footer-commands [data-cmd]').forEach((el) => {
  el.addEventListener('click', () => {
    vscode.postMessage({ command: 'runCommand', commandId: el.getAttribute('data-cmd') });
  });
});
updateExportBarMode();

window.addEventListener('message', (ev) => {
  const msg = ev.data;
  if (msg.type === 'state') {
    renderSources(msg.sources || [], msg.enabledSources || []);
    if (msg.strength) strengthEl.value = msg.strength;
    previewEl.value = msg.selectionPreview || (msg.hasSelection ? '' : '（无选区 — 请先在文稿中选中文本，再点「刷新状态」或「开始准备」）');
    targetDocEl.textContent = msg.documentLabel
      ? ('目标：' + msg.documentLabel)
      : '目标：尚未关联编辑器（请先打开文稿）';
    if (msg.isJson) targetModeEl.value = 'json';
    updateExportBarMode();
  } else if (msg.type === 'clearTimeline') {
    clearTimeline();
  } else if (msg.type === 'running') {
    setRunning(!!msg.running);
  } else if (msg.type === 'event') {
    const e = msg.event;
    if (e.type === 'phase') appendTimeline(e.name, e.message || '');
    else if (e.type === 'plan') appendTimeline('plan R' + (e.round + 1), JSON.stringify(e.plan, null, 2));
    else if (e.type === 'query') appendTimeline('query', e.queryId + ' ' + JSON.stringify(e.detail));
    else if (e.type === 'hits') appendTimeline('hits', '本轮 +' + e.added + '（累计约 ' + e.total + '）');
    else if (e.type === 'error') appendTimeline('error', e.message);
    else if (e.type === 'cancelled') appendTimeline('cancelled', '已取消');
  } else if (msg.type === 'process') {
    // 新结果到来时按 defaultChecked 重置勾选
    checkedByHitId.clear();
    if (exportDoneEl) {
      exportDoneEl.style.display = 'none';
      exportDoneEl.textContent = '';
    }
    renderHits(msg.hits || []);
  } else if (msg.type === 'exportDone') {
    showExportDone(msg.message);
  }
});

vscode.postMessage({ command: 'ready' });
</script>
</body>
</html>`;
    }
}

export function registerReferencePrepConsole(
    context: vscode.ExtensionContext,
    prepHandler: ReferencePrepCommandHandler,
    resultsProvider?: ReferencePrepResultsProvider,
    proofreadHandler?: ProofreadCommandHandler
): ReferencePrepWebview {
    const webview = new ReferencePrepWebview(context, prepHandler, resultsProvider, proofreadHandler);
    context.subscriptions.push(
        vscode.commands.registerCommand('ai-proofread.referencePrep.openConsole', () => {
            webview.open();
        })
    );
    return webview;
}
