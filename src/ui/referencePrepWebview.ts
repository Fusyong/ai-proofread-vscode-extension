/**
 * 参考资料复合查询控制台：配置来源、执行选段/JSON 准备、展示 LLM 规划过程与命中结果。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ReferencePrepCommandHandler } from '../commands/referencePrepCommandHandler';
import type { ReferencePrepResultsProvider } from '../referencePrep/referencePrepResultsView';
import { loadReferencePrepLastRun, saveReferencePrepLastRun } from '../referencePrep/runPreferences';
import {
    clampControls,
    defaultControlsForStrength,
    WIKIPEDIA_LANGS,
    type ReferencePrepRunControls,
} from '../referencePrep/runControls';
import { getDefaultEnabledSources } from '../referencePrep/referencePrepRunner';
import { REFERENCE_SOURCE_OPTIONS } from '../referencePrep/referencePrepSession';
import type { ReferencePrepPlan } from '../referencePrep/schema';
import {
    inferPrepOrigin,
    listProcessRecords,
    loadProcessRecord,
    processRecordKey,
    setActiveProcessRecord,
} from '../referencePrep/processFile';
import { pickReferencePrepContinuation } from '../referencePrep/continuation';
import type { PrepEvent } from '../referencePrep/prepEvents';
import type {
    CorpusHit,
    ReferencePrepOrigin,
    ReferencePrepProcessFileV020,
    ReferencePrepStrength,
    ReferenceSourceId,
} from '../referencePrep/schema';
import { canOpenHitInBrowser, canOpenHitInEditor } from '../referencePrep/referencePrepResultsTree';
import { isWebSearchConfigured } from '../referencePrep/retrieval/webAdapter';
import {
    cleanBlockForLlm,
    formatGroupedHitsAsJsonDocument,
    formatGroupedHitsAsMarkdown,
    formatSelectedHitsAsReferenceField,
    sortHitsForLlm,
    type HitExportGroup,
} from '../referencePrep/exportSelectedHits';
import { getWorkingTextEditor, focusWorkingTextEditor } from './lastActiveTextEditor';
import { FilePathUtils } from '../utils';
import { setReferenceHitVisible } from './sidebarViewVisibility';

const PANEL_ID = 'ai-proofread.referencePrepConsole';
const PANEL_TITLE = 'References search panel';
/** 递增以在扩展更新后强制刷新已打开面板的 HTML（避免旧界面缺导出提示条）。 */
const WEBVIEW_HTML_REVISION = 15;

export class ReferencePrepWebview {
    private panel: vscode.WebviewPanel | undefined;
    private cancelSource: vscode.CancellationTokenSource | undefined;
    private lastAnchorPath: string | undefined;
    private lastProcess: ReferencePrepProcessFileV020 | undefined;
    /** 重放多条选区时保留全部分组，供查找/导出跨记录解析 hitId */
    private lastReplayRecords: ReferencePrepProcessFileV020[] | undefined;
    /** 当前面板结果来自 MD 选段还是 JSON 条目（与下拉「目标」解耦） */
    private lastPrepOrigin: 'selection' | 'json' | undefined;
    private panelListeners: vscode.Disposable[] = [];
    private appliedHtmlRevision = 0;
    private corpusSyncDisposable: vscode.Disposable | undefined;
    private planReviewResolver:
        | ((result: { action: 'confirm' | 'skip' | 'cancel'; plan?: ReferencePrepPlan }) => void)
        | undefined;

    constructor(
        private context: vscode.ExtensionContext,
        private prepHandler: ReferencePrepCommandHandler,
        private resultsProvider?: ReferencePrepResultsProvider
    ) {
        this.corpusSyncDisposable = this.resultsProvider?.onDidChangeCorpus((e) => {
            if (!this.panel) return;
            if (this.lastAnchorPath && path.normalize(this.lastAnchorPath) !== path.normalize(e.anchorPath)) {
                return;
            }
            this.syncHitsFromRecords(e.anchorPath, e.records);
        });
        if (this.corpusSyncDisposable) {
            this.context.subscriptions.push(this.corpusSyncDisposable);
        }
    }

    /** 侧栏 prune/restore 后同步面板命中列表 */
    private syncHitsFromRecords(anchorPath: string, records: ReferencePrepProcessFileV020[]): void {
        this.lastAnchorPath = anchorPath;
        const origin = this.lastPrepOrigin === 'json' ? 'json_item' : this.lastPrepOrigin === 'selection' ? 'selection' : undefined;
        const filtered = origin
            ? records.filter((r) => inferPrepOrigin(r, anchorPath) === origin)
            : records;
        if (filtered.length > 1) {
            this.lastReplayRecords = filtered;
            this.lastProcess = filtered[filtered.length - 1];
            this.postProcessGrouped(filtered, anchorPath);
        } else if (filtered.length === 1) {
            this.lastReplayRecords = undefined;
            this.lastProcess = filtered[0];
            this.setResultOriginFromProcess(filtered[0], anchorPath);
            this.postProcess(filtered[0], anchorPath);
        } else {
            this.lastReplayRecords = undefined;
            this.lastProcess = undefined;
            this.lastPrepOrigin = undefined;
            this.post({ type: 'clearHits' });
            this.postResultOrigin();
        }
    }

    private setResultOriginFromProcess(
        proc: ReferencePrepProcessFileV020,
        anchorPath: string
    ): void {
        const o = inferPrepOrigin(proc, anchorPath);
        this.lastPrepOrigin = o === 'json_item' ? 'json' : 'selection';
        this.postResultOrigin();
    }

    private setResultOrigin(origin: 'selection' | 'json' | undefined): void {
        this.lastPrepOrigin = origin;
        this.postResultOrigin();
    }

    private postResultOrigin(): void {
        this.post({ type: 'resultOrigin', origin: this.lastPrepOrigin ?? null });
    }

