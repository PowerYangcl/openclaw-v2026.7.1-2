<script setup lang="ts">
/**
 * 对话页 = 二级目录（智能体列表） + 一个或多个**对话窗格**。
 *
 * ## 结构
 * 单窗格（默认）：
 * ```
 * .chat-layout
 *   ├─ ChatSidebar
 *   ├─ (.chat-backdrop   ← 仅手机端且抽屉打开时)
 *   └─ .chat-main
 *        ├─ ChatPaneTabs（仅窄屏 + 拆分态）
 *        └─ ChatPane(chrome="none")        ← 会话 key 直接来自路由 / settings
 * ```
 * 拆分视图：
 * ```
 * .chat-layout
 *   ├─ ChatSidebar
 *   └─ .chat-main
 *        ├─ ChatPaneTabs（仅窄屏 + 拆分态）
 *        └─ .chat-split-view
 *             ├─ .chat-split-view__column   (flex: columnWeight)
 *             │    ├─ ChatPane(chrome="pane")
 *             │    ├─ ResizableDivider(horizontal)
 *             │    └─ ChatPane(chrome="pane")
 *             ├─ ResizableDivider(vertical)
 *             └─ .chat-split-view__column …
 * ```
 *
 * ## 三档视口语义（改手机端适配前请先读这段）
 *
 * | 宽度 | 侧栏 | 窗格 | 顶部 chrome |
 * | --- | --- | --- | --- |
 * | > 1099px | 常驻列（可收成 44px 图标条） | 全部并排渲染 | 无切换器（点窗格即切换） |
 * | 769–1099px | 常驻列 | **只渲染活动窗格** | 拆分态加一条窗格切换器 |
 * | ≤768px（含矮横屏） | **覆盖式抽屉**（`.chat-backdrop` + 平移进出） | 只渲染活动窗格 | 同上，且目录按钮变成「打开抽屉」 |
 *
 * ⚠️ 三处判据必须同步，否则会出现「按钮点了没反应」或「CSS 已按手机排版、JS 还按桌面算」：
 * `NARROW_SPLIT_QUERY`（本文件）、`MOBILE_QUERY`（本文件）、
 * `ChatPane.vue` 的 `allowSplit`，以及 `src/styles/layout.mobile.css` 的 `@media`。
 *
 * ## 布局模型（列 / 窗格 / 权重）
 * 由 `@/utils/splitLayout` 提供，逐行移植自旧版 `ui/src/pages/chat/split-layout.ts`；
 * 容器的渲染顺序与旧版 `chat-page.ts` 一致。
 *
 * ## 职责边界
 * - **本文件**：持有「当前会话 key」「布局」「二级目录折叠态 / 抽屉态」「视口档位」，
 *   负责路由同步与持久化；
 * - **ChatPane.vue**：只渲染一个会话，不读路由、不写全局会话 key（见其文件头说明）；
 * - **ChatPaneTabs.vue**：窄屏窗格切换器，纯展示 + 事件上抛。
 *
 * ## 与旧版的差异（有意为之）
 * 1. 旧版把布局存进 `settings.chatSplitLayout`（网关侧 UI 设置）；本项目没有该字段，
 *    改用 localStorage（`openclaw.web.chatSplitLayout.v1`），与 `sidebarSnapshot` /
 *    `chat-side-collapsed` 等既有本地状态的存放方式保持一致。
 * 2. 旧版窄屏**没有**窗格切换器（`ui/src/pages/chat/chat-controls.ts` 里零个 `pane` 引用），
 *    一旦处于拆分态，非活动窗格在窄屏就彻底不可达；本文件补上 `ChatPaneTabs`。
 * 3. 旧版窄屏把侧栏留在常规流里（236px 常驻），390px 手机上对话区只剩 154px；
 *    本项目在 ≤768px 把它改成覆盖式抽屉。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import ChatSidebar from "@/components/ChatSidebar.vue";
import ChatPaneTabs from "@/components/ChatPaneTabs.vue";
import ResizableDivider from "@/components/ResizableDivider.vue";
import ChatDetailSidebar from "@/components/ChatDetailSidebar.vue";
import FilePreviewModal, { type PreviewFile } from "@/components/FilePreviewModal.vue";
import ChatPane from "@/views/ChatPane.vue";
import { useSettingsStore } from "@/stores/settings";
import { useAgentsStore } from "@/stores/agents";
import type { ChatMessage } from "@/types/chat";
import {
  canonicalMainSessionKey,
  resolveSessionParam,
  type SessionResolveOptions,
} from "@/utils/canonicalSession";
import { normalizeAgentId, parseAgentSessionKey } from "@/utils/sessionKey";
import {
  PANE_DRAG_MIME,
  PANE_DROP_EDGE_PX,
  closePane,
  createSplitLayout,
  findPane,
  insertPane,
  normalizeChatSplitLayout,
  panesOf,
  resizeColumns,
  resizePanes,
  setActivePane,
  setPaneSession,
  type ChatSplitLayout,
  type ChatSplitPane,
} from "@/utils/splitLayout";

const settings = useSettingsStore();
const agents = useAgentsStore();
const route = useRoute();
const router = useRouter();

// ---------------------------------------------------------------------------
// 二级目录折叠态
// ---------------------------------------------------------------------------

/** 二级目录是否收起（收起后只剩对话主图标）。持久化到 localStorage，切页不丢。 */
const SIDE_COLLAPSED_KEY = "openclaw.web.chat-side-collapsed.v1";

function readSideCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDE_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

const sideCollapsed = ref<boolean>(readSideCollapsed());

/**
 * 手机端二级目录抽屉是否打开。
 *
 * 桌面端不使用（侧栏是常驻的一列），所以初值恒为 `false`；视口切回桌面时会被
 * `watch(mobile, ...)` 复位，避免「拉宽后又缩窄 → 抽屉自动弹开」。
 */
const drawerOpen = ref(false);

/**
 * 二级目录的开关。
 *
 * 两种形态：桌面端 = 「收起成 44px 图标条」（持久化），手机端 = 「推出/收起覆盖式抽屉」
 * （不持久化 —— 抽屉开着刷新页面没有意义）。
 */
function toggleSide(): void {
  if (mobile.value) {
    drawerOpen.value = !drawerOpen.value;
    return;
  }
  sideCollapsed.value = !sideCollapsed.value;
  try {
    window.localStorage.setItem(SIDE_COLLAPSED_KEY, sideCollapsed.value ? "1" : "0");
  } catch {
    // 隐私模式下 localStorage 不可用，忽略
  }
}

function closeDrawer(): void {
  drawerOpen.value = false;
}

/** 点了目录里的某个智能体 → 关掉抽屉，让用户立刻看到对话（否则还得再点一次遮罩）。 */
function onSidebarSelect(): void {
  closeDrawer();
}

/** Esc 关抽屉：与 Element Plus 各弹层的行为保持一致。 */
function onWindowKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && drawerOpen.value) closeDrawer();
}

/**
 * 当前会话 key：`?session=` 显式指定 > settings 存储值，**且一律归一为规范主会话**
 * （`agent:<id>:<mainKey>`，见 `utils/canonicalSession.ts`）。
 *
 * 归一化放在这个 computed 里，因为它是全页「当前在看哪条会话」的唯一读取口 ——
 * 在入口处收敛，比在模板与各调用点分别判断可靠。
 *
 * 刻意用 `||` 而不是 `??`：`?session=` 与 store 值都可能是空串（空串不是 nullish，
 * 用 `??` 会让空串穿透），而网关的 `chat.history` / `chat.send` 都要求至少 1 个字符。
 *
 * ## 入口 agent 由链接决定（2026-09-23 改造）
 * `?session=` 支持**裸 agentId**（`study-abroad-consultant`）——上游控制台签发的链接就是
 * 这个形态，会被解析成 `agent:study-abroad-consultant:<mainKey>`。
 *
 * 链接**没带** `session` 时落到 **chat 页的首个会话** = 侧栏（`agents.agents`）第一条
 * 对应的 agent —— 与用户进页面后看到的「第一行」是同一个东西。
 * 表还没回来（快照也没有）时才退到网关 `agents.defaultId`；再没有就是空串
 * （见 `sessionOptions()` 与下面那个「表回来后重新收敛」的 watch）。
 *
 * ⚠️ 链接**带了** `session` 却读不出 agent（旧书签 `id-<hash8>`、渠道键 `wechat`、
 * 裸 `main`）时**等同于没带**：这类值映射不到任何会话，若照原样当候选，它会顶掉
 * 「首个会话」兜底，还会让地址栏一直挂着一条网关侧根本没有的 key。
 * 判定复用 `resolveSessionParam`（与真正写 session 时同一套规则），不另立口径。
 */
const currentSessionKey = computed<string>(() => {
  const fromRoute = typeof route.query.session === "string" ? route.query.session.trim() : "";
  const usableFromRoute = resolveSessionParam(fromRoute, sessionOptions()) ? fromRoute : "";
  return canonicalMainSessionKey(usableFromRoute || settings.sessionKey, sessionOptions());
});

/**
 * 「入口会话」的候选来源 —— 全部取自运行时，**没有任何写死的 agent**。
 *
 * `firstAgentId` 取侧栏列表第一条：`agents.agents` 直接来自 `agents.list`（网关顺序，
 * 前端不重排），侧栏 `v-for="agent in agents.agents"` 也是同一个数组 ⇒
 * 「首个会话」在数据层与视觉层严格一致。
 */
function sessionOptions(): SessionResolveOptions {
  return {
    mainKey: agents.mainKey,
    firstAgentId: agents.agents[0]?.id ?? null,
    defaultAgentId: agents.defaultId,
  };
}

/**
 * 网关 `agents.list` 里有没有这个 agent。
 *
 * ⚠️ 只在**已就绪**（`agents.loaded`）时才敢判「不存在」：冷启动窗口内表还是空的，
 * 那时把链接里的 agent 判成不存在会直接把用户踢走。
 * 表就绪后仍查不到 ⇒ 该 agent 的会话在侧栏与发送守卫里都是不可达的
 * （守卫只认 `cfg.agents.list`），继续停在它上面只会得到一个发不出消息的空窗格。
 */
function agentExistsInGateway(agentId: string): boolean {
  if (!agents.loaded) return true;
  const want = normalizeAgentId(agentId);
  return agents.agents.some((row) => normalizeAgentId(row.id) === want);
}

