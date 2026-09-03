# OpenClaw 项目说明文档

> 面向新加入开发者的架构与联调指南。内容基于对本仓库 `package.json`、`README.md`、`ui/`、`src/gateway/`、`packages/gateway-*` 的实际梳理整理。

## 一、项目定位

OpenClaw 是一个**多渠道 AI 网关 / 本地优先的 Gateway 控制平面**。核心是一个运行在本地的 Gateway 后端服务，对上通过 Control UI（浏览器前端）进行管理与聊天，对下接入 100+ 消息渠道（WhatsApp / Telegram / Slack / Discord / 飞书 / 企业微信 / QQ 等）与各类 AI Provider。

- 包管理：**pnpm workspace monorepo**
- 运行时：**Node 24.15+ 推荐**（22.22.3+ / 25.9+ 亦可）
- 语言：TypeScript（开发期通过 `tsx` 直接运行 TS）

---

## 二、整体目录结构

```
openclaw/
├── package.json          # monorepo 根配置：exports(200+ plugin-sdk 子路径) + 海量 scripts
├── openclaw.mjs          # CLI 入口（bin: openclaw）
├── src/                  # ★ 后端源码（Gateway 服务、agent、渠道、RPC）
│   ├── gateway/          #   Gateway 控制平面：RPC 调用、鉴权、托管前端、HTTP/WS
│   ├── agents/           #   Agent 运行时（体量最大，1000+ 文件）
│   └── acp/              #   Agent Control Plane（会话管理、翻译、runtime）
├── ui/                   # ★ 前端源码（Control UI，Lit + Vite）
│   ├── index.html        #   Vite 入口 HTML
│   ├── package.json      #   前端独立依赖（lit / vite / vitest）
│   └── src/
│       ├── api/          #     ★ 前后端通信层（gateway.ts = WebSocket 客户端）
│       ├── app/          #     应用状态、路由、gateway store、鉴权
│       ├── components/   #     UI 组件（Lit web components）
│       └── e2e/          #     端到端测试
├── packages/             # 内部共享包（workspace:*）
│   ├── gateway-protocol/ #   ★ 前后端通信契约（TypeBox schema、版本、错误码）
│   ├── gateway-client/   #   ★ WebSocket 客户端库（依赖 ws）
│   ├── agent-core/ ai/ llm-core/ sdk/ plugin-sdk/ ...
├── extensions/           # 100+ 渠道与 Provider 插件
├── apps/                 # 移动/桌面端（android / ios / macos / shared）
├── scripts/              # 大量 build-* / check-* / 联调脚本
└── docs/                 # 官方文档
```

**一句话记忆：后端在 `src/`（重点 `src/gateway/`），前端在 `ui/`（重点 `ui/src/api/`），通信契约在 `packages/gateway-protocol/`。**

---

## 三、前端结构（`ui/`）

- **技术栈**：`lit`（Web Components）+ `vite`（构建/开发服务器）+ `vitest`（测试）。**不是 Vue/React**，而是原生 Lit 组件。
- **入口**：`ui/index.html` → `ui/src/`。
- **通信层**（最关键）：
  - [`ui/src/api/gateway.ts`](ui/src/api/gateway.ts)：`GatewayBrowserClient`，基于 **WebSocket** 与后端通信，定义了帧类型：
    - 请求帧 `req`（带 `id`）
    - 响应帧 `res`（`{ type:"res", id, ok, payload | error }`，按 `id` 关联请求）
    - 事件帧 `event`（`{ type:"event", event, payload, seq }`，服务端主动推送）
  - [`ui/src/api/types.ts`](ui/src/api/types.ts)：通信数据类型。
  - [`ui/src/app/gateway.ts`](ui/src/app/gateway.ts)：应用层封装（`ApplicationGateway`：connect / start / stop / subscribe / subscribeEvents），管理连接状态、断线重连、事件日志。
  - [`ui/src/app/gateway-store.ts`](ui/src/app/gateway-store.ts)：Gateway 连接的状态存储。

### 前端在哪里修改？

