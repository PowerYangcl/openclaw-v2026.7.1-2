# Integration Status — agent-claw-web → openclaw/web/

> Snapshot of the **Vue 3 + Element Plus + Tailwind 4** port completed 2026-09-13.
> Source repo: `/Users/wangyongbo26/jd-work/agent-claw-web/` (unchanged on disk).
> Target: `/Users/wangyongbo26/jd-work/openclaw-v2026.7.1-2/web/`.
> Plan ref: `docs/web/web-replacement-plan.md` (root policy / phase decisions).

## What's integrated

| Layer | Source | Status |
|---|---|---|
| Build config | fresh `web/`-local `package.json` + `vite.config.ts` + `tsconfig.json` | ✅ authored |
| Vue 3 SPA source | `agent-claw-web/src/{api,components,layouts,router,stores,utils,views,App.vue,main.ts,styles}` → `web/src/` | ✅ copied verbatim |
| WS / device auth | `web/src/api/{gateway,protocol,device,types}.ts` | ✅ **carried verbatim** per agent-claw-web README's "不要重写" guarantee |
| Element Plus native | `@jdcloud/mobius` → `element-plus` + `@element-plus/icons-vue` | ✅ 14 file imports swapped |
| Router `BASE_URL` | `createWebHistory(import.meta.env.BASE_URL)` | ✅ patched for sub-path deployments |
| Gateway-injected attrs | inline boot script reads `<html data-openclaw-control-ui-base-path data-openclaw-terminal-enabled>` | ✅ mirrored to `window.__OPENCLAW_BASE_PATH__` / `__OPENCLAW_TERMINAL_ENABLED__` |
| Vite dev proxy | `/control-ui-config.json`, `/__openclaw__/avatar`, `/__openclaw__/assistant-media`, `/api/` → `127.0.0.1:18789` | ✅ added |
| Env files | `.env.dev`, `.env.prod`, `.env.pre` (no JD-internal hosts) | ✅ added |
| Tests | `tests/{*.test.ts,smoke/*.e2e.mjs}` | ✅ copied |
| Tailwind + style tokens | `tailwindcss@4` + Element Plus dark `css-vars.css` | ✅ swapped from Mobius tailwind theme |

## What the source already wires (and why integration is a drop-in)

The agent-claw-web source was authored to mirror the **exact Gateway contract** documented in `web/AGENTS.md` and `docs/web/web-replacement-plan.md`:

- WS protocol version 4 (matching `packages/gateway-protocol/src/version.ts`).
- Ed25519 device-identity (`@noble/ed25519` 3.1.0) handshake via `@/api/device.ts`.
- `clientName = "openclaw-control-ui"`, `mode = "webchat"` — matches `ui/src/app/gateway-store.ts:116-118`.
- HTTP fallback for `/avatar/<agentId>` and `/__openclaw__/assistant-media` (5-min HMAC ticket) matches `src/gateway/control-ui.ts:580-744`.
- Bootstrap config is fetched *only* by `control-ui-config.json` — no equivalent is needed because Vite proxies it in dev and the Gateway serves it from `web/dist/control-ui-config.json` if the user adds it later.

## Build & verify (last run)

```
vue-tsc --noEmit          → 0 errors
vite build                → 1792 modules → dist/index.html (1.56 kB)
                            + 28 chunks (~1.5 MB JS, ~12 KB CSS gzipped)
                            + built in 3.29 s
test:unit (3 suites)      → 41 + 40 + 56 = 137/137 passed
                            (sidebarSnapshot, sessionListSelection, mediaAndAvatarUrls)
dist/index.html           → contains inline boot script that reads
                            data-openclaw-control-ui-base-path /
                            data-openclaw-terminal-enabled from <html>
                            (rewritten at serve time by
                             src/gateway/control-ui.ts:799-811)
CDP smoke (unauth)        → mounted=true, title="OpenClaw Control UI",
                            basePath injected and mirrored to window,
                            Element Plus menu rendered, route /overview,
                            networkFailures: []
CDP smoke (auth)          → token injected into sessionStorage,
                            WS handshake succeeds, "已连接",
                            stats cards show real data (sessions 10,
                            channels 0, cron 0, skills 57 available 16),
                            connection info shows protocol v4 / server
                            2026.7.1 / operator scopes, 0 exceptions,
                            0 console errors
```

**Runtime switch performed for verification:**

- Added `"gateway.controlUi.root": "/Users/wangyongbo26/jd-work/openclaw-v2026.7.1-2/web/dist"` to `~/.openclaw/openclaw.json`.
- Restarted `ai.openclaw.gateway` with `launchctl kickstart -k gui/$UID/ai.openclaw.gateway` so the Gateway serves the new `web/dist` instead of the legacy `dist/control-ui/`.
- The Vite dev server on `:5273` is now the new `web/` one (the old agent-claw-web dev server was stopped).