/**
 * 兜底修正：当前 agent 不在网关的 agent 表里 ⇒ 换用**首个会话**（不是某个写死的 agent）。
 *
 * 返回空串表示「不用改」。覆盖两种情形：
 * - 链接指向的 agent 已下线 / 被改名；
 * - 冷启动时用了本地快照里**已经过期**的「第一条」，表回来后要校正。
 *
 * 刻意只改**入口落地**这一次（由 `normalizeSessionQuery` 调用），不在 computed 里做 ——
 * computed 里改值会让地址栏在每次 `agents.list` 刷新时都可能被重写一次，那不是用户动作。
 */
function resolveUnreachableAgentSession(key: string): string {
  const parsed = parseAgentSessionKey(key);
  if (!parsed || agentExistsInGateway(parsed.agentId)) return "";
  const fallback = canonicalMainSessionKey(null, sessionOptions());
  return fallback && fallback !== key ? fallback : "";
}

/**
 * 把地址栏的 `session` 拉回规范形态（缺失 / 空 / 裸 `main` / `id-<hash8>` / 子会话…），
 * 并顺带把 store 与地址栏对齐。
 *
 * 只在**需要改写**时动 URL，且用 `replace`：这是「把异常值拉回规范」的兜底，
 * 不是用户主动切换（那种走 `setCurrentSession` 的 `push`，保留后退）。
 * 于是外部链接里的 `?session=agent:cet4:id-4daf4b7d` 一进来就会被改写为
 * `?session=agent:cet4:main`，而地址栏不会堆出一条「改写前」的历史。
 *
 * ⚠️ 同时写 store：入口只改地址栏的话，`settings.sessionKey` 会停在旧值，
 * 侧栏高亮 / 窗格布局与「正在看的会话」就分叉了。
 *
 * ⚠️ `key` 为空 = 「还没定下来」（`agents.list` 与快照都没有 agent）⇒ **什么都不做**：
 * 既不能把空串写进 store / 地址栏，也不能让 `ChatPane` 拿到空 prop
 * （它会自己退到 `main`，那是一条并不存在的会话）。
 * 这种情况由下面的 watch 在表回来后重试。
 *
 * 唯一的例外是地址栏挂着一条**读不出 agent** 的 `session`（旧书签 `id-<hash8>`、
 * 渠道键 `wechat`、裸 `main`）：它既不是用户的选择、也映射不到任何会话，
 * 留着只会让地址栏永远挂着一条解释不了的 key —— 摘掉它（`currentSessionKey` 已经
 * 把这类值等同于「没带」，所以摘掉不会改变当前会话）。
 */
function normalizeSessionQuery(): void {
  const key = resolveUnreachableAgentSession(currentSessionKey.value) || currentSessionKey.value;
  if (!key) {
    // `!key` 且地址栏有值 ⇒ 一定是「读不出 agent」的脏值（能读出来 key 就不会为空）。
    const raw = typeof route.query.session === "string" ? route.query.session.trim() : "";
    if (!raw) return;
    const query = { ...route.query };
    delete query.session;
    void router.replace({ path: route.path, query });
    return;
  }

  // 地址栏与 store 必须一起改：只改地址栏的话，侧栏高亮 / 窗格布局与
  // 「正在看的会话」会分叉（下次进来还会显示上一个顾问）。
  if (settings.sessionKey !== key) settings.setSessionKey(key);

  // 地址栏已经等于最终 key ⇒ 形态已规范，不必进历史。
  // 这条等价于旧的 `!needsSessionQueryNormalize(...)` 判断，但不会在
  // 「形态规范、agent 却不可达」时误判成「无事可做」。
  if (route.query.session === key) return;
  void router.replace({
    path: route.path,
    query: { ...route.query, session: key },
  });
}

/**
 * 「还没定下来」或「定错了」时再收敛一次 —— 入口会话依赖**运行时**的 agent 列表
 * （chat 页首个会话 = `agents.list` 第一条），而它晚于首屏到达：
 *
 * - 冷启动且本地没有侧栏快照 ⇒ `currentSessionKey` 先是空串，表回来后才能落到首个会话；
 * - 快照里的「第一条」在网关侧已经不存在 ⇒ `normalizeSessionQuery` 换到当前的首个会话；
 * - 网关 `mainKey` 与快照里不一致 ⇒ 规范 key 的尾段要跟着纠正。
 *
 * ⚠️ 收敛本身是**幂等、且只在有差异时写**的（比 `route.query.session` 与
 * `settings.sessionKey`），所以用户主动切换（侧栏 / 窗格下拉 / 打开拆分视图）
 * 不会被这里覆盖 —— 那时地址栏已经带着目标 `session`。
 */
watch(
  () => [agents.loaded, agents.agents[0]?.id ?? "", agents.mainKey, agents.defaultId] as const,
  () => normalizeSessionQuery(),
);

// ---------------------------------------------------------------------------
// 拆分视图布局
// ---------------------------------------------------------------------------

/**
 * 布局持久化。
 *
 * ⚠️ 键里带 `v1`，且**读盘必须走 `normalizeChatSplitLayout`**：旧版本写进去的形状
 * 可能缺字段 / 权重全 0 / pane id 重复，直接拿来渲染会得到「某一列宽 0、肉眼看不见」
 * 这种诡异状态，而不是报错。归一化失败就当作「没有布局」（退回单窗格）。
 */
