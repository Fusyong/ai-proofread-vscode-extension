/**
 * 多校次对齐表 → HTML / JSON / CSV
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    classStats,
    multiRowClassLabel,
    type MultiAlignmentRow,
    type MultiAlignmentSource,
    type MultiAlignmentTable,
    type MultiRowClass,
} from './multiAlignmentMerger';

export const MULTI_ALIGNMENT_REPORT_VERSION = 1;

export interface MultiAlignmentReportJson {
    version: typeof MULTI_ALIGNMENT_REPORT_VERSION;
    runtime: number;
    sources: MultiAlignmentSource[];
    rows: MultiAlignmentRow[];
    statistics: {
        total: number;
        byClass: Record<MultiRowClass, number>;
        avgSourceChange: number;
        avgRunAgreement: number;
    };
}

function escapeHtml(text: string): string {
    if (!text) {
        return '';
    }
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function avg(nums: number[]): number {
    if (nums.length === 0) {
        return 1;
    }
    return nums.reduce((s, n) => s + n, 0) / nums.length;
}

export function buildMultiAlignmentReportJson(
    table: MultiAlignmentTable,
    runtime = 0
): MultiAlignmentReportJson {
    const byClass = classStats(table.rows);
    return {
        version: MULTI_ALIGNMENT_REPORT_VERSION,
        runtime,
        sources: table.sources,
        rows: table.rows,
        statistics: {
            total: table.rows.length,
            byClass,
            avgSourceChange: avg(table.rows.map(r => r.sourceChange)),
            avgRunAgreement: avg(table.rows.map(r => r.runAgreement)),
        },
    };
}

function csvEscape(value: string): string {
    if (/[",\r\n]/.test(value)) {
        return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
}

export function formatMultiAlignmentCsv(table: MultiAlignmentTable): string {
    const labels = table.sources.map(s => s.label);
    const header = [
        'index',
        'class',
        'sourceChange',
        'runAgreement',
        'a',
        ...labels.map(l => `b_${l}`),
    ];
    const lines = [header.map(csvEscape).join(',')];
    table.rows.forEach((row, i) => {
        const bCols = table.sources.map(s => {
            const cell = row.cells.find(c => c.sourceId === s.id);
            return cell?.b ?? '';
        });
        lines.push(
            [
                String(i + 1),
                row.class,
                row.sourceChange.toFixed(4),
                row.runAgreement.toFixed(4),
                row.a ?? '',
                ...bCols,
            ]
                .map(csvEscape)
                .join(',')
        );
    });
    return lines.join('\n') + '\n';
}

export function multiAlignmentJsonPath(htmlPath: string): string {
    if (htmlPath.toLowerCase().endsWith('.html')) {
        return htmlPath.slice(0, -'.html'.length) + '.json';
    }
    return `${htmlPath}.json`;
}

export function multiAlignmentCsvPath(htmlPath: string): string {
    if (htmlPath.toLowerCase().endsWith('.html')) {
        return htmlPath.slice(0, -'.html'.length) + '.csv';
    }
    return `${htmlPath}.csv`;
}

/**
 * 生成多校次勘误 HTML，并旁路写入 CSV；JSON 可选（默认写入）。
 */
export function generateMultiAlignmentReport(
    table: MultiAlignmentTable,
    outputHtmlPath: string,
    runtime = 0,
    writeJson = true
): { htmlPath: string; jsonPath: string; csvPath: string } {
    const report = buildMultiAlignmentReportJson(table, runtime);
    const jsonPath = multiAlignmentJsonPath(outputHtmlPath);
    const csvPath = multiAlignmentCsvPath(outputHtmlPath);

    fs.mkdirSync(path.dirname(outputHtmlPath), { recursive: true });
    if (writeJson) {
        fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
    }
    fs.writeFileSync(csvPath, formatMultiAlignmentCsv(table), 'utf8');
    fs.writeFileSync(outputHtmlPath, buildMultiAlignmentHtml(report), 'utf8');

    return { htmlPath: outputHtmlPath, jsonPath, csvPath };
}