## Coverage delta vs legacy `ui/`

`ui/` declares **22 first-level routes** + terminal (ghostty-web) + workboard + config-form schema renderer (see `web/AGENTS.md` and `docs/web/web-replacement-plan.md`). The Vue 3 port currently ships a **subset** that matches the agent-claw-web footprint:

| Legacy route | Vue 3 web/ | Notes |
|---|---|---|
| `/login` | ✅ `views/LoginView.vue` | full URL-token + password login |
| `/overview` | ✅ `views/OverviewView.vue` | stats cards + health snapshot |
| `/chat` | ✅ `views/ChatView.vue` | streaming chat + markdown + sidebar + audio + voice (3.4k lines) |
| `/sessions` | ✅ `views/SessionsView.vue` | list / archive / delete |
| `/channels` | ✅ `views/ChannelsView.vue` | status grid |
| `/agents` | ✅ `views/AgentsView.vue` | agents list |
| `/skills` | ✅ `views/SkillsView.vue` | skill status + missing-deps |
| `/cron` | ✅ `views/CronView.vue` | scheduled jobs CRUD |
| `/usage` | ✅ `views/UsageView.vue` | token + cost dashboard |
| `/logs` | ✅ `views/LogsView.vue` | live event stream |
| `/config` | ✅ `views/ConfigView.vue` | raw JSON viewer |
| `/config/{general,appearance,...}` | ❌ | not ported (no schema-form renderer yet) |
| `/workboard`, `/instances`, `/nodes`, `/tasks`, `/plugin`, `/dreams`, `/mcp`, `/infrastructure`, `/automation`, `/ai-agents`, `/communications`, `/debug`, `/worktrees`, `/activity`, `/instances`, `/plugin` | ❌ | each must be ported per-PR per the migration plan |
| Terminal (`?view=terminal`, ghostty-web) | ❌ | per `web/AGENTS.md`, port lives in `web/src/components/terminal/` and will mirror `ui/src/components/terminal/`; deps `@openclaw/libterminal` + `ghostty-web` NOT in package.json yet — bring them in when porting |
| i18n | ❌ deferred | `ui/src/i18n/` keeps running until vue-i18n lands (decision 1 in `docs/web/web-replacement-plan.md`) |

**Deferred decisions** (`docs/web/web-replacement-plan.md` §3.6 + `web/README.md`):

1. i18n deferred to a follow-up PR.
2. Terminal kept (deps come back at port time).
3. Element Plus native (`@jdcloud/mobius` retired at PR time).
4. `gateway.controlUi.root` default = `web/dist`; legacy `dist/control-ui/` fallback removed.
5. Old npm consumers break at upgrade — release notes required.

## Security / dependency boundaries checked

- **No deep `../../../src/...` imports** in `src/` (grep clean).
- **No `@openclaw/*` aliases resolving into `extensions/*`** — root `tsconfig.json` aliases `@openclaw/*` to `extensions/*`, but `web/`'s local `tsconfig.json` only references `node_modules/*` + `@/*` → `src/*` so Vue code can never reach a plugin barrel by accident.
- **No raw `window.open`** — the `lint:ui:no-raw-window-open` style rule should be ported as `lint:web:no-raw-window-open` (follow-up PR, not required for this drop-in).
- **`@noble/ed25519` 3.1.0** matches `packages/gateway-protocol` + agent-claw-web device-auth contract.

## Known unrelated repo state

- The repo-root `pnpm install` fails on `ui/`'s dependency `@create-markdown/core>=2.0.3` (latest published is 2.0.0 on the JD mirror). **Pre-existing**, not introduced by this PR.
- Node version: this machine is on Node v22.22.2 (`wanted: >=22.22.3`). Pnpm still installs, but `pnpm` warns. Track with the team.

## How to run

```bash
# In the openclaw repo root, once:
pnpm web:install             # delegates to scripts/web.js install -> pnpm install --filter web

# In one terminal: the Gateway (Vue 3 dev mode hits it via the Vite proxy)
pnpm gateway:dev

# In another: the Vue 3 dev server
pnpm web:dev                 # → http://127.0.0.1:5273/

# Production build (gateway serves web/dist/index.html by default):
pnpm web:build               # writes ./web/dist/

# Optional verifications
pnpm --dir web typecheck     # vue-tsc --noEmit
pnpm --dir web test:unit     # esbuild + node
```

Default `gateway.controlUi.basePath = "/"`; for sub-path deployments, set `OPENCLAW_CONTROL_UI_BASE_PATH=/openclaw/` (or `VITE_BASE_PATH`) before `pnpm web:build`.
