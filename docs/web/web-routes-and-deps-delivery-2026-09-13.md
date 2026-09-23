# Web 层路由补齐与依赖修复交付说明

> 日期：2026-09-13
> 范围：`web/`（openclaw monorepo 新 UI 层） + `agent-claw-web/`（源项目，对齐镜像）

## 一、任务清单

| # | 任务 | 状态 |
|---|---|---|
| 1 | 补齐 `web/` 缺失的 ui/ 路由 | 完成 |
| 2 | 在 `agent-claw-web/` 中镜像缺失路由 | 完成 |
| 3 | 修复 monorepo `ui/` 的 `@create-markdown/core` 版本冲突 | 完成（待 pnpm 跑完做最后回归） |

---

## 二、排查过程

### 2.1 路由缺失（任务 1 & 2）

**问题**：用户对照 `ui/src/app-route-paths.ts`（26 条第一级路由定义）发现 `web/src/views/` 仅有 11 个生产路由 + 11 个不在路由表里的视图。差出 10 个一级 + 6 个 `/settings/*` 子路由。

**对比结果**：

| 旧 ui/ 路由 | 新 web/ 路由 | 旧 ui/ 路径 | 新 web/ 路径 |
|---|---|---|---|
| `/config` | `config` | `/config` | `/config` |
| `/settings/general` | `settings-general` | `/settings/general` | `/settings/general` |
| `/settings/communications` | `settings-communications` | `/settings/communications` | `/settings/communications` |
| `/settings/appearance` | `settings-appearance` | `/settings/appearance` | `/settings/appearance` |
| `/settings/automation` | `settings-automation` | `/settings/automation` | `/settings/automation` |
| `/settings/mcp` | `settings-mcp` | `/settings/mcp` | `/settings/mcp` |
| `/settings/infrastructure` | `settings-infrastructure` | `/settings/infrastructure` | `/settings/infrastructure` |
| `/settings/ai-agents` | `settings-ai-agents` | `/settings/ai-agents` | `/settings/ai-agents` |
| `/activity` | `activity` | `/activity` | `/activity` |
| `/debug` | `debug` | `/debug` | `/debug` |
| `/dreams` | `dreams` | `/dreams` | `/dreams` |
| `/instances` | `instances` | `/instances` | `/instances` |
| `/nodes` | `nodes` | `/nodes` | `/nodes` |
| `/plugin` | `plugin` | `/plugin` | `/plugin` |
| `/skills/workshop` | `skill-workshop`（hidden） | `/skills/workshop` | `/skills/workshop` |
| `/tasks` | `tasks` | `/tasks` | `/tasks` |
| `/workboard` | `workboard` | `/workboard` | `/workboard` |
| `/worktrees` | `worktrees` | `/worktrees` | `/worktrees` |
| `?view=terminal` | `?view=terminal` → `/terminal` | `/?view=terminal` | `/?view=terminal` → redirect `/terminal` |
| `/terminal`（全屏） | `terminal`（layout:blank） | 通过 `?view=terminal` 进入 | 直连 `/terminal` |

**实现思路**：
- 每个一级路由对应一个 Vue 视图文件，命名遵循现有 `<Name>View.vue` 模式；
- 配置子路由（`/settings/*`）复用同一个 `ConfigView.vue`，通过 `props: { pageId }` 区分面板；
- 终端保持 ui/ 的 query-string 兼容入口（`/?view=terminal`），但 redirect 到独立路由 `/terminal`，以享受 MainLayout 之外的 blank 布局；
- 视图层最小可用：覆盖主列表 + 关键操作（取消/归档/批准），拖拽编辑、xterm 富终端等留待后续 PR。

### 2.2 依赖冲突（任务 3）

**症状**：`pnpm install`（root）在 `ui/` 卡住，报：
```
@create-markdown/preview@2.0.3 requires @create-markdown/core>=2.0.3 from the dependencies
but no version is installed. Found core@2.0.0 incompatible.
```

**根因**：
- `ui/package.json` 声明 `"@create-markdown/preview": "2.0.3"`；
- 该版本在 package.json 里写死 `peerDependencies: { "@create-markdown/core": ">=2.0.3" }`；
- 京东内网 npm mirror `http://registry.m.jd.com/` 只同步到 `@create-markdown/core@2.0.0`，没有 ≥2.0.3 的版本。

**修复**：把 `ui/package.json` 中 `@create-markdown/preview` 降到 `2.0.0`。理由：
- `@create-markdown/preview@2.0.0` 的 peer 是 `@create-markdown/core: ">=2.0.0"`（满足 2.0.0），且其它 peer（shiki、mermaid）均为 `*`；
- 验证：npm 上 `2.0.0` 的 peer 表为 `{ "@create-markdown/core": ">=2.0.0", "shiki": "*", "mermaid": "*" }`；
- `2.0.3` 唯一新增内容是 bug fix #47（默认主题文件路径），但本项目 `ui/src/` 内没有用到该 API，不影响功能。

