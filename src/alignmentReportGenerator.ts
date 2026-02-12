/**
 * 对齐报告生成器
 */

import * as fs from 'fs';
import * as path from 'path';
import { AlignmentItem, AlignmentOptions } from './sentenceAligner';
import { getAlignmentStatistics } from './sentenceAligner';

/**
 * HTML转义函数
 */
function escapeHtml(text: string): string {
    if (!text) return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * 生成HTML格式的对齐报告
 * @param alignment 对齐结果列表
 * @param outputPath 输出文件路径
 * @param titleA 原文文件名
 * @param titleB 校对后文件名
 * @param options 对齐参数
 * @param runtime 运行时间（秒）
 */
export function generateHtmlReport(
    alignment: AlignmentItem[],
    outputPath: string,
    titleA: string = '',
    titleB: string = '',
    options: AlignmentOptions = {},
    runtime: number = 0
): void {
    // 如果文件名为空，使用默认值
    if (!titleA) titleA = '原文';
    if (!titleB) titleB = '校对后';

    const threshold = options.similarityThreshold || 0.6;
    const ngramSize = options.ngramSize ?? 1;
    const algorithmName = '锚点算法';

    // 获取统计信息
    const stats = getAlignmentStatistics(alignment);

    const htmlLines: string[] = [];

    // HTML头部
    htmlLines.push(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>句子对齐报告（勘误表）</title>
    <style>
        body {
            font-family: "SimSun", "宋体", serif;
            font-size: 14px;
            line-height: 1.6;
            max-width: 1400px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f5f5f5;
        }
        .header {
            background-color: #2c3e50;
            color: white;
            padding: 20px;
            border-radius: 5px;
            margin-bottom: 20px;
        }
        .alignment-results {
            background-color: white;
            padding: 15px;
            border-radius: 5px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            overflow-x: auto;
        }
        .alignment-table {
            width: 100%;
            table-layout: fixed;
            border-collapse: collapse;
            margin-top: 10px;
        }
        .alignment-table th {
            background-color: #3498db;
            color: white;
            padding: 10px;
            text-align: left;
            border: 1px solid #2980b9;
            vertical-align: middle;
        }
        .alignment-table td {
            padding: 10px;
            border: 1px solid #ddd;
            vertical-align: top;
        }
        .alignment-table tr:nth-child(even) {
            background-color: #f9f9f9;
        }
        .alignment-table tr:hover {
            background-color: #f0f0f0;
        }
        .alignment-table tr.match {
            /* 完全匹配（相似度=1）不使用背景色和border-left */
        }
        .alignment-table tr.match.partial-match {
            /* 部分匹配使用黄色border-left */
            border-left: 4px solid #f39c12;
            background-color: inherit;
        }
        .alignment-table tr.match.partial-match:hover {
            /* 部分匹配悬停时使用浅黄色背景 */
            background-color: rgba(243, 156, 18, 0.3);
        }
        .alignment-table tr.movein {
            border-left: 4px solid #3498db;
        }
        .alignment-table tr.movein:hover {
            /* movein悬停时使用浅蓝色背景 */
            background-color: rgba(52, 152, 219, 0.3);
        }
        .alignment-table tr.moveout {
            border-left: 4px solid #9b59b6;
        }
        .alignment-table tr.moveout:hover {
            /* moveout悬停时使用浅紫色背景 */
            background-color: rgba(155, 89, 182, 0.3);
        }
        .alignment-table tr.delete {
            border-left: 4px solid #e74c3c;
        }
        .alignment-table tr.delete:hover {
            /* delete悬停时使用浅红色背景 */
            background-color: rgba(231, 76, 60, 0.3);
        }
        .alignment-table tr.insert {
            border-left: 4px solid #27ae60;
        }
        .alignment-table tr.insert:hover {
            /* insert悬停时使用浅绿色背景 */
            background-color: rgba(39, 174, 96, 0.3);
        }
        .col-index {
            width: 5%;
            text-align: center;
            font-weight: bold;
        }
        .col-type {
            width: 5%;
            font-weight: bold;
        }
        .col-similarity {
            width: 5%;
            text-align: center;
        }
        .col-remark {
            width: 18%;
            min-width: 150px;
            padding: 4px;
        }
        .alignment-table tbody td.col-remark {
            vertical-align: top;
        }
        .remark-input {
            display: block;
            width: 100%;
            min-width: 80px;
            min-height: 2em;
            margin: 0;
            padding: 4px 6px;
            border: 1px solid #bdc3c7;
            border-radius: 4px;
            font-size: 12px;
            font-family: inherit;
            box-sizing: border-box;
            resize: none;
            overflow: hidden;
            white-space: pre-wrap;
            word-wrap: break-word;
        }
        .col-sentence-a,
        .col-sentence-b {
            width: 42.5%;
            word-break: break-all;
            overflow-wrap: anywhere;
            min-width: 0;
        }
        .item-header {
            font-weight: bold;
        }
        .similarity {
            font-size: 12px;
            color: #7f8c8d;
        }
        .sentence-a {
            color: black;
        }
        .sentence-b {
            color: black;
        }
        .index {
            font-size: 12px;
            color: #95a5a6;
            margin-right: 8px;
            font-weight: normal;
        }
        .filter-controls {
            background-color: #ecf0f1;
            padding: 12px 15px;
            border-radius: 5px;
            margin-bottom: 15px;
            border: 1px solid #bdc3c7;
            display: flex;
            flex-direction: column;
            gap: 12px;
        }
        .filter-row {
            display: flex;
            gap: 15px;
            align-items: center;
            flex-wrap: nowrap;
            overflow-x: auto;
        }
        .filter-group {
            display: flex;
            align-items: center;
            gap: 8px;
            flex: 0 0 auto;
            white-space: nowrap;
        }
        .filter-label {
            font-weight: bold;
            margin: 0;
            display: inline-block;
            color: #2c3e50;
            font-size: 13px;
            white-space: nowrap;
        }
        .filter-buttons {
            display: flex;
            gap: 6px;
            flex-wrap: nowrap;
        }
        .filter-btn {
            padding: 5px 10px;
            border: 2px solid #3498db;
            background-color: white;
            color: #3498db;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            transition: all 0.2s;
            white-space: nowrap;
        }
        .filter-btn:hover {
            background-color: #e8f4f8;
        }
        .filter-btn.active {
            background-color: #3498db;
            color: white;
        }
        .filter-input-group {
            display: flex;
            gap: 6px;
            align-items: center;
            white-space: nowrap;
        }
        .filter-input {
            padding: 5px 8px;
            border: 1px solid #bdc3c7;
            border-radius: 4px;
            font-size: 12px;
            width: 40px;
        }
        .filter-search {
            padding: 5px 10px;
            border: 1px solid #bdc3c7;
            border-radius: 4px;
            font-size: 12px;
        }
        .filter-search.index-filter {
            flex: 1;
            min-width: 200px;
        }
        .filter-reset {
            padding: 5px 12px;
            background-color: #e74c3c;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            white-space: nowrap;
        }
        .filter-reset:hover {
            background-color: #c0392b;
        }
        .filter-stats {
            font-size: 13px;
            color: #7f8c8d;
            margin-top: 10px;
            margin-bottom: 10px;
        }
        .alignment-table tr.hidden {
            display: none;
        }
        .alignment-table th.hidden,
        .alignment-table td.hidden {
            display: none;
        }
        @media print {
            body.print-no-repeat-header .alignment-table thead {
                display: table-row-group;
            }
        }
        .print-option {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .print-option input[type="checkbox"] {
            cursor: pointer;
        }
        .stats-summary {
            background-color: #ecf0f1;
            padding: 15px;
            border-radius: 5px;
            margin-bottom: 20px;
            border: 1px solid #bdc3c7;
        }
        .stats-summary h3 {
            margin-top: 0;
            margin-bottom: 10px;
            color: #2c3e50;
            font-size: 16px;
        }
        .stats-grid {
            display: flex;
            flex-direction: row;
            flex-wrap: nowrap;
            gap: 20px;
            align-items: center;
            justify-content: flex-start;
            overflow-x: auto;
        }
        .stat-item {
            text-align: center;
            flex: 0 0 auto;
            white-space: nowrap;
        }
        .stat-value {
            font-size: 24px;
            font-weight: bold;
            color: #3498db;
            line-height: 1.2;
        }
        .stat-label {
            font-size: 12px;
            color: #7f8c8d;
            margin-top: 4px;
        }
    </style>
    <script src="https://cdn.jsdelivr.net/npm/diff@7.0.0/dist/diff.min.js"></script>
</head>
<body>
    <div class="header">
        <h1>句子对齐（勘误表）</h1>
        <p>对齐文件 ${escapeHtml(titleA)} 和 ${escapeHtml(titleB)}</p>
        <p style="font-size: 13px; margin-top: 10px; opacity: 0.9;">
            相似度算法: ${algorithmName} | 阈值: ${threshold.toFixed(2)} | N-gram大小: ${ngramSize} | 运行时间: ${runtime.toFixed(2)}秒
        </p>
        <p style="font-size: 13px; margin-top: 8px; opacity: 0.9;">
            统计信息: MATCH ${stats.match} | DELETE ${stats.delete} | INSERT ${stats.insert} | MOVEIN ${stats.movein} | MOVEOUT ${stats.moveout} | 总计 ${stats.total}
        </p>
    </div>
    <div class="alignment-results">
        <div class="filter-controls">
            <div class="filter-row">
                <div class="filter-group">
                    <label class="filter-label">类型：</label>
                    <div class="filter-buttons">
                        <button class="filter-btn active" data-type="all" onclick="filterByType('all')">全部</button>
                        <button class="filter-btn active" data-type="match" onclick="filterByType('match')">MATCH</button>
                        <button class="filter-btn active" data-type="movein" onclick="filterByType('movein')">MOVEIN</button>
                        <button class="filter-btn active" data-type="moveout" onclick="filterByType('moveout')">MOVEOUT</button>
                        <button class="filter-btn active" data-type="delete" onclick="filterByType('delete')">DELETE</button>
                        <button class="filter-btn active" data-type="insert" onclick="filterByType('insert')">INSERT</button>
                    </div>
                </div>
                <div class="filter-group">
                    <label class="filter-label">列显示：</label>
                    <div class="filter-buttons">
                        <button class="filter-btn active" data-col="type" onclick="toggleColumn('type')">类型</button>
                        <button class="filter-btn active" data-col="similarity" onclick="toggleColumn('similarity')">相似度</button>
                        <button class="filter-btn" data-col="remark" onclick="toggleColumn('remark')">备注</button>
                    </div>
                </div>
                <div class="filter-group">
                    <label class="filter-label">相似度：</label>
                    <div class="filter-input-group">
                        <input type="number" class="filter-input" id="minSimilarity" placeholder="最小" min="0" max="1" step="0.01" oninput="applyFiltersIfDefined()">
                        <span>至</span>
                        <input type="number" class="filter-input" id="maxSimilarity" placeholder="最大" min="0" max="1" step="0.01" oninput="applyFiltersIfDefined()">
                    </div>
                </div>
                <div class="filter-group print-option">
                    <label class="print-option" title="打印或导出为 PDF 时，表头是否在每一页重复显示">
                        <input type="checkbox" id="printRepeatHeader" checked onchange="togglePrintRepeatHeader()">
                        <span>分页加表头</span>
                    </label>
                </div>
            </div>
            <div class="filter-row">
                <div class="filter-group" style="flex: 1;">
                    <label class="filter-label">序号：</label>
                    <input type="text" class="filter-search index-filter" id="indexFilter" placeholder="如: 1,2,5-20,80-" oninput="applyFiltersIfDefined()" title="支持格式: 1,2,5-20,80- (注意：筛选条件无法保存)">
                </div>
                <div class="filter-group" style="flex: 1;">
                    <label class="filter-label">搜索：</label>
                    <div class="filter-input-group" style="flex: 1;">
                        <input type="text" class="filter-search" id="searchText" placeholder="在左右文本中搜索..." oninput="applyFiltersIfDefined()" title="注意：筛选条件无法保存" style="flex: 1;">
                        <button class="filter-reset" onclick="resetFilters()">重置</button>
                    </div>
                </div>
            </div>
        </div>
        <div class="filter-stats" id="filterStats"></div>
        <table class="alignment-table">
            <thead>
                <tr>
                    <th class="col-index">序号</th>
                    <th class="col-type">类型</th>
                    <th class="col-similarity">相似度</th>
                    <th class="col-sentence-a">[句ID, 行ID]${escapeHtml(titleA)}</th>
                    <th class="col-sentence-b">[句ID, 行ID]${escapeHtml(titleB)}</th>
                    <th class="col-remark hidden">备注</th>
                </tr>
            </thead>
            <tbody>`);

    // 生成表格行
    alignment.forEach((item, idx) => {
        const itemType = item.type;
        const similarityValue = item.similarity ?? 0;
        const similarityText = similarityValue > 0 ? similarityValue.toFixed(2) : '';
        // 所有条目无条件应用jsdiff，不管相似度如何
        const needsDiff = true;
        const needsDiffAttr = 'data-needs-diff="true"';
        const partialMatchClass = (itemType === 'match' && similarityValue < 1.0) ? ' partial-match' : '';

        const textA = item.a || '';
        const textB = item.b || '';
        const textAEscaped = escapeHtml(textA);
        const textBEscaped = escapeHtml(textB);

        // 构建原文句子
        let sentenceAText = '';
        if (item.a) {
            let aIdxStr = '?';
            if (item.a_indices && item.a_indices.length > 0) {
                if (item.a_indices.length === 1) {
                    aIdxStr = String(item.a_indices[0] + 1);
                } else {
                    aIdxStr = `${item.a_indices[0] + 1}-${item.a_indices[item.a_indices.length - 1] + 1}`;
                }
            } else if (item.a_index !== undefined && item.a_index !== null) {
                aIdxStr = String(item.a_index + 1);
            }

            let aLineStr = '?';
            if (item.a_line_number !== undefined) {
                aLineStr = String(item.a_line_number);
            }

            sentenceAText = `<span class="index">[${aIdxStr}, ${aLineStr}]</span><span class="sentence-a">${escapeHtml(item.a)}</span>`;
        }

        // 构建校对后句子
        let sentenceBText = '';
        if (item.b) {
            let bIdxStr = '?';
            if (item.b_indices && item.b_indices.length > 0) {
                if (item.b_indices.length === 1) {
                    bIdxStr = String(item.b_indices[0] + 1);
                } else {
                    bIdxStr = `${item.b_indices[0] + 1}-${item.b_indices[item.b_indices.length - 1] + 1}`;
                }
            } else if (item.b_index !== undefined && item.b_index !== null) {
                bIdxStr = String(item.b_index + 1);
            }

            let bLineStr = '?';
            if (item.b_line_number !== undefined) {
                bLineStr = String(item.b_line_number);
            }

            sentenceBText = `<span class="index">[${bIdxStr}, ${bLineStr}]</span><span class="sentence-b">${escapeHtml(item.b)}</span>`;
        }

        htmlLines.push(`
            <tr class="${itemType}${partialMatchClass}" data-type="${itemType}" data-similarity="${similarityValue.toFixed(4)}" data-text-a="${textAEscaped}" data-text-b="${textBEscaped}" data-row-idx="${idx + 1}" data-diff-mode="false" ${needsDiffAttr}>
                <td class="col-index">${idx + 1}</td>
                <td class="col-type"><span class="item-header">${itemType.toUpperCase()}</span></td>
                <td class="col-similarity"><span class="similarity">${similarityText}</span></td>
                <td class="col-sentence-a">${sentenceAText}</td>
                <td class="col-sentence-b">${sentenceBText}</td>
                <td class="col-remark hidden"><textarea class="remark-input" placeholder="备注" data-row-idx="${idx + 1}" title="备注内容无法保存" rows="1"></textarea></td>
            </tr>`);
    });

    // JavaScript代码（从Python脚本移植）
    htmlLines.push(`
            </tbody>
        </table>
    </div>

    <script>
        function applyFiltersIfDefined() { if (typeof applyFilters === 'function') applyFilters(); }
        // 类型筛选状态
        const typeFilters = {
            'all': true,
            'match': true,
            'movein': true,
            'moveout': true,
            'delete': true,
            'insert': true
        };

        // 列显示状态（备注列默认关闭）
        const columnVisibility = {
            'type': true,
            'similarity': true,
            'remark': false
        };

        // 类型筛选函数
        function filterByType(type) {
            const btn = document.querySelector(\`[data-type="\${type}"]\`);
            typeFilters[type] = !typeFilters[type];

            if (type === 'all') {
                const allActive = !typeFilters['all'];
                typeFilters['match'] = allActive;
                typeFilters['movein'] = allActive;
                typeFilters['moveout'] = allActive;
                typeFilters['delete'] = allActive;
                typeFilters['insert'] = allActive;

                document.querySelectorAll('.filter-btn[data-type]').forEach(b => {
                    b.classList.toggle('active', allActive);
                });
            } else {
                btn.classList.toggle('active', typeFilters[type]);

                const allActive = typeFilters['match'] && typeFilters['movein'] && typeFilters['moveout'] && typeFilters['delete'] && typeFilters['insert'];
                const allBtn = document.querySelector('[data-type="all"]');
                allBtn.classList.toggle('active', allActive);
                typeFilters['all'] = allActive;
            }

            applyFilters();
        }

        // 备注列：文本框随内容增高（整行行高自适应），无滚动条
        function resizeRemarkInput(ta) {
            ta.style.height = '0px';
            var oneLine = 26;
            var h = ta.scrollHeight > 0 ? ta.scrollHeight : oneLine;
            ta.style.height = Math.max(h, oneLine) + 'px';
        }
        // 备注列：从 Excel 等多格粘贴时，按行依次填入连续备注格
        document.addEventListener('DOMContentLoaded', function() {
            var cb = document.getElementById('printRepeatHeader');
            if (cb) document.body.classList.toggle('print-no-repeat-header', !cb.checked);
            var remarkInputs = document.querySelectorAll('.alignment-table .remark-input');
            remarkInputs.forEach(function(ta) {
                ta.addEventListener('input', function() { resizeRemarkInput(ta); });
            });
            // 粘贴内容可能含 CRLF，按 \\r\\n 或 \\n 或 \\r 分割（避免正则中的 ? 在旧引擎中报 Unexpected token）
            document.addEventListener('paste', function(e) {
                const el = e.target;
                if (!el || !el.classList || !el.classList.contains('remark-input')) return;
                const text = (e.clipboardData || window.clipboardData).getData('text');
                if (!text) return;
                var lines = text.split(/\\r\\n|\\n|\\r/).map(function(s) { return s.trim(); });
                if (lines.length <= 1) return;
                e.preventDefault();
                var rowIdx = parseInt(el.getAttribute('data-row-idx'), 10);
                var allInputs = Array.prototype.slice.call(document.querySelectorAll('.alignment-table tbody td.col-remark .remark-input'));
                var visibleInputs = allInputs.filter(function(inp) { return !inp.closest('tr').classList.contains('hidden'); });
                visibleInputs.sort(function(a, b) { return parseInt(a.getAttribute('data-row-idx'), 10) - parseInt(b.getAttribute('data-row-idx'), 10); });
                var start = visibleInputs.findIndex(function(inp) { return parseInt(inp.getAttribute('data-row-idx'), 10) === rowIdx; });
                if (start < 0) return;
                for (var i = 0; i < lines.length && start + i < visibleInputs.length; i++) {
                    visibleInputs[start + i].value = lines[i];
                    resizeRemarkInput(visibleInputs[start + i]);
                }
            });
        });

        // 打印时是否每页重复表头（取消勾选则不重复）
        function togglePrintRepeatHeader() {
            var cb = document.getElementById('printRepeatHeader');
            document.body.classList.toggle('print-no-repeat-header', !cb.checked);
        }
        // 切换列显示/隐藏
        function toggleColumn(columnName) {
            const btn = document.querySelector(\`[data-col="\${columnName}"]\`);
            columnVisibility[columnName] = !columnVisibility[columnName];
            btn.classList.toggle('active', columnVisibility[columnName]);

            // 切换表头
            const headerCells = document.querySelectorAll(\`.alignment-table thead th.col-\${columnName}\`);
            headerCells.forEach(cell => {
                if (columnVisibility[columnName]) {
                    cell.classList.remove('hidden');
                } else {
                    cell.classList.add('hidden');
                }
            });

            // 切换表格数据列
            const dataCells = document.querySelectorAll(\`.alignment-table tbody td.col-\${columnName}\`);
            dataCells.forEach(cell => {
                if (columnVisibility[columnName]) {
                    cell.classList.remove('hidden');
                } else {
                    cell.classList.add('hidden');
                }
            });
        }

        // 解析序号筛选字符串
        // 支持格式: 1,2,5-20,80- (单个数字、范围、起始范围)
        // 忽略空格，兼容中英文逗号
        function parseIndexFilter(filterText, maxRowIndex) {
            if (!filterText || !filterText.trim()) {
                return null; // 空字符串表示不过滤
            }

            const allowedIndices = new Set();
            // 替换中文逗号为英文逗号，去除所有空格
            const normalized = filterText.replace(/，/g, ',').replace(/\s+/g, '');

            if (!normalized) {
                return null;
            }

            // 按逗号分割
            const parts = normalized.split(',');

            for (const part of parts) {
                if (!part) continue; // 跳过空部分

                if (part.includes('-')) {
                    // 处理范围
                    const rangeParts = part.split('-');
                    if (rangeParts.length === 2) {
                        const start = rangeParts[0] ? parseInt(rangeParts[0], 10) : null;
                        const end = rangeParts[1] ? parseInt(rangeParts[1], 10) : null;

                        if (start !== null && !isNaN(start)) {
                            if (end !== null && !isNaN(end)) {
                                // 完整范围: 5-20
                                for (let i = start; i <= end && i <= maxRowIndex; i++) {
                                    if (i >= 1) {
                                        allowedIndices.add(i);
                                    }
                                }
                            } else {
                                // 起始范围: 80- (从80开始到最大序号)
                                for (let i = start; i <= maxRowIndex; i++) {
                                    if (i >= 1) {
                                        allowedIndices.add(i);
                                    }
                                }
                            }
                        }
                    }
                } else {
                    // 单个数字
                    const num = parseInt(part, 10);
                    if (!isNaN(num) && num >= 1 && num <= maxRowIndex) {
                        allowedIndices.add(num);
                    }
                }
            }

            return allowedIndices.size > 0 ? allowedIndices : null;
        }

        // 应用所有筛选条件
        function applyFilters() {
            const rows = document.querySelectorAll('.alignment-table tbody tr');
            const maxRowIndex = rows.length;
            const minSimilarity = parseFloat(document.getElementById('minSimilarity').value) || 0;
            const maxSimilarity = parseFloat(document.getElementById('maxSimilarity').value) || 1;
            const searchText = document.getElementById('searchText').value.toLowerCase().trim();
            const indexFilterText = document.getElementById('indexFilter').value.trim();
            const allowedIndices = parseIndexFilter(indexFilterText, maxRowIndex);

            let visibleCount = 0;

            rows.forEach(row => {
                const rowType = row.dataset.type;
                const typeMatch = typeFilters[rowType];

                const similarity = parseFloat(row.dataset.similarity) || 0;
                const similarityMatch = similarity >= minSimilarity && similarity <= maxSimilarity;

                const textA = (row.dataset.textA || '').toLowerCase();
                const textB = (row.dataset.textB || '').toLowerCase();
                const textMatch = !searchText || textA.includes(searchText) || textB.includes(searchText);

                // 序号筛选
                const rowIdx = parseInt(row.dataset.rowIdx, 10);
                const indexMatch = !allowedIndices || allowedIndices.has(rowIdx);

                const shouldShow = typeMatch && similarityMatch && textMatch && indexMatch;

                if (shouldShow) {
                    row.classList.remove('hidden');
                    visibleCount++;
                } else {
                    row.classList.add('hidden');
                }
            });

            updateFilterStats(visibleCount, rows.length);
            renderedRows.clear();
            updateRenderQueue();
            initialRender();
        }

        // 更新筛选统计信息
        function updateFilterStats(visible, total) {
            const statsEl = document.getElementById('filterStats');
            if (visible === total) {
                statsEl.textContent = \`显示全部 \${total} 条结果\`;
            } else {
                statsEl.textContent = \`显示 \${visible} / \${total} 条结果\`;
            }
        }

        // 重置所有筛选
        function resetFilters() {
            typeFilters['all'] = true;
            typeFilters['match'] = true;
            typeFilters['movein'] = true;
            typeFilters['moveout'] = true;
            typeFilters['delete'] = true;
            typeFilters['insert'] = true;

            document.querySelectorAll('.filter-btn[data-type]').forEach(btn => {
                btn.classList.add('active');
            });

            document.getElementById('minSimilarity').value = '';
            document.getElementById('maxSimilarity').value = '';
            document.getElementById('searchText').value = '';
            document.getElementById('indexFilter').value = '';

            // 重置列显示状态（类型、相似度显示，备注列默认关闭）
            columnVisibility['type'] = true;
            columnVisibility['similarity'] = true;
            columnVisibility['remark'] = false;
            document.querySelectorAll('.filter-btn[data-col]').forEach(btn => {
                btn.classList.toggle('active', columnVisibility[btn.dataset.col]);
            });
            document.querySelectorAll('.alignment-table th.col-type, .alignment-table td.col-type, .alignment-table th.col-similarity, .alignment-table td.col-similarity').forEach(cell => {
                cell.classList.remove('hidden');
            });
            document.querySelectorAll('.alignment-table th.col-remark, .alignment-table td.col-remark').forEach(cell => {
                cell.classList.add('hidden');
            });

            applyFilters();
        }

        // 懒加载渲染配置
        const RENDER_BATCH_SIZE = 10;
        const VIEWPORT_BUFFER = 100;
        const INITIAL_RENDER_BUFFER = 2000;

        let renderQueue = [];
        let isRendering = false;
        let renderedRows = new Set();

        function isInViewportWithBuffer(element, buffer = VIEWPORT_BUFFER) {
            const rect = element.getBoundingClientRect();
            const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
            return rect.top >= -buffer && rect.bottom <= viewportHeight + buffer;
        }

        function getDistanceToViewport(row) {
            const rect = row.getBoundingClientRect();
            const viewportTop = window.pageYOffset || document.documentElement.scrollTop;
            const viewportBottom = viewportTop + (window.innerHeight || document.documentElement.clientHeight);
            const rowTop = viewportTop + rect.top;
            const rowBottom = viewportTop + rect.bottom;

            if (rowBottom < viewportTop) {
                return viewportTop - rowBottom;
            } else if (rowTop > viewportBottom) {
                return rowTop - viewportBottom;
            } else {
                return 0;
            }
        }

        function updateRenderQueue() {
            const allRows = document.querySelectorAll('.alignment-table tbody tr[data-needs-diff="true"]:not(.hidden)');
            renderQueue = [];

            allRows.forEach(row => {
                if (!renderedRows.has(row)) {
                    const distance = getDistanceToViewport(row);
                    renderQueue.push({ row: row, distance: distance });
                }
            });

            renderQueue.sort((a, b) => a.distance - b.distance);
        }

        function renderDiffForRow(row) {
            const textA = row.dataset.textA || '';
            const textB = row.dataset.textB || '';
            const cellA = row.querySelector('.col-sentence-a');
            const cellB = row.querySelector('.col-sentence-b');

            if (!cellA || !cellB) return false;

            if (row._originalA === undefined || row._originalB === undefined) {
                row._originalA = cellA.innerHTML;
                row._originalB = cellB.innerHTML;
            }

            if (typeof Diff !== 'undefined') {
                let segmenter = null;
                if (typeof Intl !== 'undefined' && Intl.Segmenter) {
                    try {
                        segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
                    } catch (e) {
                    }
                }

                const diff = segmenter
                    ? Diff.diffWordsWithSpace(textA, textB, segmenter)
                    : Diff.diffWords(textA, textB);

                let originalHtml = '';
                let modifiedHtml = '';

                diff.forEach(part => {
                    const escapedValue = escapeHtml(part.value);

                    if (part.removed) {
                        originalHtml += '<span style="color: red; text-decoration: dotted underline 2px;">' + escapedValue + '</span>';
                    } else if (!part.added) {
                        originalHtml += '<span style="color: black;">' + escapedValue + '</span>';
                    }

                    if (part.added) {
                        modifiedHtml += '<span style="color: green; text-decoration: underline 2px;">' + escapedValue + '</span>';
                    } else if (!part.removed) {
                        modifiedHtml += '<span style="color: black;">' + escapedValue + '</span>';
                    }
                });

                const indexA = cellA.querySelector('.index');
                const indexB = cellB.querySelector('.index');
                const indexAHtml = indexA ? indexA.outerHTML : '';
                const indexBHtml = indexB ? indexB.outerHTML : '';

                cellA.innerHTML = indexAHtml + (originalHtml || '');
                cellB.innerHTML = indexBHtml + (modifiedHtml || '');
            } else {
                const indexA = cellA.querySelector('.index');
                const indexB = cellB.querySelector('.index');
                const indexAHtml = indexA ? indexA.outerHTML : '';
                const indexBHtml = indexB ? indexB.outerHTML : '';
                cellA.innerHTML = indexAHtml + escapeHtml(textA);
                cellB.innerHTML = indexBHtml + escapeHtml(textB);
            }

            row.dataset.diffMode = 'true';
            return true;
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        function renderBatch() {
            if (isRendering || renderQueue.length === 0) {
                return;
            }

            isRendering = true;

            const viewportRows = renderQueue.filter(item =>
                isInViewportWithBuffer(item.row, VIEWPORT_BUFFER)
            );

            const rowsToRender = viewportRows.length > 0
                ? viewportRows.slice(0, RENDER_BATCH_SIZE)
                : renderQueue.slice(0, RENDER_BATCH_SIZE);

            rowsToRender.forEach(item => {
                if (renderDiffForRow(item.row)) {
                    renderedRows.add(item.row);
                }
            });

            renderQueue = renderQueue.filter(item => !renderedRows.has(item.row));

            isRendering = false;

            if (renderQueue.length > 0) {
                requestAnimationFrame(() => {
                    setTimeout(renderBatch, 0);
                });
            }
        }

        function initialRender() {
            updateRenderQueue();

            const viewportRows = renderQueue.filter(item =>
                isInViewportWithBuffer(item.row, INITIAL_RENDER_BUFFER)
            );

            viewportRows.forEach(item => {
                if (renderDiffForRow(item.row)) {
                    renderedRows.add(item.row);
                }
            });

            renderQueue = renderQueue.filter(item => !renderedRows.has(item.row));

            if (renderQueue.length > 0) {
                requestAnimationFrame(() => {
                    setTimeout(renderBatch, 100);
                });
            }
        }

        let scrollTimer = null;
        function handleScroll() {
            if (scrollTimer) {
                return;
            }

            scrollTimer = setTimeout(() => {
                updateRenderQueue();
                renderBatch();
                scrollTimer = null;
            }, 150);
        }

        let intersectionObserver = null;
        function setupIntersectionObserver() {
            if (!('IntersectionObserver' in window)) {
                return;
            }

            intersectionObserver = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        const row = entry.target;
                        if (row.dataset.needsDiff === 'true' && !renderedRows.has(row)) {
                            updateRenderQueue();
                            renderBatch();
                        }
                    }
                });
            }, {
                root: null,
                rootMargin: \`\${VIEWPORT_BUFFER}px\`,
                threshold: 0
            });

            document.querySelectorAll('.alignment-table tbody tr[data-needs-diff="true"]').forEach(row => {
                intersectionObserver.observe(row);
            });
        }

        // 显示筛选条件无法保存的提示
        function showFilterWarning() {
            // 检查是否已经显示过提示
            if (sessionStorage.getItem('filterWarningShown') === 'true') {
                return;
            }

            // 创建提示元素
            const warningDiv = document.createElement('div');
            warningDiv.style.cssText = 'background-color: #fff3cd; border: 1px solid #ffc107; border-radius: 4px; padding: 10px; margin-bottom: 15px; color: #856404; font-size: 13px;';
            warningDiv.innerHTML = '<strong>提示：</strong>筛选条件与备注无法保存，刷新、重新打开后会重置！建议：（1）另行存储你的筛选条件如条目列表，用列表或表格存储备注；（2）把条目列表和备注等粘贴到本表中；（3）复制筛选结果到Word文档中进一步处理，或通过浏览器打印为PDF。';

            // 添加关闭按钮
            const closeBtn = document.createElement('button');
            closeBtn.textContent = '×';
            closeBtn.style.cssText = 'float: right; background: none; border: none; font-size: 20px; cursor: pointer; color: #856404; padding: 0 5px;';
            closeBtn.onclick = function() {
                warningDiv.remove();
                sessionStorage.setItem('filterWarningShown', 'true');
            };
            warningDiv.insertBefore(closeBtn, warningDiv.firstChild);

            // 插入到筛选控件之前
            const filterControls = document.querySelector('.filter-controls');
            if (filterControls && filterControls.parentNode) {
                filterControls.parentNode.insertBefore(warningDiv, filterControls);
            }
        }

        document.addEventListener('DOMContentLoaded', function() {
            showFilterWarning();
            applyFilters();
            initialRender();
            setupIntersectionObserver();
            window.addEventListener('scroll', handleScroll, { passive: true });
        });
    </script>
</body>
</html>`);

    // 写入文件
    fs.writeFileSync(outputPath, htmlLines.join(''), 'utf8');
}
