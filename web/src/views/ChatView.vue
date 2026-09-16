<script setup lang="ts">
/**
 * 对话页 = 二级目录（智能体列表） + 一个或多个**对话窗格**。
 *
 * ## 结构
 * 单窗格（默认）：
 * ```
 * .chat-layout
 *   ├─ ChatSidebar
 *   └─ ChatPane(chrome="none")        ← 会话 key 直接来自路由 / settings
 * ```
 * 拆分视图：
 * ```
 * .chat-layout
 *   ├─ ChatSidebar
 *   └─ .chat-split-view
 *        ├─ .chat-split-view__column   (flex: columnWeight)
 *        │    ├─ ChatPane(chrome="pane")
 *        │    ├─ ResizableDivider(horizontal)
 *        │    └─ ChatPane(chrome="pane")
 *        ├─ ResizableDivider(vertical)
 *        └─ .chat-split-view__column …
 * ```
 *
 * 布局模型（列 / 窗格 / 权重）由 `@/utils/splitLayout` 提供，逐行移植自旧版
 * `ui/src/pages/chat/split-layout.ts`；容器的渲染顺序与旧版 `chat-page.ts` 一致。
 *
 * ## 职责边界
 * - **本文件**：持有「当前会话 key」「布局」「二级目录折叠态」，负责路由同步与持久化；
 * - **ChatPane.vue**：只渲染一个会话，不读路由、不写全局会话 key（见其文件头说明）。
 *
 * ## 与旧版的差异（有意为之）
 * 旧版把布局存进 `settings.chatSplitLayout`（网关侧 UI 设置）；本项目没有该字段，
 * 改用 localStorage（`openclaw.web.chatSplitLayout.v1`），与 `sidebarSnapshot` /
 * `chat-side-collapsed` 等既有本地状态的存放方式保持一致。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import ChatSidebar from "@/components/ChatSidebar.vue";
import ResizableDivider from "@/components/ResizableDivider.vue";
import ChatPane from "@/views/ChatPane.vue";
import { useSettingsStore } from "@/stores/settings";
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

function toggleSide(): void {
  sideCollapsed.value = !sideCollapsed.value;
  try {
    window.localStorage.setItem(SIDE_COLLAPSED_KEY, sideCollapsed.value ? "1" : "0");
  } catch {
    // 隐私模式下 localStorage 不可用，忽略
  }
}

/**
 * 当前会话 key：`?session=` 显式指定 > settings 里派生的 key > `main`。
 *
 * 刻意用 `||` 而不是 `??`：`?session=` 与 store 值都可能是空串（空串不是 nullish，
 * 用 `??` 会让空串穿透），而网关的 `chat.history` / `chat.send` 都要求至少 1 个字符。
 */
const currentSessionKey = computed<string>(
  () =>
    (typeof route.query.session === "string" ? route.query.session.trim() : "") ||
    settings.sessionKey.trim() ||
    "main",
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
    return normalizeChatSplitLayout(JSON.parse(raw) as unknown);
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
let mediaQuery: MediaQueryList | null = null;

function handleViewportChange(event: MediaQueryListEvent): void {
  narrow.value = event.matches;
}

/** 活动窗格；单窗格模式下为 null。 */
const activePane = computed<ChatSplitPane | null>(() => {
  const current = layout.value;
  return current ? (findPane(current, current.activePaneId)?.pane ?? null) : null;
});

/** 单窗格模式下是否展示「打开拆分视图」入口（窄屏没有意义）。 */
const allowOpenSplit = computed(() => !narrow.value);

/**
 * 路由 / settings 的会话变化 → 同步到**活动窗格**（拆分态）或单窗格。
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

/** 把某个会话设为「当前会话」：写 settings + 路由（侧栏高亮 / 刷新可复原）。 */
function setCurrentSession(nextSessionKey: string, replace = false): void {
  const key = nextSessionKey.trim();
  if (!key) return;
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

/** 窗格内切换会话（窗格头下拉）。 */
function handlePaneSessionChange(paneId: string, nextSessionKey: string): void {
  const current = layout.value;
  const key = nextSessionKey.trim();
  if (!key) return;
  if (!current) {
    setCurrentSession(key);
    return;
  }
  const pane = findPane(current, paneId)?.pane;
  if (!pane || pane.sessionKey === key) return;
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

onMounted(() => {
  mediaQuery = window.matchMedia(NARROW_SPLIT_QUERY);
  narrow.value = mediaQuery.matches;
  mediaQuery.addEventListener("change", handleViewportChange);
});

onBeforeUnmount(() => {
  mediaQuery?.removeEventListener("change", handleViewportChange);
  mediaQuery = null;
});
</script>

<template>
  <div class="chat-layout">
    <!-- 二级目录：只有智能体列表一段（点击切换该 agent 的代表会话） -->
    <ChatSidebar :collapsed="sideCollapsed" @toggle="toggleSide" />

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
      @focus-pane="handleFocusPane"
      @session-change="handlePaneSessionChange"
      @open-split="openSplitView"
      @toggle-side="toggleSide"
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
           窗格宽度会是它所在列的权重，而不是整行宽。 -->
      <ChatPane
        v-if="narrow && activePane"
        class="chat-split-view__pane chat-split-view__pane--solo"
        :pane-id="activePane.id"
        :session-key="activePane.sessionKey"
        :active="true"
        chrome="none"
        :allow-split="false"
        :side-collapsed="sideCollapsed"
        @focus-pane="handleFocusPane"
        @session-change="handlePaneSessionChange"
        @toggle-side="toggleSide"
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
              :side-collapsed="sideCollapsed"
              @focus-pane="handleFocusPane"
              @session-change="handlePaneSessionChange"
              @open-split="openSplitView"
              @split-right="handleSplitRight"
              @split-down="handleSplitDown"
              @close-pane="handleClosePane"
              @toggle-side="toggleSide"
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
</template>

<style scoped>
/* 对话页 = 二级目录（智能体列表） + 一个或多个对话窗格 */
.chat-layout {
  display: flex;
  height: 100%;
  min-height: 0;
  overflow: hidden;
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
