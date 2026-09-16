<script setup lang="ts">
/**
 * 对话页二级目录 —— **只有一段列表：智能体列表**。
 *
 * 搬运自上游 `ui/src/components/app-sidebar.ts` 的 `renderSessions()`：
 * - `renderAgentRow()`：智能体列表，每行 = 头像 + 名称 + 描述，点击切到该智能体的会话；
 * - `renderRecentSession()`：最近会话列表 —— **本项目已删除这一段**，原因：
 *   本项目在展示层把「每个 agent 收敛成一条会话」（见 `utils/sessionListSelection.ts`），
 *   于是「最近会话」与「智能体列表」是 **1:1 重复**：同一批 agent 出现两遍，
 *   第二遍还只能显示原始 key（`agent:cet4:main`）——用户反馈的「显示两种」就是它。
 *   现在只保留智能体列表，点击即切到该 agent 的代表会话（`selectAgent`），
 *   会话的「运行中 / 未读 / 最近活跃时间」内联到智能体行右侧，信息不丢。
 *
 * 头像与名称的取值链路与目标页一致：
 * agent 行头像 = `resolveAgentAvatarValue(agent, identity)`（原始值交给 ChatAvatar 判定）
 * （文本），统一交给 `ChatAvatar` 渲染；名称 = `resolveAgentLabel(agent, identity)`
 * —— 运行时身份优先，因为 `agents.list` 的行里通常没有 `name`。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useGatewayStore } from "@/stores/gateway";
import { useSettingsStore } from "@/stores/settings";
import { useAgentsStore } from "@/stores/agents";
import type { GatewaySessionRow, SessionsListResult } from "@/api/types";
import { formatSidebarTime } from "@/utils/format";
import {
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  parseAgentSessionKey,
} from "@/utils/sessionKey";
import {
  buildSidebarSessionRows,
  pickRepresentativeSession,
} from "@/utils/sessionListSelection";
import { resolveAgentAvatarValue, resolveAgentLabel } from "@/utils/avatar";
import { readSidebarSnapshot, writeSidebarSnapshot } from "@/utils/sidebarSnapshot";
import ChatAvatar from "@/components/ChatAvatar.vue";
import RefreshButton from "@/components/RefreshButton.vue";

withDefaults(defineProps<{ collapsed?: boolean }>(), { collapsed: false });
const emit = defineEmits<{ (e: "toggle"): void }>();

const gateway = useGatewayStore();
const settings = useSettingsStore();
const agents = useAgentsStore();
const router = useRouter();

/**
 * 首屏就用「上次见到的会话结构」渲染，`sessions.list` 回来后整表替换。
 * 没有快照（首次访问）时列表为空，由骨架屏占位 —— 见 `firstLoadSettled`。
 */
const bootstrap = readSidebarSnapshot(settings.gatewayUrl);

const sessions = ref<GatewaySessionRow[]>(bootstrap?.sessions ?? []);
const sessionsLoading = ref(false);

/**
 * 「智能体列表首次加载是否已落定」。
 *
 * ⚠️ 只由 `agents` 决定，**不再等 `sessions.list`**：侧栏现在只有智能体这一段列表，
 * 若把落定条件绑在会话接口上，会话慢时会把已经拿到的智能体列表也用骨架屏盖住。
 */
const agentsLoadSettled = ref(agents.loaded);
/** agentId → 描述（来自 config.get 的 agents.list[].description）。 */
const agentDescriptions = ref<Record<string, string>>({});

const token = computed(() => settings.token);
const currentSessionKey = computed(() => settings.sessionKey);
const selectedAgentId = computed(() => agents.selectedAgentId);

/**
 * 某 agent 的「代表会话」——每个 agent 只保留一条。
 *
 * 保留优先级（用户确认的规则，实现见 `utils/sessionListSelection.ts`）：
 *   1) **当前会话**（仅当它属于该 agent 且网关里真实存在）；
 *   2) **规范主会话** `agent:<id>:<mainKey>`——即用户口径里的 "main 会话"；
 *   3) 其余里**最近更新**的一条；
 *   4) 当前会话（网关尚未落库）+ 5) 规范主会话 key 两档兜底。
 *
 * 背景：入口 token 不同会派生出不同的 `agent:<id>:id-<hash8>` 会话
 * （见 `stores/settings.ts` 的 `deriveSessionKeyFromToken`），历史累积下来
 * 同一 agent 会出现 `:main` 和 `:id-xxxxxxxx` 并存。这里在**展示层**收敛成一条。
 */
