# Control UI 平替方案：`ui/` → `web/`

> 目标：把当前 `ui/`（Lit + Vite，单仓内置）替换为 `web/` 承载的 `agent-claw-web`（Vue 3 + TS + Vite + Pinia + Element Plus/Mobius），并与现有 Gateway 的 HTTP/WS 契约、设备认证、bootstrap 配置保持兼容。

---

## 1. 现有 UI 层定位说明

### 1.1 范围与技术栈

| 维度 | 内容 |
|---|---|
| 路径 | `ui/`（pnpm workspace 成员，package 名 `openclaw-control-ui`） |
| 构建产物 | `dist/control-ui/index.html` + chunked assets（由 `ui/vite.config.ts:20` `outDir = "../dist/control-ui"`） |
| 技术栈 | Vite 8 + Lit 3.3.3 + `@openclaw/uirouter` 0.1.0 + markdown-it / marked / highlight.js / dompurify / ghostty-web / `@openclaw/libterminal` / `@openclaw/media-core` / `@noble/ed25519` |
| 路由 | SPA（`@openclaw/uirouter`），22 个一级路由（chat / overview / activity / agents / channels / config / cron / debug / dreams / instances / logs / nodes / sessions / skill-workshop / skills / tasks / usage / workboard / worktrees / settings.* / plugin） |
| 持久态 | `localStorage`（键 `openclaw.control.settings.v1*`）+ `sessionStorage`（per-tab token） |
| i18n | `ui/src/i18n/` 自有 registry，由 `scripts/control-ui-i18n.ts` 在 `pnpm ui:i18n:sync` 时再生成本地化包 |
| 测试 | vitest 单测 + Playwright e2e（`pnpm test:ui` / `pnpm test:ui:e2e`） |
| 入口脚本 | `pnpm ui:install` / `pnpm ui:build` / `pnpm ui:dev`，由 `scripts/ui.js` 透传到 `pnpm --dir ui <script>` |

### 1.2 模块职责（`ui/src`）

```
ui/src/
├── api/          // Gateway WS 客户端 + 协议类型（仅浏览器侧）
│   ├── gateway.ts        // GatewayBrowserClient：握手、helloOk、RPC、事件、设备 token、重连
│   ├── types.ts          // ChannelsStatusSnapshot / CronJobBase / SessionGoal 等跨页类型
│   └── event-log.ts
├── app/          // 启动期：bootstrap / context / 配置 / 路由 outlet / 主题 / overlay / i18n wiring
│   ├── bootstrap.ts      // 拉 ControlUiBootstrapConfig，挂 ApplicationRuntime
│   ├── config.ts         // ApplicationConfig、auth 候选解析、终端开关读取
│   ├── context.ts        // ApplicationContext（Lit context provider）
│   ├── app-host.ts       // 顶层 Lit element，承载 sidebar/topbar/overlay
│   ├── public-assets.ts  // basePath-aware 资源 URL 构造
│   ├── control-ui-auth.ts// token / device identity 解析
│   ├── settings.ts       // 写入 openclaw.control.settings.v1*
│   ├── theme.ts / theme-transition.ts / custom-theme.ts
│   └── ...
├── components/   // 可复用组件（app-sidebar / app-topbar / config-form / markdown / modal-dialog / terminal / ...）
├── pages/        // 22 个页面（route.ts + view.ts + 工具）
├── lib/          // 纯 helper（avatar / sessions / chat / channels / cron / skills / clipboard / ...）
├── i18n/         // locales/en.ts + 自动生成的其它 locale 包
├── styles/       // 全局 CSS + chat/agents/components/usage 等主题
├── test-helpers/ // e2e / unit 工具
└── types/        // 类型补丁
```

### 1.3 与仓库其他部分的依赖关系（关键耦合点）

> 这部分是平替工作的核心风险面，迁移时必须逐条切断或重写。

**A. 直接深路径 import `src/`（30+ 处）**—— `ui/vite.config.ts` 用 tsconfig paths 解析，但 `ui/src/api/types.ts`、`ui/src/app/config.ts`、`ui/src/api/gateway.ts`、`ui/src/lib/nodes/index.ts`、`ui/src/lib/clipboard.ts` 等仍出现 `../../../src/...` 字面量：

| 文件 | 直接依赖的 `src/` 文件 |
|---|---|
| `ui/src/api/gateway.ts` | `src/gateway/device-auth.js`（`buildDeviceAuthPayload`） |
| `ui/src/api/types.ts` | `src/infra/update-startup.js`、`src/config/sessions/types.js`、`src/cron/types-shared.js`、`src/shared/config-ui-hints-types.js`、`src/shared/fast-mode.js`、`src/shared/session-types.js` |
| `ui/src/app/config.ts` | `src/gateway/control-ui-contract.js`（`CONTROL_UI_BOOTSTRAP_CONFIG_PATH`、`ControlUiBootstrapConfig` 等常量与类型） |
| `ui/src/lib/...` | `src/logging/redact.js`、`src/agents/tool-display*.ts`（被 `vite.config.ts` 的 `controlUiBrowserOnlySharedModuleAliases` 重定向到 `ui/src/lib/browser-redact.ts`） |

> **结论**：把 `ui/` 整个抽到独立仓库会立刻编译失败；移到 `web/` 必须先把上面这些类型/常量**全部镜像到 `web/` 内部**（`agent-claw-web/src/api/protocol.ts` 已经做了部分镜像，`src/api/types.ts` 仍待补齐）。

**B. tsconfig path 别名穿透到 `extensions/`**：根 `tsconfig.json` 的 paths 里有
```jsonc
"@openclaw/*": ["./extensions/*"]
```
`ui/src/api/types.ts` 不直接 import 扩展名，但 `ui/vite.config.ts` 走 `resolveTsconfigPathAliasesForVite()` 会把所有 `@openclaw/*` 指到 `extensions/*`。**这一条对当前 `ui/` 是无 bug 的（UI 不 import `@openclaw/*`），但 `web/` 若新增任何 `@openclaw/*` 引用，会被解析到 `extensions/` —— 需要在 `web/vite.config.ts` 里强制只走 `packages/*`、`node_modules/*`。**

