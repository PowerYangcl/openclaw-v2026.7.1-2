#!/usr/bin/env node
/**
 * esbuild CLI 代理（用法与 `esbuild` 完全一致）。
 *
 * ## 为什么需要这个文件
 * 本仓库是 pnpm 安装。esbuild 的 postinstall 会把
 * `node_modules/esbuild/bin/esbuild` **硬链接成平台原生二进制**
 * （Mach-O / ELF，文件开头是 `\xcf\xfa\xed\xfe`，没有 shebang）；
 * 而 pnpm 生成的 `node_modules/.bin/esbuild` 是 cmd-shim 脚本，结尾固定是：
 *
 *   exec node "$basedir/../esbuild/bin/esbuild" "$@"
 *
 * 于是 `npm run test:unit:*` 一律炸在：
 *   node_modules/esbuild/bin/esbuild:1
 *   SyntaxError: Invalid or unexpected token
 *
 * `vite build` / `vue-tsc` 不受影响 —— 它们走 `require("esbuild")` 的 JS API，
 * 由 `lib/main.js` 自己去 spawn 原生二进制，根本不经过这个 bin shim。
 *
 * 不去改 `node_modules`，因为下次 `pnpm install` 会原样复现；
 * 这里自己解析原生二进制并转发参数，跨平台（platform/arch 从运行时取）。
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);

/** 按「ESBUILD_BINARY_PATH → optionalDependencies 包 → 已安装的 esbuild 目录」依次找原生二进制。 */
function resolveNativeBinary() {
  if (process.env.ESBUILD_BINARY_PATH) {
    return process.env.ESBUILD_BINARY_PATH;
  }
  const platformPackage = `@esbuild/${process.platform}-${process.arch}`;
  try {
    const manifest = require.resolve(`${platformPackage}/package.json`);
    return path.join(path.dirname(manifest), "bin", "esbuild");
  } catch {
    // 没有 optionalDependencies（例如用了 ESBUILD_BINARY_PATH 的镜像安装）时的兜底
    const esbuildDir = path.dirname(require.resolve("esbuild/package.json"));
    return path.join(esbuildDir, "bin", "esbuild");
  }
}

const binary = resolveNativeBinary();
const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });
if (result.error) {
  console.error(`[esbuild-cli] 无法启动 esbuild 原生二进制：${result.error.message}\n  路径：${binary}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