function preferredSessionForAgent(agentId: string): string {
  return pickRepresentativeSession({
    agentId,
    sessions: sessions.value,
    currentSessionKey: currentSessionKey.value,
    mainKey: agents.mainKey,
    defaultAgentId: agents.defaultId,
    // 这里**刻意**保留合成行（规则④⑤）：用户点了某个 agent 就必须能导航过去，
    // 哪怕它的会话还没落库。与首屏渲染的取舍不同 —— 那边宁可留空也不能画残缺列表。
  }).key;
}

/**
 * agentId → 该 agent 的**代表会话行**（只取网关里真实存在的那条，不合成）。
 *
 * 侧栏只剩智能体列表这一段（见文件头注释），但会话的「运行中 / 未读 / 最近活跃时间」
 * 仍然有用 —— 内联到智能体行右侧，而不是再铺一段重复的列表。
 *
 * 这里传 `allowSyntheticRows: false`：合成行（网关里并不存在的 key）没有
 * `updatedAt` / `hasActiveRun` 可读，画在右侧只会是空白噪声。
 */
const agentSessionRows = computed<Record<string, GatewaySessionRow>>(() => {
  const map: Record<string, GatewaySessionRow> = {};
  for (const row of buildSidebarSessionRows({
    agents: agents.agents,
    sessions: sessions.value,
    currentSessionKey: currentSessionKey.value,
    mainKey: agents.mainKey,
    defaultAgentId: agents.defaultId,
    allowSyntheticRows: false,
  })) {
    const id = sessionAgentId(row);
    if (id) map[id] = row;
  }
  return map;
});

/** 某个 agent 的代表会话行（没有真实会话时为 null）。 */
function agentSessionRow(agentId: string): GatewaySessionRow | null {
  return agentSessionRows.value[normalizeAgentId(agentId)] ?? null;
}

/** 智能体行右侧的时间文案（取代表会话的最近活跃时间；无会话则空串 → 不渲染）。 */
function agentTimeLabel(agentId: string): string {
  return formatSidebarTime(agentSessionRow(agentId)?.updatedAt);
}

async function loadSessions(): Promise<void> {
  sessionsLoading.value = true;
  try {
    const res = await gateway.request<SessionsListResult>("sessions.list", {
      limit: 200,
      includeGlobal: true,
      includeUnknown: true,
    });
    sessions.value = Array.isArray(res?.sessions) ? res.sessions : [];
    // 落盘快照：下次首屏直接用完整结构渲染（见 utils/sidebarSnapshot.ts）
    writeSidebarSnapshot(settings.gatewayUrl, { sessions: sessions.value });
  } catch {
    // 静默失败：侧栏降级为「只有智能体列表 + 无会话元信息」，不影响对话主流程。
  } finally {
    sessionsLoading.value = false;
  }
}

/**
 * agent 描述。上游从「完整运行时配置」里取（`agents.list[].description`），
 * 本项目等价地读一次 `config.get`；取不到就只展示名称。
 */
async function loadAgentDescriptions(): Promise<void> {
  try {
    const res = await gateway.request<{
      config?: { agents?: { list?: Array<{ id?: string; description?: string }> } };
      resolved?: { agents?: { list?: Array<{ id?: string; description?: string }> } };
    }>("config.get", {});
    const list = res?.config?.agents?.list ?? res?.resolved?.agents?.list ?? [];
    const next: Record<string, string> = {};
    for (const entry of list) {
      const id = typeof entry?.id === "string" ? normalizeAgentId(entry.id) : "";
      const description = typeof entry?.description === "string" ? entry.description.trim() : "";
      if (id && description) next[id] = description;
    }
    agentDescriptions.value = next;
  } catch {
    agentDescriptions.value = {};
  }
}

/**
 * agent 行头像**原始值**（图片路径 / URL / emoji / 文字）。
 *
 * 不再在这里区分「图片 or 文本」：`ChatAvatar` 内建了完整降级链，
 * 提前过滤会把网关返回的本地头像路径（可能没转成 `/avatar/<id>`）整条丢掉。
 */
function agentAvatarValue(agent: (typeof agents.agents)[number]): string {
  return resolveAgentAvatarValue(agent, agents.identities[normalizeAgentId(agent.id)] ?? null);
}

/** agent 头像归因状态（`local` 表示由网关 `/avatar/<agentId>` 提供）。 */
function agentAvatarStatus(agent: (typeof agents.agents)[number]): string | null {
  return agents.identities[normalizeAgentId(agent.id)]?.avatarStatus?.trim() || null;
}