function buildMultiAlignmentHtml(report: MultiAlignmentReportJson): string {
    const sources = report.sources;
    const dataJson = JSON.stringify(report).replace(/</g, '\\u003c');

    const classButtons: MultiRowClass[] = [
        'all_identical',
        'runs_consensus',
        'majority',
        'divergent',
        'structural',
    ];

    const thRuns = sources
        .map(
            (s, i) =>
                `<th class="col-run" data-source-id="${escapeHtml(s.id)}" data-source-idx="${i}">${escapeHtml(s.label)}</th>`
        )
        .join('\n');

    const hideChecks = sources
        .map(
            s =>
                `<label class="run-toggle"><input type="checkbox" class="run-visible" data-source-id="${escapeHtml(s.id)}" checked> ${escapeHtml(s.label)}</label>`
        )
        .join('\n');

    const classFilters = classButtons
        .map(c => {
            const active = c === 'all_identical' ? '' : ' active';
            return `<button type="button" class="filter-btn class-btn${active}" data-class="${c}" onclick="toggleClassFilter('${c}')">${multiRowClassLabel(c)}</button>`;
        })
        .join('\n');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>多校次句子对齐（加工记录/勘误表）</title>
<style>
:root {
    --bg: #f7f6f3;
    --panel: #fff;
    --border: #d8d4cc;
    --text: #1f1c18;
    --muted: #6b6560;
    --accent: #2f5d50;
    --del: #c44;
    --ins: #2a7;
    --structural: #eee8df;
    --identical: #eef5ef;
    --consensus: #e8f0fa;
    --majority: #faf3e0;
    --divergent: #f8e8e6;
}
* { box-sizing: border-box; }
body {
    margin: 0;
    font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    background: linear-gradient(165deg, #f3f1eb 0%, #e8eee9 45%, #f7f6f3 100%);
    color: var(--text);
}
.wrap { max-width: 100%; padding: 10px 14px 40px; }
h1 { font-size: 1.2rem; margin: 0 0 2px; font-weight: 650; }
.sub { color: var(--muted); font-size: 0.82rem; margin-bottom: 8px; }
.toolbar {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 6px 10px;
    margin-bottom: 6px;
    display: flex;
    flex-direction: column;
    gap: 4px;
}
.toolbar-row { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; }
.toolbar-row label { font-size: 0.8rem; color: var(--muted); white-space: nowrap; }
.sep { width: 1px; height: 1.1em; background: var(--border); margin: 0 2px; }
.filter-btn, .mode-btn {
    border: 1px solid var(--border);
    background: #faf9f6;
    border-radius: 4px;
    padding: 2px 8px;
    cursor: pointer;
    font-size: 0.8rem;
}
.filter-btn.active, .mode-btn.active {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
}
.run-toggle { margin-right: 4px; font-size: 0.8rem; }
.apply-index-filter { display: inline-flex; align-items: center; gap: 3px; font-size: 0.8rem; color: var(--muted); }
.stats {
    font-size: 0.8rem;
    color: var(--muted);
    margin-bottom: 6px;
}
.table-scroll { overflow: auto; max-height: calc(100vh - 180px); border: 1px solid var(--border); border-radius: 6px; background: var(--panel); }
table.multi-align {
    border-collapse: collapse;
    width: max-content;
    min-width: 100%;
    table-layout: fixed;
    font-size: 0.88rem;
}
table.multi-align th, table.multi-align td {
    border-bottom: 1px solid var(--border);
    padding: 8px 10px;
    vertical-align: top;
    word-break: break-word;
}
table.multi-align thead th {
    position: sticky;
    top: 0;
    background: #f0efe9;
    z-index: 2;
    font-weight: 600;
}
.col-index { width: 52px; }
.col-class { width: 88px; }
.col-metric { width: 72px; }
.col-a, .col-run { width: 280px; min-width: 200px; }
tr.hidden-row { display: none; }
th.hidden-col, td.hidden-col { display: none; }
tr.class-all_identical { background: var(--identical); }
tr.class-runs_consensus { background: var(--consensus); }
tr.class-majority { background: var(--majority); }
tr.class-divergent { background: var(--divergent); }
tr.class-structural { background: var(--structural); }
.badge {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 0.75rem;
    background: rgba(0,0,0,0.06);
}
del.diff { background: #fdd; text-decoration: none; color: var(--del); }
ins.diff { background: #dfd; text-decoration: none; color: var(--ins); }
.span-cont { opacity: 0.55; font-style: italic; }
.metric { font-variant-numeric: tabular-nums; }
input[type="number"], input[type="search"], input[type="text"].index-filter {
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 2px 6px;
    width: 64px;
    font-size: 0.8rem;
}
input[type="search"] { width: 160px; }
input[type="text"].index-filter { width: 140px; }
</style>
</head>
<body>
<div class="wrap">
    <h1>多校次句子对齐（加工记录/勘误表）</h1>
    <div class="sub">共 ${report.statistics.total} 行 · 耗时 ${report.runtime.toFixed(2)}s</div>
    <div class="toolbar">
        <div class="toolbar-row">
            <label>显示校次</label>
            ${hideChecks}
        </div>
        <div class="toolbar-row">
            <label>Diff</label>
            <button type="button" class="mode-btn active" data-mode="vsSource" onclick="setDiffMode('vsSource')">原文 ↔ 各校次</button>
            <button type="button" class="mode-btn" data-mode="vsAdjacent" onclick="setDiffMode('vsAdjacent')">相邻</button>
            <span class="sep"></span>
            <label>分类</label>
            ${classFilters}
        </div>
        <div class="toolbar-row">
            <label>源变 ≥</label>
            <input type="number" id="minSourceChange" min="0" max="1" step="0.05" value="0" oninput="applyFilters()">
            <label>校同 ≤</label>
            <input type="number" id="maxRunAgreement" min="0" max="1" step="0.05" value="1" oninput="applyFilters()">
            <label>序号</label>
            <input type="text" class="index-filter" id="indexFilter" placeholder="如: 1,2,5-20,80-" oninput="applyFilters()" title="支持: 1,2,5-20,80-">
            <label class="apply-index-filter" title="取消勾选后保留序号内容，但不做序号筛选">
                <input type="checkbox" id="applyIndexFilter" checked onchange="applyFilters()">
                <span>应用</span>
            </label>
            <label>搜索</label>
            <input type="search" id="searchText" placeholder="原文或校次文本…" oninput="applyFilters()">
            <button type="button" class="filter-btn" onclick="resetFilters()">重置</button>
        </div>
    </div>
    <div class="stats" id="filterStats"></div>
    <div class="table-scroll">
        <table class="multi-align" id="multiTable">
            <thead>
                <tr>
                    <th class="col-index">序号</th>
                    <th class="col-class">分类</th>
                    <th class="col-metric">源变</th>
                    <th class="col-metric">校同</th>
                    <th class="col-a">原文</th>
                    ${thRuns}
                </tr>
            </thead>
            <tbody id="tableBody"></tbody>
        </table>
    </div>
</div>
<script src="https://cdn.jsdelivr.net/npm/diff@7.0.0/dist/diff.min.js"></script>
<script>
const REPORT = ${dataJson};
const CLASS_LABELS = {
    all_identical: '全文一致',
    runs_consensus: '校次一致',
    majority: '多数一致',
    divergent: '校次分歧',
    structural: '结构空缺'
};

let diffMode = 'vsSource';
let classEnabled = {
    all_identical: false,
    runs_consensus: true,
    majority: true,
    divergent: true,
    structural: true
};

function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function normText(t) {
    return String(t || '').trim().replace(/\\s/g, '');
}

function jaccardChar(a, b, n) {
    a = normText(a); b = normText(b);
    if (!a && !b) return 1;
    if (!a || !b) return 0;
    if (a === b) return 1;
    n = Math.max(1, n || 2);
    function grams(s) {
        const set = new Set();
        if (s.length < n) { set.add(s); return set; }
        for (let i = 0; i <= s.length - n; i++) set.add(s.slice(i, i + n));
        return set;
    }
    const A = grams(a), B = grams(b);
    let inter = 0;
    A.forEach(g => { if (B.has(g)) inter++; });
    const uni = A.size + B.size - inter;
    return uni === 0 ? 0 : inter / uni;
}

function visibleSourceIds() {
    return Array.from(document.querySelectorAll('.run-visible:checked')).map(el => el.dataset.sourceId);
}

function classifyRow(row, ids) {
    if (!ids.length) return { class: 'structural', sourceChange: 1, runAgreement: 1 };
    const bs = ids.map(id => {
        const cell = (row.cells || []).find(c => c.sourceId === id);
        if (!cell || cell.b === undefined || cell.b === null) return null;
        return cell.b;
    });
    if (bs.some(b => b === null)) {
        const present = bs.filter(b => b !== null);
        return {
            class: 'structural',
            sourceChange: avg(bs.map(b => b === null ? 0 : jaccardChar(row.a, b))),
            runAgreement: pairwiseAvg(present, jaccardChar)
        };
    }
    const norms = bs.map(normText);
    const aNorm = normText(row.a);
    const sourceChange = avg(bs.map(b => jaccardChar(row.a, b)));
    const runAgreement = pairwiseAvg(bs, jaccardChar);
    if (norms.every(n => n === aNorm)) return { class: 'all_identical', sourceChange, runAgreement };
    if (norms.length && norms.every(n => n === norms[0])) return { class: 'runs_consensus', sourceChange, runAgreement };
    const counts = {};
    norms.forEach(n => { counts[n] = (counts[n] || 0) + 1; });
    let best = '', bestCount = 0;
    Object.keys(counts).forEach(n => { if (counts[n] > bestCount) { bestCount = counts[n]; best = n; } });
    const need = Math.floor(norms.length / 2) + 1;
    if (bestCount >= need && bestCount < norms.length && best !== aNorm) {
        return { class: 'majority', sourceChange, runAgreement };
    }
    return { class: 'divergent', sourceChange, runAgreement };
}

function avg(xs) {
    if (!xs.length) return 1;
    return xs.reduce((s, x) => s + x, 0) / xs.length;
}
function pairwiseAvg(items, sim) {
    if (items.length <= 1) return 1;
    const scores = [];
    for (let i = 0; i < items.length; i++)
        for (let j = i + 1; j < items.length; j++)
            scores.push(sim(items[i], items[j]));
    return avg(scores);
}

let segmenter = null;
try {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
        segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
    }
} catch (e) {}

function wordDiffHtml(left, right) {
    left = left || ''; right = right || '';
    if (typeof Diff === 'undefined') {
        return escapeHtml(right || left);
    }
    const parts = segmenter
        ? Diff.diffWordsWithSpace(left, right, segmenter)
        : Diff.diffWords(left, right);
    return parts.map(p => {
        const v = escapeHtml(p.value);
        if (p.added) return '<ins class="diff">' + v + '</ins>';
        if (p.removed) return '<del class="diff">' + v + '</del>';
        return v;
    }).join('');
}

function cellB(row, sourceId) {
    const cell = (row.cells || []).find(c => c.sourceId === sourceId);
    return cell ? (cell.b || '') : '';
}
function cellSpan(row, sourceId) {
    const cell = (row.cells || []).find(c => c.sourceId === sourceId);
    return cell && cell.span === 'cont' ? 'cont' : 'start';
}

function renderBody() {
    const ids = visibleSourceIds();
    const tbody = document.getElementById('tableBody');
    const sources = REPORT.sources;
    let html = '';
    REPORT.rows.forEach((row, idx) => {
        const c = classifyRow(row, ids);
        row._class = c.class;
        row._sourceChange = c.sourceChange;
        row._runAgreement = c.runAgreement;
        const aHtml = escapeHtml(row.a || '');
        let runCells = '';
        sources.forEach((s) => {
            const b = cellB(row, s.id);
            const spanCls = cellSpan(row, s.id) === 'cont' ? ' span-cont' : '';
            let inner;
            if (diffMode === 'vsSource') {
                inner = wordDiffHtml(row.a || '', b);
            } else {
                const vis = ids;
                const pos = vis.indexOf(s.id);
                if (pos < 0) {
                    inner = escapeHtml(b);
                } else if (pos === 0) {
                    inner = wordDiffHtml(row.a || '', b);
                } else {
                    inner = wordDiffHtml(cellB(row, vis[pos - 1]), b);
                }
            }
            runCells += '<td class="col-run' + spanCls + '" data-source-id="' + escapeHtml(s.id) + '">' + inner + '</td>';
        });
        html += '<tr class="class-' + c.class + '" data-row-idx="' + (idx + 1) + '"'
            + ' data-class="' + c.class + '"'
            + ' data-source-change="' + c.sourceChange.toFixed(4) + '"'
            + ' data-run-agreement="' + c.runAgreement.toFixed(4) + '"'
            + ' data-text="' + escapeHtml((row.a || '') + ' ' + sources.map(s => cellB(row, s.id)).join(' ')) + '">'
            + '<td class="col-index">' + (idx + 1) + '</td>'
            + '<td class="col-class"><span class="badge">' + CLASS_LABELS[c.class] + '</span></td>'
            + '<td class="col-metric metric">' + c.sourceChange.toFixed(2) + '</td>'
            + '<td class="col-metric metric">' + c.runAgreement.toFixed(2) + '</td>'
            + '<td class="col-a">' + aHtml + '</td>'
            + runCells
            + '</tr>';
    });
    tbody.innerHTML = html;
    updateColumnVisibility();
    applyFilters();
}

function updateColumnVisibility() {
    const visible = new Set(visibleSourceIds());
    document.querySelectorAll('th.col-run, td.col-run').forEach(el => {
        const id = el.dataset.sourceId;
        if (visible.has(id)) el.classList.remove('hidden-col');
        else el.classList.add('hidden-col');
    });
}

function setDiffMode(mode) {
    diffMode = mode;
    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });
    renderBody();
}

function toggleClassFilter(cls) {
    classEnabled[cls] = !classEnabled[cls];
    document.querySelectorAll('.class-btn[data-class="' + cls + '"]').forEach(btn => {
        btn.classList.toggle('active', classEnabled[cls]);
    });
    applyFilters();
}

function parseIndexFilter(filterText, maxRowIndex) {
    if (!filterText || !filterText.trim()) return null;
    const allowedIndices = new Set();
    const normalized = filterText.replace(/，/g, ',').replace(/\\s+/g, '');
    if (!normalized) return null;
    const parts = normalized.split(',');
    for (const part of parts) {
        if (!part) continue;
        if (part.includes('-')) {
            const rangeParts = part.split('-');
            if (rangeParts.length === 2) {
                const start = rangeParts[0] ? parseInt(rangeParts[0], 10) : null;
                const end = rangeParts[1] ? parseInt(rangeParts[1], 10) : null;
                if (start !== null && !isNaN(start)) {
                    if (end !== null && !isNaN(end)) {
                        for (let i = start; i <= end && i <= maxRowIndex; i++) {
                            if (i >= 1) allowedIndices.add(i);
                        }
                    } else {
                        for (let i = start; i <= maxRowIndex; i++) {
                            if (i >= 1) allowedIndices.add(i);
                        }
                    }
                }
            }
        } else {
            const num = parseInt(part, 10);
            if (!isNaN(num) && num >= 1 && num <= maxRowIndex) allowedIndices.add(num);
        }
    }
    return allowedIndices.size > 0 ? allowedIndices : null;
}

function applyFilters() {
    const minSC = parseFloat(document.getElementById('minSourceChange').value) || 0;
    const maxRA = parseFloat(document.getElementById('maxRunAgreement').value);
    const maxRun = isNaN(maxRA) ? 1 : maxRA;
    const q = (document.getElementById('searchText').value || '').trim().toLowerCase();
    const rows = document.querySelectorAll('#tableBody tr');
    const maxRowIndex = rows.length;
    const indexFilterText = document.getElementById('indexFilter').value.trim();
    const applyIndex = document.getElementById('applyIndexFilter').checked;
    const allowedIndices = (applyIndex && indexFilterText)
        ? parseIndexFilter(indexFilterText, maxRowIndex)
        : null;
    let shown = 0;
    const counts = { all_identical: 0, runs_consensus: 0, majority: 0, divergent: 0, structural: 0 };
    let sumSC = 0, sumRA = 0;
    rows.forEach(tr => {
        const cls = tr.dataset.class;
        const sc = parseFloat(tr.dataset.sourceChange) || 0;
        const ra = parseFloat(tr.dataset.runAgreement) || 0;
        const text = (tr.dataset.text || '').toLowerCase();
        const rowIdx = parseInt(tr.dataset.rowIdx, 10);
        let ok = classEnabled[cls] !== false;
        if (sc < minSC) ok = false;
        if (ra > maxRun) ok = false;
        if (q && text.indexOf(q) < 0) ok = false;
        if (allowedIndices && !allowedIndices.has(rowIdx)) ok = false;
        tr.classList.toggle('hidden-row', !ok);
        if (ok) {
            shown++;
            counts[cls]++;
            sumSC += sc;
            sumRA += ra;
        }
    });
    const avgSC = shown ? (sumSC / shown).toFixed(3) : '—';
    const avgRA = shown ? (sumRA / shown).toFixed(3) : '—';
    document.getElementById('filterStats').textContent =
        '显示 ' + shown + ' / ' + REPORT.rows.length
        + ' · 全文一致 ' + counts.all_identical
        + ' · 校次一致 ' + counts.runs_consensus
        + ' · 多数 ' + counts.majority
        + ' · 分歧 ' + counts.divergent
        + ' · 空缺 ' + counts.structural
        + ' · 均源变 ' + avgSC
        + ' · 均校同 ' + avgRA;
}

function resetFilters() {
    classEnabled = {
        all_identical: false,
        runs_consensus: true,
        majority: true,
        divergent: true,
        structural: true
    };
    document.querySelectorAll('.class-btn').forEach(btn => {
        btn.classList.toggle('active', classEnabled[btn.dataset.class]);
    });
    document.getElementById('minSourceChange').value = '0';
    document.getElementById('maxRunAgreement').value = '1';
    document.getElementById('indexFilter').value = '';
    document.getElementById('applyIndexFilter').checked = true;
    document.getElementById('searchText').value = '';
    document.querySelectorAll('.run-visible').forEach(el => { el.checked = true; });
    renderBody();
}

document.querySelectorAll('.run-visible').forEach(el => {
    el.addEventListener('change', () => renderBody());
});

renderBody();
</script>
</body>
</html>`;
}