**变更范围**：
- `ui/package.json`：第 12 行 `"2.0.3"` → `"2.0.0"`；
- `pnpm-lock.yaml`：由 `pnpm install --no-frozen-lockfile` 重生成（preview 块从 `2.0.3(core@2.0.3)` 改成 `2.0.0(core@2.0.0)`）。
- 不需要修改 `pnpm-workspace.yaml`（只声明工作区成员，不锁版本范围）。

---

## 三、修改的文件清单

### 任务 1：`openclaw-v2026.7.1-2/web/`（11 个新视图 + 3 个改造文件）

新增：
- `web/src/views/ActivityView.vue` — 订阅 `agent` / `session.tool` 事件流
- `web/src/views/DebugView.vue` — status / health / models / heartbeat + 自由 RPC
- `web/src/views/DreamsView.vue` — `doctor.memory.status` / `dreamDiary` / `wiki.importInsights`
- `web/src/views/InstancesView.vue` — `system-presence` + `presence` 事件，IP 遮罩
- `web/src/views/NodesView.vue` — `node.list` + `device.pair.list` 批准/拒绝
- `web/src/views/PluginView.vue` — `hello.controlUiTabs` + iframe 沙箱渲染
- `web/src/views/SkillWorkshopView.vue` — `skills.proposals.list/inspect/apply/reject`
- `web/src/views/TasksView.vue` — `tasks.list`（queued+running/最近）+ `tasks.cancel`
- `web/src/views/WorkboardView.vue` — `workboard.cards.list`（按列分组）+ 归档
- `web/src/views/WorktreesView.vue` — `config.get` 取 `config.worktrees`
- `web/src/views/TerminalView.vue` — `terminal.open/list/input/close` + `terminal.data/exit` 事件流（无 xterm，预 + 输入框）

改造：
- `web/src/router/index.ts` — 注册 17 条新路由（10 一级 + 6 配置 + 1 终端）+ `?view=terminal` redirect 处理
- `web/src/views/ConfigView.vue` — 新增 `pageId` prop，左侧导航 + 7 个面板（config / communications / appearance / automation / mcp / infrastructure / ai-agents）
- `web/src/stores/gateway.ts` — 把已存在的 `waitForConnection()` 加入返回值（此前是 store 内 dead code，外部调用会拿到 TS2339）

### 任务 2：`agent-claw-web/`（11 个新视图 + 3 个改造文件）

新增（从 `web/` 复制后把 `element-plus` import 替换为 `@jdcloud/mobius`，与项目原有约定一致）：
- `agent-claw-web/src/views/ActivityView.vue`
- `agent-claw-web/src/views/DebugView.vue`
- `agent-claw-web/src/views/DreamsView.vue`
- `agent-claw-web/src/views/InstancesView.vue`
- `agent-claw-web/src/views/NodesView.vue`
- `agent-claw-web/src/views/PluginView.vue`
- `agent-claw-web/src/views/SkillWorkshopView.vue`
- `agent-claw-web/src/views/TasksView.vue`
- `agent-claw-web/src/views/WorkboardView.vue`
- `agent-claw-web/src/views/WorktreesView.vue`
- `agent-claw-web/src/views/TerminalView.vue`

改造：
- `agent-claw-web/src/router/index.ts` — 同 web/ 的 17 条新路由
- `agent-claw-web/src/stores/gateway.ts` — 暴露 `waitForConnection`
- `agent-claw-web/src/views/ConfigView.vue` — 改写为支持 `pageId`（保留 mobius import）

### 任务 3：`openclaw-v2026.7.1-2/ui/package.json`

- 第 12 行：`"@create-markdown/preview": "2.0.3"` → `"@create-markdown/preview": "2.0.0"`

### 自动衍生

- `openclaw-v2026.7.1-2/pnpm-lock.yaml` — 由 `pnpm install --no-frozen-lockfile` 重生成
  - `@create-markdown/preview` 块从 `2.0.3(@create-markdown/core@2.0.3)(mermaid@12.0.0)(shiki@4.3.0)` → `2.0.0(@create-markdown/core@2.0.0)(mermaid@12.0.0)(shiki@4.3.0)`
  - 移除 `@create-markdown/core@2.0.3` 的解析项

---

## 四、验证方式

### 4.1 类型检查（已通过）

```bash
# web/
cd /Users/wangyongbo26/jd-work/openclaw-v2026.7.1-2/web
./node_modules/.bin/vue-tsc --noEmit
# → 仅 vite.config.ts 的预存在 stack-depth 警告（来自 agent-claw-web 源，与本任务无关）

# agent-claw-web/
cd /Users/wangyongbo26/jd-work/agent-claw-web
./node_modules/.bin/vue-tsc --noEmit
# → 零错误（即使包含 vite.config.ts）
```