/**
 * agent 展示名：**运行时身份优先**（`agent.identity.get` 的 `name`）。
 *
 * `agents.list` 的行里常常没有 `name`（本机实测只有 `id/workspace/model`），
 * 只调 `normalizeAgentLabel(agent)` 会退化成裸 id —— 侧栏显示 `main`、
 * 而聊天页头显示 `年间`，同一个实体两个名字。
 */
function agentLabel(agent: (typeof agents.agents)[number]): string {
  return resolveAgentLabel(agent, agents.identities[normalizeAgentId(agent.id)] ?? null);
}

function selectSession(sessionKey: string): void {
  if (!sessionKey) return;
  settings.setSessionKey(sessionKey);
  void router.push({ name: "chat", query: { session: sessionKey } });
}

function selectAgent(agentId: string): void {
  const next = preferredSessionForAgent(agentId);
  void agents.ensureIdentity(agentId);
  selectSession(next);
}

/**
 * 会话归属的 agentId：从 `agent:<id>:...` 前缀取，回退到网关默认 agent。
 */
function sessionAgentId(row: GatewaySessionRow): string {
  const parsed = parseAgentSessionKey(row.key);
  return normalizeAgentId(
    parsed?.agentId ?? agents.defaultId ?? DEFAULT_AGENT_ID,
  );
}

let unsubscribe: (() => void) | null = null;

function handleEvent(evt: { event: string; payload?: unknown }): void {
  // 会话列表随对话活动变化：收到 chat 帧后延迟刷新一次，保持侧栏最新。
  if (evt.event !== "chat") return;
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => void loadSessions(), 800);
}

let refreshTimer = 0;

onMounted(() => {
  // 首次加载落定后才允许展示「空态 / 兜底」；此前用快照或骨架屏呈现完整结构。
  // 用 `ensureLoaded()` 返回的 promise（并发调用共享同一次真实加载），
  // 而不是看 `loading` —— 后者在「已被别的视图触发」时会立刻早返回，导致提前落定。
  void agents.ensureLoaded().finally(() => {
    agentsLoadSettled.value = true;
  });
  void loadSessions();
  void loadAgentDescriptions();
  unsubscribe = gateway.onEvent(handleEvent);
});

onBeforeUnmount(() => {
  unsubscribe?.();
  window.clearTimeout(refreshTimer);
});

// 切换到新 agent 的会话时，顺手把该 agent 的运行时身份取回来（头像/名称的最终来源）。
watch(
  () => agents.selectedAgentId,
  (id) => {
    void agents.ensureIdentity(id);
  },
);
</script>

