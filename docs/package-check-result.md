# VSIX 打包内容检查结果

## 已采用方案：只复制 sql.js 的 dist，不包含 node_modules

- **node_modules** 继续被 `.vscodeignore` 排除，VSIX 体积不暴增。
- 构建脚本 **copy-sqljs-dist** 将 `node_modules/sql.js/dist/` 下的 `sql-wasm.js` 与 `sql-wasm.wasm` 复制到 `dist/`。
- 运行时从 **dist** 加载：`referenceStore` 使用 `require(path.join(__dirname, 'sql-wasm.js'))` 和 `locateFile` 指向 `__dirname`，无需 node_modules。
- `.vscodeignore` 中增加 `dist/sql-wasm.[0-9a-f]*.js`，排除 Parcel 可能生成的带 hash 的重复 chunk。

## 预期 VSIX 内容（体积可控）

- `extension/dist/extension.js`
- `extension/dist/sql-wasm.js`（复制自 sql.js，约 97 KB）
- `extension/dist/sql-wasm.wasm`（约 644 KB）
- 其余：LICENSE、icon、package.json、readme 等。