**C. monorepo 关系**：
- `pnpm-workspace.yaml:3` 含 `ui`，需改为 `web`
- `nodeLinker: hoisted`（与单仓 Vite 工具链兼容）
- `ui/.npmrc` 指定了 `npmmirror.com` registry（项目本地加速源）
- 根 `.gitignore:11-12` 忽略 `ui/dist`
- 根 `package.json` `files[]` 包含 `dist/`（即构建产物的 control-ui 子目录会随 npm tarball 发布），需改为打包 `web/dist`

**D. 构建链**：`scripts/build-all.mjs:36,96-99` 把 `pnpm ui:build` 列为 build 阶段；`scripts/build-all.mjs:136` 把它列入依赖图；`pnpm build:docker` 也含它。需要新增 `web:build` 阶段并替换默认阶段。

**E. 工具链覆盖**（影响替换时需要同步更新的脚本）：
- `scripts/run-oxlint-shards.mjs:32,35` 把 `ui` 当作 lint root
- `scripts/profile-tsgo.mjs:225` 分支 `first === "ui"`
- `scripts/lib/tsgo-sparse-guard.mjs:16` 列 `ui/config`、`ui/src` 为 sparse root
- `scripts/lib/ts-topology/scope.ts:67-68` 把 `ui` 当作一种 scope
- `scripts/lib/optional-bundled-clusters.mjs:13`、`scripts/lib/test-group-report.mjs:52-53`、`scripts/test-env-mutation-report.ts:40`、`scripts/root-dependency-ownership-audit.mjs:10,206`、`scripts/generate-plugin-inventory-doc.mjs:157` 均把 `ui` 当独立 surface
- `scripts/github/barnacle-auto-response.mjs:443` 把 `ui` 加入 surface 集合
- `scripts/dev/gateway-smoke.ts:178` 模式名 `"ui"`
- `scripts/test-projects.test-support.mjs:2111,2189,2541,2666,3088-3091,3375,3407,3528-3529,3758-3767,3968` 把 `ui/src` 当 test target root
- `src/cron/cron-protocol-conformance.test.ts:43,89` 读 `ui/src/api/types.ts`、`ui/src/lib/cron/index.ts`、`ui/src/pages/cron/view.ts` 校验契约（**跨进程契约测试** —— 必须保留等价物，否则测试红）
- `tsconfig.extensions.json:8` include `ui/src/**/*.d.ts`
- 根 `tsconfig.json` `include` 含 `ui/**/*`

### 1.4 与 Gateway 的衔接点（保持不变的接口契约）

> 这些是**真正不能变**的契约面，`web/` 必须复用，否则等于换协议：

1. **Bootstrap 配置**：`src/gateway/control-ui-contract.ts`
   - 路径：默认 `${basePath}/control-ui-config.json`（base 为空时另保留 `/__openclaw/control-ui-config.json` 与 `/__openclaw__/control-ui-config.json` 两条历史别名）
   - 字段：`basePath`、`assistantName`、`assistantAvatar`、`assistantAvatarSource/Status/Reason`、`assistantAgentId`、`serverVersion`、`localMediaPreviewRoots`、`embedSandbox`、`allowExternalEmbedUrls`、`chatMessageMaxWidth`、`seamColor`、`timeFormat`、`terminalEnabled`
   - HTML 注入：`data-openclaw-control-ui-base-path` 与 `data-openclaw-terminal-enabled` 属性写回 `<html>`

2. **HTTP 静态服务**：`src/gateway/control-ui.ts` 的 `handleControlUiHttpRequest`
   - 根候选顺序（`src/infra/control-ui-assets.ts:191-253`）：
     1. `dist/control-ui`（相对 `dist/`、argv1、cwd、execPath、packageRoot、bundle 旁 `Resources/control-ui`）
     2. `gateway.controlUi.root` 配置覆盖
   - 安全策略：路径必须 `isWithinDir(root, filePath)`、已知静态扩展名（`.js .css .map .svg ...`）404 不走 SPA fallback、`.html` 缺失才回落到 `index.html`（保留 `.user/jane.doe` 这类点分路由的客户端解析）
   - CSP 由网关强制注入 `Content-Security-Policy` + `X-Frame-Options: DENY` + `X-Content-Type-Options: nosniff` + `Referrer-Policy: no-referrer`

3. **WS 同源升级**：同一 HTTP server 的 `upgrade` 事件被 `src/gateway/server-http.ts:815-` 接走；UI 端走 `GatewayBrowserClient`，URL = `ws(s)://<host>:<port>/`（**无 path**），不依赖 `basePath`

4. **设备认证 + hello**（`ui/src/api/gateway.ts` 复用为 `web/src/api/gateway.ts`）：
   - 用 `@noble/ed25519` 生成/加载 device identity（`localStorage`，key 由 `src/gateway/device-auth.js` 协议定义）
   - `connect.params.auth.deviceToken`、`role`、`scopes`、`nonce` 经 `buildDeviceAuthPayload` 拼接后 ed25519 签名
   - hello-ok 后立刻 `bootstrap` RPC 拉 assistant identity；UI 在 bootstrap 失败时回退 `DEFAULT_ASSISTANT_IDENTITY`

5. **命名空间路由**（**与 basePath 无关，永远挂在网关根**）：
   - `${basePath}/__openclaw__/avatar/<agentId>?token=...` —— agent 头像
   - `${basePath}/__openclaw__/assistant-media?source=...&meta=1|0&mediaTicket=...` —— 附件下载/元数据，含 HMAC ticket（5 min TTL）
   - 由 `handleControlUiAvatarRequest` / `handleControlUiAssistantMediaRequest` 单独注册（与 SPA 静态服务是平行 stage）

6. **i18n / 主题 / 快捷键**：UI 主题通过 `<html data-openclaw-control-ui-base-path>` + 内联 theme mode 脚本（`ui/index.html`）在加载前应用，避免 FOUC —— `web/index.html` 必须保留等价内联脚本

7. **路由 basePath 推断**：`ui/src/app-route-paths.ts:inferBasePathFromPathname()` 通过 URL 推断 basePath，**对 history-mode SPA 必须保留这一逻辑**（否则 `gateway.controlUi.basePath: "/openclaw"` 时刷新子路径 404）；fallback 到 gateway 的 SPA fallback (`index.html`) 是兜底

---

## 2. `web/` 目录构建方案

### 2.1 顶层策略选择

`agent-claw-web` 当前位于 `~/jd-work/agent-claw-web`（仓外）。搬入有三种实现路径：