<template>
  <!-- 收起态：只保留对话主图标（点击展开二级目录） -->
  <aside v-if="collapsed" class="chat-side chat-side--collapsed">
    <el-button
      class="chat-side__rail-btn"
      text
      title="对话"
      aria-label="展开对话目录"
      @click="emit('toggle')"
    >
      <el-icon><ChatRound /></el-icon>
    </el-button>
  </aside>

  <aside v-else class="chat-side">
    <div class="chat-side__scroll">
      <!-- 智能体列表（renderAgentRow）—— 侧栏**唯一**的一段列表。
           曾经并列的「最近会话」段已删除：展示层把每个 agent 收敛成一条会话后，
           两段是 1:1 重复（同一批 agent 出现两遍，第二遍还只能显示原始 key）。
           会话的运行中状态 / 未读 / 最近活跃时间改为内联到本行右侧。 -->
      <section class="chat-side__section">
        <div class="chat-side__head">
          <span class="chat-side__head-text">对话</span>
          <RefreshButton
            class="chat-side__refresh"
            :loading="sessionsLoading"
            @refresh="loadSessions"
          />
        </div>

        <div class="chat-side__items">
          <el-button
            v-for="agent in agents.agents"
            :key="agent.id"
            class="agent-row"
            :class="{ 'agent-row--active': normalizeAgentId(agent.id) === selectedAgentId }"
            :title="agentLabel(agent)"
            text
            @click="selectAgent(agent.id)"
          >
            <ChatAvatar
              role="assistant"
              :name="agentLabel(agent)"
              :avatar="agentAvatarValue(agent)"
              :avatar-status="agentAvatarStatus(agent)"
              :agent-id="normalizeAgentId(agent.id)"
              :token="token"
              :size="30"
            />
            <span class="agent-row__body">
              <span class="agent-row__name">{{ agentLabel(agent) }}</span>
              <!-- 描述行：超出当前横向宽度时以省略号截断（.agent-row__desc 三件套负责截断），
                   鼠标悬停通过 el-tooltip 展示完整内容。
                   :disabled 在描述很短时跳过 popper，避免短文本也被 tooltip 弹层打扰。 -->
              <el-tooltip
                v-if="agentDescriptions[normalizeAgentId(agent.id)]"
                :content="agentDescriptions[normalizeAgentId(agent.id)]"
                placement="top"
                :show-after="200"
                :disabled="agentDescriptions[normalizeAgentId(agent.id)].length <= 18"
              >
                <span class="agent-row__desc">
                  {{ agentDescriptions[normalizeAgentId(agent.id)] }}
                </span>
              </el-tooltip>
              <el-tooltip
                v-else-if="agent.isDefault"
                :content="'默认智能体'"
                placement="top"
                :show-after="200"
                disabled
              >
                <span class="agent-row__desc">默认智能体</span>
              </el-tooltip>
            </span>
            <!-- 代表会话的状态：运行中转圈 > 未读点 > 最近活跃时间。
                 aside 整段始终渲染（不再整体 v-if）：初始化 / RPC 没回来时也保留占位，
                 避免 sessions 回来后整行布局抖动；空状态仅占 min-width。 -->
            <span class="agent-row__aside">
              <template v-if="agentSessionRow(agent.id)">
                <span
                  v-if="agentSessionRow(agent.id)?.hasActiveRun"
                  class="agent-row__run"
                  aria-label="运行中"
                />
                <template v-else>
                  <span
                    v-if="agentSessionRow(agent.id)?.unread"
                    class="agent-row__unread"
                    aria-label="未读"
                  />
                  <span v-if="agentTimeLabel(agent.id)" class="agent-row__meta">
                    {{ agentTimeLabel(agent.id) }}
                  </span>
                </template>
              </template>
            </span>
          </el-button>

          <!-- 首次加载未落定：骨架占位（有快照时根本走不到这里）。
               绝不能用「当前会话兜底」的单行冒充完整菜单。 -->
          <div v-if="!agents.agents.length && !agentsLoadSettled" class="chat-side__skeleton">
            <span
              v-for="i in 3"
              :key="i"
              class="chat-side__skeleton-row chat-side__skeleton-row--agent"
            />
          </div>
          <div v-else-if="!agents.agents.length" class="chat-side__empty">暂无智能体</div>
        </div>
      </section>
    </div>
  </aside>
</template>

<style scoped>
.chat-side {
  width: 236px;
  flex-shrink: 0;
  border-right: 1px solid var(--wb-border);
  background: var(--wb-bg-card);
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  transition: width 0.18s var(--wb-ease);
}

/* ============== 收起态：只有对话主图标 ============== */

.chat-side--collapsed {
  width: 48px;
  align-items: center;
  padding-top: 8px;
  gap: 6px;
}

.chat-side__rail-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--wb-radius);
  background: var(--wb-accent-soft);
  color: var(--wb-accent-strong);
  font-size: 17px;
  cursor: pointer;
  transition: all 0.15s var(--wb-ease);
}
.chat-side__rail-btn.el-button {
  border: none;
  padding: 0;
}
.chat-side__rail-btn.el-button > span {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.chat-side__rail-btn:hover {
  background: var(--wb-accent);
  color: #fff;
}

.chat-side__scroll {
  flex: 1;
  overflow-y: auto;
  padding: 10px 8px 16px;
  min-height: 0;
}

.chat-side__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 4px 8px 6px;
}

.chat-side__head-text {
  font-size: 13px;
  font-weight: 600;
  color: var(--wb-text-primary);
  letter-spacing: 0.04em;
  text-transform: none;
}