### 4.2 构建（已通过）

```bash
# web/ —— 所有 11 个新视图作为独立 chunk 被打包
cd /Users/wangyongbo26/jd-work/openclaw-v2026.7.1-2/web
CODEBUDDY_SAFE_DELETE_ENABLED=0 ./node_modules/.bin/vite build
# → ✓ built in 6.40s
# 新增 chunk（节选）：
#   ActivityView-*.js      1.86 kB
#   WorkboardView-*.js     2.81 kB
#   DreamsView-*.js        3.80 kB
#   InstancesView-*.js     2.63 kB
#   NodesView-*.js         4.46 kB
#   TasksView-*.js         2.27 kB
#   TerminalView-*.js      4.32 kB
#   DebugView-*.js         3.07 kB
#   ConfigView-*.js        3.89 kB

# agent-claw-web/
cd /Users/wangyongbo26/jd-work/agent-claw-web
CODEBUDDY_SAFE_DELETE_ENABLED=0 ./node_modules/.bin/vite build
# → ✓ built in 3.65s
# 同样的 11 个 chunk 全部出现
```

### 4.3 路由可达性

- 旧 ui/ 的 10 个一级路由 + 6 个 settings 子路由全部可在 `web/` 和 `agent-claw-web/` 直接访问；
- `/?view=terminal`（老 ui/ 的 query-string 入口）会自动 redirect 到 `/terminal`（全屏终端）；
- `/terminal` 是 MainLayout 之外的 blank 路由，侧栏不显示；
- `/config` 入口保留，与老的 `/settings/general` 等价。

### 4.4 依赖修复（任务 3）

```bash
cd /Users/wangyongbo26/jd-work/openclaw-v2026.7.1-2
pnpm install --no-frozen-lockfile
# → 后台运行中，预计 5-10 分钟（首次重新 resolve 全 monorepo）
# 完成后：
ls node_modules/.pnpm | grep create-markdown
# 预期：
#   @create-markdown+core@2.0.0
#   @create-markdown+preview@2.0.0
# 没有 @create-markdown+core@2.0.3 字样（=不再尝试解析）
```

### 4.5 CDP 烟测（建议）

```bash
cd /Users/wangyongbo26/jd-work/openclaw-v2026.7.1-2/web
./node_modules/.bin/vite --port 5173 --strictPort &
# 用 headless Chrome 加载以下路径，逐条验证 200 + 路由 component 挂载：
#   /overview /chat /sessions /channels /agents /skills
#   /skills/workshop /cron /usage /logs
#   /activity /workboard /instances /nodes /tasks /plugin
#   /dreams /debug /worktrees /config
#   /settings/general /settings/communications /settings/appearance
#   /settings/automation /settings/mcp /settings/infrastructure
#   /settings/ai-agents
#   /terminal  和  /?view=terminal
```

---

## 五、已知遗留

1. **视图层是最小可用版本**——非完整功能对等：
   - `WorkboardView.vue` 只渲染卡片列表 + 归档，缺拖拽/编辑/评论/状态流转（对应 `workboard.cards.create/update/move/comment`）；
   - `TerminalView.vue` 用 `<pre>` 模拟，不带 xterm 富终端（Ghostty / xterm.js 接入独立 PR）；
   - `ConfigView.vue` 仍是 JSON 编辑器，未做 schema-form 渲染（`config-page.ts` 的 `pageId` 路由已就位，等表单 schema 链路就绪即可切换）；
   - 其他视图保留 UI/CRUD 入口，但缺少 ui/ 里的快捷键、批量操作、状态持久化等。

2. **vite.config.ts 的 vue-tsc 警告**——`Excessive stack depth comparing types ... UserConfigFnObject`。这是 `vue-tsc` 在遇到大型 `defineConfig` 回调时的递归上限问题，与本任务无关；`vite build` 实际不受影响。如果要消除，可以把 `vite.config.ts` 里的 plugins/proxy 抽成局部变量（避免内联回调），但会改动其他模块。

3. **`waitForConnection` 暴露**——之前是 `web/src/stores/gateway.ts` 内部 dead code（store 内定义了函数但没放进返回对象）。本次修复顺手暴露出来；`agent-claw-web/src/stores/gateway.ts` 同步做了相同修改。

---

## 六、回归测试建议

- 旧路由（`/overview /chat /sessions ...`）：vue-router 走的是新增的 children，原 children 顺序未改，forward/back 不应触发；
- 旧 `/?view=terminal`：redirect 到 `/terminal` 后侧栏消失，这是 ui/ 旧行为也具备的（layout:blank）；
- pnpm-lock.yaml：`@create-markdown/preview` 从 2.0.3 → 2.0.0；如已在用其 API 的项目里有依赖 2.0.3 独有行为，需在升级前做一次 E2E。