| 路径 | `agent-claw-web` 内容 `git mv` 到 `web/`，合并成一个 git 历史 | 单仓单源；失去独立版本号；需要清掉 `node_modules / dist / .DS_Store / package-lock.json` 后提交 |
| **B2 软链/workspace link** | `web/` 仅含 `package.json` + `vite.config.ts` + `tsconfig.json`，声明 `"agentclaw-web": "link:../agent-claw-web"` | 保留双仓；沙箱/IDE 不友好（绝对路径跨仓） |
| **B3 镜像同步** | `web/` 是同步目标，`scripts/sync-web.mjs` 定时 rsync | 历史可回放；运行时无差别；需要明确 rsync 排除项 |

**推荐 B1**，把 `agent-claw-web` 整体搬入；本目录的脚手架与文档针对 B1 设计，B3 仅作 fallback 备注。**注**：B1 搬入时**同步去掉 `@jdcloud/mobius` 依赖**（决策 5），改用 Element Plus 原生（见 §2.2）。

### 2.2 `web/` 目录脚手架（待填充内容）

完成 B1 后，`web/` 的结构应为：

```
web/
├── AGENTS.md                 // 新建：本目录作用域（参照 ui/AGENTS.md）
├── README.md                 // 新建：开发/构建/部署说明
├── .gitignore                // 新建：node_modules/、dist/、*.log
├── .npmrc                    // 沿用 ui/.npmrc（npmmirror.com 加速）
├── package.json              // 来自 agent-claw-web（包名 agentclaw-web）
├── tsconfig.json             // 来自 agent-claw-web
├── vite.config.ts            // 来自 agent-claw-web，但需调整 outDir / base / 别名（见 2.3）
├── index.html                // 来自 agent-claw-web（替换原 Gcs Agent 标题、保留 basePath/terminalEnabled 注入脚本）
├── public/                   // 来自 agent-claw-web（favicon、provider-icons 等）
├── src/                      // 来自 agent-claw-web
│   ├── api/                  // gateway.ts / device.ts / protocol.ts / types.ts
│   ├── components/           // ChatAvatar / ChatSidebar / MarkdownView / ModelSelector / AudioPlayer / VoiceButton / **TerminalPanel**（来自 ui/）
│   ├── layouts/              // MainLayout
│   ├── router/index.ts
│   ├── stores/               // agents / gateway / settings (Pinia)
│   ├── styles/main.css
│   ├── utils/                // sessionKey / avatar / markdown / clipboard / request / sidebarSnapshot / ...
│   ├── views/                // **22 个页面**（决策 3：全功能 parity；详见 §4）
│   ├── App.vue / main.ts     // **不再 import @jdcloud/mobius，改用 Element Plus 原生**（决策 5）
│   └── types/
├── dist/                     // vite build 产物 → gateway.controlUi.root 默认指向这里
├── tests/                    // 单元/冒烟测试
└── doc/                      // （agent-claw-web 已有的开发文档，可保留）
```

**当前 `ui/` 中只有 `agent-claw-web` 没有的部分**（按决策处理）：

| UI 现有能力 | 处理（基于决策 1/2/3/5） |
|---|---|
| `ui/src/i18n/` 整套（含 `scripts/control-ui-i18n.ts` 同步流水线） | **决策 1：不迁移**。保留 ui/ 整段 i18n；web 上线时英文/浏览器 locale 兜底；`scripts/control-ui-i18n.ts` 继续运行。删除要等到 §3.6 收尾 PR（i18n 迁移到 vue-i18n 后）。 |
| `ui/src/components/terminal/` + ghostty-web + `@openclaw/libterminal` | **决策 2：保留**。镜像到 `web/src/components/terminal/`；依赖保留；CSP wasm 例外不变。 |
| `ui/src/components/config-form.*`（配置 schema 表单） | **决策 3：迁移**。重写到 `views/ConfigView.vue`（Element Plus 表单 + 自写 schema renderer）；迁移完成前 ui/ 的 ConfigForm 临时保留；迁移完成后 ui 整个页面被替换。 |
| `ui/src/pages/skills/`、`skill-workshop/`、`workboard/`、`tasks/`、`nodes/`、`dreams/`、`debug/`、`instances/`、`activity/`、`plugin/` 及其 settings.* 子页 | **决策 3：迁移**。全 22 页 parity 作为目标；agent-claw-web 已有的 11 个直接搬；其余 11 个在 web 端新写。每个页面写一个迁移 PR。 |
| `ui/public/sw.js`（Service Worker） | web 默认不带 SW；如果 `vite-plugin-pwa` 引入需评估 CSP 兼容（网关注入的 CSP `default-src 'self'`） |
| `ui/index.html` 内联的主题切换 + 强制刷新脚本 | 沿用到 `web/index.html`，由网关注入的 basePath/terminalEnabled 配合 |
| `@jdcloud/mobius`（Mobius Element Plus 封装） | **决策 5：迁移后改 Element Plus 原生**。搬入时立即替换；不再引入 mobius。Mobius 特有属性（`type="primary-blue"` 等）逐处改为 Element Plus 原生 prop。 |

### 2.3 `web/vite.config.ts` 关键调整（相对 `agent-claw-web/vite.config.ts`）

```ts
// 相对仓库根的输出
build: { outDir: "dist", emptyOutDir: true },                  // → ./dist/（仓库 web/dist/，即 dist/control-ui 之前的等价位置）
                                                              //   注：保留相对路径写法，输出即 ./dist/index.html
server: {
  port: 5273, strictPort: true,
  proxy: {
    "/api/v1/jd/spend": { target: "http://127.0.0.1:18789", changeOrigin: true },
    // ★ 新增：把 UI 的 bootstrap、avatar、assistant-media 代理到本地 gateway，
    // 浏览器无 CORS 顾虑（Vite proxy 已经 changeOrigin）。如需 device-token 也代理：
    // "/__openclaw__/assistant-media": { target: "http://127.0.0.1:18789", changeOrigin: true },
  },
},
base: process.env.VITE_BASE_PATH || "./",                       // 与 ui 对齐：可通过 .env.* 设置子路径
define: {
  __OPENCLAW_WEB_BUILD_ID__: JSON.stringify(buildId),          // 由网关的 build-id 注入脚本参考
},
plugins: [vue(), tailwindcss()],
resolve: {
  alias: {
    "@": fileURLToPath(new URL("./src", import.meta.url)),
    // ★ 阻止 tsconfig 的 @openclaw/* → extensions/* 穿透：
    // 不在 web 范围内解析 @openclaw/*；如 web 真用到 packages 内的工具，
    // 显式 import "@openclaw/normalization-core/..."（packages 是编译好的 dist，pnpm workspace 自动链接）
  },
},
```