    private recordsOriginForAnchor(anchorPath: string): ReferencePrepOrigin {
        return anchorPath.toLowerCase().endsWith('.json') ? 'json_item' : 'selection';
    }

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
                if (this.panel?.visible) {
                    this.postState();
                    this.syncTreeToWorkingEditor();
                }
            })
        );
        this.postState();
    }

    /** 编辑器切换时：侧栏只展示当前文档对应来源的过程记录 */
    private syncTreeToWorkingEditor(): void {
        if (!this.resultsProvider || this.cancelSource) return;
        const editor = getWorkingTextEditor();
        if (!editor) {
            this.resultsProvider.refresh(null);
            return;
        }
        const anchorPath = editor.document.uri.fsPath;
        const origin = this.recordsOriginForAnchor(anchorPath);
        const records = listProcessRecords(anchorPath, { origin }).filter(
            (r) => r.corpus.length > 0 || r.rounds.length > 0
        );
        if (records.length > 1) {
            this.resultsProvider.refreshRecords(records, anchorPath);
        } else if (records.length === 1) {
            this.resultsProvider.refresh(records[0], anchorPath);
        } else {
            this.resultsProvider.refresh(null, anchorPath);
        }
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
        const strengthPresets: Record<string, ReferencePrepRunControls> = {
            light: defaultControlsForStrength('light'),
            standard: defaultControlsForStrength('standard'),
            thorough: defaultControlsForStrength('thorough'),
        };
        this.post({
            type: 'state',
            sources: REFERENCE_SOURCE_OPTIONS.map((o) => ({
                ...o,
                stub: o.stub || (o.id === 'web' && !isWebSearchConfigured()),
            })),
            enabledSources,
            strength: last.strength,
            controls: last.controls,
            strengthPresets,
            wikiLangs: WIKIPEDIA_LANGS,
            hasSelection: Boolean(selection),
            selectionPreview: selection.slice(0, 200),
            isJson,
            jsonPath: isJson ? editor?.document.uri.fsPath : undefined,
            webConfigured: isWebSearchConfigured(),
            documentLabel: editor
                ? `${editor.document.languageId} · ${editor.document.uri.fsPath.split(/[/\\]/).pop()}`
                : undefined,
        });

        // 仅当缓存结果属于「当前工作文档」且来源匹配（MD↔selection / JSON↔json）时才回显，
        // 避免打开 Markdown 时仍展示上次 JSON 条目检索结果。
        if (this.resultsBelongToEditor(editor)) {
            if (this.lastReplayRecords?.length && this.lastAnchorPath) {
                this.postProcessGrouped(this.lastReplayRecords, this.lastAnchorPath);
            } else if (this.lastProcess && this.lastAnchorPath) {
                this.postProcess(this.lastProcess, this.lastAnchorPath);
            }
            this.postResultOrigin();
        } else if (this.lastProcess || this.lastReplayRecords?.length) {
            this.post({ type: 'clearHits' });
            this.post({ type: 'resultOrigin', origin: null });
        }
    }

    /** 面板缓存的过程结果是否属于当前编辑器文档（路径 + MD/JSON 来源） */
    private resultsBelongToEditor(editor: vscode.TextEditor | undefined): boolean {
        if (!editor || !this.lastAnchorPath) return false;
        if (path.normalize(editor.document.uri.fsPath) !== path.normalize(this.lastAnchorPath)) {
            return false;
        }
        const editorIsJson = editor.document.languageId === 'json';
        if (!this.lastPrepOrigin) {
            // 无显式来源时：至少要求锚点扩展名与语言一致
            const anchorIsJson = this.lastAnchorPath.toLowerCase().endsWith('.json');
            return editorIsJson === anchorIsJson;
        }
        if (editorIsJson) return this.lastPrepOrigin === 'json';
        return this.lastPrepOrigin === 'selection';
    }

    private postEvent(event: PrepEvent): void {
        this.post({ type: 'event', event });
        if (event.type === 'process') {
            this.lastProcess = event.process;
            this.lastAnchorPath = event.anchorPath;
            this.lastReplayRecords = undefined;
            this.setResultOriginFromProcess(event.process, event.anchorPath);
            this.postProcess(event.process, event.anchorPath);
        }
    }

    private postProcess(process: ReferencePrepProcessFileV020, anchorPath: string): void {
        const hits = sortHitsForLlm(process.corpus).map((h) => this.serializeHit(h));
        const emptyQueries: Array<{ roundIndex: number; queryId: string; intent: string }> = [];
        process.rounds.forEach((r, roundIndex) => {
            for (const q of r.plan.queries) {
                const n = process.corpus.filter(
                    (h) =>
                        h.queryId === q.queryId &&
                        (!h.roundId || !r.roundId || h.roundId === r.roundId)
                ).length;
                if (n === 0) {
                    emptyQueries.push({ roundIndex, queryId: q.queryId, intent: q.intent });
                }
            }
        });
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
            emptyQueries,
            hits,
            mergedReference: process.mergedReference ?? '',
            enabledSources: process.enabledSources,
            strength: process.strength,
        });
    }

    /** 多选区/多条目重放：命中按组展示；hitId 加 record 前缀避免跨记录冲突 */
    private postProcessGrouped(records: ReferencePrepProcessFileV020[], anchorPath: string): void {
        const isJson = this.recordsOriginForAnchor(anchorPath) === 'json_item';
        const groupKind = isJson ? 'target' : 'selection';
        const groups = records.map((proc, index) => {
            const key = processRecordKey(proc, index);
            const raw =
                (proc.targetPreview ?? proc.userInput ?? '').replace(/\s+/g, ' ').trim() ||
                (isJson ? `条目 ${index + 1}` : `选区 ${index + 1}`);
            const hits = sortHitsForLlm(proc.corpus).map((h) => ({
                ...this.serializeHit(h),
                hitId: `${key}::${h.hitId}`,
            }));
            return {
                recordId: key,
                target: raw,
                groupKind,
                hitCount: hits.length,
                activeHits: proc.corpus.filter((h) => h.status === 'active').length,
                roundCount: proc.rounds.length,
                hits,
            };
        });
        this.setResultOrigin(isJson ? 'json' : 'selection');
        this.post({
            type: 'process',
            anchorPath,
            groups,
            groupKind,
            hits: groups.flatMap((g) => g.hits),
            rounds: [],
            mergedReference: '',
            enabledSources: records[0]?.enabledSources ?? [],
            strength: records[0]?.strength,
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
            suggestedForExport: h.suggestedForExport,
            /** 默认勾选：软筛选建议导出；旧数据无标记时保持 active 即勾选 */
            defaultChecked:
                h.status === 'active' &&
                h.kind !== 'navigation_hint' &&
                h.suggestedForExport !== false,
        };
    }

    /**
     * 按过程记录分组解析勾选命中（多记录重放时 hitId 为 `recordId::hitId`）。
     * 仅匹配带前缀的 id，避免跨记录同号 hitId 串台。
     */
    private resolveSelectedHitGroups(hitIds?: string[]): HitExportGroup[] {
        if (!hitIds?.length) return [];
        const want = new Set(hitIds);

        if (this.lastReplayRecords?.length) {
            const groups: HitExportGroup[] = [];
            for (let index = 0; index < this.lastReplayRecords.length; index++) {
                const rec = this.lastReplayRecords[index];
                const key = processRecordKey(rec, index);
                const hits: CorpusHit[] = [];
                for (const h of rec.corpus) {
                    if (want.has(`${key}::${h.hitId}`)) {
                        hits.push(h);
                    }
                }
                if (hits.length) {
                    groups.push({
                        target: (rec.userInput ?? rec.targetPreview ?? '').trim(),
                        hits,
                    });
                }
            }
            return groups;
        }

        if (!this.lastProcess) return [];
        const hits = this.lastProcess.corpus.filter((h) => want.has(h.hitId));
        if (!hits.length) return [];
        return [
            {
                target: (this.lastProcess.userInput ?? this.lastProcess.targetPreview ?? '').trim(),
                hits,
            },
        ];
    }

    private normalizeTargetText(text: string): string {
        return text.replace(/\s+/g, ' ').trim();
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
     * 多选区时按 target 分节。
     */
    private prepareSelectedMdExport(
        hitIds?: string[]
    ):
        | { kind: 'file'; uri: vscode.Uri; tip: string; md: string; hitCount: number }
        | { kind: 'preview'; tip: string; md: string; hitCount: number }
        | undefined {
        const groups = this.resolveSelectedHitGroups(hitIds);
        const hitCount = groups.reduce((n, g) => n + g.hits.length, 0);
        if (!hitCount) {
            vscode.window.showWarningMessage('请先勾选要导出的命中。');
            return undefined;
        }
        const md = formatGroupedHitsAsMarkdown(groups);
        if (!md.trim()) {
            vscode.window.showWarningMessage('选中命中没有可导出的正文。');
            return undefined;
        }
        const charCount = md.length;
        const groupHint = groups.length > 1 ? `、${groups.length} 个 target` : '';
        const tipBase = `导出完成：${hitCount} 条${groupHint}、${charCount} 字符`;
        const anchor = this.lastAnchorPath ?? getWorkingTextEditor()?.document.uri.fsPath;
        if (anchor) {
            const outPath = FilePathUtils.getFilePath(anchor, '.selected-refs', '.md');
            fs.writeFileSync(outPath, md, 'utf8');
            return {
                kind: 'file',
                uri: vscode.Uri.file(outPath),
                tip: `${tipBase} → ${path.basename(outPath)}`,
                md,
                hitCount,
            };
        }
        return {
            kind: 'preview',
            tip: `${tipBase}（未落盘）`,
            md,
            hitCount,
        };
    }

    private async exportSelectedAsMd(hitIds?: string[]): Promise<void> {
        if (this.lastPrepOrigin === 'json') {
            vscode.window.showWarningMessage(
                '当前结果来自 JSON 条目检索，请使用「导出选中为 JSON」或「合并选中到源 JSON」。'
            );
            return;
        }
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

    private async exportSelectedAsJson(hitIds?: string[]): Promise<void> {
        if (this.lastPrepOrigin === 'selection') {
            vscode.window.showWarningMessage(
                '当前结果来自 Markdown 选段，请使用「导出选中为 md」；JSON 导出仅用于 JSON 条目检索结果。'
            );
            return;
        }
        const groups = this.resolveSelectedHitGroups(hitIds);
        const hitCount = groups.reduce((n, g) => n + g.hits.length, 0);
        if (!hitCount) {
            vscode.window.showWarningMessage('请先勾选要导出的命中。');
            return;
        }
        const payload = formatGroupedHitsAsJsonDocument(groups);
        const hasBody = Array.isArray(payload)
            ? payload.some((x) => x.reference.trim())
            : Boolean(payload.reference.trim());
        if (!hasBody) {
            vscode.window.showWarningMessage('选中命中没有可导出的正文。');
            return;
        }
        const text = JSON.stringify(payload, null, 2);
        const groupHint = groups.length > 1 ? `（${groups.length} 个 target）` : '';
        const jsonPath = this.resolveJsonPathForMerge();
        const anchor = jsonPath ?? this.lastAnchorPath ?? getWorkingTextEditor()?.document.uri.fsPath;
        if (anchor) {
            const outPath = FilePathUtils.getFilePath(anchor, '.selected-refs', '.json');
            fs.writeFileSync(outPath, text, 'utf8');
            await this.notifyExportDone(
                `已导出 ${hitCount} 条${groupHint}为 JSON：${path.basename(outPath)}`,
                vscode.Uri.file(outPath)
            );
        } else {
            const tip = `已导出 ${hitCount} 条${groupHint}为 JSON（未保存）`;
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
        if (this.lastPrepOrigin !== 'json') {
            vscode.window.showWarningMessage(
                '合并到源 JSON 仅适用于 JSON 条目检索结果。Markdown 选段与 JSON 切分不同步，请勿混用。'
            );
            return;
        }
        const groups = this.resolveSelectedHitGroups(hitIds);
        const hitCount = groups.reduce((n, g) => n + g.hits.length, 0);
        if (!hitCount) {
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

        const rows = items as Array<Record<string, unknown>>;
        const flatMerged = formatSelectedHitsAsReferenceField(groups.flatMap((g) => g.hits));
        if (!flatMerged.trim()) {
            vscode.window.showWarningMessage('选中命中没有可写入的 reference 正文。');
            return;
        }

        const groupsWithTarget = groups.filter((g) => this.normalizeTargetText(g.target));
        type MergeMode =
            | 'by_target'
            | 'by_target_append'
            | 'by_target_fill_empty'
            | 'overwrite_all'
            | 'fill_empty'
            | 'append_all';
        type MergePick = vscode.QuickPickItem & { value: MergeMode };

        const itemsPick: MergePick[] = [];
        if (groupsWithTarget.length > 0) {
            itemsPick.push(
                {
                    label: '按 target 写入对应条目',
                    description:
                        groupsWithTarget.length > 1
                            ? `将 ${groupsWithTarget.length} 组勾选资料分别写入匹配条目（覆盖）`
                            : '写入 JSON 中与当前选区 target 匹配的条目（覆盖）',
                    value: 'by_target',
                },
                {
                    label: '按 target 追加到对应条目',
                    description: '匹配条目已有 reference 时在其后追加',
                    value: 'by_target_append',
                },
                {
                    label: '按 target 仅填空条目',
                    description: '仅写入尚无 reference 的匹配条目',
                    value: 'by_target_fill_empty',
                }
            );
        }
        itemsPick.push(
            {
                label: '覆盖写入全部条目的 reference',
                description: '每条 item.reference 替换为全部勾选资料（合并为一份）',
                value: 'overwrite_all',
            },
            {
                label: '仅写入尚无 reference 的条目',
                description: '已有 reference 的条目跳过；内容为全部勾选资料',
                value: 'fill_empty',
            },
            {
                label: '追加到全部条目的 reference',
                description: '在已有内容后追加全部勾选资料',
                value: 'append_all',
            }
        );

        const mode = await vscode.window.showQuickPick(itemsPick, {
            title: '合并选中资料到源 JSON',
            placeHolder:
                groupsWithTarget.length > 1
                    ? '多选区勾选时建议选用「按 target …」'
                    : '选择写入方式',
            ignoreFocusOut: true,
        });
        if (!mode) return;

        let touched = 0;
        const unmatched: string[] = [];

        if (
            mode.value === 'by_target' ||
            mode.value === 'by_target_append' ||
            mode.value === 'by_target_fill_empty'
        ) {
            for (const group of groupsWithTarget) {
                const ref = formatSelectedHitsAsReferenceField(group.hits);
                if (!ref.trim()) continue;
                const want = this.normalizeTargetText(group.target);
                let matched = 0;
                for (const raw of rows) {
                    if (!('target' in raw)) continue;
                    const itemTarget = this.normalizeTargetText(String(raw.target ?? ''));
                    if (!itemTarget || itemTarget !== want) continue;
                    const prev = typeof raw.reference === 'string' ? raw.reference : '';
                    if (mode.value === 'by_target_fill_empty' && prev.trim()) continue;
                    if (mode.value === 'by_target_append' && prev.trim()) {
                        raw.reference = `${prev}\n\n${ref}`;
                    } else {
                        raw.reference = ref;
                    }
                    matched++;
                    touched++;
                }
                if (matched === 0) {
                    unmatched.push(want.slice(0, 40) + (want.length > 40 ? '…' : ''));
                }
            }
        } else {
            for (const raw of rows) {
                if (!('target' in raw)) continue;
                const prev = typeof raw.reference === 'string' ? raw.reference : '';
                if (mode.value === 'fill_empty' && prev.trim()) continue;
                if (mode.value === 'append_all' && prev.trim()) {
                    raw.reference = `${prev}\n\n${flatMerged}`;
                } else {
                    raw.reference = flatMerged;
                }
                touched++;
            }
        }

        fs.writeFileSync(jsonPath, JSON.stringify(items, null, 2), 'utf8');
        const doc = await vscode.workspace.openTextDocument(jsonPath);
        await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
        let tip = `已将 ${hitCount} 条选中资料合并到源 JSON（更新 ${touched} 个条目）`;
        if (unmatched.length) {
            tip += `；未匹配 target：${unmatched.slice(0, 3).join('、')}${unmatched.length > 3 ? '…' : ''}`;
        }
        vscode.window.showInformationMessage(tip);
        this.post({ type: 'exportDone', message: tip });
    }

    private async handleMessage(msg: {
        command?: string;
        commandId?: string;
        enabledSources?: ReferenceSourceId[];
        strength?: ReferencePrepStrength;
        targetMode?: 'selection' | 'json';
        resume?: boolean;
        hitId?: string;
        hitIds?: string[];
        anchorPath?: string;
        controls?: Partial<ReferencePrepRunControls>;
        action?: 'confirm' | 'skip' | 'cancel';
        plan?: ReferencePrepPlan;
        disabledQueryIds?: string[];
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
                if (this.planReviewResolver) {
                    const r = this.planReviewResolver;
                    this.planReviewResolver = undefined;
                    r({ action: 'cancel' });
                }
                break;
            case 'planConfirm': {
                const resolver = this.planReviewResolver;
                this.planReviewResolver = undefined;
                if (!resolver) break;
                const action =
                    msg.action === 'skip' ? 'skip' : msg.action === 'cancel' ? 'cancel' : 'confirm';
                if (action === 'cancel' || action === 'skip') {
                    resolver({ action });
                    break;
                }
                let plan = msg.plan;
                if (plan && Array.isArray(msg.disabledQueryIds) && msg.disabledQueryIds.length) {
                    const disabled = new Set(msg.disabledQueryIds);
                    plan = {
                        ...plan,
                        queries: plan.queries.filter((q) => !disabled.has(q.queryId)),
                    };
                }
                resolver({ action: 'confirm', plan });
                break;
            }
            case 'run':
                await this.runPrep(msg);
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
            case 'exportSelectedJson':
                await this.exportSelectedAsJson(msg.hitIds);
                break;
            case 'mergeSelectedIntoJson':
                await this.mergeSelectedIntoSourceJson(msg.hitIds);
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
        if (!hitId) return undefined;
        if (this.lastReplayRecords?.length) {
            const sep = hitId.indexOf('::');
            if (sep <= 0) return undefined;
            const recordKey = hitId.slice(0, sep);
            const realId = hitId.slice(sep + 2);
            for (let i = 0; i < this.lastReplayRecords.length; i++) {
                const rec = this.lastReplayRecords[i];
                if (processRecordKey(rec, i) !== recordKey) continue;
                return rec.corpus.find((h) => h.hitId === realId);
            }
            return undefined;
        }
        if (!this.lastProcess) return undefined;
        return this.lastProcess.corpus.find((h) => h.hitId === hitId);
    }

    private async replayFromAnchor(anchorPath?: string): Promise<void> {
        const editor = getWorkingTextEditor();
        const docPath = anchorPath || editor?.document.uri.fsPath;
        if (!docPath) {
            vscode.window.showWarningMessage('请先打开带有 .referenceprep.json 的文档，或传入锚点路径。');
            return;
        }
        const origin = this.recordsOriginForAnchor(docPath);
        const allRecords = listProcessRecords(docPath, { origin });
        if (allRecords.length === 0) {
            vscode.window.showWarningMessage(
                origin === 'json_item'
                    ? '未找到 JSON 条目检索过程文件（.referenceprep.json）。'
                    : '未找到选段检索过程文件（.referenceprep.json）。'
            );
            return;
        }
        const records = allRecords.filter((r) => r.corpus.length > 0 || r.rounds.length > 0);
        if (records.length === 0) {
            vscode.window.showWarningMessage('过程文件中尚无检索轮次或命中，无可重放内容。');
            return;
        }

        if (records.length === 1) {
            await this.applyReplay(docPath, [records[0]], false);
            return;
        }

        type ReplayPick = vscode.QuickPickItem & { recordId?: string };
        const unit = origin === 'json_item' ? '条目' : '选区';
        const items: ReplayPick[] = records.map((r, i) => {
            const preview = (r.targetPreview ?? r.userInput ?? '').replace(/\s+/g, ' ').trim();
            const activeHits = r.corpus.filter((h) => h.status === 'active').length;
            const short = preview.slice(0, 48);
            return {
                label: preview
                    ? `${i + 1}. ${short}${preview.length > 48 ? '…' : ''}`
                    : `${i + 1}. （无预览）`,
                description: `${activeHits} 条命中 · ${r.rounds.length} 轮`,
                detail: preview.length > 48 ? preview.slice(0, 120) : undefined,
                recordId: r.id ?? '',
            };
        });
        const picked = await vscode.window.showQuickPick(items, {
            title: `重放过程文件（${unit}）`,
            placeHolder: `共 ${records.length} 条${unit}；选一条，或不选（Esc）以分组展示全部`,
            ignoreFocusOut: true,
        });

        if (!picked) {
            await this.applyReplay(docPath, records, true);
            return;
        }
        if (!picked.recordId) {
            vscode.window.showWarningMessage('所选记录无效。');
            return;
        }
        const loaded = loadProcessRecord(docPath, picked.recordId);
        if (!loaded) {
            vscode.window.showWarningMessage('所选记录已不存在。');
            return;
        }
        await this.applyReplay(docPath, [loaded], false);
    }

    private async applyReplay(
        docPath: string,
        records: ReferencePrepProcessFileV020[],
        showAll: boolean
    ): Promise<void> {
        if (!records.length) return;

        if (showAll && records.length > 1) {
            this.lastReplayRecords = records;
            this.lastProcess = records[records.length - 1];
            this.lastAnchorPath = docPath;
            const isJson = this.recordsOriginForAnchor(docPath) === 'json_item';
            const unit = isJson ? '条目' : '选区';
            const lastId = this.lastProcess.id;
            if (lastId) {
                setActiveProcessRecord(docPath, lastId);
            }
            this.resultsProvider?.refreshRecords(records, docPath);
            await setReferenceHitVisible(true);
            this.post({ type: 'clearTimeline' });
            this.postProcessGrouped(records, docPath);
            this.postEvent({
                type: 'phase',
                name: 'replay',
                message: `重放全部 ${records.length} 条${unit}记录`,
            });
            for (let ri = 0; ri < records.length; ri++) {
                const proc = records[ri];
                const previewRaw = (proc.targetPreview ?? proc.userInput ?? '')
                    .replace(/\s+/g, ' ')
                    .trim();
                const previewShown = previewRaw.slice(0, 80);
                this.postEvent({
                    type: 'phase',
                    name: 'replay',
                    message: previewRaw
                        ? `── ${unit} ${ri + 1}/${records.length}：${previewShown}${previewRaw.length > 80 ? '…' : ''} ──`
                        : `── ${unit} ${ri + 1}/${records.length} ──`,
                });
                for (let i = 0; i < proc.rounds.length; i++) {
                    const r = proc.rounds[i];
                    this.postEvent({ type: 'plan', round: i, plan: r.plan });
                    for (const q of r.plan.queries) {
                        this.postEvent({ type: 'query', round: i, queryId: q.queryId, detail: q });
                    }
                }
            }
            this.postEvent({
                type: 'phase',
                name: 'done',
                message: `已从过程文件重放全部 ${records.length} 条${unit}`,
            });
            return;
        }

        const proc = records[0];
        this.lastReplayRecords = undefined;
        this.lastProcess = proc;
        this.lastAnchorPath = docPath;
        this.setResultOriginFromProcess(proc, docPath);
        if (proc.id) {
            setActiveProcessRecord(docPath, proc.id);
        }
        this.resultsProvider?.refresh(proc, docPath);
        await setReferenceHitVisible(true);
        this.post({ type: 'clearTimeline' });
        this.postProcess(proc, docPath);

        const isJson = inferPrepOrigin(proc, docPath) === 'json_item';
        const unit = isJson ? '条目' : '选区';
        const previewRaw = (proc.targetPreview ?? proc.userInput ?? '').replace(/\s+/g, ' ').trim();
        const previewShown = previewRaw.slice(0, 80);
        this.postEvent({
            type: 'phase',
            name: 'replay',
            message: previewRaw
                ? `${unit}：${previewShown}${previewRaw.length > 80 ? '…' : ''}`
                : '重放过程文件',
        });
        for (let i = 0; i < proc.rounds.length; i++) {
            const r = proc.rounds[i];
            this.postEvent({ type: 'plan', round: i, plan: r.plan });
            for (const q of r.plan.queries) {
                this.postEvent({ type: 'query', round: i, queryId: q.queryId, detail: q });
            }
        }
        this.postEvent({ type: 'phase', name: 'done', message: '已从过程文件重放' });
    }

    private requestPlanReviewFromPanel(args: {
        round: number;
        plan: ReferencePrepPlan;
    }): Promise<{ action: 'confirm' | 'skip' | 'cancel'; plan?: ReferencePrepPlan }> {
        return new Promise((resolve) => {
            this.planReviewResolver = resolve;
            this.post({
                type: 'planReviewUi',
                round: args.round,
                plan: args.plan,
                awaitConfirm: true,
            });
        });
    }

    private async runPrep(msg: {
        enabledSources?: ReferenceSourceId[];
        strength?: ReferencePrepStrength;
        targetMode?: 'selection' | 'json';
        resume?: boolean;
        controls?: Partial<ReferencePrepRunControls>;
    }): Promise<void> {
        const enabledSources = (msg.enabledSources ?? []).filter((s) => s !== 'web' || isWebSearchConfigured());
        if (!enabledSources.length) {
            vscode.window.showErrorMessage('请至少选择一个可用的资料来源。');
            return;
        }
        const strength = msg.strength ?? 'standard';
        const controls = clampControls(msg.controls, strength);
        await saveReferencePrepLastRun(this.context, { enabledSources, strength, controls });
        await this.prepHandler.maybeShowWikipediaNotice(this.context, enabledSources);

        const editor = getWorkingTextEditor();
        if (!editor) {
            vscode.window.showErrorMessage('请先打开并选中目标文档（焦点可在检索面板上）。');
            return;
        }

        this.cancelSource?.cancel();
        this.cancelSource = new vscode.CancellationTokenSource();
        const token = this.cancelSource.token;
        this.lastReplayRecords = undefined;
        this.lastProcess = undefined;
        this.lastPrepOrigin = undefined;
        this.post({ type: 'clearTimeline' });
        this.post({ type: 'clearHits' });
        this.postResultOrigin();
        this.post({ type: 'running', running: true });

        const onEvent = (event: PrepEvent) => this.postEvent(event);

        try {
            if (msg.targetMode === 'json') {
                if (editor.document.languageId !== 'json') {
                    vscode.window.showErrorMessage('当前文件不是 JSON，请切换到切分 JSON 或改用选段模式。');
                    return;
                }
                const jsonPath = editor.document.uri.fsPath;
                await this.prepHandler.handlePrepareReferencesJson(jsonPath, this.context, {
                    skipPicks: true,
                    enabledSources,
                    strength,
                    controls,
                    onEvent,
                    token,
                    skipExistingReference: !!msg.resume,
                    requestPlanReview: (args) => this.requestPlanReviewFromPanel(args),
                });
                const records = listProcessRecords(jsonPath, { origin: 'json_item' }).filter(
                    (r) => r.corpus.length > 0 || r.rounds.length > 0
                );
                if (records.length > 1) {
                    await this.applyReplay(jsonPath, records, true);
                } else if (records.length === 1) {
                    await this.applyReplay(jsonPath, records, false);
                }
            } else {
                if (editor.document.languageId === 'json') {
                    vscode.window.showErrorMessage(
                        'JSON 文件请将「目标」设为「当前 JSON 文件」。选段模式仅用于 Markdown 等文稿（选段与 JSON 切分不同步）。'
                    );
                    return;
                }
                const selectedText = editor.document.getText(editor.selection);
                if (!selectedText.trim()) {
                    vscode.window.showErrorMessage('请先选择要准备参考资料的文本。');
                    return;
                }
                const cont = await pickReferencePrepContinuation({
                    context: this.context,
                    anchorPath: editor.document.uri.fsPath,
                    target: selectedText,
                    title: '检索面板 · 准备参考资料（选段）',
                });
                if (!cont) return;
                await this.prepHandler.runPrepForSelection({
                    target: cont.targetOverride ?? selectedText,
                    anchorPath: cont.anchorPath,
                    context: this.context,
                    enabledSources,
                    strength,
                    controls,
                    freshProcess: cont.freshProcess,
                    continuation: cont.continuation,
                    maxRoundsOverride: cont.maxRoundsOverride,
                    recordId: cont.recordId,
                    onEvent,
                    token,
                    requestPlanReview: (args) => this.requestPlanReviewFromPanel(args),
                    openMergedPreview: false,
                    showInformationMessage: true,
                });
            }
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            this.postEvent({ type: 'error', message });
        } finally {
            if (this.planReviewResolver) {
                const r = this.planReviewResolver;
                this.planReviewResolver = undefined;
                r({ action: 'cancel' });
            }
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
#hits li.hit-group {
  display: block;
  border: none;
  border-radius: 0;
  padding: 10px 0 2px;
  margin: 8px 0 4px;
  border-bottom: 1px solid var(--vscode-widget-border);
}
#hits li.hit-group:first-child { margin-top: 0; }
#hits li.hit-group .hit-group-title {
  font-weight: 600;
  font-size: 0.95em;
  color: var(--vscode-foreground);
}
#hits li.hit-group .hit-group-meta {
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground);
  margin-top: 2px;
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
.btn-json-only { display: none; }
body.mode-json .btn-json-only { display: inline-block; }
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
.cmd-group-label {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  margin-right: 2px;
  white-space: nowrap;
  user-select: none;
}
.controls-box {
  border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.35));
  padding: 8px 10px;
  margin: 6px 0 10px;
  font-size: 12px;
}
.controls-box summary {
  cursor: pointer;
  font-weight: 600;
  margin-bottom: 6px;
}
.controls-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
  align-items: flex-end;
}
.controls-grid label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}
.controls-grid input[type=number], .controls-grid select {
  min-width: 72px;
  max-width: 100px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  padding: 2px 4px;
}
.controls-grid label.inline-check {
  flex-direction: row;
  align-items: center;
  gap: 6px;
  min-width: auto;
}
#planPanel {
  display: none;
  border: 1px solid var(--vscode-focusBorder, rgba(128,128,128,0.4));
  padding: 8px 10px;
  margin: 8px 0 12px;
  background: var(--vscode-editor-inactiveSelectionBackground, transparent);
}
#planPanel.visible { display: block; }
#planPanel h3 { margin: 0 0 6px; font-size: 13px; }
#planList { list-style: none; padding: 0; margin: 0 0 8px; }
#planList li {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 4px 0;
  border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25));
  font-size: 12px;
}
#planList .q-meta { color: var(--vscode-descriptionForeground); font-size: 11px; }
#planActions { display: flex; gap: 8px; flex-wrap: wrap; }
.empty-query-note {
  color: var(--vscode-editorWarning-foreground, #cca700);
  font-size: 11px;
}
</style>
</head>
<body>
<h2>配置</h2>
<div class="row" id="sources"></div>
<div class="row">
  <label>检索强度
    <select id="strength">
      <option value="light">轻量</option>
      <option value="standard" selected>标准</option>
      <option value="thorough">深入</option>
    </select>
  </label>
  <label>目标
    <select id="targetMode">
      <option value="selection">Markdown 选段</option>
      <option value="json">当前 JSON 文件</option>
    </select>
  </label>
  <button type="button" class="secondary" id="btnResetControls" title="按当前强度重置检索控制">按强度重置</button>
</div>
<details class="controls-box" id="controlsBox" open>
  <summary>检索控制</summary>
  <div class="controls-grid">
    <label title="精排后默认勾选的最低相关分">勾选最低分
      <input type="number" id="ctlMinScore" min="0" max="1" step="0.05" />
    </label>
    <label title="每个查询默认勾选条数上限">勾选条数/查询
      <input type="number" id="ctlMaxSelected" min="1" max="50" step="1" />
    </label>
    <label title="每个查询默认勾选总字符上限">勾选字符/查询
      <input type="number" id="ctlMaxChars" min="500" max="100000" step="500" />
    </label>
    <label title="每个查询入库候选上限（宽于勾选条数）">候选池/查询
      <input type="number" id="ctlMaxCandidates" min="1" max="100" step="1" />
    </label>
    <label title="首选词典保留条目数">词典首选
      <input type="number" id="ctlDictPrimary" min="1" max="30" step="1" />
    </label>
    <label title="后备词典按相关性加选">词典相关加选
      <input type="number" id="ctlDictRel" min="0" max="30" step="1" />
    </label>
    <label title="后备词典按长度加选">词典长度加选
      <input type="number" id="ctlDictLen" min="0" max="30" step="1" />
    </label>
    <label title="维基首选语言">维基首选
      <select id="ctlWikiDefault"></select>
    </label>
    <label title="维基备选语言">维基备选
      <select id="ctlWikiFallback"></select>
    </label>
    <label class="inline-check" title="开启后每轮规划需确认再执行">
      <input type="checkbox" id="ctlRequirePlan" />规划后确认
    </label>
    <label class="inline-check" title="锁定后切换强度不覆盖自定义值">
      <input type="checkbox" id="ctlLocked" />锁定自定义
    </label>
  </div>
</details>
<div class="row">
  <span class="status" id="resultOriginHint"></span>
</div>
<div class="row">
  <span class="status">核对选中引文 → 侧栏「资料检索」；核对全文引文 → 先建立引文索引 → 侧栏「引文核查」。引文索引亦供 BM25 资料准备使用。校对请到校对面板。</span>
</div>
<div class="row">
  <textarea class="preview" id="selectionPreview" readonly placeholder="选区预览…"></textarea>
</div>
<div class="row">
  <span class="status" id="targetDoc"></span>
</div>
<div class="row">
  <button id="btnRun">开始准备</button>
  <button class="secondary btn-json-only" id="btnResume" title="跳过过程文件中已有检索记录的条目，只处理未完成项">继续未完成部分</button>
  <button class="secondary" id="btnCancel" disabled>取消</button>
  <button class="secondary" id="btnReplay">重放过程文件</button>
  <button class="secondary" id="btnRefresh">刷新状态</button>
  <span class="status" id="runStatus"></span>
</div>

<h2>过程</h2>
<div id="timeline"><div class="tl-item"><span class="tag">就绪</span>选择来源后点击「开始准备」</div></div>

<div id="planPanel">
  <h3 id="planPanelTitle">本轮规划</h3>
  <ul id="planList"></ul>
  <div id="planActions" style="display:none">
    <button type="button" id="btnPlanConfirm">确认并执行</button>
    <button type="button" class="secondary" id="btnPlanSkip">跳过本轮</button>
    <button type="button" class="secondary" id="btnPlanCancel">取消</button>
  </div>
  <pre id="planJson" style="display:none;max-height:160px;overflow:auto;font-size:11px;white-space:pre-wrap;"></pre>
  <button type="button" class="secondary" id="btnTogglePlanJson" style="margin-top:4px">展开 JSON</button>
</div>

<h2>结果</h2>
<div class="row"><span class="status" id="suggestHint"></span></div>
<div class="export-bar mode-selection" id="exportBar">
  <button type="button" class="secondary" id="btnSelectAll">全选</button>
  <button type="button" class="secondary" id="btnSelectNone">全不选</button>
  <button type="button" class="mode-only for-selection" id="btnExportMd">导出选中为 md</button>
  <button type="button" class="mode-only for-json" id="btnExportJson">导出选中为 JSON</button>
  <button type="button" class="mode-only for-json" id="btnMergeJson">合并选中到源 JSON</button>
  <span class="status" id="selectedCount"></span>
</div>
<div class="export-done" id="exportDone" style="display:none" role="status"></div>
<ul id="hits"></ul>

<div class="panel-footer-commands">
  <p class="header-commands-hint">常用检索命令（作用于当前编辑器选区/文档；Ctrl+Shift+P 可查全部）</p>
  <div class="header-actions">
    <span class="cmd-group-label">单源检索：</span>
    <button type="button" class="link-button" data-cmd="ai-proofread.search.dictPrep" title="仅本地词典（LLM 规划+精排）">词典·LLM规划</button>
    <span class="cmd-sep" aria-hidden="true">|</span>
    <button type="button" class="link-button" data-cmd="ai-proofread.search.refsGrep" title="仅参考资料 grep（规划+精排）">Grep</button>
    <span class="cmd-sep" aria-hidden="true">|</span>
    <button type="button" class="link-button" data-cmd="ai-proofread.search.refsBm25" title="仅 BM25（规划+精排；需先建立引文索引）">BM25</button>
    <span class="cmd-sep" aria-hidden="true">|</span>
    <button type="button" class="link-button" data-cmd="ai-proofread.search.refsVector" title="仅轻量向量（规划+精排）">向量</button>
    <span class="cmd-sep" aria-hidden="true">|</span>
    <button type="button" class="link-button" data-cmd="ai-proofread.search.wikipedia" title="仅维基百科（规划+精排）">查维基</button>
    <span class="cmd-sep" aria-hidden="true">|</span>
    <button type="button" class="link-button" data-cmd="ai-proofread.search.web" title="Web 搜索尚未实现" disabled style="opacity:0.5;cursor:not-allowed;text-decoration:none;">Web（未实现）</button>
    <span class="cmd-sep cmd-sep--between-groups" aria-hidden="true">||</span>
    <button type="button" class="link-button" data-cmd="ai-proofread.llmGrepSearchReferences" title="用自然语言描述检索意图，LLM 规划后多源检索（默认词典+grep+BM25+向量）">意图检索</button>
    <span class="cmd-sep cmd-sep--between-groups" aria-hidden="true">||</span>
    <button type="button" class="link-button" data-cmd="ai-proofread.queryLocalDictSelection" title="整词查本地 MDX，无 LLM">直接查词典</button>
    <span class="cmd-sep" aria-hidden="true">|</span>
    <button type="button" class="link-button" data-cmd="ai-proofread.searchSelectionInPDF" title="search selection in PDF">从md反查PDF</button>
    <span class="cmd-sep" aria-hidden="true">|</span>
    <button type="button" class="link-button" data-cmd="ai-proofread.searchSelectionInShidianguji" title="search selection in Shidianguji">识典古籍</button>
    <span class="cmd-sep" aria-hidden="true">|</span>
    <button type="button" class="link-button" data-cmd="ai-proofread.searchSelectionInAncientbooks" title="search selection in Ancientbooks">中华经典古籍库</button>
    <span class="cmd-sep" aria-hidden="true">|</span>
    <button type="button" class="link-button" data-cmd="ai-proofread.searchSelectionInReferences" title="search selection in References">VSCode搜索参考资料库</button>
    <span class="cmd-sep cmd-sep--between-groups" aria-hidden="true">||</span>
    <button type="button" class="link-button" data-cmd="ai-proofread.citation.verifySelection" title="Verify Selected Citation">核对选中引文</button>
    <span class="cmd-sep" aria-hidden="true">|</span>
    <button type="button" class="link-button" data-cmd="ai-proofread.citation.openView" title="Verify Citations">核对全文引文</button>
    <span class="cmd-sep" aria-hidden="true">|</span>
    <button type="button" class="link-button" data-cmd="ai-proofread.citation.rebuildIndex" title="供核对全文引文与资料准备 BM25 共用">建立引文索引</button>
    <span class="cmd-sep cmd-sep--between-groups" aria-hidden="true">||</span>
    <button type="button" class="link-button" data-cmd="ai-proofread.referencePrep.clearRetrievalCache" title="Clear Project Retrieval Cache">清除检索缓存</button>
  </div>
</div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const sourcesEl = document.getElementById('sources');
const strengthEl = document.getElementById('strength');
const targetModeEl = document.getElementById('targetMode');
const resultOriginHintEl = document.getElementById('resultOriginHint');
const previewEl = document.getElementById('selectionPreview');
const targetDocEl = document.getElementById('targetDoc');
const timelineEl = document.getElementById('timeline');
const hitsEl = document.getElementById('hits');
const exportBar = document.getElementById('exportBar');
const exportDoneEl = document.getElementById('exportDone');
const selectedCountEl = document.getElementById('selectedCount');
const runStatus = document.getElementById('runStatus');
const btnRun = document.getElementById('btnRun');
const btnResume = document.getElementById('btnResume');
const btnCancel = document.getElementById('btnCancel');
const planPanel = document.getElementById('planPanel');
const planList = document.getElementById('planList');
const planActions = document.getElementById('planActions');
const planJsonEl = document.getElementById('planJson');
const suggestHintEl = document.getElementById('suggestHint');

/** @type {Map<string, boolean>} */
const checkedByHitId = new Map();
/** @type {'selection'|'json'|null} 当前命中结果来源（与目标下拉解耦） */
let resultOrigin = null;
/** @type {Record<string, any>} */
let strengthPresets = {};
/** @type {any} */
let pendingPlan = null;
let pendingPlanRound = 0;

function readControlsFromUi() {
  return {
    minSelectScore: Number(document.getElementById('ctlMinScore').value),
    maxSelectedPerQuery: Number(document.getElementById('ctlMaxSelected').value),
    maxSelectedCharsPerQuery: Number(document.getElementById('ctlMaxChars').value),
    maxCandidateHitsPerQuery: Number(document.getElementById('ctlMaxCandidates').value),
    maxEntriesPrimary: Number(document.getElementById('ctlDictPrimary').value),
    maxEntriesRelevance: Number(document.getElementById('ctlDictRel').value),
    maxEntriesLength: Number(document.getElementById('ctlDictLen').value),
    requirePlanConfirm: document.getElementById('ctlRequirePlan').checked,
    wikiDefaultLang: document.getElementById('ctlWikiDefault').value,
    wikiFallbackLang: document.getElementById('ctlWikiFallback').value,
    controlsLocked: document.getElementById('ctlLocked').checked
  };
}

function applyControlsToUi(c) {
  if (!c) return;
  document.getElementById('ctlMinScore').value = c.minSelectScore;
  document.getElementById('ctlMaxSelected').value = c.maxSelectedPerQuery;
  document.getElementById('ctlMaxChars').value = c.maxSelectedCharsPerQuery;
  document.getElementById('ctlMaxCandidates').value = c.maxCandidateHitsPerQuery;
  document.getElementById('ctlDictPrimary').value = c.maxEntriesPrimary;
  document.getElementById('ctlDictRel').value = c.maxEntriesRelevance;
  document.getElementById('ctlDictLen').value = c.maxEntriesLength;
  document.getElementById('ctlRequirePlan').checked = !!c.requirePlanConfirm;
  document.getElementById('ctlLocked').checked = !!c.controlsLocked;
  if (c.wikiDefaultLang) document.getElementById('ctlWikiDefault').value = c.wikiDefaultLang;
  if (c.wikiFallbackLang) document.getElementById('ctlWikiFallback').value = c.wikiFallbackLang;
}

function fillWikiLangSelects(langs) {
  for (const id of ['ctlWikiDefault', 'ctlWikiFallback']) {
    const el = document.getElementById(id);
    const cur = el.value;
    el.innerHTML = '';
    for (const lang of (langs || ['zh', 'en'])) {
      const opt = document.createElement('option');
      opt.value = lang;
      opt.textContent = lang;
      el.appendChild(opt);
    }
    if (cur) el.value = cur;
  }
}

function summarizeQuery(q) {
  const parts = [];
  if (q.dict) parts.push('dict:' + (q.dict.dictId || '?') + ' [' + (q.dict.candidates || []).join('/') + ']');
  if (q.grep) parts.push('grep:' + (q.grep.patterns || []).slice(0, 3).join('/'));
  if (q.wikipedia) {
    const terms = (q.wikipedia.searchTerms || q.wikipedia.titles || []).slice(0, 3).join('/');
    parts.push('wiki:' + (q.wikipedia.lang || '') + ' ' + terms);
  }
  if (q.web) parts.push('web:' + (q.web.searchTerms || []).slice(0, 2).join('/'));
  return parts.join(' · ') || '(无来源块)';
}

function renderPlanPanel(plan, round, awaitConfirm) {
  pendingPlan = plan;
  pendingPlanRound = round;
  planPanel.classList.add('visible');
  document.getElementById('planPanelTitle').textContent =
    '本轮规划 · 第 ' + (round + 1) + ' 轮' + (awaitConfirm ? '（待确认）' : '');
  planList.innerHTML = '';
  const queries = (plan && plan.queries) || [];
  if (!queries.length) {
    planList.innerHTML = '<li>（本轮无查询）' + (plan && plan.sufficient ? ' · sufficient' : '') + '</li>';
  }
  for (const q of queries) {
    const li = document.createElement('li');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'plan-q-check';
    cb.value = q.queryId;
    cb.checked = true;
    cb.disabled = !awaitConfirm;
    const body = document.createElement('div');
    body.innerHTML =
      '<div><strong>' + esc(q.queryId) + '</strong> · ' + esc(q.intent) +
      ' · p=' + Number(q.priority || 0).toFixed(2) + '</div>' +
      '<div class="q-meta">' + esc(summarizeQuery(q)) + '</div>';
    li.appendChild(cb);
    li.appendChild(body);
    planList.appendChild(li);
  }
  planJsonEl.textContent = JSON.stringify(plan, null, 2);
  planActions.style.display = awaitConfirm ? 'flex' : 'none';
}

function hidePlanReviewActions() {
  planActions.style.display = 'none';
}

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
  if (btnResume) btnResume.disabled = running;
  btnCancel.disabled = !running;
  runStatus.textContent = running ? '运行中…' : '';
}