const SPLIT_LAYOUT_KEY = "openclaw.web.chatSplitLayout.v1";

function readPersistedLayout(): ChatSplitLayout | undefined {
  try {
    const raw = window.localStorage.getItem(SPLIT_LAYOUT_KEY);
    if (!raw) return undefined;
    const normalized = normalizeChatSplitLayout(JSON.parse(raw) as unknown);
    // 归一化失败当作「没有布局」；成功则顺带把窗格会话归一到规范主会话。
    return normalized ? normalizeLayoutSessions(normalized) : undefined;
  } catch {
    return undefined;
  }
}

function persistLayout(next: ChatSplitLayout | undefined): void {
  try {
    if (next) {
      window.localStorage.setItem(SPLIT_LAYOUT_KEY, JSON.stringify(next));
    } else {
      window.localStorage.removeItem(SPLIT_LAYOUT_KEY);
    }
  } catch {
    // 配额满 / 隐私模式下静默降级：布局只在本次会话内有效
  }
}

/**
 * 把布局里每个窗格的会话归一到「该 agent 的规范主会话」。
 *
 * 持久化布局（localStorage）里可能带着 `agent:<id>:id-<hash8>` 这类旧 key ——
 * 不收敛的话，拆分视图会出现「右侧窗格还在看那条早该废弃的会话」，
 * 相当于把旧会话又保留了一份（见 `utils/canonicalSession.ts`）。
 */
function normalizeLayoutSessions(source: ChatSplitLayout): ChatSplitLayout {
  let next = source;
  for (const pane of panesOf(source)) {
    const key = canonicalMainSessionKey(pane.sessionKey, sessionOptions());
    if (pane.sessionKey !== key) next = setPaneSession(next, pane.id, key);
  }
  return next;
}

/** `undefined` = 单窗格模式。 */
const layout = ref<ChatSplitLayout | undefined>(readPersistedLayout());

function applyLayout(next: ChatSplitLayout | undefined): void {
  layout.value = next;
  persistLayout(next);
}

/**
 * 窄屏（< 1100px）只渲染活动窗格。
 *
 * 与旧版 `NARROW_SPLIT_QUERY` 一致：窄屏下并排两个窗格每个都不到 320px，
 * 消息气泡和输入框都会挤坏。此模式下也**隐藏「打开拆分视图」入口**，
 * 避免用户点了之后「什么也没发生」。
 */
const NARROW_SPLIT_QUERY = "(max-width: 1099px)";
const narrow = ref(false);

/**
 * 手机形态（≤768px，含「矮横屏」）。
 *
 * ⚠️ 这个字符串必须与 `src/styles/layout.mobile.css` 的 `@media` 条件**逐字一致**：
 * JS 与 CSS 判断漂移就会出现「CSS 已按手机排版、JS 还以为是桌面」（或反过来）——
 * 典型症状是抽屉已经变成覆盖层、但布局层还在按并排两列算宽度。
 * 矮横屏（宽 ≤932px 且高 ≤500px）单独列出，因为那时纵向比横向更紧张。
 */
const MOBILE_QUERY =
  "(max-width: 768px), (max-width: 932px) and (max-height: 500px) and (orientation: landscape)";
const mobile = ref(false);

/** 媒体查询的清理函数（`onBeforeUnmount` 统一调用，避免监听器泄漏）。 */
const mediaQueryDisposers: Array<() => void> = [];

function bindMediaQuery(query: string, target: Ref<boolean>): void {
  const mediaQuery = window.matchMedia(query);
  target.value = mediaQuery.matches;
  const onChange = (event: MediaQueryListEvent): void => {
    target.value = event.matches;
  };
  mediaQuery.addEventListener("change", onChange);
  mediaQueryDisposers.push(() => mediaQuery.removeEventListener("change", onChange));
}

/** 视口回到桌面宽度时把抽屉收掉：不这么做，`drawerOpen` 会残留成「真」。 */
watch(mobile, (isMobile) => {
  if (!isMobile) closeDrawer();
});

/** 活动窗格；单窗格模式下为 null。 */
const activePane = computed<ChatSplitPane | null>(() => {
  const current = layout.value;
  return current ? (findPane(current, current.activePaneId)?.pane ?? null) : null;
});

/** 单窗格模式下是否展示「打开拆分视图」入口（窄屏没有意义）。 */
const allowOpenSplit = computed(() => !narrow.value);

/** 布局里的全部窗格（按渲染顺序）；单窗格模式下为空。 */
const layoutPanes = computed<ChatSplitPane[]>(() => (layout.value ? panesOf(layout.value) : []));

/**
 * 是否渲染顶部窗格切换器。
 *
 * 只有「窄屏 **且** 处于拆分态」才需要：窄屏下只渲染活动窗格，
 * 没有切换器另一个窗格就不可达（旧版 `ui/` 正好缺这个东西）。
 * 桌面拆分态不需要 —— 两个窗格都摆在眼前，点一下就是切换。
 */
const showPaneTabs = computed(() => narrow.value && layoutPanes.value.length > 1);