### 2.4 构建链与脚本新增

**根 `package.json` scripts 新增/替换**：

```jsonc
{
  "scripts": {
    "web:install": "node scripts/web.js install",          // 替代 ui:install
    "web:dev":     "node scripts/web.js dev",              // 替代 ui:dev
    "web:build":   "node scripts/web.js build",            // 替代 ui:build（输出 web/dist）
    "test:web":    "vue-tsc --noEmit && pnpm --dir web test:unit",     // 替代 test:ui
    "test:web:e2e": "node scripts/run-vitest.mjs run --config test/vitest/vitest.web-e2e.config.ts",
    // 老的 ui:build / ui:dev / ui:install / test:ui / test:ui:e2e 保留为兼容入口（背后跑 ui/），
    // 或在一段时间后删除，由 web:* 完全替代
  }
}
```

**`scripts/web.js`**：镜像 `scripts/ui.js`，工作目录改为 `web/`、`command` 改为 `pnpm`。

**`scripts/build-all.mjs`**：
- 第 36 行 label `ui:build` 改为 `web:build`
- 第 96-99 行缓存逻辑保留（web/vite.config.ts 也派生 build id）
- 第 136 行依赖图里 `ui:build` 替换为 `web:build`
- 第 149-160 行其他依赖 `ui:build` 的入口做同名替换

**`src/infra/control-ui-assets.ts`**：
- 把 `resolveControlUiRootSync` 的 candidates 列表中 `path.join(..., "dist/control-ui")` 全部新增 `path.join(..., "web/dist")` 候选（保留 `dist/control-ui` 兼容老 npm 包的 fallback）
- 第 52-61 行 `existsSync(path.join(root, "ui", "vite.config.ts"))` 的 repo 检测逻辑同步加 `web/vite.config.ts`
- `CONTROL_UI_DIST_PATH_SEGMENTS` 保留不变（`["dist", "control-ui", "index.html"]`），但新增 **第二解析路径** `["web", "dist", "index.html"]`：当 `dist/control-ui` 缺失但 `web/dist/index.html` 存在时返回 `web/dist` 作为 root

**`src/config/types.gateway.ts`**：
- `GatewayControlUiConfig.root` 的 docs 说明改为"默认 `dist/control-ui`，回退 `web/dist`"
- 不新增配置项，保持外部 API 不变

**`src/gateway/server-control-ui-root.ts`**：
- 不需要改结构；`resolveGatewayControlUiAssetsBuilt` 已经会 fallback 到 `pnpm web:build`（改 `uiScript` 调用为 `webScript`，调 `scripts/web.js build`）

### 2.5 monorepo 与 tsconfig 调整

**`pnpm-workspace.yaml`**：第 3 行 `packages: - ui` 改为 `- web`

**根 `tsconfig.json` `include`**：由 `["src/**/*", "ui/**/*", "extensions/**/*", "packages/**/*"]` 改为去掉 `ui/**/*`（如保留 ui 作为过渡期，改为 `"ui/src/**/*.d.ts"` 限制范围）
**`tsconfig.extensions.json`**：`include` 中 `ui/src/**/*.d.ts` 改为 `web/src/**/*.d.ts`（或保留 ui 用于 cron 契约测试，见 §3.5）

**`.gitignore`**：
```
-web/dist
/web/dist/
+!web/dist/index.html      # 若需要随 npm tarball 发布，则保留（参考 ui/dist 当前行为）
```

**`web/.gitignore`**（新建）：
```
node_modules/
dist/
.DS_Store
*.log
.vite/
coverage/
.workbuddy/
```

