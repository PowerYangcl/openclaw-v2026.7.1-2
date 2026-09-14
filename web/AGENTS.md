# Web Control UI Guide

This directory owns the browser Control UI — the in-tree replacement for the legacy `ui/` (Lit + Vite).
It is hosted by the Gateway from `web/dist/` (or `gateway.controlUi.root` if overridden).

## Scope

- Stack: Vue 3 + TypeScript + Vite + Pinia + **Element Plus (native — no `@jdcloud/mobius` wrapper)** + Tailwind 4.
- Lives at `web/`. The Gateway serves `web/dist/index.html` at the configured `gateway.controlUi.basePath`.
- **Full functional parity with the legacy `ui/` is the goal** (22 first-level routes + terminal + config-form). All pages migrate to `web/`; the phasing of those PRs is decided case-by-case.
- Keep web-specific rules here. Repo-global architecture / verification / git workflow rules live in the root `AGENTS.md`.

## i18n

**Deferred.** Migration from `ui/src/i18n/` is tracked in `docs/web/web-replacement-plan.md` §4. Until vue-i18n lands, the legacy UI (`ui/`) keeps the i18n pipeline; `web/` ships with English / browser-locale fallback.

## Terminal page

**Kept.** `web/src/components/terminal/` mirrors `ui/src/components/terminal/`. Dependencies `@openclaw/libterminal` and `ghostty-web` stay in `package.json`. The CSP `wasm-unsafe-eval` exception for `gateway.terminal.enabled === true` still applies — see `src/gateway/control-ui-csp.ts`.

## Build & dev

| Command            | Purpose                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| `pnpm web:install` | Install workspace deps                                                                                         |
| `pnpm web:dev`     | Vite dev server on `:5273`; proxies `/api/`, `/control-ui-config.json`, `/__openclaw__/*` to `127.0.0.1:18789` |
| `pnpm web:build`   | Vite production build → `./dist/` (gateway default root)                                                       |
| `pnpm typecheck`   | `vue-tsc --noEmit` (run as `CODEBUDDY_SAFE_DELETE_ENABLED=0` on this machine)                                  |
| `pnpm test:unit`   | esbuild + node unit tests                                                                                      |
| `pnpm test:e2e`    | CDP smoke against live local gateway                                                                           |

## Boundaries (do not cross)

- **No deep source imports.** Do **not** write `../../../src/...`. Mirror the type locally in `web/src/api/` or consume a published `packages/*` package. The legacy `ui/` directly imports ~30 source files; this is the primary thing we are fixing.
- **No `@openclaw/*` resolving to `extensions/*`.** The repo `tsconfig.json` aliases `@openclaw/*` to `extensions/*`. In `web/`, only `packages/*` and `node_modules/*` are reachable. If you need a `@openclaw/*` symbol, import it explicitly from `packages/<name>/src/...` or re-add the package to `web/package.json`.
- **No raw `window.open`.** The repo lints `lint:ui:no-raw-window-open` — port to `web/` as `lint:web:no-raw-window-open` once the legacy UI is gone.

## Integration contract with the Gateway

| Surface          | URL / path                                                                                                                           | Source of truth                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Bootstrap config | `${basePath}/control-ui-config.json`                                                                                                 | `src/gateway/control-ui-contract.ts`                               |
| WS               | `ws(s)://<host>:<port>/` (same-origin upgrade)                                                                                       | `src/gateway/server-http.ts`                                       |
| Avatar           | `${basePath}/__openclaw__/avatar/<agentId>?token=...`                                                                                | `handleControlUiAvatarRequest`                                     |
| Assistant media  | `${basePath}/__openclaw__/assistant-media?source=...&mediaTicket=...`                                                                | `handleControlUiAssistantMediaRequest`                             |
| Device auth      | ed25519-signed `connect.params.auth.deviceToken`                                                                                     | `src/gateway/device-auth.js` (mirrored in `web/src/api/device.ts`) |
| HTML attrs       | `<html data-openclaw-control-ui-base-path="${basePath}" data-openclaw-terminal-enabled="${bool}">` injected by gateway at serve time | `serveResolvedIndexHtml` in `src/gateway/control-ui.ts`            |

> When the gateway opens `http://127.0.0.1:18789/` the HTML returned is `web/dist/index.html` with these attributes injected. Read them in `web/index.html` (inline script) **before** Vue mounts to avoid FOUC.

## SPA fallback & basePath

Gateway serves `index.html` for any unknown path under the configured `basePath` that does not look like a static asset (`.js .css .map .svg ...`). For sub-route refreshes:

- Set `vite build.base` to the same `basePath` (e.g. `/openclaw/`) so chunks resolve.
- Use `createWebHistory(import.meta.env.BASE_URL)` in `src/router/index.ts`.

## Smoke test (CDP)

Use the `webapp-cdp-smoke` skill. A starter script lives at `tests/smoke/` once the legacy UI is gone; until then reuse the scripts that already cover Chat / Sidebar / ModelSelector.

## Files to inspect first when porting a new bit

- `docs/web/web-replacement-plan.md` — the migration plan with the integration contract.
- `ui/src/api/gateway.ts` — source-of-truth for the WS handshake / device auth / reconnect.
- `ui/src/app-route-paths.ts` — route definitions + `inferBasePathFromPathname`.
- `src/gateway/control-ui-contract.ts` — bootstrap config schema.

## Common gotchas

- Vue 3 `<template v-if>` keeps the SVG namespace through conditions, so inline `<circle>` / `<path>` fallbacks work without `<g>` wrappers.
- `??` does not treat empty string as nullish; funnel through `nonEmpty()` / `normalizeOptionalString()` when reading from storage or RPC.
- `<style scoped>` compiles to `.cls[data-v-xxx]`; DOM injected via `document.createElement` + `innerHTML` will not match — use real elements for hit-test.
- `:deep()` requires an ancestor with `data-v-*`. Popovers teleported to `body` have no scoped ancestor — use an unscoped `<style>` block with unique class names.