/**
 * 路由 / settings 的会话变化 → 同步到**活动窗格**（拆分态）。
 *
 * 为什么要有这一步：侧栏点某个会话时只改 `settings.sessionKey`（不 push 路由），
 * 而组件实例不会重建，必须显式把新 key 写进布局里的活动窗格，否则点了没反应。
 */
watch(
  () => [route.query.session, settings.sessionKey] as const,
  () => {
    const current = layout.value;
    if (!current) return;
    const next = currentSessionKey.value;
    const active = findPane(current, current.activePaneId)?.pane;
    if (!active || active.sessionKey === next) return;
    applyLayout(setPaneSession(current, active.id, next));
  },
);

/**
 * 把某个会话设为「当前会话」：写 settings + 路由（侧栏高亮 / 刷新可复原）。
 *
 * ⚠️ 入参先归一到**该 agent 的规范主会话**（见 `utils/canonicalSession.ts`）：
 * 「点侧栏切 agent」有效，但「切到主会话以外的会话」不会发生 —— 那正是同一个 agent
 * 名下堆出多条会话的来源。会话 key 的唯一写入口也在这里 / `settings.setSessionKey`。
 */
function setCurrentSession(nextSessionKey: string, replace = false): void {
  const key = canonicalMainSessionKey(nextSessionKey, sessionOptions());
  if (settings.sessionKey !== key) {
    settings.setSessionKey(key);
  }
  if (route.query.session === key) return;
  void router[replace ? "replace" : "push"]({
    path: route.path,
    query: { ...route.query, session: key },
  });
}

/** 点某个窗格 → 它成为活动窗格，并把它的会话提为「当前会话」。 */
function handleFocusPane(paneId: string): void {
  const current = layout.value;
  if (!current || current.activePaneId === paneId) return;
  const next = setActivePane(current, paneId);
  applyLayout(next);
  const pane = findPane(next, paneId)?.pane;
  if (pane) setCurrentSession(pane.sessionKey, true);
}

/**
 * 窗格内切换会话（窗格头下拉）。
 *
 * 入参同样经 `setCurrentSession` 归一（→ 该 agent 的规范主会话），所以下拉里即使
 * 列出了历史 `id-<hash8>` 会话，选中后也只会落到主会话上。
 */
function handlePaneSessionChange(paneId: string, nextSessionKey: string): void {
  const current = layout.value;
  const key = canonicalMainSessionKey(nextSessionKey, sessionOptions());
  if (!current) {
    setCurrentSession(key);
    return;
  }
  const pane = findPane(current, paneId)?.pane;
  if (!pane || pane.sessionKey === key) {
    if (current.activePaneId === paneId) setCurrentSession(key);
    return;
  }
  const next = setPaneSession(current, paneId, key);
  applyLayout(next);
  if (next.activePaneId === paneId) setCurrentSession(key);
}

/**
 * 「打开拆分视图」（旧版 chat-page.ts:openSplitView）：
 * 当前会话左右裂成两栏，新窗格默认持有同一个会话。
 */
function openSplitView(): void {
  const current = layout.value;
  if (current) return;
  applyLayout(createSplitLayout(currentSessionKey.value));
}

function handleSplitRight(paneId: string): void {
  const current = layout.value;
  if (!current) return;
  const pane = findPane(current, paneId)?.pane;
  if (!pane) return;
  applyLayout(insertPane(current, paneId, pane.sessionKey, "right"));
}

function handleSplitDown(paneId: string): void {
  const current = layout.value;
  if (!current) return;
  const pane = findPane(current, paneId)?.pane;
  if (!pane) return;
  applyLayout(insertPane(current, paneId, pane.sessionKey, "down"));
}

// ---------------------------------------------------------------------------
// 拖拽拆分落区（对齐旧版 split-drop-zone）
// ---------------------------------------------------------------------------

/** 正在被拖动的窗格（null = 当前没有窗格拖拽）。 */
const draggingPaneId = ref<string | null>(null);
/** 落点：哪个窗格的哪个方向（`right` = 左右拆分，`down` = 上下拆分）。 */
const dropTarget = ref<{ paneId: string; edge: "right" | "down" } | null>(null);

function handlePaneDragStart(paneId: string): void {
  draggingPaneId.value = paneId;
}

function handlePaneDragEnd(): void {
  draggingPaneId.value = null;
  dropTarget.value = null;
}

/** 命中哪个窗格的哪条边；不在边缘区域 ⇒ null（不显示落区，也不接受 drop）。 */
function resolveDropTarget(event: DragEvent): { paneId: string; edge: "right" | "down" } | null {
  const current = layout.value;
  if (!current) return null;
  const el = (event.target as HTMLElement | null)?.closest?.("[data-pane-id]") as HTMLElement | null;
  const paneId = el?.dataset.paneId;
  if (!paneId || !findPane(current, paneId)) return null;
  const rect = el!.getBoundingClientRect();
  const minX = Math.min(event.clientX - rect.left, rect.right - event.clientX);
  const minY = Math.min(event.clientY - rect.top, rect.bottom - event.clientY);
  if (Math.min(minX, minY) > PANE_DROP_EDGE_PX) return null;
  // 离左右边更近 ⇒ 横向拆分；离上下边更近 ⇒ 纵向拆分
  return { paneId, edge: minX <= minY ? "right" : "down" };
}

