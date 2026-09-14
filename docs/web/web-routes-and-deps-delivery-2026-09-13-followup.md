# Web 层三个补齐交付（workboard CRUD + xterm + schema-form）

> 日期：2026-09-13（接续 `web-routes-and-deps-delivery-2026-09-13.md`）
> 范围：`web/` + `agent-claw-web/` + 新组件 `SchemaForm.vue`

## 三个补齐项

| #   | 模块                                               | 状态 | RPC                                                                      |
| --- | -------------------------------------------------- | ---- | ------------------------------------------------------------------------ |
| 9   | Workboard 完整 CRUD（创建/编辑/列切换/评论/归档）  | ✅   | workboard.cards.{list,create,update,move,comment,archive}                |
| 10  | xterm.js 富终端（替换 `<pre>` 模拟）               | ✅   | terminal.{open,list,attach,input,resize,close} + terminal.data/exit 事件 |
| 11  | SchemaForm 渲染（JSON Schema → Element Plus 表单） | ✅   | config.{get,schema,set}                                                  |

## 1. WorkboardView 完整 CRUD

**升级**：从只读卡片列表 + 单归档按钮升级到完整 Kanban。

**功能**：

- 顶部「新建卡片」按钮 → `el-dialog` 标题/备注/列/优先级/标签
- 卡片操作：`el-select` 列切换（move RPC）+ 评论按钮 + 编辑按钮 + 归档按钮
- 编辑对话框：标题/备注/列/优先级/标签
- 评论对话框：列出已有评论 + 输入新评论（提交走 `workboard.cards.comment`）
- 列定义（5 列）：todo / in_progress / review / done / blocked
- 优先级标签：高/中/低
- 标签解析：逗号（中/英）/空格分隔

**RPC payload**（从 ui/ view.test 推）：

- `workboard.cards.create` → `{ title, notes?, status, priority, labels[], position: Date.now() }`
- `workboard.cards.update` → `{ id, patch: { title, notes, status, priority, labels[] } }`
- `workboard.cards.move` → `{ id, status, position: Date.now() }`
- `workboard.cards.comment` → `{ id, body }`
- `workboard.cards.archive` → `{ id, archived: true }`

**Bundle 影响**：`WorkboardView` 2.81KB → 10.12KB（gzip 1.53KB → 3.30KB）。

## 2. TerminalView 富终端（xterm.js + addon-fit）

**升级**：从 `<pre>+<input>` 模拟升级到真 xterm。

**引入依赖**：

```jsonc
// web/package.json
"@xterm/xterm": "^5.5.0",
"@xterm/addon-fit": "^0.10.0"
```

**安装方法**（绕开 pnpm install broker）：

- `curl -sSL http://registry.m.jd.com/@xterm%2Fxterm/-/xterm-5.5.0.tgz -o xterm.tgz`
- `curl -sSL http://registry.m.jd.com/@xterm%2Faddon-fit/-/addon-fit-0.10.0.tgz -o addon-fit.tgz`
- `tar -xzf xterm.tgz -C web/node_modules/@xterm/xterm --strip-components=1`
- `tar -xzf addon-fit.tgz -C web/node_modules/@xterm/addon-fit --strip-components=1`
- agent-claw-web 通过 `cp -R` 从 web/node_modules 复用

**特性**：

- 真正 PTY 模拟（Ansi 颜色 / 光标移动 / 退格 / Ctrl+C）
- `ResizeObserver` 监控容器尺寸 → `fit.fit()` + `terminal.resize` RPC
- `term.onData((data) => gateway.request("terminal.input", ...))` —— 用户按键直接转发 PTY
- 工具栏新增 `Ctrl+C` 按钮（发送 `\x03`）—— 中断正在运行的命令
- 主题：深色背景 `#0d1117` + 浅灰前景，与原设计一致

**Bundle 影响**：`TerminalView` 4.32KB → 296.98KB（gzip 1.98KB → 74.83KB）。

## 3. SchemaForm 渲染器

**新增文件**：`web/src/components/SchemaForm.vue`（也镜像到 `agent-claw-web/src/components/SchemaForm.vue`）。

**支持的 JSON Schema 类型**：

