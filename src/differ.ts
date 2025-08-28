/**
 * 比较工具模块
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TempFileManager } from './utils';

/**
 * 显示两个文本之间的差异
 * @param context 扩展上下文
 * @param originalText 原始文本
 * @param proofreadText 校对后的文本
 * @param fileExt 文件扩展名
 */
export async function showDiff(
    context: vscode.ExtensionContext,
    originalText: string,
    proofreadText: string,
    fileExt: string,
    preview: boolean = true
): Promise<void> {
    const tempFileManager = TempFileManager.getInstance(context);
    const originalUri = await tempFileManager.createTempFile(originalText, fileExt);
    const proofreadUri = await tempFileManager.createTempFile(proofreadText, fileExt);
    await openDiffView(originalUri, proofreadUri, preview);
}

/**
 * 显示两个文件之间的差异
 * @param originalFile 原始文件路径
 * @param proofreadFile 校对后的文件路径
 */
export async function showFileDiff(
    originalFile: string,
    proofreadFile: string,
    preview: boolean = true
): Promise<void> {
    const originalUri = vscode.Uri.file(originalFile);
    const proofreadUri = vscode.Uri.file(proofreadFile);
    await openDiffView(originalUri, proofreadUri, preview);
}

/**
 * 打开diff视图
 * @param originalUri 原始文件URI
 * @param proofreadUri 校对后的文件URI
 */
async function openDiffView(
    originalUri: vscode.Uri,
    proofreadUri: vscode.Uri,
    preview: boolean = true
): Promise<void> {
    await vscode.commands.executeCommand('vscode.diff', originalUri, proofreadUri, 'Original ↔ Processed', { preview: preview });
}

/**
 * 生成jsdiff文件
 * @param originalFile 原始文件路径
 * @param proofreadFile 校对后的文件路径
 * @param outputFile 输出文件路径
 * @param diffTitle 标题
 */
export async function jsDiffMarkdown(
    originalFile: string,
    proofreadFile: string,
    outputFile: string,
    diffTitle: string
): Promise<void> {
    const originalFileContent = fs.readFileSync(originalFile, 'utf8');
    const proofreadFileContent = fs.readFileSync(proofreadFile, 'utf8');
    // jsdiff 模版
    const jsdiffTemplate = `
<html>
  <head>
    <title>${diffTitle}</title>
    <meta charset="utf-8">
    <style>
      #display {
        white-space: pre-wrap;       /* CSS3 */
        word-wrap: break-word;       /* IE */
        overflow-wrap: break-word;   /* Modern browsers */
        font-family: "SimSun", "宋体" !important;
        font-size: 14px !important;
        line-height: 1.5  !important;
      }
      #display span {
        display: inline;
        word-wrap: break-word;
        overflow-wrap: break-word;
      }
    </style>
  </head>
  <body>
    <pre id="display"></pre>
    <!-- <script src="diff.js"></script> -->
    <script src="https://cdn.jsdelivr.net/npm/diff@7.0.0/dist/diff.min.js"></script>
    <script type="text/plain" id="a-text">${originalFileContent}</script>
    <script type="text/plain" id="b-text">${proofreadFileContent}</script>
    <script>
    // 获取文本内容
    const a = document.getElementById('a-text').textContent;
    const b = document.getElementById('b-text').textContent;
    </script>
    <!-- <script src="a.js"></script>
    <script src="b.js"></script> -->
    <script>
// Variables 'a' and 'b' are now available from the included JS files
let span = null;

const segmenter = new Intl.Segmenter(
  'zh', { granularity: 'word' }
);
const diff = Diff.diffWordsWithSpace(a, b, segmenter),
    display = document.getElementById('display'),
    fragment = document.createDocumentFragment();

diff.forEach((part) => {
  // green for additions, red for deletions
  // grey for common parts
  const color = part.added ? 'green' :
    part.removed ? 'red' : 'black';
  span = document.createElement('span');
  span.style.color = color;

  // Add underline for additions and strikethrough for deletions
  if (part.added) {
    span.style.textDecoration = 'underline 2px';
  } else if (part.removed) {
    span.style.textDecoration = 'dotted underline 2px';
  }

  span.appendChild(document
    .createTextNode(part.value));
  fragment.appendChild(span);
});

display.appendChild(fragment);
</script>
</body>
</html>
`;

    // 替换模版中的文本内容
    const jsdiffHtml = jsdiffTemplate.replace('${originalFileContent}', originalFileContent)
        .replace('${proofreadFileContent}', proofreadFileContent)
        .replace('${diffTitle}', diffTitle);

    // 写文件
    fs.writeFileSync(outputFile, jsdiffHtml);
}

