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
    const ngramSize = options.ngramSize || 2;
    const algorithmName = '锚点算法';

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
        }
        .alignment-table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 10px;
        }
        .alignment-table th {
            background-color: #3498db;
            color: white;
            padding: 10px;
            text-align: left;
            border: 1px solid #2980b9;
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
            border-left: 4px solid #27ae60;
        }
        .alignment-table tr.match.partial-match {
            border-left: 4px solid #f39c12;
        }
        .alignment-table tr.movein {
            border-left: 4px solid #f39c12;
        }
        .alignment-table tr.moveout {
            border-left: 4px solid #f39c12;
        }
        .alignment-table tr.delete {
            border-left: 4px solid #e74c3c;
        }
        .alignment-table tr.insert {
            border-left: 4px solid #3498db;
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
        .col-sentence-a {
            width: 42.5%;
        }
        .col-sentence-b {
            width: 42.5%;
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
            padding: 15px;
            border-radius: 5px;
            margin-bottom: 15px;
            border: 1px solid #bdc3c7;
            display: flex;
            gap: 20px;
            align-items: center;
            flex-wrap: nowrap;
        }
        .filter-group {
            display: flex;
            align-items: center;
            gap: 10px;
            flex: 0 1 auto;
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
            gap: 10px;
            flex-wrap: wrap;
        }
        .filter-btn {
            padding: 6px 12px;
            border: 2px solid #3498db;
            background-color: white;
            color: #3498db;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            transition: all 0.2s;
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
            gap: 10px;
            align-items: center;
        }
        .filter-input {
            padding: 6px 10px;
            border: 1px solid #bdc3c7;
            border-radius: 4px;
            font-size: 13px;
            width: 80px;
        }
        .filter-search {
            padding: 6px 10px;
            border: 1px solid #bdc3c7;
            border-radius: 4px;
            font-size: 13px;
            width: 200px;
        }
        .filter-reset {
            padding: 6px 15px;
            background-color: #e74c3c;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
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
    </div>
    <div class="alignment-results">
        <div class="filter-controls">
            <div class="filter-group">
                <label class="filter-label">类型筛选：</label>
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
                <label class="filter-label">相似度范围：</label>
                <div class="filter-input-group">
                    <input type="number" class="filter-input" id="minSimilarity" placeholder="最小值" min="0" max="1" step="0.01" oninput="applyFilters()">
                    <span>至</span>
                    <input type="number" class="filter-input" id="maxSimilarity" placeholder="最大值" min="0" max="1" step="0.01" oninput="applyFilters()">
                </div>
            </div>
            <div class="filter-group">
                <label class="filter-label">文本搜索：</label>
                <div class="filter-input-group">
                    <input type="text" class="filter-search" id="searchText" placeholder="在左右文本中搜索..." oninput="applyFilters()">
                    <button class="filter-reset" onclick="resetFilters()">重置筛选</button>
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
                </tr>
            </thead>
            <tbody>`);

    // 生成表格行
    alignment.forEach((item, idx) => {
        const itemType = item.type;
        const similarityValue = item.similarity ?? 0;
        const similarityText = similarityValue > 0 ? similarityValue.toFixed(2) : '';
        const needsDiff = (itemType === 'match' && similarityValue < 1.0) || itemType === 'movein' || itemType === 'moveout';
        const needsDiffAttr = needsDiff ? 'data-needs-diff="true"' : '';
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
            </tr>`);
    });

    // JavaScript代码（从Python脚本移植）
    htmlLines.push(`
            </tbody>
        </table>
    </div>

    <script>
        // 类型筛选状态
        const typeFilters = {
            'all': true,
            'match': true,
            'movein': true,
            'moveout': true,
            'delete': true,
            'insert': true
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

        // 应用所有筛选条件
        function applyFilters() {
            const rows = document.querySelectorAll('.alignment-table tbody tr');
            const minSimilarity = parseFloat(document.getElementById('minSimilarity').value) || 0;
            const maxSimilarity = parseFloat(document.getElementById('maxSimilarity').value) || 1;
            const searchText = document.getElementById('searchText').value.toLowerCase().trim();

            let visibleCount = 0;

            rows.forEach(row => {
                const rowType = row.dataset.type;
                const typeMatch = typeFilters[rowType];

                const similarity = parseFloat(row.dataset.similarity) || 0;
                const similarityMatch = similarity >= minSimilarity && similarity <= maxSimilarity;

                const textA = (row.dataset.textA || '').toLowerCase();
                const textB = (row.dataset.textB || '').toLowerCase();
                const textMatch = !searchText || textA.includes(searchText) || textB.includes(searchText);

                const shouldShow = typeMatch && similarityMatch && textMatch;

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

            document.querySelectorAll('.filter-btn').forEach(btn => {
                btn.classList.add('active');
            });

            document.getElementById('minSimilarity').value = '';
            document.getElementById('maxSimilarity').value = '';
            document.getElementById('searchText').value = '';

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

        document.addEventListener('DOMContentLoaded', function() {
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
