/**
 * 移除 mdict-js 中遗留的 debugger 语句（首次加载 .mdx 会解码 key block 并触发断点）。
 * npm install 后通过 postinstall 自动执行。
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'node_modules', 'mdict-js');
const targets = ['src/mdict-base.js', 'lib/mdict-base.js'];

let patched = 0;
for (const rel of targets) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) continue;
    const before = fs.readFileSync(file, 'utf8');
    if (!/\bdebugger\b/.test(before)) continue;
    const after = before
        .replace(/^\s*debugger;?\s*$/gm, '')
        .replace(/\/\/ console\.log\([^)]*\)\s*\n/g, '');
    if (after !== before) {
        fs.writeFileSync(file, after, 'utf8');
        patched++;
        console.log(`[patch-mdict-js] removed debugger from ${rel}`);
    }
}

if (patched === 0) {
    console.log('[patch-mdict-js] no debugger found (already clean)');
}