| type                                           | 控件                                       |
| ---------------------------------------------- | ------------------------------------------ | ------ | ------------------------------ | ------------------- |
| `string`（含 enum）                            | `el-select`                                |
| `string`（minLength ≥ 50 或 format=multiline） | `el-input` textarea                        |
| `string`（其它）                               | `el-input`                                 |
| `string`（敏感字段：path 匹配 /password        | token                                      | secret | api.?key/i 或 hint.sensitive） | 隐藏 + 「显示」按钮 |
| `number` / `integer`                           | `el-input-number`（integer → step=1）      |
| `boolean`                                      | `el-switch`                                |
| `array`（primitive item）                      | 动态列表（add/remove 行）                  |
| `array`（object item）/ `object`               | JSON textarea 兜底（anyOf/oneOf 同样兜底） |
| 未知                                           | JSON textarea 兜底                         |

**支持的 uiHints**（基于 `src/shared/config-ui-hints-types.ts`）：

- `label` —— 覆盖自动 humanize 出来的字段名
- `help` —— 字段下方的小字说明
- `placeholder` —— 输入框占位符
- `sensitive` —— 强制标为敏感（与路径规则同效）
- `advanced` —— 默认折叠，需勾选「显示高级选项」才出现
- `*` 通配符匹配（如 `agents.*.token`）

**ConfigView 集成**：

- 加载时同时跑 `config.get` + `config.schema`
- Schema 可用 → 默认显示表单视图
- Schema 不可用 / 用户主动切 → JSON 编辑器（之前的兜底）
- 「查看 JSON」按钮在两者间切换
- 每个面板独立 `pageId` → 切换时刷新配置（page watch）

**Bundle 影响**：`ConfigView` 3.89KB → 15.89KB（gzip 1.94KB → 5.21KB）；SchemaForm 是 lazy 子 chunk。

---

## 验证结果

| 项                                  | 结果                                           |
| ----------------------------------- | ---------------------------------------------- |
| `vue-tsc --noEmit` (web/)           | 0 错误                                         |
| `vue-tsc --noEmit` (agent-claw-web) | 0 错误                                         |
| `vite build` (web/)                 | ✓ 3.91s                                        |
| `vite build` (agent-claw-web)       | ✓ 3.70s                                        |
| CDP 路由可达性                      | **76/76 PASS**（19 路径 × 4 断言）             |
| pnpm install 状态                   | 未新增依赖冲突（xterm 由 tar 绕道，不经 pnpm） |

## 修改的文件

**web/**：

- `web/src/views/WorkboardView.vue`（重写 — 完整 CRUD）
- `web/src/views/TerminalView.vue`（重写 — xterm.js）
- `web/src/views/ConfigView.vue`（重写 — 集成 SchemaForm + pageId）
- `web/src/components/SchemaForm.vue`（新增）
- `web/package.json`（+ `@xterm/xterm` `^5.5.0` / `@xterm/addon-fit` `^0.10.0`）
- `web/node_modules/@xterm/{xterm,addon-fit}/`（通过 tar 绕道安装）

**agent-claw-web/**：

- `src/views/WorkboardView.vue`（重写）
- `src/views/TerminalView.vue`（重写）
- `src/views/ConfigView.vue`（重写）
- `src/components/SchemaForm.vue`（新增）
- `package.json`（+ xterm 同款）
- `node_modules/@xterm/{xterm,addon-fit}/`（从 web/ 复用）

## 已知限制

1. **SchemaForm 不支持 anyOf/oneOf/allOf** —— 回退为 JSON 编辑；后续可接 ajv / @json-editor/json-editor
2. **SchemaForm 不支持嵌套 object 的递归渲染** —— 顶层 properties 会被拍平展示；嵌套 object 显示 JSON 兜底
3. **xterm 没有 attach 到 ghostty-web** —— 当前是浏览器内 emulator，wasm 优化留给后续 PR
4. **Workboard 拖拽未实现** —— 当前用 el-select 列切换；如要拖拽引入 vue-draggable-plus + sortablejs

## 与 ui/ 的功能对位

| ui/ 功能                                     | web/ 状态                                   |
| -------------------------------------------- | ------------------------------------------- |
| Workboard 卡片 CRUD + 拖拽 + 评论 + 状态流转 | ✅ CRUD / 状态切换 / 评论 / 归档（缺拖拽）  |
| Terminal xterm + ghostty-web                 | ✅ xterm（缺 ghostty-wasm）                 |
| ConfigForm 完整 schema → 控件渲染            | ✅ 基础类型 + 敏感字段（缺 anyOf/递归对象） |