| 需求                     | 修改位置                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| 页面/组件 UI             | [`ui/src/components/`](ui/src/components)（Lit 组件，如 `app-sidebar.ts`、`command-palette.ts`）     |
| 路由/导航                | [`ui/src/app/app-navigation.ts`](ui/src/app/app-navigation.ts)、`app-routes.ts`                      |
| 调用后端 / 新增 RPC 请求 | [`ui/src/api/gateway.ts`](ui/src/api/gateway.ts)（客户端）+ 后端方法注册（见下）                     |
| 主题/样式                | [`ui/src/app/theme.ts`](ui/src/app/theme.ts)、`custom-theme.ts`；设计规范见 `ui/docs/design-system/` |
| 全局状态/连接            | [`ui/src/app/gateway-store.ts`](ui/src/app/gateway-store.ts)                                         |

> 注意：`ui/src/api/gateway.ts` 直接以相对路径 import 了 `packages/gateway-protocol/src/*` 和 `src/gateway/device-auth.js`，即前端与后端共享同一套协议定义，改协议时两端要同步。

---

## 四、后端结构（`src/gateway/`）

Gateway 是控制平面，负责启动 HTTP/WebSocket 服务、鉴权、托管前端、分发 RPC 方法。关键文件：

| 文件                                                                                 | 职责                                                   |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| [`src/gateway/boot.ts`](src/gateway/boot.ts)                                         | Gateway 启动引导                                       |
| [`src/gateway/call.ts`](src/gateway/call.ts)                                         | **RPC 调用核心**：接收请求帧、分发到方法、返回响应帧   |
| [`src/gateway/methods/registry.ts`](src/gateway/methods/registry.ts)                 | **方法注册表**：注册/规范化所有 RPC 方法及其权限 scope |
| [`src/gateway/methods/core-descriptors.ts`](src/gateway/methods/core-descriptors.ts) | 核心 RPC 方法描述符定义                                |
| [`src/gateway/control-ui.ts`](src/gateway/control-ui.ts)                             | **托管前端**：把 `ui/` 构建产物作为静态资源对外提供    |
| [`src/gateway/auth.ts`](src/gateway/auth.ts)                                         | 鉴权（token / password / 设备配对）                    |
| [`src/gateway/net.ts`](src/gateway/net.ts)                                           | 网络/HTTP 层                                           |
| [`src/gateway/method-scopes.ts`](src/gateway/method-scopes.ts)                       | 方法权限作用域（admin / node / dynamic 等）            |

### 新增一个后端接口（RPC 方法）的大致路径

1. 在方法描述符中定义方法（参考 [`src/gateway/methods/core-descriptors.ts`](src/gateway/methods/core-descriptors.ts)），指定名称、scope、handler。
2. 经 [`registry.ts`](src/gateway/methods/registry.ts) 注册。
3. 前端在 [`ui/src/api/gateway.ts`](ui/src/api/gateway.ts) 通过 client 发起对应方法调用。

---

## 五、前后端通信机制

```
浏览器 (ui/)                                          本地 Gateway (src/gateway/)
┌────────────────────────┐                          ┌────────────────────────────┐
│ GatewayBrowserClient    │  ──── WebSocket ───▶     │ net.ts / control-ui.ts       │
│ ui/src/api/gateway.ts   │   req { id, method,... } │   接收帧                      │
│                         │                          │        ▼                     │
│                         │                          │ call.ts  分发                 │
│                         │  ◀─── res { id, ok } ──── │        ▼                     │
│  subscribeEvents(...)   │  ◀─── event { event } ── │ methods/registry.ts 方法处理  │
└────────────────────────┘                          └────────────────────────────┘
```

- **传输**：WebSocket（客户端库 `@openclaw/gateway-client` 依赖 `ws`）。
- **协议契约**：[`packages/gateway-protocol/`](packages/gateway-protocol)（`@openclaw/gateway-protocol`），基于 **TypeBox** 定义 schema，包含：
  - `version.ts`：`PROTOCOL_VERSION` / `MIN_CLIENT_PROTOCOL_VERSION`（连接时做版本协商）
  - `client-info.ts`：客户端类型/模式
  - `connect-error-details.ts`：连接错误码与恢复建议
  - `frame-guards.ts` / `schema.ts`：帧结构与校验
