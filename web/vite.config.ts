import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig, loadEnv, type Plugin, type UserConfig } from "vite";

// OpenClaw Web Control UI — Vite config.
//
// Integration contract with the Gateway (`src/infra/control-ui-assets.ts`):
//   - `web/dist/` is the Gateway's default static asset root when `web/` ships in-tree.
//     (Legacy `dist/control-ui/` from the Lit UI is retained as a fallback by `resolveControlUiRootSync`.)
//   - `gateway.controlUi.basePath` is injected into `<html data-openclaw-control-ui-base-path>` by
//     `serveResolvedIndexHtml` in `src/gateway/control-ui.ts`; we mirror that into `VITE_BASE_PATH`
//     so chunk URLs resolve at sub-path deployments (e.g. `/openclaw/`).
//   - Vite dev server runs on `:5273` (legacy `ui/` ran on `:5173`).
//   - Proxies match the four Gateway HTTP surfaces:
//       /control-ui-config.json                  -> ${basePath}/control-ui-config.json
//       /__openclaw__/avatar/<agentId>           -> HMAC-signed avatar
//       /__openclaw__/assistant-media            -> 5-minute ticket proxy
//       /api/v1/jd/spend                         -> legacy cost dashboard
//
// See `web/AGENTS.md` for the full integration contract and `docs/web/web-replacement-plan.md`
// for the migration plan.

/**
 * 给 build 产物的 index.html 注入「不缓存」meta。
 *
 * 浏览器 disk cache 命中是「刷新后样式才正确」的根因：
 *   - host server（gateway serveResolvedIndexHtml / vite preview / 自托管 nginx）默认不显式发 Cache-Control
 *   - 浏览器按启发式缓存，命中 → 拿旧 HTML + 旧 chunk hash
 *
 * 加 meta 兜底：HTML 里写出 `Cache-Control: no-cache`（HTTP/1.1）、
 * Pragma + Expires（HTTP/1.0 fallback），浏览器遵守 meta 跳过 disk cache。
 * 不动 chunk 文件 —— 它们已经是 hash 化文件名，长效缓存就好。
 */
function noCacheHtmlMeta(): Plugin {
  return {
    name: "control-ui:no-cache-html-meta",
    apply: "build",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        if (html.includes("</head>")) {
          return html.replace(
            "</head>",
            [
              '<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">',
              '<meta http-equiv="Pragma" content="no-cache">',
              '<meta http-equiv="Expires" content="0">',
              "</head>",
            ].join("\n  "),
          );
        }
        return html;
      },
    },
  };
}

const GATEWAY_TARGET = process.env.VITE_GATEWAY_HTTP_URL ?? "http://127.0.0.1:18789";

// ---------------------------------------------------------------------------
// PWA / Service Worker —— 构建期版本号
//
// 与旧版 `ui/` 完全同口径（`ui/vite.config.ts` 的 resolveControlUiBuildId +
// controlUiServiceWorkerBuildIdPlugin），这样两套 UI 的缓存版本号可互相比较：
//   1. define 把 buildId 编译进 `window.__OPENCLAW_CONTROL_UI_BUILD_ID__`（见 main.ts）；
//   2. closeBundle 把 `public/sw.js` 里的占位符替换成同一个 buildId 再写回 dist。
//
// 为什么必须「写回 dist/sw.js」而不是让 vite 直接拷 public：
//   publicDir 是**原样拷贝**，拷出来的 sw.js 里还是字面量占位符，缓存名会退化成 `dev`。
//   旧版靠这个 closeBundle 插件补上；占位符丢失时**必须抛错**，否则缓存永不轮换、
//   用户永远拿到旧 chunk（这类问题只在线上出现，本地开发根本复现不了）。
// ---------------------------------------------------------------------------

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = path.resolve(here, "..");

function normalizeBuildId(input: string): string {
  const normalized = input.trim().replace(/[^a-zA-Z0-9._-]+/g, "-");
  return normalized.slice(0, 96) || "dev";
}