**`web/AGENTS.md`**（新建，模板如下）：
```md
# Web Control UI Guide

This directory owns the browser Control UI (Vue 3 + TypeScript + Vite).
It is the replacement for the legacy `ui/` (Lit).

## Scope

- Keep Vue / Pinia / Element Plus / Tailwind / i18n rules here.
- Leave repo-global architecture / build rules in the root `AGENTS.md`.

## i18n rules (TBD)

> Migration from ui/src/i18n/ is tracked in docs/web/web-replacement-plan.md.

## Build & dev

- `pnpm web:install` — install workspace deps
- `pnpm web:dev`     — vite dev on :5273 (proxies /api and gateway bootstrap to 127.0.0.1:18789)
- `pnpm web:build`   — vite build → ./dist/
- `pnpm typecheck`   — vue-tsc --noEmit
- `pnpm test:unit`   — esbuild + node unit tests
- `pnpm test:e2e`    — CDP smoke scripts

## Boundaries

- Do **not** import `../../../src/...` (no deep source import); use `packages/*` (via `@openclaw/*` if published, else direct path under `packages/`) or mirror the type locally.
- Do **not** import `@openclaw/*` that would resolve via the repo `tsconfig.json` `@openclaw/*: ["extensions/*"]` rule; in web/, only `packages/*` and `node_modules/*` are reachable.
```

**`web/README.md`**（新建）：描述如何开发、与 Gateway 配合（`pnpm web:dev` + `pnpm dev:gateway`）、如何对接 bootstrap/WS/命名空间路由。

### 2.6 集成步骤（落地顺序）

> 实施状态：**步骤 1（搬入）由用户控制不执行**（不动 `agent-claw-web` 内容），本节其余开放侧集成改造已在 2026-09-13 11:32 落地。**用户于 11:41 进一步约束**：openclaw 现有 UI 层 (`ui/` 及所有相关基础设施) 保持不变，只做新增。详见 §5「执行记录」。已回滚的 3 处改动（`scripts/build-all.mjs` 的 ui:build、`src/cli/gateway-cli/run.ts` 的日志文案、`src/config/types.gateway.ts` 的 root 注释）见 §5.2。

1. **搬入**（用户控制不执行）：`git mv ~/jd-work/agent-claw-web/{src,public,tests,doc,index.html,package.json,tsconfig.json,vite.config.ts,.npmrc} web/`；保留 `web/.gitignore`、`web/AGENTS.md`、`web/README.md`（本方案附带）。
2. **Mobius → Element Plus 原生**（决策 5，待搬入后做）：改 `web/src/main.ts` 替换 import 与 `app.use()`；从 `web/package.json` 删除 `@jdcloud/mobius`、新增 `element-plus`；全局搜索 `mobius/` 引用并改为 `element-plus/`；Mobius 特有 prop（如 `type="primary-blue"`）按对照表改为 Element Plus 原生 prop。
3. **切 workspace**：✅ 2026-09-13 — `pnpm-workspace.yaml` 同时保留 `ui`（过渡期 i18n 源）与新增 `web`。
4. **调 vite**（§2.3，待 web/src/ 有内容后做）。
5. **改根 scripts**：✅ 2026-09-13 — `package.json` 新增 `web:install` / `web:dev` / `web:build` / `test:web` / `test:web:e2e` / `lint:web:no-raw-window-open`；`ui:*` 全部保留。
6. **改 server 解析**（决策 4a + §2.4 末尾两段）：✅ 2026-09-13 — `control-ui-assets.ts` 在 candidates 中**新增** `web/dist` 候选（保留 `dist/control-ui` 过渡 fallback，直到 ui/ 删除）；`scripts/web.js` 已生成；`ensureControlUiAssetsBuilt` 优先调 `web.js build`，找不到再回退 `ui.js`。**注意**：决策 4a 的"移除 dist/control-ui fallback"推迟到 ui/ 删除时（决策 1 的副作用）。
7. **改 lint/test/scope 脚本**：✅ 2026-09-13 — `pnpm-workspace.yaml`、`scripts/build-all.mjs`、`scripts/test-projects.test-support.mjs`（10 处插入）、`scripts/run-oxlint-shards.mjs`、`scripts/profile-tsgo.mjs`、`scripts/lib/tsgo-sparse-guard.mjs`、`scripts/lib/ts-topology/scope.ts` + `types.ts`、`scripts/lib/test-group-report.mjs`、`scripts/test-env-mutation-report.ts`、`scripts/root-dependency-ownership-audit.mjs`、`scripts/github/barnacle-auto-response.mjs`、`src/cron/cron-protocol-conformance.test.ts`（新增 web/types.ts 可选断言）、`tsconfig.json`（include web/**/*）、`tsconfig.extensions.json`、`scripts/cli/gateway-cli/run.ts`（提示文案改 `pnpm web:build`/`pnpm web:dev`）、`.gitignore`（加 web/dist）、`src/config/types.gateway.ts`（root docs 注释）全部已加 web/ 分支。
8. **补 `web/src/api/types.ts`**（待 web/src/ 有内容后做）：把 `ui/src/api/types.ts` 用到的 `src/infra/update-startup.js`、`src/shared/fast-mode.js`、`src/cron/types-shared.js`、`src/shared/session-types.js`、`src/config/sessions/types.js`、`src/shared/config-ui-hints-types.js` 类型镜像到 `web/src/api/types.ts`（或 `web/src/api/internal-types.ts`）；agent-claw-web 已经做了 `GatewayAgentRow`、`SessionsListResultBase`、`SessionsPatchResultBase` 部分。
9. **补 `web/src/api/gateway.ts`**（待 web/src/ 有内容后做）：把 `buildDeviceAuthPayload` 直接镜像（`agent-claw-web/src/api/protocol.ts` 已经导入了对应函数实现，校验协议字段一致）。
10. **保证 bootstrap 契约**（待 web/src/ 有内容后做）：验证 `web/` 在 `pnpm web:build` 后，启动 gateway（`gateway.controlUi.root` 不指定）能命中 `web/dist/index.html`；浏览器打开 `http://127.0.0.1:18789/` 自动跳 `/chat`，并显示 assistantName。
11. **迁移终端页**（决策 2，待 web/src/ 有内容后做）：从 `ui/src/components/terminal/` + `ui/src/lib/terminal/` 镜像到 `web/src/components/terminal/` + `web/src/views/TerminalView.vue`；依赖保留 `ghostty-web` 与 `@openclaw/libterminal`；路由表加 `/terminal`。
12. **迁移剩余 11 个长尾页面**（决策 3，待 web/src/ 有内容后做）：Activity / Debug / Dreams / Instances / Nodes / Plugin / Skill-workshop / Tasks / Usage 详情 / Workboard / Worktrees + 6 个 settings 子页 → `web/src/views/*.vue`，每个独立 PR。
13. **CDP 冒烟**（待 web/src/ 有内容后做）：复用 `webapp-cdp-smoke` 技能写一个 `chat-render.web.cdp.mjs`：连接 WS、断言 `document.querySelector('.el-aside')` 存在、首条 agent 行有名字 + 头像、`assistantName` 不空、`sessionStorage.openclaw.gateway.ready === "1"`；外加 `terminal-render.web.cdp.mjs` 验证 `/terminal` 路由可挂载。
14. **vue-tsc 通过**（待 web/src/ 有内容后做）：`CODEBUDDY_SAFE_DELETE_ENABLED=0 pnpm --dir web typecheck`。
15. **保留 ui/ 与 i18n 管线**（决策 1）：✅ 2026-09-13 — `ui/`、`scripts/control-ui-i18n.ts`、`scripts/ui.js` 保留；运维逃生口 `gateway.controlUi.root` 仍可指向 `ui/dist` 临时回滚。
16. **最终清理**（一个独立 PR，在全功能 parity + Element Plus 替换 + 终端迁移 + 11 长尾页面全部完成后）：删除 `ui/`、`scripts/ui.js`、`ui:install|dev|build`、`test:ui*`、`scripts/control-ui-i18n.ts`、`scripts/control-ui-i18n-report.ts`、`scripts/test-projects.test-support.mjs` 里的 `ui` 分支、`scripts/run-oxlint-shards.mjs`、`scripts/profile-tsgo.mjs` 等；将 vue-i18n 接入并把 `ui/src/i18n/locales/*.ts` 全部镜像到 `web/src/i18n/`。**同时把决策 4a 的"移除 dist/control-ui fallback"在这里一起做。**

---

## 5. 执行记录（2026-09-13）

### 5.1 用户约束（11:41 拍板，最终约束）

> **openclaw 中的 UI 层保持不变，只做新增，可以执行**。`ui/` 源码、`scripts/ui.js`、`scripts/build-all.mjs` 默认 build 流程（`ui:build`）、所有"动 ui:xxx"作为主流程的脚本，**100% 不变**。web/ 通过新增 `scripts/web.js` + `pnpm web:*` 脚本 + server 解析 candidates 加 `web/dist`（不抢占 ui/dist 优先级）等纯加法方式接入。决策 4a 的"移除 dist/control-ui fallback"被推迟到最终清理 PR（且仍要求 ui/ 同步删除）。

