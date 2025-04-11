/**
 * 比较工具模块
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
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
export async function generateJsDiff(
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