function readPackageVersion(): string {
  try {
    const raw = fs.readFileSync(path.join(repoRoot, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim()
      ? parsed.version.trim()
      : "dev";
  } catch {
    return "dev";
  }
}

function readGitShortSha(): string | null {
  try {
    const raw = execFileSync("git", ["-C", repoRoot, "rev-parse", "--short=12", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return raw.trim() || null;
  } catch {
    return null;
  }
}

function resolveControlUiBuildId(): string {
  const explicit =
    process.env.OPENCLAW_CONTROL_UI_BUILD_ID?.trim() || process.env.OPENCLAW_VERSION?.trim();
  if (explicit) {
    return normalizeBuildId(explicit);
  }
  const version = readPackageVersion();
  const gitSha = readGitShortSha();
  return normalizeBuildId(gitSha ? `${version}-${gitSha}` : version);
}

/**
 * 把 buildId 写进构建产物里的 `sw.js`（覆盖 publicDir 拷出来的占位符版本）。
 *
 * 读取的是 `public/sw.js` 源文件而不是 dist 里的副本：dist 里那份可能已经是替换过的，
 * 再替换会找不到占位符 —— 而「找不到占位符」是必须报错的信号，不能靠碰运气。
 */
function controlUiServiceWorkerBuildIdPlugin(buildId: string): Plugin {
  let outDir = "";
  return {
    name: "control-ui:service-worker-build-id",
    apply: "build",
    configResolved(config) {
      outDir = path.isAbsolute(config.build.outDir)
        ? config.build.outDir
        : path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const swPath = path.join(outDir, "sw.js");
      const publicSwPath = path.join(here, "public/sw.js");
      const source = fs.readFileSync(publicSwPath, "utf8");
      const placeholder = '"__OPENCLAW_CONTROL_UI_BUILD_ID__"';
      const updated = source.replace(placeholder, JSON.stringify(buildId));
      if (updated === source) {
        throw new Error(`Control UI service worker build id placeholder missing in ${swPath}`);
      }
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(swPath, updated);
    },
  };
}

/**
 * ⚠️ 回调**必须显式标注 `: UserConfig`**，不要靠 `defineConfig` 推导。
 *
 * 本仓同时存在两份 vite（仓库根 `vite@8.1.3`、`web/node_modules/vite@6.4.3`），
 * 而 `@vitejs/plugin-vue` / `@tailwindcss/vite` 返回的 `Plugin<Api>` 与 `vite` 自己导出的
 * `Plugin<any>` 在交叉比较时会让 TS 报 `TS2321 Excessive stack depth`（`vite.config.ts`
 * 里的历史遗留报错就是它，会直接卡住 `npm run build` 的 `vue-tsc` 步骤）。
 * 把返回类型写死成 `UserConfig` 就绕开了整条重载推导路径 —— 旧版 `ui/vite.config.ts`
 * 用的也是这个办法（`export default function X(): UserConfig`）。
 */
export default defineConfig(({ mode }): UserConfig => {
  const env = loadEnv(mode, process.cwd(), "");
  const basePath = env.VITE_BASE_PATH || env.OPENCLAW_CONTROL_UI_BASE_PATH || "./";
  const controlUiBuildId = resolveControlUiBuildId();

  return {
    plugins: [
      vue(),
      tailwindcss(),
      noCacheHtmlMeta(),
      controlUiServiceWorkerBuildIdPlugin(controlUiBuildId),
    ],
    define: {
      OPENCLAW_CONTROL_UI_BUILD_ID: JSON.stringify(controlUiBuildId),
    },
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    server: {
      host: true,
      port: 5273,
      strictPort: true,
      // dev mode：HTML/JS 全 no-store，避免 disk cache 让修改不生效。
      // chunk hash 化 + immutable 是 build mode 的策略；dev 端采用朴素 no-store 即可。
      headers: {
        "Cache-Control": "no-store, must-revalidate",
      },
      proxy: {
        "/control-ui-config.json": {
          target: GATEWAY_TARGET,
          changeOrigin: true,
        },
        "/__openclaw__/avatar": {
          target: GATEWAY_TARGET,
          changeOrigin: true,
        },
        "/__openclaw__/assistant-media": {
          target: GATEWAY_TARGET,
          changeOrigin: true,
        },
        "/api/": {
          target: GATEWAY_TARGET,
          changeOrigin: true,
        },
        "/api/v1/jd/spend": {
          target: GATEWAY_TARGET,
          changeOrigin: true,
        },
      },
    },
    preview: {
      // `vite preview` 同样走默认 cache（heuristic）。
      // build 产物的 index.html 已含 no-cache meta，这里再保险一道 header。
      headers: {
        "Cache-Control": "no-store, must-revalidate",
      },
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      chunkSizeWarningLimit: 2048,
    },
    base: basePath,
  };
});
