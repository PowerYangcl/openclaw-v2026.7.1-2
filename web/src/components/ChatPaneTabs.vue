<script setup lang="ts">
/**
 * 窄屏顶部窗格切换器（手机端「窗格切换器」）。
 *
 * ## 为什么需要它
 *
 * 窄屏（`max-width: 1099px`）下布局层只渲染**活动窗格** —— 这是与旧版 `ui/` 一致的口径
 * （`ui/src/pages/chat/chat-page.ts:396-403` 的 narrow 分支），因为并排两个窗格时每个都
 * 不到 320px，消息气泡和输入框都会挤坏。
 * 但旧版**没有**提供任何切换手段（`chat-controls.ts` 里零个 `pane` 引用），于是窄屏一旦
 * 处于拆分态，另一个窗格就彻底不可达。本组件补的就是这个缺口。
 *
 * ## 职责边界
 *
 * 纯展示 + 事件上抛：不读路由、不读布局、不直接改 store。
 * 「有哪些窗格 / 哪个是活动的 / 要不要渲染这一行」全部由 `ChatView.vue` 决定
 * （它才是布局的持有者，见其文件头说明），所以 `v-if` 也由父级控制。
 *
 * ## 刻意不做的事
 *
 * - **不放「打开目录」按钮**：那条路已经由窗格头 `.chat-top` 里既有的目录按钮承担
 *   （手机端它会把侧栏当抽屉打开，见 `ChatPane` 的 `sideDrawer`）。在这里再放一个
 *   只会让手机顶部多一行 chrome。
 * - **不放「关闭窗格」**：窄屏下窗格头的关闭按钮仍在（对齐 `ui/`
 *   `chat-page.ts:374-375` 的「keep session switching and close available」）。
 */
import { ref, watch } from "vue";
import ChatAvatar from "@/components/ChatAvatar.vue";
import { useAgentsStore } from "@/stores/agents";
import { useSettingsStore } from "@/stores/settings";
import type { ChatSplitPane } from "@/utils/splitLayout";

const props = withDefaults(
  defineProps<{
    /** 布局里的全部窗格，按渲染顺序（`panesOf(layout)`）。 */
    panes?: ChatSplitPane[];
    /** 当前活动窗格 id。 */
    activePaneId?: string;
  }>(),
  { panes: () => [], activePaneId: "" },
);

const emit = defineEmits<{ (e: "select", paneId: string): void }>();

const agents = useAgentsStore();
const settings = useSettingsStore();

/**
 * 标签文案：`<agent 名>`；会话自己还有可辨识名字时拼成 `<agent 名> · <会话名>`。
 *
 * 沿用与窗格头会话下拉**完全相同**的取名链路（`agentIdForSession` / `nameForAgent` /
 * `sessionDisplayNameFor`）—— 两处名字必须一字不差，否则用户会以为是两个不同的会话。
 */
function labelForPane(pane: ChatSplitPane): string {
  const agentId = agents.agentIdForSession(pane.sessionKey);
  const agentName = agents.nameForAgent(agentId);
  const sessionName = agents.sessionDisplayNameFor(pane.sessionKey);
  if (!sessionName || sessionName === agentName) return agentName;
  return `${agentName} · ${sessionName}`;
}

function agentIdForPane(pane: ChatSplitPane): string {
  return agents.agentIdForSession(pane.sessionKey);
}

const stripRef = ref<HTMLElement | null>(null);

/**
 * 活动窗格变化后把对应标签滚进可视区。
 *
 * `inline: "nearest"` 是关键：标签少时不产生多余位移，标签多时只滚动最小必要距离
 * （用 `"center"` 会让首个标签一开始就被推走，看起来很跳）。
 * 必须 `await` 一个微任务：`activePaneId` 变了但 DOM 上的 `data-active` 还没更新完，
 * 立刻查会拿到旧节点。
 */
watch(
  () => props.activePaneId,
  async () => {
    await Promise.resolve();
    stripRef.value?.querySelector<HTMLElement>('[data-active="1"]')?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  },
);

function onSelect(paneId: string): void {
  if (paneId === props.activePaneId) return;
  emit("select", paneId);
}
</script>

<template>
  <div class="chat-pane-tabs">
    <div ref="stripRef" class="chat-pane-tabs__strip" role="tablist" aria-label="窗格切换">
      <button
        v-for="pane in panes"
        :key="pane.id"
        type="button"
        role="tab"
        class="chat-pane-tabs__tab"
        :class="{ 'is-active': pane.id === activePaneId }"
        :data-active="pane.id === activePaneId ? '1' : '0'"
        :aria-selected="pane.id === activePaneId"
        :title="`${labelForPane(pane)}（${pane.sessionKey}）`"
        @click="onSelect(pane.id)"
      >
        <ChatAvatar
          role="assistant"
          :name="labelForPane(pane)"
          :avatar="agents.avatarForAgent(agentIdForPane(pane))"
          :avatar-status="agents.avatarStatusForAgent(agentIdForPane(pane))"
          :agent-id="agentIdForPane(pane)"
          :token="settings.token"
          :size="18"
        />
        <span class="chat-pane-tabs__text">{{ labelForPane(pane) }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.chat-pane-tabs {
  display: flex;
  align-items: stretch;
  flex-shrink: 0;
  min-width: 0;
  padding: 0 calc(6px + var(--wb-safe-right, 0px)) 0 calc(6px + var(--wb-safe-left, 0px));
  border-bottom: 1px solid var(--wb-border);
  background: var(--wb-bg-card);
}

/**
 * 标签条：**横向滚动而不是换行**。
 *
 * 换行会让顶栏高度随窗格数变化（2 → 3 个时突然变高 40px），下面的消息区跟着跳；
 * 横向滚动下高度恒定，且与「同一时刻只显示一个窗格」的形态自洽。
 * 隐藏滚动条是因为手机端本来就靠手势横向滚动，一条 8px 的滚动条纯属占高。
 */
.chat-pane-tabs__strip {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1 1 auto;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
  -webkit-overflow-scrolling: touch;
  padding: 4px 0;
}

.chat-pane-tabs__strip::-webkit-scrollbar {
  display: none;
}

/**
 * ⚠️ `flex: 0 0 auto` 不能省。
 *
 * 少了它，flex 项会被压进可用宽度里，而里面的文字是 `nowrap` ⇒ 文字从标签框
 * **溢出去**，看起来像「标签相互叠字」，横向滚动也永远不触发。
 * 这与决策文档里 320px 视口下模拟标签条撑破页面是同一个成因。
 */
.chat-pane-tabs__tab {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 62vw;
  min-height: 32px;
  padding: 4px 10px;
  border: 1px solid var(--wb-border);
  border-radius: 999px;
  background: var(--wb-bg-card-strong);
  color: var(--wb-text-secondary);
  font: inherit;
  font-size: 12.5px;
  line-height: 1.4;
  cursor: pointer;
  appearance: none;
  transition:
    background 0.15s var(--wb-ease),
    border-color 0.15s var(--wb-ease);
}

/* 活动标签用「主色边框 + 染色底 + 加粗」三重信号，刻意不用任何阴影：
   inset box-shadow 会被子元素背景盖住（本仓踩过这个坑），药丸形态直接绕开。 */
.chat-pane-tabs__tab.is-active {
  border-color: var(--wb-accent);
  background: var(--wb-accent-soft);
  color: var(--wb-accent-strong);
  font-weight: 600;
}

.chat-pane-tabs__tab:active {
  background: var(--wb-bg-hover);
}

.chat-pane-tabs__text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