function onSplitDragOver(event: DragEvent): void {
  if (!draggingPaneId.value) return;
  if (!event.dataTransfer?.types.includes(PANE_DRAG_MIME)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  dropTarget.value = resolveDropTarget(event);
}

function onSplitDragLeave(event: DragEvent): void {
  // 子元素之间移动也会连续触发 dragleave —— 只有真正离开容器才清高亮。
  const next = event.relatedTarget as Node | null;
  if (next && (event.currentTarget as HTMLElement | null)?.contains(next)) return;
  dropTarget.value = null;
}

function onSplitDrop(event: DragEvent): void {
  const target = dropTarget.value;
  const source = draggingPaneId.value;
  dropTarget.value = null;
  if (!target || !source || !layout.value || target.paneId === source) return;
  event.preventDefault();
  const pane = findPane(layout.value, target.paneId)?.pane;
  if (!pane) return;
  applyLayout(insertPane(layout.value, target.paneId, pane.sessionKey, target.edge));
  draggingPaneId.value = null;
}

/**
 * 关闭窗格。
 *
 * `closePane` 在「只剩一个窗格」时返回 `undefined` —— 这时退回单窗格渲染，
 * 并把活下来那个窗格的会话提为当前会话，避免路由/侧栏停留在已关掉的会话上。
 */
function handleClosePane(paneId: string): void {
  const current = layout.value;
  if (!current) return;
  const survivingPane = panesOf(current).find((pane) => pane.id !== paneId) ?? null;
  const next = closePane(current, paneId);
  applyLayout(next);
  if (!next) {
    if (survivingPane) setCurrentSession(survivingPane.sessionKey, true);
    return;
  }
  const active = findPane(next, next.activePaneId)?.pane;
  if (active) setCurrentSession(active.sessionKey, true);
}

// ---------------------------------------------------------------------------
// 右侧详情面板 + 文件预览弹窗
// ---------------------------------------------------------------------------

/**
 * 当前在详情面板展开的消息（null = 面板关闭）。
 *
 * 状态由布局层持有：多个窗格（单窗格 / 拆分 / 窄屏活动窗格）都能触发「详情」，
 * 但面板在布局层**只有一个** —— 谁点开就显示谁，切会话/关窗格时顺带收起。
 */
const detailMessage = ref<ChatMessage | null>(null);

/** 详情面板展示的消息所属 agent 的展示名（点开时按活动窗格的会话推导）。 */
const detailAgentName = ref<string>("");

/** 文件预览弹窗是否打开。 */
const filePreviewOpen = ref(false);
/** 文件预览弹窗的初始选中文件。 */
const filePreviewActivePath = ref("");

/** 点「详情」按钮：在右侧面板展开该消息的完整内容，并记录其 agent 展示名。 */
function handleOpenDetail(message: ChatMessage): void {
  detailMessage.value = message;
  // 助手消息按当前会话对应的 agent 取展示名；非助手消息面板回落「我 / 助手」。
  if (message.role === "assistant") {
    detailAgentName.value = agents.nameForAgent(agents.agentIdForSession(currentSessionKey.value));
  } else {
    detailAgentName.value = "";
  }
}

/** 关闭详情面板（顺带关掉文件预览弹窗，避免面板关了弹窗还悬着）。 */
function closeDetail(): void {
  detailMessage.value = null;
  filePreviewOpen.value = false;
}

/**
 * 详情面板里点「查看会话工作区文件」→ 打开文件预览弹窗。
 *
 * ⚠️ 数据源为**初步实现**：当前从详情消息本身可提取的文件引用（正文里的本地文件
 * 路径、content 附件文档）构造文件列表，让弹窗可真实工作。完整的「会话工作区文件树」
 * 需接入网关 workspace RPC（`session.workspace.*`），作为后续增量 —— 届时只需替换
 * `workspaceFiles` 的取值来源，弹窗组件无需改动。
 */
function openFilePreview(): void {
  filePreviewActivePath.value = "";
  filePreviewOpen.value = true;
}

/** 文件预览弹窗的文件列表（当前 = 从详情消息提取的文件引用，初步实现）。 */
const workspaceFiles = computed<PreviewFile[]>(() => {
  const msg = detailMessage.value;
  if (!msg) return [];
  const files: PreviewFile[] = [];
  const seen = new Set<string>();
  const push = (path: string): void => {
    const clean = path.trim();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    files.push({ path: clean, size: "", contents: "" });
  };
  // 1) content 里的文档附件
  for (const att of msg.contentAttachments ?? []) {
    if (att.kind === "document") push(att.label || att.url);
  }
  // 2) 正文里出现的本地文件路径（/root/…、~/… 等常见形态）
  const text = msg.text ?? "";
  const pathRe = /(?:\/[\w./-]+|~\/[\w./-]+)/g;
  for (const m of text.matchAll(pathRe)) push(m[0]);
  return files;
});

onMounted(() => {
  // 首屏把地址栏的 session 拉回规范形态：带 token 的静默登录链接、旧书签
  // （可能写着 `id-<hash8>`）、手改 URL 一律在这一步收敛。
  normalizeSessionQuery();
  bindMediaQuery(NARROW_SPLIT_QUERY, narrow);
  bindMediaQuery(MOBILE_QUERY, mobile);
  window.addEventListener("keydown", onWindowKeydown);
});

onBeforeUnmount(() => {
  for (const dispose of mediaQueryDisposers) dispose();
  mediaQueryDisposers.length = 0;
  window.removeEventListener("keydown", onWindowKeydown);
});
</script>

<template>
  <div class="chat-layout">
    <!-- 二级目录：只有智能体列表一段（点击切换该 agent 的代表会话）。
         手机端（`mobile`）它不再是常驻的一列，而是 `position: fixed` 的覆盖式抽屉
         （样式在 ChatSidebar.vue 里，因为要覆盖它自己的宽度，必须同文件内定顺序）——
         390px 宽的屏幕上，236px 的常驻侧栏会把对话区压到 154px，完全没法用。 -->
    <ChatSidebar
      :collapsed="mobile ? false : sideCollapsed"
      :drawer="mobile"
      :open="drawerOpen"
      @toggle="toggleSide"
      @select="onSidebarSelect"
    />

    <!-- 抽屉遮罩：点它关闭。比要求用户去点抽屉里的「关闭」宽容得多，
         手机上尤其重要（抽屉本身也可能很长）。 -->
    <div v-if="mobile && drawerOpen" class="chat-backdrop" @click="closeDrawer" />

    <!-- 对话主区：顶部（窄屏拆分态）挂窗格切换器，下面是窗格 / 拆分容器。
         桌面端不渲染切换器，这一层只是个透明的 flex 列，布局与改动前完全一致。 -->
    <div class="chat-main">
      <!-- 窄屏 + 拆分态：只渲染活动窗格，所以必须给一条切换入口，否则另一个窗格不可达。
           桌面拆分态不需要 —— 两个窗格都摆在眼前，点一下就是切换。 -->
      <ChatPaneTabs
        v-if="showPaneTabs"
        :panes="layoutPanes"
        :active-pane-id="layout?.activePaneId ?? ''"
        @select="handleFocusPane"
      />

      <!-- 单窗格模式：直接把当前会话交给唯一的窗格 -->
      <ChatPane
        v-if="!layout"
        pane-id="single"
        class="chat-split-view__pane chat-split-view__pane--single"
        :session-key="currentSessionKey"
        :active="true"
        chrome="none"
        :allow-split="allowOpenSplit"
        :side-collapsed="sideCollapsed"
        :side-drawer="mobile"
        @focus-pane="handleFocusPane"
        @session-change="handlePaneSessionChange"
        @open-split="openSplitView"
        @toggle-side="toggleSide"
        @open-detail="handleOpenDetail"
      />

      <!-- 拆分视图 -->
      <div
        v-else
        class="chat-split-view"
        :class="{ 'chat-split-view--narrow': narrow }"
        @dragover="onSplitDragOver"
        @dragleave="onSplitDragLeave"
        @drop="onSplitDrop"
      >
        <!-- 窄屏：只渲染活动窗格，**不套列 / 不渲染任何分隔条**
             （旧版 renderSplitLayout 的 narrow 分支）——若仍走列结构，
             窗格宽度会是它所在列的权重，而不是整行宽。

             `chrome="pane"`（旧版同样是 `chrome="pane"`）：窄屏也必须保留窗格头，
             否则会话下拉和「关闭窗格」一起消失，用户被困在多窗格状态里出不来。
             旧版口径见 `ui/src/pages/chat/chat-page.ts:374-375`
             「keep session switching and close available」。
             拆分回调一律不传（`allow-pane-split=false` 让两个拆分按钮也不渲染）：
             窄屏拆出来的新窗格肉眼不可见，按钮点了等于没反应。 -->
        <ChatPane
          v-if="narrow && activePane"
          class="chat-split-view__pane chat-split-view__pane--solo"
          :pane-id="activePane.id"
          :session-key="activePane.sessionKey"
          :active="true"
          chrome="pane"
          :allow-split="false"
          :allow-pane-split="false"
          :side-collapsed="sideCollapsed"
          :side-drawer="mobile"
          @focus-pane="handleFocusPane"
          @session-change="handlePaneSessionChange"
          @close-pane="handleClosePane"
          @toggle-side="toggleSide"
          @open-detail="handleOpenDetail"
        />

        <template v-for="(column, columnIndex) in layout.columns" :key="column.id">
          <div
            v-if="!narrow"
            class="chat-split-view__column"
            :style="{ flex: `${layout.columnWeights[columnIndex] ?? 1} 1 0` }"
          >
            <template v-for="(pane, paneIndex) in column.panes" :key="pane.id">
              <ChatPane
                class="chat-split-view__pane"
                :class="{
                  'is-drop-h': dropTarget?.paneId === pane.id && dropTarget.edge === 'right',
                  'is-drop-v': dropTarget?.paneId === pane.id && dropTarget.edge === 'down',
                }"
                :style="{ flex: `${column.paneWeights[paneIndex] ?? 1} 1 0` }"
                :pane-id="pane.id"
                @pane-drag-start="handlePaneDragStart"
                @pane-drag-end="handlePaneDragEnd"
                :session-key="pane.sessionKey"
                :active="pane.id === layout.activePaneId"
                chrome="pane"
                :allow-split="false"
                :allow-pane-split="true"
                :side-collapsed="sideCollapsed"
                :side-drawer="mobile"
                @focus-pane="handleFocusPane"
                @session-change="handlePaneSessionChange"
                @open-split="openSplitView"
                @split-right="handleSplitRight"
                @split-down="handleSplitDown"
                @close-pane="handleClosePane"
                @toggle-side="toggleSide"
                @open-detail="handleOpenDetail"
              />
              <!-- 同列内相邻两窗格之间的横向分隔条（旧版 orientation="horizontal"） -->
              <ResizableDivider
                v-if="paneIndex < column.panes.length - 1"
                orientation="horizontal"
                :split-ratio="
                  (column.paneWeights[paneIndex] ?? 1) /
                  ((column.paneWeights[paneIndex] ?? 1) + (column.paneWeights[paneIndex + 1] ?? 1))
                "
                :min-ratio="0.15"
                :max-ratio="0.85"
                label="调整上下拆分比例"
                @resize="
                  (payload) => layout && applyLayout(resizePanes(layout, column.id, paneIndex, payload.splitRatio))
                "
              />
            </template>
          </div>
          <!-- 列与列之间的竖向分隔条（窄屏整列都不渲染，这里一并关掉） -->
          <ResizableDivider
            v-if="!narrow && columnIndex < layout.columns.length - 1"
            :split-ratio="
              (layout.columnWeights[columnIndex] ?? 1) /
              ((layout.columnWeights[columnIndex] ?? 1) + (layout.columnWeights[columnIndex + 1] ?? 1))
            "
            :min-ratio="0.15"
            :max-ratio="0.85"
            label="调整左右拆分比例"
            @resize="(payload) => layout && applyLayout(resizeColumns(layout, columnIndex, payload.splitRatio))"
          />
        </template>
      </div>
    </div>

    <!-- 右侧详情面板：点消息下的「详情」按钮后，展开该消息的完整内容。 -->
    <ChatDetailSidebar
      :message="detailMessage"
      :agent-name="detailAgentName"
      @close="closeDetail"
      @open-file-preview="openFilePreview"
    />

    <!-- 会话工作区文件预览弹窗（详情面板里「查看会话工作区文件」触发）。 -->
    <FilePreviewModal
      v-if="filePreviewOpen"
      :files="workspaceFiles"
      :active-path="filePreviewActivePath"
      @close="filePreviewOpen = false"
      @select="(path) => (filePreviewActivePath = path)"
    />
  </div>
