import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig, loadEnv } from "vite";

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

const GATEWAY_TARGET = process.env.VITE_GATEWAY_HTTP_URL ?? "http://127.0.0.1:18789";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const basePath = env.VITE_BASE_PATH || env.OPENCLAW_CONTROL_UI_BASE_PATH || "./";

  return {
    plugins: [vue(), tailwindcss()],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    server: {
      host: true,
      port: 5273,
      strictPort: true,
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
    build: {
      outDir: "dist",
      emptyOutDir: true,
      chunkSizeWarningLimit: 2048,
    },
    base: basePath,
  };
});