function updateExportBarMode() {
  // 导出/合并随「结果来源」；无结果时跟随目标下拉预览
  const displayMode = resultOrigin || (targetModeEl.value === 'json' ? 'json' : 'selection');
  exportBar.className = 'export-bar mode-' + displayMode;
  document.body.classList.toggle('mode-json', targetModeEl.value === 'json');
  if (resultOriginHintEl) {
    if (resultOrigin === 'selection') {
      resultOriginHintEl.textContent = '当前结果：Markdown 选段（可导出 md；校对请到校对面板）';
    } else if (resultOrigin === 'json') {
      resultOriginHintEl.textContent = '当前结果：JSON 条目（可导出 JSON / 勾选后合并到源 JSON；不自动写入）';
    } else {
      resultOriginHintEl.textContent = '选段与 JSON 检索相互独立，请勿混用结果。';
    }
  }
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

function renderHits(hits, groups, groupKind) {
  hitsEl.innerHTML = '';
  const flat = Array.isArray(groups) && groups.length
    ? groups.flatMap(g => g.hits || [])
    : (hits || []);
  if (!flat.length) {
    hitsEl.innerHTML = '<li class="hit-meta" style="display:block">暂无命中</li>';
    updateSelectedCount();
    return;
  }
  const seen = new Set(flat.map(h => h.hitId));
  for (const id of [...checkedByHitId.keys()]) {
    if (!seen.has(id)) checkedByHitId.delete(id);
  }

  function appendHit(h) {
    if (!checkedByHitId.has(h.hitId)) {
      checkedByHitId.set(h.hitId, h.defaultChecked === true);
    }
    const li = document.createElement('li');
    if (h.status === 'pruned') li.className = 'pruned';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'hit-check';
    cb.value = h.hitId;
    cb.dataset.chars = String(h.charCount || 0);
    cb.checked = checkedByHitId.get(h.hitId) === true;
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
      (h.suggestedForExport === false ? ' · 未建议勾选' : '') +
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

  if (Array.isArray(groups) && groups.length) {
    const kind = (groups[0] && groups[0].groupKind) || groupKind || 'selection';
    const unit = (kind === 'target' || kind === 'json') ? '条目' : '选区';
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      const header = document.createElement('li');
      header.className = 'hit-group';
      const title = (g.target || (unit + ' ' + (gi + 1)));
      const short = title.length > 100 ? title.slice(0, 100) + '…' : title;
      header.innerHTML =
        '<div class="hit-group-title">' + unit + ' ' + (gi + 1) + '/' + groups.length + ' · ' + esc(short) + '</div>' +
        '<div class="hit-group-meta">' +
          (g.activeHits != null ? g.activeHits : (g.hits || []).length) + ' 条命中' +
          (g.roundCount != null ? ' · ' + g.roundCount + ' 轮' : '') +
        '</div>';
      hitsEl.appendChild(header);
      for (const h of (g.hits || [])) appendHit(h);
    }
  } else {
    for (const h of flat) appendHit(h);
  }
  const suggested = flat.filter(h => h.defaultChecked === true).length;
  if (suggestHintEl) {
    suggestHintEl.textContent = flat.length
      ? ('建议勾选 ' + suggested + ' / ' + flat.length + '（可按检索控制门槛调整）')
      : '';
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
    targetMode: targetModeEl.value,
    controls: readControlsFromUi()
  });
};
if (btnResume) {
  btnResume.onclick = () => {
    vscode.postMessage({
      command: 'run',
      enabledSources: getEnabledSources(),
      strength: strengthEl.value,
      targetMode: 'json',
      resume: true,
      controls: readControlsFromUi()
    });
  };
}
document.getElementById('btnResetControls').onclick = () => {
  const p = strengthPresets[strengthEl.value];
  if (p) applyControlsToUi({ ...p, controlsLocked: document.getElementById('ctlLocked').checked });
};
strengthEl.addEventListener('change', () => {
  if (document.getElementById('ctlLocked').checked) return;
  const p = strengthPresets[strengthEl.value];
  if (p) applyControlsToUi({ ...p, controlsLocked: false });
});
document.getElementById('btnTogglePlanJson').onclick = () => {
  planJsonEl.style.display = planJsonEl.style.display === 'none' ? 'block' : 'none';
};
function postPlanAction(action) {
  const disabled = Array.from(planList.querySelectorAll('input.plan-q-check:not(:checked)')).map(el => el.value);
  hidePlanReviewActions();
  vscode.postMessage({
    command: 'planConfirm',
    action: action,
    plan: pendingPlan,
    disabledQueryIds: disabled
  });
}
document.getElementById('btnPlanConfirm').onclick = () => postPlanAction('confirm');
document.getElementById('btnPlanSkip').onclick = () => postPlanAction('skip');
document.getElementById('btnPlanCancel').onclick = () => postPlanAction('cancel');
document.querySelectorAll('.panel-footer-commands [data-action="panelRun"]').forEach((el) => {
  el.addEventListener('click', () => btnRun.click());
});
btnCancel.onclick = () => vscode.postMessage({ command: 'cancel' });
document.getElementById('btnReplay').onclick = () => vscode.postMessage({ command: 'replay' });
document.getElementById('btnRefresh').onclick = () => vscode.postMessage({ command: 'refreshState' });
targetModeEl.addEventListener('change', updateExportBarMode);
/** 仅在文档类型变化时自动切换目标模式，避免覆盖用户手动选择 */
let lastDocIsJson = undefined;
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
    if (msg.strengthPresets) strengthPresets = msg.strengthPresets;
    fillWikiLangSelects(msg.wikiLangs);
    if (msg.controls) applyControlsToUi(msg.controls);
    previewEl.value = msg.selectionPreview || (msg.hasSelection ? '' : '（无选区 — 请先在文稿中选中文本，再点「刷新状态」或「开始准备」）');
    targetDocEl.textContent = msg.documentLabel
      ? ('目标：' + msg.documentLabel)
      : '目标：尚未关联编辑器（请先打开文稿）';
    if (typeof msg.isJson === 'boolean' && msg.isJson !== lastDocIsJson) {
      lastDocIsJson = msg.isJson;
      targetModeEl.value = msg.isJson ? 'json' : 'selection';
    }
    updateExportBarMode();
  } else if (msg.type === 'clearTimeline') {
    clearTimeline();
    planPanel.classList.remove('visible');
    hidePlanReviewActions();
  } else if (msg.type === 'clearHits') {
    checkedByHitId.clear();
    hitsEl.innerHTML = '';
    resultOrigin = null;
    if (suggestHintEl) suggestHintEl.textContent = '';
    updateSelectedCount();
    updateExportBarMode();
    if (exportDoneEl) {
      exportDoneEl.style.display = 'none';
      exportDoneEl.textContent = '';
    }
  } else if (msg.type === 'resultOrigin') {
    resultOrigin = msg.origin || null;
    updateExportBarMode();
  } else if (msg.type === 'running') {
    setRunning(!!msg.running);
  } else if (msg.type === 'planReviewUi') {
    renderPlanPanel(msg.plan, msg.round || 0, !!msg.awaitConfirm);
    appendTimeline('plan_review', msg.awaitConfirm ? '等待确认规划' : '已更新规划面板');
  } else if (msg.type === 'event') {
    const e = msg.event;
    if (e.type === 'phase') appendTimeline(e.name, e.message || '');
    else if (e.type === 'plan') {
      appendTimeline('plan R' + (e.round + 1), (e.plan.queries || []).length + ' 个查询');
      renderPlanPanel(e.plan, e.round || 0, false);
    }
    else if (e.type === 'planReview') {
      renderPlanPanel(e.plan, e.round || 0, !!e.awaitConfirm);
      appendTimeline('plan_review', e.awaitConfirm ? '待确认' : '已展示');
    }
    else if (e.type === 'query') appendTimeline('query', e.queryId + ' ' + summarizeQuery(e.detail || {}));
    else if (e.type === 'hits') appendTimeline('hits', '本轮 +' + e.added + '（累计约 ' + e.total + '）');
    else if (e.type === 'error') appendTimeline('error', e.message);
    else if (e.type === 'cancelled') {
      const tip = targetModeEl.value === 'json'
        ? '已取消（可点「继续未完成部分」接着跑）'
        : '已取消（可重放过程文件，或再次开始并选择续跑）';
      appendTimeline('cancelled', tip);
      hidePlanReviewActions();
    }
  } else if (msg.type === 'process') {
    // 新结果到来时按 defaultChecked 重置勾选
    checkedByHitId.clear();
    if (exportDoneEl) {
      exportDoneEl.style.display = 'none';
      exportDoneEl.textContent = '';
    }
    renderHits(msg.hits || [], msg.groups, msg.groupKind);
    const emptyQs = msg.emptyQueries || [];
    if (emptyQs.length && suggestHintEl) {
      const tip = emptyQs.slice(0, 6).map(q => q.queryId + '(' + q.intent + ')').join('、');
      suggestHintEl.textContent =
        (suggestHintEl.textContent ? suggestHintEl.textContent + ' · ' : '') +
        '无命中规划 ' + emptyQs.length + ' 个：' + tip + (emptyQs.length > 6 ? '…' : '');
    }
    if (msg.rounds && msg.rounds.length) {
      const lastRound = msg.rounds[msg.rounds.length - 1];
      if (lastRound && lastRound.plan) {
        renderPlanPanel(lastRound.plan, msg.rounds.length - 1, false);
      }
    }
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
    resultsProvider?: ReferencePrepResultsProvider
): ReferencePrepWebview {
    const webview = new ReferencePrepWebview(context, prepHandler, resultsProvider);
    context.subscriptions.push(
        vscode.commands.registerCommand('ai-proofread.referencePrep.openConsole', () => {
            webview.open();
        })
    );
    return webview;
}