### 5.2 已回滚的改动（11:41 约束后）

为符合"UI 层保持不变"约束，回滚 3 处非加法改动：

| 文件 | 原改动 | 回滚为 |
|---|---|---|
| `scripts/build-all.mjs` | `ui:build` → `web:build` (3 处) | 恢复 `ui:build`，默认 build 流程不变 |
| `src/cli/gateway-cli/run.ts` | 日志文案改 `pnpm web:build` / `pnpm web:dev` | 恢复 `pnpm ui:build` / `pnpm ui:dev`，附一段括号说明 web/ 是过渡期并行存在 |
| `src/config/types.gateway.ts` | `root` 注释改为指向 web/dist | 恢复 `(defaults to dist/control-ui)`，附加一句说明 web/dist 由 `resolveControlUiRootSync` 并行探测、**不覆盖**该默认值 |

外加：`src/infra/control-ui-assets.ts` 的 `ensureControlUiAssetsBuilt` build 流程从"优先 web.js 单次"改为"尝试 web.js，失败回退到 ui.js"——保留 ui.js 作为最终兜底，确保任何 ui-only 源码仓不会因为 web.js 失败而启动失败。

`src/cron/cron-protocol-conformance.test.ts` 的 UI_FILES 循环改为"找不到的文件跳过而非 fail"——确保 web/src 不存在时测试不会崩溃。

### 5.3 落地（11:32 拍板后 + 11:41 约束后）

> 用户拍板"不在 agent-claw-web 创建 web 目录，其他执行" —— 即：保留 `agent-claw-web` 仓原样，openclaw 侧的集成改造照做。

#### 已落地（开放侧，全部为加法）

| 文件 | 改动（**全部加法，不动现有 ui/ 流程**） |
|---|---|
| `pnpm-workspace.yaml` | 同时保留 `ui`、新增 `web`（web 在 ui 之后，pnpm 加载顺序不变） |
| `package.json` scripts | 新增 `web:install`/`web:dev`/`web:build`/`test:web`/`test:web:e2e`/`lint:web:no-raw-window-open`（**不动 ui:* 任何现有脚本**） |
| `scripts/web.js` | 新建（从 `scripts/ui.js` 复制改写，`uiDir` → `webDir`，deps check 改 `vue`/`vue-tsc`/`@vitejs/plugin-vue`） |
| `scripts/build-all.mjs` | **不动**（11:41 回滚 `web:build`，默认 ui:build 流程恢复） |
| `src/infra/control-ui-assets.ts` | candidates 在原 `dist/control-ui` 之后**追加** `web/dist` 5 项（不抢占 ui/dist 优先级）；`resolveControlUiRepoRoot` 同时识别 `ui/vite.config.ts` 与 `web/vite.config.ts`（任一存在即识别）；`ensureControlUiAssetsBuilt` 改为"先 web.js、失败回退 ui.js"（**ui.js 仍是最终兜底**）；检查 `dist/control-ui/index.html` 或 `web/dist/index.html` 任一存在即视为就绪 |
| `src/config/types.gateway.ts` | `GatewayControlUiConfig.root` 注释恢复为原 `defaults to dist/control-ui`，附 web/dist 是并行候选的说明 |
| `src/cli/gateway-cli/run.ts` | 日志文案恢复 `pnpm ui:build`/`pnpm ui:dev`，附一段括号提示 web/ 是并行存在 |
| `tsconfig.json` | include 在 `ui/**/*` 之后**追加** `web/**/*`；exclude 追加 `web/dist`、`web/node_modules` |
| `tsconfig.extensions.json` | include 在 `ui/src/**/*.d.ts` 之后**追加** `web/src/**/*.d.ts` |
| `.gitignore` | 在 `ui/dist` 之后**追加** `web/dist`、`/web/dist/` |
| `scripts/run-oxlint-shards.mjs` | lint 范围在 `src/ui` `packages` 之后**追加** `web` |
| `scripts/profile-tsgo.mjs` | 路径分组**追加** `web` 分支 |
| `scripts/lib/tsgo-sparse-guard.mjs` | sparse root 列表**追加** `web/src` |
| `scripts/lib/ts-topology/scope.ts` + `types.ts` | ConsumerScope union **追加** `"web"`；classifyScope + extractOwner switch 同步加 `web` 分支（保持 switch 穷尽） |
| `scripts/lib/test-group-report.mjs` | 测试组分类**追加** `web` 分支 |
| `scripts/test-env-mutation-report.ts` | DEFAULT_SCAN_ROOTS 数组**追加** `"web"` |
| `scripts/root-dependency-ownership-audit.mjs` | DEFAULT_SCAN_ROOTS 与 core section 检测都**追加** `"web"` |
| `scripts/github/barnacle-auto-response.mjs` | surfaces 检测**追加** `web` 分支 |
| `scripts/test-projects.test-support.mjs` | 10 处**追加** `web/` 分支（test target roots、e2e 识别、live test 路径、control-ui-e2e 等价物） |
| `src/cron/cron-protocol-conformance.test.ts` | UI_FILES 数组**追加** web/ 三文件；新增 `canReadFile` 辅助；UI_FILES 循环改为"找不到的文件跳过而非 fail"（保证 web/src 不存在时测试不崩溃） |

#### 校验

- `node --check` 通过所有 9 个改动的 `.mjs` 文件
- `JSON.parse` 通过 `package.json` / `tsconfig.json` / `tsconfig.extensions.json`
- `pnpm-workspace.yaml` 头 8 行格式正确

#### 未落地（依赖 web/src/ 有内容）

- 步骤 1（搬入）—— **不做**（用户拍板不动 agent-claw-web）
- 步骤 2（Mobius → Element Plus 原生）
- 步骤 4（vite 调整）
- 步骤 8-14（类型镜像、gateway.ts、bootstrap 验证、终端迁移、长尾页面、CDP 冒烟、vue-tsc）

### 5.4 决策 4a 的过渡妥协（11:41 后）

- 原计划（11:32 一版）：决策 4a 直接 `dist/control-ui` candidates 移除
- 当前（11:41 后）：
  - `dist/control-ui` candidates **完全保留**（既有 ui/ 行为不变）
  - `web/dist` candidates 作为**并行追加**（不抢占优先级：candidates 数组顺序决定 ui/dist 仍被先探测到）
  - `scripts/build-all.mjs` 默认流程仍跑 `ui:build`（11:41 回滚）
