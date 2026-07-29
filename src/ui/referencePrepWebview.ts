/**
 * 参考资料复合查询控制台：配置来源、执行选段/JSON 准备、展示 LLM 规划过程与命中结果。
 */

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

const PANEL_ID = 'ai-proofread.referencePrepConsole';
const PANEL_TITLE = '参考资料检索';

export class ReferencePrepWebview {
    private panel: vscode.WebviewPanel | undefined;
    private cancelSource: vscode.CancellationTokenSource | undefined;
    private lastAnchorPath: string | undefined;
    private lastProcess: ReferencePrepProcessFileV020 | undefined;

    constructor(
        private context: vscode.ExtensionContext,
        private prepHandler: ReferencePrepCommandHandler,
        private resultsProvider?: ReferencePrepResultsProvider
    ) {}

    open(): void {
        if (this.panel) {
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
        this.panel.webview.onDidReceiveMessage(
            (msg) => this.handleMessage(msg),
            undefined,
            this.context.subscriptions
        );
        this.panel.onDidDispose(
            () => {
                this.panel = undefined;
                this.cancelSource?.cancel();
                this.cancelSource = undefined;
            },
            undefined,
            this.context.subscriptions
        );
        this.postState();
    }

    private post(message: Record<string, unknown>): void {
        void this.panel?.webview.postMessage(message);
    }

    private postState(): void {
        const last = loadReferencePrepLastRun(this.context);
        const defaults = getDefaultEnabledSources();
        const enabledSources =
            last.enabledSources.length > 0 ? last.enabledSources : defaults;
        const editor = vscode.window.activeTextEditor;
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
        const hits = process.corpus.map((h) => this.serializeHit(h));
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
        return {
            hitId: h.hitId,
            source: h.source,
            status: h.status,
            snippet: h.snippet?.slice(0, 240) ?? '',
            refTag: h.refTag,
            file: h.relPath ?? h.file,
            line: h.startLine ?? h.line,
            pageUrl: h.pageUrl,
            pageTitle: h.pageTitle,
            canOpenEditor: canOpenHitInEditor(h),
            canOpenBrowser: canOpenHitInBrowser(h),
            referenceBlock: h.referenceBlock,
            pruneReason: h.pruneReason,
        };
    }

    private async handleMessage(msg: {
        command?: string;
        enabledSources?: ReferenceSourceId[];
        strength?: ReferencePrepStrength;
        targetMode?: 'selection' | 'json';
        hitId?: string;
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
            case 'pruneHit':
                if (msg.hitId && this.resultsProvider) {
                    const hit = this.findHit(msg.hitId);
                    if (hit) this.resultsProvider.pruneHit(hit);
                    if (this.lastAnchorPath) {
                        const proc = loadProcessFile(this.lastAnchorPath);
                        if (proc) {
                            this.lastProcess = proc;
                            this.postProcess(proc, this.lastAnchorPath);
                        }
                    }
                }
                break;
            case 'restoreHit':
                if (msg.hitId && this.resultsProvider) {
                    const hit = this.findHit(msg.hitId);
                    if (hit) this.resultsProvider.restoreHit(hit);
                    if (this.lastAnchorPath) {
                        const proc = loadProcessFile(this.lastAnchorPath);
                        if (proc) {
                            this.lastProcess = proc;
                            this.postProcess(proc, this.lastAnchorPath);
                        }
                    }
                }
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
            case 'run':
                await this.runPrep(msg);
                break;
            default:
                break;
        }
    }

    private findHit(hitId?: string): CorpusHit | undefined {
        if (!hitId || !this.lastProcess) return undefined;
        return this.lastProcess.corpus.find((h) => h.hitId === hitId);
    }

    private async replayFromAnchor(anchorPath?: string): Promise<void> {
        const editor = vscode.window.activeTextEditor;
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
        await vscode.commands.executeCommand('setContext', 'aiProofread.showReferencePrepResultsView', true);
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

        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('请先打开编辑器。');
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
                    openMergedPreview: true,
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
}
#hits li.pruned { opacity: 0.55; }
.hit-meta { font-size: 0.9em; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
.hit-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.hit-actions button { padding: 2px 8px; font-size: 0.9em; }
.status { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-left: 8px; }
.warn { color: var(--vscode-errorForeground); }
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
  <button id="btnRun">开始准备</button>
  <button class="secondary" id="btnCancel" disabled>取消</button>
  <button class="secondary" id="btnReplay">重放过程文件</button>
  <button class="secondary" id="btnRefresh">刷新状态</button>
  <span class="status" id="runStatus"></span>
</div>

<h2>过程</h2>
<div id="timeline"><div class="tl-item"><span class="tag">就绪</span>选择来源后点击「开始准备」</div></div>

<h2>结果</h2>
<ul id="hits"></ul>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const sourcesEl = document.getElementById('sources');
const strengthEl = document.getElementById('strength');
const targetModeEl = document.getElementById('targetMode');
const previewEl = document.getElementById('selectionPreview');
const timelineEl = document.getElementById('timeline');
const hitsEl = document.getElementById('hits');
const runStatus = document.getElementById('runStatus');
const btnRun = document.getElementById('btnRun');
const btnCancel = document.getElementById('btnCancel');

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
    hitsEl.innerHTML = '<li class="hit-meta">暂无命中</li>';
    return;
  }
  for (const h of hits) {
    const li = document.createElement('li');
    if (h.status === 'pruned') li.className = 'pruned';
    li.innerHTML =
      '<div class="hit-meta">' + esc(h.source) +
      (h.refTag ? ' · ' + esc(h.refTag) : '') +
      (h.file ? ' · ' + esc(h.file) + (h.line != null ? ':' + h.line : '') : '') +
      (h.pageTitle ? ' · ' + esc(h.pageTitle) : '') +
      ' · ' + esc(h.status) + '</div>' +
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
    const prune = document.createElement('button');
    prune.className = 'secondary';
    prune.textContent = h.status === 'pruned' ? '恢复' : '丢弃';
    prune.onclick = () => vscode.postMessage({
      command: h.status === 'pruned' ? 'restoreHit' : 'pruneHit',
      hitId: h.hitId
    });
    actions.appendChild(prune);
    li.appendChild(actions);
    hitsEl.appendChild(li);
  }
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

window.addEventListener('message', (ev) => {
  const msg = ev.data;
  if (msg.type === 'state') {
    renderSources(msg.sources || [], msg.enabledSources || []);
    if (msg.strength) strengthEl.value = msg.strength;
    previewEl.value = msg.selectionPreview || (msg.hasSelection ? '' : '（无选区）');
    if (msg.isJson) targetModeEl.value = targetModeEl.value;
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
    renderHits(msg.hits || []);
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