</template>

<style scoped>
/* 对话页 = 二级目录（智能体列表） + 一个或多个对话窗格 */
.chat-layout {
  display: flex;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

/**
 * 对话主区：`[窗格切换器?] + [窗格 | 拆分容器]`。
 *
 * 这一层是给窄屏顶部标签条准备的槽位 —— 标签条必须和下面的窗格**同一列**，
 * 否则它会横跨到侧栏上方。桌面端不渲染标签条，这层就是一条透明的 flex 列，
 * 布局与改造前完全一致（拆分容器仍是 `flex: 1 1 0`，只是在列方向上生长）。
 */
.chat-main {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

/**
 * 抽屉遮罩。只在手机端且抽屉打开时存在（模板里的 `v-if`），所以无需 `@media` 包住。
 *
 * `z-index` 与抽屉（`ChatSidebar.vue` 里的 `70`）配套：遮罩 60 < 抽屉 70，
 * 两者都远低于 Element Plus 弹层（`el-message` 等从 2000 起）。
 *
 * ⚠️ 不要给 `.chat-layout` 或任何祖先加 `transform` / `filter` —— 那会让
 * `position: fixed` 相对那个祖先定位（containing block 变了），遮罩就不再铺满视口。
 */
.chat-backdrop {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: rgba(15, 23, 42, 0.45);
}

/* ============== 拆分视图容器 ============== */

.chat-split-view {
  display: flex;
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.chat-split-view__column {
  display: flex;
  flex-direction: column;
  min-width: 320px;
  min-height: 0;
}

/* 单个窗格：宽度由 inline `flex: <weight> 1 0` 决定，这里只管最小尺寸与裁切 */
.chat-split-view__pane {
  min-width: 0;
  min-height: 200px;
  overflow: hidden;
}

/* 单窗格模式直接铺满（此时它是 `.chat-layout` 的 flex 子项） */
.chat-split-view__pane--single {
  flex: 1 1 0;
  min-height: 0;
}

/* 窄屏独占整行的窗格（不套列）：撑满整行，不再需要 200px 的最小高度 */
.chat-split-view__pane--solo {
  flex: 1 1 0;
  min-height: 0;
}

.chat-split-view--narrow .chat-split-view__pane {
  min-height: 0;
}


/* 拖拽拆分落区：把窗格头拖到别的窗格边缘时，给出插入方向的指示 */
.chat-split-view__pane.is-drop-h,
.chat-split-view__pane.is-drop-v {
  background: var(--el-color-primary-light-9, #ecf5ff);
}

.chat-split-view__pane.is-drop-h {
  box-shadow: inset 4px 0 0 var(--el-color-primary, #409eff);
}

.chat-split-view__pane.is-drop-v {
  box-shadow: inset 0 4px 0 var(--el-color-primary, #409eff);
}
</style>