- **协议 Schema 生成**：`pnpm protocol:gen` → 生成 `dist/protocol.schema.json`；`pnpm protocol:gen:swift` 同步生成移动端 Swift 模型（`apps/*/OpenClawProtocol/GatewayModels.swift`），保证多端协议一致。
- **鉴权**：token / password / 设备配对（device-auth），前端携带 `buildDeviceAuthPayload` 生成的凭据。

---

## 六、本地联调

### 1. 首次准备

```bash
git clone <repo> && cd openclaw
pnpm install
pnpm openclaw setup      # 首次初始化（tsx 直接运行 TS）
```

### 2. 启动后端 Gateway（热重载）

```bash
pnpm gateway:watch       # scripts/gateway-watch-tmux.mjs，tmux 内热重载
# 或
pnpm gateway:dev         # 开发模式（OPENCLAW_SKIP_CHANNELS=1 跳过渠道，起 Gateway）
```

### 3. 启动前端

```bash
pnpm ui:dev              # 或在 ui/ 目录执行 vite（pnpm --dir ui dev）
# 纯前端 mock 联调（不依赖真实后端）：
pnpm dev:ui:mock         # scripts/control-ui-mock-dev.ts
```

- 生产构建：`pnpm ui:build`（Vite build）→ 产物由后端 [`control-ui.ts`](src/gateway/control-ui.ts) 托管。
- **改动 `ui/` 后**：需重新 `pnpm ui:build`，或用 `pnpm ui:dev` 走 Vite 热更新。

### 4. 全量构建

```bash
pnpm build               # scripts/build-all.mjs → 生成 dist/
pnpm ui:build            # 前端构建
```

### 5. 测试

```bash
pnpm test:ui             # 前端单测（pnpm --dir ui test，vitest）
pnpm test:ui:e2e         # 前端 E2E（vitest.ui-e2e.config.ts，见 ui/src/e2e/）
```

---

## 七、常用命令速查

| 命令                           | 作用                                                |
| ------------------------------ | --------------------------------------------------- |
| `pnpm openclaw <...>`          | CLI 统一入口（tsx 运行 TS，`scripts/run-node.mjs`） |
| `pnpm openclaw:rpc`            | 以 RPC/JSON 模式运行 agent                          |
| `pnpm gateway:watch`           | 后端热重载开发（推荐）                              |
| `pnpm gateway:dev`             | 后端开发模式（跳过渠道）                            |
| `pnpm ui:dev`                  | 前端 Vite 开发服务器                                |
| `pnpm dev:ui:mock`             | 前端 mock 联调                                      |
| `pnpm ui:build`                | 前端构建                                            |
| `pnpm build`                   | 全量构建到 dist/                                    |
| `pnpm protocol:gen`            | 生成前后端 RPC 协议 schema                          |
| `pnpm test:ui` / `test:ui:e2e` | 前端单测 / E2E                                      |
| `pnpm start`                   | 生产启动（`node openclaw.mjs`）                     |

---

## 八、修改前的关键提醒

1. **前端只用 Lit**（非 Vue/React），组件写在 `ui/src/components/`。
2. **协议是前后端共享契约**：改 RPC 结构要同时动 `packages/gateway-protocol/`、后端 `src/gateway/methods/`、前端 `ui/src/api/gateway.ts`，并跑 `pnpm protocol:gen` 保持 schema 与移动端 Swift 一致。
3. **前端调后端**：统一走 WebSocket + 方法调用（`ui/src/api/gateway.ts`），不要绕过封装直接发 HTTP。
4. **联调顺序**：先 `pnpm gateway:watch` 起后端，再 `pnpm ui:dev` 起前端；纯 UI 调整可用 `pnpm dev:ui:mock`。

---

## 九、延伸阅读

- 官方架构文档：`docs.openclaw.ai/concepts/architecture`
- RPC 参考：`docs.openclaw.ai/reference/rpc`
- 仓库内：`README.md`、`docs/` 目录、各子目录 `AGENTS.md`