.chat-side__refresh {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: var(--wb-radius-sm);
  background: transparent;
  color: var(--wb-text-tertiary);
  cursor: pointer;
  transition: all 0.15s var(--wb-ease);
}
.chat-side__refresh.el-button {
  border: none;
  padding: 0;
  min-height: auto;
}
.chat-side__refresh.el-button > span {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.chat-side__refresh.el-button.is-loading {
  pointer-events: none;
}

.chat-side__refresh:hover:not(:disabled) {
  background: var(--wb-bg-hover);
  color: var(--wb-accent-strong);
}

.chat-side__refresh:disabled {
  opacity: 0.4;
  cursor: default;
}

.chat-side__items {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.chat-side__empty {
  padding: 10px 10px;
  font-size: 12px;
  color: var(--wb-text-tertiary);
}

/**
 * 首屏骨架：仅在「首次加载未落定且没有本地快照」时出现（首次访问）。
 * 作用是**占住结构**，让别人一眼看出「菜单还没到」，而不是以为菜单只有一项。
 */
.chat-side__skeleton {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 2px 8px;
}

.chat-side__skeleton-row {
  display: block;
  height: 14px;
  border-radius: var(--wb-radius-sm);
  background: var(--wb-bg-hover);
  animation: chat-side-skeleton 1.4s ease-in-out infinite;
}

/* agent 行更高（两行文字），宽度错开一点更像真实列表 */
.chat-side__skeleton-row--agent {
  height: 30px;
  margin-bottom: 4px;
}

.chat-side__skeleton-row:nth-child(2) {
  width: 82%;
}

.chat-side__skeleton-row:nth-child(3) {
  width: 66%;
}

@keyframes chat-side-skeleton {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
}

/* ============== 智能体行（renderAgentRow 的 Vue 版） ============== */

.agent-row {
  display: flex;
  align-items: center;
  /* 头像与名称（标题）之间的间距，按设计要求固定 10px。
     同一行还包含右侧 aside（时间戳/状态点），
     它通过 .agent-row__aside { margin-left: auto } 推到行末，gap 与它无关。 */
  gap: 10px;
  width: 100%;
  padding: 24px 8px;
  border-radius: var(--wb-radius);
  background: transparent;
  cursor: pointer;
  text-align: left;
  font-family: inherit;
  transition: background 0.15s var(--wb-ease);
  justify-content: flex-start;
  margin: 0;
}
.agent-row.el-button {
  border: none;
  font-size: 13px;
}

.agent-row:hover {
  background: var(--wb-bg-hover);
}

.agent-row--active {
  background: var(--wb-accent-soft);
}

.agent-row__body {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
  line-height: 1.3;
}

.agent-row__name {
  font-size: 13px;
  font-weight: 600;
  color: var(--wb-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-row--active .agent-row__name {
  color: var(--wb-accent-strong);
}

.agent-row__desc {
  font-size: 11px;
  color: var(--wb-text-tertiary);
  /* 描述行内联展示：必须 inline-block + max-width 才能省略号截断生效。
     超出当前横向宽度时尾部省略，鼠标悬停由父层 <el-tooltip> 展示完整内容。 */
  display: inline-block;
  max-width: 100%;
  vertical-align: bottom;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-top: 1px;
}

/* ============== 智能体行右侧的会话状态 ==============
   会话列表整段删除后，「运行中 / 未读 / 最近活跃时间」内联到智能体行右侧。
   注意 el-button 会把 slot 包在一个内部 <span> 里；
   必须用 :deep(> span) 才能命中这个子组件生成的 span 并把它设为 display: contents，
   从而让 avatar / body / aside 成为 .agent-row 的直接 flex 子项。
   只有这样，.agent-row__body { flex: 1 } 才能撑开，
   .agent-row__aside { margin-left: auto } 才能被推到行尾。 */

.agent-row__aside {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 5px;
  flex-shrink: 0;
  /* 时间戳 / 状态点固定靠右对齐 —— margin-left:auto 在 flex 容器里把这一栏
     推到与「标题+描述」相对的行末，与父容器的 gap 互不影响。 */
  margin-left: auto;
  /* 始终占位（min-width）：
     初始化时 `sessions.list` 还没回来 → `agentSessionRow()` 为 null →
     如果没有这段占位，__aside 整段会因 v-if 不渲染，
     等 RPC 回来时整行右侧突然出现时间戳 → 整行布局抖动。
     40px ≈ "2天" / "12分钟前" 这种短时间戳的渲染宽度。 */
  min-width: 40px;
}

/* el-button 的 slot wrapper span 是子组件内部生成的，没有本组件的 data-v，
   普通 scoped 选择器无法命中，必须用 :deep 穿透。 */
.agent-row.el-button :deep(> span) {
  display: contents;
}

.agent-row__meta {
  font-size: 10.5px;
  color: var(--wb-text-tertiary);
  font-variant-numeric: tabular-nums;
  /* 元素自身显式靠右：父容器 .agent-row__aside 的 inline-flex
     已经能推整个 aside 到行末，但本规则给 __meta 自身一个独立
     的「在父内也靠右」能力，防止父容器布局变化时回归。 */
  margin-left: auto;
}

.agent-row__unread {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #ef4444;
  flex-shrink: 0;
}

.agent-row__run {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  border: 1.5px solid var(--wb-accent);
  border-top-color: transparent;
  animation: chat-side-spin 0.7s linear infinite;
}

@keyframes chat-side-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