/**
 * 生成JSON文件的jsdiff比较结果
 * @param originalFile 原始JSON文件路径
 * @param proofreadFile 校对后的JSON文件路径
 * @param outputFile 输出HTML文件路径
 * @param diffTitle 比较标题
 * @param segmentCount 每次要比较的片段数量（0表示所有片段）
 */
export async function jsDiffJsonFiles(
    originalFile: string,
    proofreadFile: string,
    outputFile: string,
    diffTitle: string,
    segmentCount: number = 0
): Promise<void> {
    try {
        // 读取并解析JSON文件
        const originalContent = JSON.parse(fs.readFileSync(originalFile, 'utf8'));
        const proofreadContent = JSON.parse(fs.readFileSync(proofreadFile, 'utf8'));

        // 验证JSON格式
        if (!Array.isArray(originalContent) || !Array.isArray(proofreadContent)) {
            throw new Error('两个文件都必须是JSON数组格式');
        }

        if (segmentCount === 0) {
            // 一次性比较所有片段
            await generateSingleDiffFile(originalFile, proofreadFile, outputFile, diffTitle, originalContent, proofreadContent);
        } else {
            // 循环比较，分批处理
            await generateBatchDiffFiles(originalFile, proofreadFile, outputFile, diffTitle, originalContent, proofreadContent, segmentCount);
        }
    } catch (error) {
        throw new Error(`处理JSON文件时出错：${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * 生成单个差异文件（比较所有片段）
 */
async function generateSingleDiffFile(
    originalFile: string,
    proofreadFile: string,
    outputFile: string,
    diffTitle: string,
    originalContent: any[],
    proofreadContent: any[]
): Promise<void> {
    // 拼接JSON内容
    const originalText = concatenateJsonContent(originalContent, 0);
    const proofreadText = concatenateJsonContent(proofreadContent, 0);

    // 生成jsdiff HTML
    const jsdiffHtml = generateDiffHtml(
        diffTitle,
        originalText,
        proofreadText,
        path.basename(originalFile),
        path.basename(proofreadFile),
        originalContent.length,
        proofreadContent.length,
        0
    );

    // 写文件
    fs.writeFileSync(outputFile, jsdiffHtml);
}

/**
 * 生成批量差异文件（循环比较）
 */
async function generateBatchDiffFiles(
    originalFile: string,
    proofreadFile: string,
    baseOutputFile: string,
    diffTitle: string,
    originalContent: any[],
    proofreadContent: any[],
    segmentCount: number
): Promise<void> {
    const totalSegments = Math.max(originalContent.length, proofreadContent.length);
    const batchCount = Math.ceil(totalSegments / segmentCount);
    
    // 获取基础文件名（不含扩展名）
    const baseFileName = path.basename(baseOutputFile, path.extname(baseOutputFile));
    const outputDir = path.dirname(baseOutputFile);

    for (let i = 0; i < batchCount; i++) {
        const startIndex = i * segmentCount;
        const endIndex = Math.min(startIndex + segmentCount, totalSegments);
        const currentSegmentCount = endIndex - startIndex;
        
        // 生成带序号的文件名
        const batchNumber = i + 1;
        const outputFileName = `${baseFileName}-${batchNumber.toString().padStart(3, '0')}.html`;
        const outputFilePath = path.join(outputDir, outputFileName);
        
        // 拼接当前批次的JSON内容
        const originalText = concatenateJsonContent(originalContent, segmentCount, startIndex);
        const proofreadText = concatenateJsonContent(proofreadContent, segmentCount, startIndex);
        
        // 生成当前批次的标题
        const batchTitle = `${diffTitle} - 批次 ${batchNumber}/${batchCount} (片段 ${startIndex + 1}-${endIndex})`;
        
        // 生成jsdiff HTML
        const jsdiffHtml = generateDiffHtml(
            batchTitle,
            originalText,
            proofreadText,
            path.basename(originalFile),
            path.basename(proofreadFile),
            originalContent.length,
            proofreadContent.length,
            currentSegmentCount,
            batchNumber,
            batchCount,
            startIndex + 1,
            endIndex
        );
        
        // 写文件
        fs.writeFileSync(outputFilePath, jsdiffHtml);
    }
}

/**
 * 生成差异HTML内容
 */
function generateDiffHtml(
    title: string,
    originalText: string,
    proofreadText: string,
    originalFileName: string,
    proofreadFileName: string,
    originalTotal: number,
    proofreadTotal: number,
    currentSegmentCount: number,
    batchNumber?: number,
    totalBatches?: number,
    startSegment?: number,
    endSegment?: number
): string {
    const jsdiffTemplate = `
<html>
  <head>
    <title>${title}</title>
    <meta charset="utf-8">
    <style>
      #display {
        white-space: pre-wrap;
        word-wrap: break-word;
        overflow-wrap: break-word;
        font-family: "SimSun", "宋体" !important;
        font-size: 14px !important;
        line-height: 1.5 !important;
      }
      #display span {
        display: inline;
        word-wrap: break-word;
        overflow-wrap: break-word;
      }
      .info {
        background-color: #f0f0f0;
        padding: 10px;
        margin: 10px 0;
        border-radius: 5px;
        font-family: monospace;
        font-size: 12px;
      }
      
    </style>
  </head>
  <body>
    <div class="info">
      <strong>比较信息</strong><br>
      比较时间：${new Date().toLocaleString()}<br>
      原始文件：${originalFileName} (${originalTotal} 个片段)<br>
      校对文件：${proofreadFileName} (${proofreadTotal} 个片段)<br>
      ${batchNumber ? `当前批次：${batchNumber}/${totalBatches}<br>当前片段：${startSegment}-${endSegment}` : `比较片段：全部`}
    </div>
    <pre id="display"></pre>
    <script src="https://cdn.jsdelivr.net/npm/diff@7.0.0/dist/diff.min.js"></script>
    <script type="text/plain" id="a-text">${originalText}</script>
    <script type="text/plain" id="b-text">${proofreadText}</script>
    <script>
    // 获取文本内容
    const a = document.getElementById('a-text').textContent;
    const b = document.getElementById('b-text').textContent;
    </script>
    <script>
// Variables 'a' and 'b' are now available from the included JS files
let span = null;

const segmenter = new Intl.Segmenter(
  'zh', { granularity: 'word' }
);
const diff = Diff.diffWordsWithSpace(a, b, segmenter),
    display = document.getElementById('display'),
    fragment = document.createDocumentFragment();

diff.forEach((part) => {
  // green for additions, red for deletions
  // grey for common parts
  const color = part.added ? 'green' :
    part.removed ? 'red' : 'black';
  span = document.createElement('span');
  span.style.color = color;

  // Add underline for additions and strikethrough for deletions
  if (part.added) {
    span.style.textDecoration = 'underline 2px';
  } else if (part.removed) {
    span.style.textDecoration = 'dotted underline 2px';
  }

  span.appendChild(document
    .createTextNode(part.value));
  fragment.appendChild(span);
});

display.appendChild(fragment);
</script>
</body>
</html>
`;

    return jsdiffTemplate;
}

/**
 * 拼接JSON内容用于比较
 * @param jsonContent JSON数组内容
 * @param segmentCount 要比较的片段数量（0表示所有片段）
 * @param startIndex 起始索引（可选，默认为0）
 * @returns 拼接后的文本
 */
function concatenateJsonContent(jsonContent: any[], segmentCount: number, startIndex: number = 0): string {
    if (segmentCount === 0) {
        segmentCount = jsonContent.length;
    } else {
        segmentCount = Math.min(segmentCount, jsonContent.length - startIndex);
    }

    const segments = jsonContent.slice(startIndex, startIndex + segmentCount);
    const result: string[] = [];

    segments.forEach((item, index) => {
        const actualIndex = startIndex + index + 1; // 实际的片段编号
        if (typeof item === 'object' && item !== null) {
            // 如果是对象，优先使用target字段，如果没有则拼接所有一级字段
            if (item.target) {
                result.push(`${item.target}\n`);
            } else {
                const fields = Object.entries(item)
                    .filter(([_, value]) => typeof value === 'string')
                    .map(([key, value]) => `${key}: ${value}`)
                    .join('\n');
                if (fields) {
                    result.push(`${fields}\n`);
                }
            }
        } else if (typeof item === 'string') {
            // 如果是字符串，直接添加
            result.push(`${item}\n`);
        }
    });

    return result.join('\n---\n\n');
}