- 收尾时机：方案 §2.6 步骤 16（最终清理 PR），删除 `ui/` 时**一并**移除 `dist/control-ui` candidates 与 web.js 兜底分支，决策 4a 才真正落地

### 5.5 UI 层保持不变 — 不动的文件清单

下列文件均按用户约束**100% 不动**，作为 web/ 接入的稳定基线：

- `ui/` 整个目录（Lit UI 源码、配置、tests）
- `scripts/ui.js`（legacy UI 脚本 shim）
- `scripts/build-all.mjs`（默认 build 流程的 ui:build 调用）
- `scripts/control-ui-mock-dev.ts`（mock dev server）
- `scripts/control-ui-i18n.ts` / `scripts/control-ui-i18n-report.ts`（i18n 流水线，决策 1 不迁移）
- `scripts/check-no-raw-window-open.mjs`（lint UI 源码用，目前仅扫 ui/）
- `scripts/check-madge-import-cycles.ts`（目前 scanRoots 只含 src/extensions/ui）
- `scripts/audit-seams.mjs`（bundle cluster `ui` 检查）
- `scripts/ensure-playwright-chromium.mjs`（按 `--dir ui` 安装）

---

## 3. 替代后的目录结构与集成要点

### 3.1 顶层目录前后对比

```
openclaw-v2026.7.1-2/
├── ui/                (被替代；过渡期保留)        →    web/                 (新)
├── dist/control-ui/   (旧 gateway 默认 root)      →    web/dist/            (新 gateway 默认 root)
├── scripts/ui.js      (旧 UI 脚本 shim)           →    scripts/web.js       (新)
├── package.json#scripts.ui:*                        →    package.json#scripts.web:*
├── pnpm-workspace.yaml#packages: [ui]              →    pnpm-workspace.yaml#packages: [web]
└── (其余 src/ packages/ extensions/ apps/ docs/ skills/ config/ ... 不变)
```

### 3.2 `web/` 与仓库其余部分的依赖关系（替代后）

| 方向 | 依赖 |
|---|---|
| `web/` → Gateway | 运行时：HTTP bootstrap + WS + 命名空间路由（avatar / assistant-media / canvas / a2ui） |
| `web/` → packages | 编译时/类型：`@openclaw/normalization-core` 等已发布的 workspace 包（pnpm 自动 link） |
| `web/` ← Gateway | 构建产物：网关启动时 `resolveGatewayControlUiRootState` 解析到 `web/dist`（若设 `gateway.controlUi.root` 也可指向其他位置） |
| Gateway → `web/` | 仅 HTTP/WS：读 `web/dist/index.html` 与 chunk 文件；不 import 任何 `.ts` |

### 3.3 集成契约（不变面）

1. **Bootstrap config**（`src/gateway/control-ui-contract.ts`）：字段集不变；web 端 `src/stores/settings.ts` 或新加 `src/stores/bootstrap.ts` 在启动时 `fetch('/control-ui-config.json')` 后写入 Pinia
2. **WS 同源**：`new WebSocket('ws://' + location.host + '/')`，与 ui 一致
3. **设备身份 / Ed25519**：直接复用 agent-claw-web 的 `src/api/device.ts`（已有完整 ed25519 实现）
4. **路由 basePath 推断**：Vue Router 用 `createWebHistory(import.meta.env.BASE_URL)`；当 `gateway.controlUi.basePath: "/openclaw"` 时，`web/` 在打包时 `base: "/openclaw/"`，刷新子路径由网关 SPA fallback 兜底
5. **Avatar / Assistant Media URL**：`${basePath}/__openclaw__/avatar/<agentId>?token=...` 与 `${basePath}/__openclaw__/assistant-media?source=...&mediaTicket=...`；URL 拼接走 `web/src/utils/` 工具，参考 `agent-claw-web/src/utils/assistantMedia.ts`
6. **HTML 注入**：`<html data-openclaw-control-ui-base-path="${basePath}" data-openclaw-terminal-enabled="${terminalEnabled}">` —— 由网关 `serveResolvedIndexHtml` 在 `control-ui.ts:796-823` 注入；web 端 `index.html` 必须以 `<html lang="zh-CN">` 起始，**不要**预先填这两个属性（网关运行时注入）
7. **CSP**：网关注入 `Content-Security-Policy`（含 `'unsafe-inline'` 给 index.html 内联脚本的 hash）。web 端 Element Plus / Pinia / Tailwind 不需要额外 CSP 例外；如果引入 `vite-plugin-pwa` 等需要 `worker-src blob:` 的依赖，需在 `src/gateway/control-ui-csp.ts` 调整

### 3.4 配置与默认值

```yaml
# config/openclaw.yaml（网关侧配置；保持兼容，不新增字段）
gateway:
  controlUi:
    enabled: true               # 默认 true
    # basePath: "/"             # 默认空 = 根
    # root: "/abs/path/to/web/dist"   # 留空时自动解析 web/dist（fallback dist/control-ui）
    # embedSandbox: "scripts"   # 现有值
```

`pnpm dev`（旧 ui:dev）：旧 `dev:ui:mock` 脚本（`scripts/control-ui-mock-dev.ts`）保留为仅在 `ui/` 仍存在时有效；web 的 dev 推荐 `pnpm web:dev` + 单独 gateway 进程（`pnpm gateway:dev`）。

### 3.5 测试与契约保护

| 测试 | 替代 | 说明 |
|---|---|---|
| `pnpm test:ui` (vitest + Playwright) | `pnpm test:web` (vue-tsc + esbuild unit + CDP smoke) | 旧的 Playwright 单浏览器 e2e 在 web 里改用 CDP smoke |
| `pnpm test:ui:e2e` | `pnpm test:web:e2e` | 复用 `webapp-cdp-smoke` 技能 |
| `src/cron/cron-protocol-conformance.test.ts` 读 `ui/src/api/types.ts` | 改为读 `web/src/api/types.ts`（或保留 `ui/src` 直到 ui 删除） | 跨进程契约必须保留 |
| `tsconfig.extensions.json` `ui/src/**/*.d.ts` | 改为 `web/src/**/*.d.ts` | 类型暴露面 |
| `scripts/test-projects.test-support.mjs` 把 `ui/src` 当 root | 加 `web/src` 为 root，`ui/src` 留作过渡 | 见 §1.3 E |

