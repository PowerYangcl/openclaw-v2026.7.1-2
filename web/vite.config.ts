import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig, loadEnv, type Plugin } from "vite";

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

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const basePath = env.VITE_BASE_PATH || env.OPENCLAW_CONTROL_UI_BASE_PATH || "./";

  return {
    plugins: [vue(), tailwindcss(), noCacheHtmlMeta()],
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
