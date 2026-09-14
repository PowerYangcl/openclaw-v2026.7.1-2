# web/ — OpenClaw Web Control UI

> Vue 3 + TypeScript + Vite + Pinia + **Element Plus (native)** + Tailwind 4. The in-tree replacement for `ui/` (Lit + Vite).

This directory hosts the **browser Control UI** served by the Gateway. The Gateway resolves its static asset root to `web/dist/` — the `dist/control-ui/` legacy fallback is removed (release notes must flag the breaking change for old npm consumers).

## Quick start

```bash
# Install deps (in the repo root, once)
pnpm web:install

# Start the Gateway in one terminal…
pnpm gateway:dev

# …then start the web UI dev server in another.
pnpm web:dev
# → http://127.0.0.1:5273/

# Production build
pnpm web:build
# → ./dist/   (Gateway default root)

# Type check
pnpm typecheck

# Unit + CDP smoke
pnpm test:unit
pnpm test:e2e
```

## Integration with the Gateway

- **Bootstrap config**: `${basePath}/control-ui-config.json`. Field set is defined in `src/gateway/control-ui-contract.ts` (OpenClaw source tree).
- **WebSocket**: same-origin `ws(s)://<gateway-host>:<port>/`. Handshake uses ed25519 device identity (`@noble/ed25519`).
- **Avatar / assistant media**: `${basePath}/__openclaw__/avatar/<agentId>` and `${basePath}/__openclaw__/assistant-media?source=...&mediaTicket=...`. The HMAC media ticket is issued by the Gateway; the UI never holds a long-lived media secret.

## Where things live

```
web/
├── AGENTS.md                ← scope rules + integration contract
├── README.md                ← this file
├── index.html               ← entry; gateway injects basePath/terminalEnabled into <html>
├── src/
│   ├── api/                 ← WS client (gateway.ts), device.ts, protocol constants
│   ├── components/          ← ChatAvatar / ChatSidebar / MarkdownView / ModelSelector / AudioPlayer / VoiceButton
│   ├── layouts/MainLayout.vue
│   ├── router/index.ts      ← vue-router; respects import.meta.env.BASE_URL
│   ├── stores/              ← Pinia: agents, gateway, settings
│   ├── styles/main.css
│   ├── utils/               ← sessionKey / avatar / markdown / clipboard / request / sidebarSnapshot
│   └── views/               ← Overview / Chat / Sessions / Channels / Agents / Skills / Cron / Usage / Logs / Config / Login
├── tests/                   ← esbuild unit tests + CDP e2e
└── dist/                    ← vite build output → Gateway default root
```

## Migration plan

The full architectural plan lives at [`docs/web/web-replacement-plan.md`](../docs/web/web-replacement-plan.md). Key rules to honor during day-to-day work:

- **No `../../../src/...` deep source imports.** Mirror types locally or use `packages/*`.
- **No `@openclaw/*` resolving to `extensions/*`.** The repo tsconfig aliases `@openclaw/*` to `extensions/*`; in `web/` only `packages/*` + `node_modules/*` are reachable.
- **No raw `window.open`.** Repo-wide lint keeps the security boundary clean.

## Boundaries with the legacy UI

During the transition, both `ui/` (Lit) and `web/` (Vue) coexist. Operators can pin the Lit UI by setting `gateway.controlUi.root` to an absolute path under `ui/dist`. The full deprecation list lives in [`docs/web/web-replacement-plan.md` §3.6](../docs/web/web-replacement-plan.md#36-清理清单终态独立-pr).

## Decisions (settled 2026-09-13)

1. **i18n — not migrated.** `ui/src/i18n/` + `scripts/control-ui-i18n.ts` keep running until a follow-up PR ports them to vue-i18n.
2. **Terminal (ghostty-web) — kept.** Mirrors from `ui/src/components/terminal/`; CSP `wasm-unsafe-eval` exception still applies when `gateway.terminal.enabled === true`.
3. **All features migrate.** Full parity with `ui/` is the goal (22 routes + terminal + config-form). Phasing decided per PR.
4. **`gateway.controlUi.root` default — option A.** Direct change to `web/dist`; the `dist/control-ui/` fallback is removed (old npm consumers break at upgrade — release notes required).
5. **Element Plus native.** `@jdcloud/mobius` is dropped at migration time; `element-plus` + `@element-plus/icons-vue` replace it.