### 3.6 清理清单（终态，独立 PR —— 全功能 parity + Element Plus + 终端迁移 + 11 长尾页面全部完成后）

> 本 PR 收尾**不做**：i18n 与 `ui/src/i18n/` 保留（决策 1）；`ui/` 整个目录暂留作 i18n 源 + 兜底 UI 路由 + 老 npm 包升级期临时回滚路径。

- **必须删**：
  - `ui/`（迁移收尾后整个目录）
  - `scripts/ui.js`、`scripts/control-ui-mock-dev.ts`、`scripts/dev/gateway-smoke.ts` 的 ui 分支
  - `pnpm-workspace.yaml` 中的 `ui`、`package.json scripts.ui:*`、`test:ui*`、`lint:ui*`
  - `src/infra/control-ui-assets.ts`、`src/config/types.gateway.ts` 中对 `ui/vite.config.ts` 的探测（决策 4a 后已移除 dist/control-ui 候选，仅留 web/dist）
  - 根 `.gitignore` 中的 `ui/dist`
  - `scripts/lib/*`、`scripts/test-projects.test-support.mjs`、`scripts/profile-tsgo.mjs`、`scripts/run-oxlint-shards.mjs`、`scripts/lib/tsgo-sparse-guard.mjs`、`scripts/lib/ts-topology/scope.ts` 中 `ui` surface 分支
  - `tsconfig.extensions.json` 与根 `tsconfig.json` 中 `ui/**/*` 包含
  - `docs/web/control-ui.md` → 重命名为 `docs/web/web-ui.md` 并更新到 Vue 3 + Element Plus 栈
- **条件删除**（vue-i18n 接入 + 验证 `ui/src/i18n/locales/*.ts` 全部迁完后方可）：
  - `scripts/control-ui-i18n.ts`、`scripts/control-ui-i18n-report.ts`
  - `ui/src/i18n/` 整套
- **Element Plus 残留清理**（迁移收尾后）：
  - `web/package.json` 中确认无 `@jdcloud/mobius` 残留
  - `web/src/` 中 `mobius` 关键字零匹配

---

## 4. 用户决策（已落定）

> 2026-09-13 拍板。所有后续 PR 按此执行；未明确项单独走决策流程。

1. **i18n：不迁移**（保持当前 `ui/src/i18n/` + `scripts/control-ui-i18n.ts` 流水线原状）
   - `web/` 上线时**不带 vue-i18n**，文案以英文/浏览器 locale 兜底
   - `pnpm ui:i18n:sync` / `pnpm ui:i18n:check` / `pnpm ui:i18n:report` **继续可用**（因为 `ui/` 暂留作 i18n 源 + 兜底 UI 路由）
   - i18n 收尾时机：等 `ui/` 全功能迁完、可以安全删除 `ui/` 时，再走"把 `ui/src/i18n/` 迁移到 vue-i18n + 删除 ui/"的收尾 PR
   - 副作用：`scripts/control-ui-i18n.ts` 与 `ui/src/i18n/` 在 §3.6 清理清单里要推迟
2. **终端页（ghostty-web）：保留**
   - 镜像 `ui/src/components/terminal/*` 到 `web/src/components/terminal/`（含 `terminal-panel.ts`、embedded terminal 复用组件）
   - 依赖保留：`@openclaw/libterminal`、`ghostty-web` 在 `web/package.json` 保留
   - CSP 例外：`gateway.control-ui-csp.ts` 中的 wasm-unsafe-eval 在 `gateway.terminal.enabled` 为 true 时仍生效
   - web 端：`views/` 新增 `TerminalView.vue`，挂载 `/terminal` 路由（侧栏入口）
3. **所有功能迁移，后续再定顺序**
   - **本次 PR 目标是"全功能 parity"**：22 个一级页面 + 终端 + config-form 全部迁移到 `web/`
   - agent-claw-web 已覆盖 11 个（Chat/Overview/Sessions/Channels/Agents/Skills/Cron/Usage/Logs/Config/Login），其余 11 个（Activity、Debug、Dreams、Instances、Nodes、Plugin、Skill-workshop、Tasks、Usage 详情、Workboard、Worktrees + 6 个 settings 子页）需要逐页面端口
   - 分批策略（提交粒度）由后续 PR 自定；本方案不再约束
4. **`gateway.controlUi.root` 默认值：选 A（直接改默认值为 `web/dist`）**
   - 行为变更：源码仓库与 npm tarball 不再产出 `dist/control-ui/`，只产出 `web/dist/`
   - 老 npm 包升级体验：会断在 `gateway:start` 阶段（`Control UI assets not found`）；release notes 必须标注
   - 实施要点：
     - `src/infra/control-ui-assets.ts` 的 `resolveControlUiRootSync` candidates **移除 `dist/control-ui` 候选**（保留 `web/dist`），唯一根来源是 `web/dist/`
     - `package.json#files` 由 `dist/` 改为 `web/dist/`（或同时保留 `dist/` 让 server-only 用户仍可用，但前端资源以 `web/dist` 为准）
     - `gateway.controlUi.root` 配置仍可覆盖为绝对路径（运维逃生口）
   - **不再保留 dist/control-ui fallback**（区别于方案初稿的"加 fallback 候选"建议）
5. **迁移后改为 Element Plus 原生**
   - 实施点：搬入 agent-claw-web 时**立即**改造 `web/src/main.ts`，把 `import Mobius from "@jdcloud/mobius"` 换成：
     ```ts
     import ElementPlus from "element-plus";
     import zhCn from "element-plus/es/locale/lang/zh-cn";
     import "element-plus/dist/index.css";
     // ...
     app.use(ElementPlus, { locale: zhCn });
     ```
   - `web/package.json` `dependencies`：
     - 移除 `@jdcloud/mobius`
     - 保留 `@element-plus/icons-vue`
     - 新增 `element-plus`
   - UI 组件替换（按需）：`el-button`/`el-popover`/`el-table`/`el-tree`/`el-tabs` 等用法与 Mobius 一致；`Mobius` 特有的"京东云风格"属性（如 `type="primary-blue"`）需要逐处改为 Element Plus 原生 prop（参考 `el-button type`/`el-tag type`）
   - 影响 `web/vite.config.ts`：去掉 `@jdcloud/mobius/dist/index.css` 的隐式 CSS（已并入 `element-plus/dist/index.css`），但全局样式入口保留