<script setup lang="ts">
/**
 * 对话窗格（单会话）：仿 WorkBuddy 的用户/助手对话交互。
 *
 * 每条 AI 回复下方会渲染消耗/剩余积分（如果服务端消息携带了 spendResult）。
 * 流式生成时展示「思考中…」或带光标的内容；服务端若推送了 thinking 块，
 * 会展示在回复正文上方的可折叠「思考」块中。
 *
 * ## 为什么叫「窗格」
 * 布局层（`ChatView.vue`）在拆分视图下会同时挂载 N 个本组件，**每个实例状态完全独立**
 * （消息列表、流式态、附件、待执行队列、事件订阅各自一份），对齐旧版
 * `chat-pane.ts` 里「一个 pane 一个 ChatStateController」的模型。
 * 因此本组件**不读路由、不写全局会话 key**：
 * - 会话 key 由 `sessionKey` prop 进来；
 * - 用户在本窗格切换会话 / 点击拆分 / 关闭时，只 `emit` 事件，由布局层决定路由与持久化。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import {
  Check,
  CloseBold,
  CopyDocument,
  Delete,
  Download,
  Loading,
  Plus,
  Promotion,
  View,
} from "@element-plus/icons-vue";
import { useGatewayStore } from "@/stores/gateway";
import { useSettingsStore } from "@/stores/settings";
import { useAgentsStore } from "@/stores/agents";
import { formatTime, formatDateTimeMinute } from "@/utils/format";
import { sessionKeysMatch, qualifySessionKey } from "@/utils/sessionListSelection";
import {
  clearBackgroundAssistantMessages,
  clearChatMessageCache,
  getChatHistoryCursor,
  getChatMessageCache,
  noteBackgroundAssistantMessage,
  readBackgroundAssistantMessages,
  setChatMessageCache,
} from "@/utils/chatMessageCache";
import { chatRunStateFor, resetChatRunStateForSession } from "@/utils/chatRunState";
import { isReplyFinishedAgentEvent } from "@/utils/agentLifecycle";
import { readModelOverride, writeModelOverride } from "@/utils/modelOverrides";
import { formatFriendlyError, localizeChatError } from "@/utils/chatErrorCopy";
import { saveUrlViaBlob, shouldSaveViaBlob } from "@/utils/downloadSave";
import { exportChatMarkdown } from "@/utils/exportChat";
import {
  contextPercentClassOf,
  contextPercentOf,
  contextWindowDetailOf,
} from "@/utils/contextUsage";
import { resolveLocalUserName } from "@/utils/avatar";
import { copyToClipboard } from "@/utils/clipboard";
import {
  hasVisibleMessageContent,
  isRenderableMessageRole,
  resolveCommittedText,
  shouldAdoptStreamedMedia,
} from "@/utils/messageCommit";
import type { SessionsListResult } from "@/api/types";
import { GatewayRequestError } from "@/api/gateway";
import MarkdownView from "@/components/MarkdownView.vue";
import ModelSelector, { type ModelOption } from "@/components/ModelSelector.vue";
import VoiceButton from "@/components/VoiceButton.vue";
import ChatAvatar from "@/components/ChatAvatar.vue";
import AudioPlayer from "@/components/AudioPlayer.vue";
import RefreshButton from "@/components/RefreshButton.vue";
import ChatIcon from "@/components/ChatIcon.vue";
import {
  buildAssistantMediaUrl,
  extractAudioReferences,
  isGatewayHostedMediaUrl,
  withAssistantMediaDownload,
  type AudioReference,
} from "@/utils/assistantMedia";
import {
  extractTranscriptMediaItems,
  type TranscriptMediaItem,
} from "@/utils/transcriptMedia";
import {
  contentImagesExcludingTranscriptMedia,
  contentMediaSafeHref,
  extractContentAttachments,
  extractContentImages,
  type ContentAttachmentItem,
  type ContentImageBlock,
} from "@/utils/contentMedia";
import { inferMediaAttachment, splitMediaMarkers } from "@/utils/mediaMarker";
import {
  findSameTurnAssistant,
  needsHistoryMediaBackfill,
} from "@/utils/mediaReconcile";
import {
  CHAT_ATTACHMENT_ACCEPT,
  buildApiAttachments,
  chatAttachmentFilesFromClipboard,
  chatAttachmentPreviewHref,
  discardChatAttachmentDataUrls,
  formatAttachmentSize,
  getChatAttachmentPreviewUrl,
  isImageAttachment,
  readChatAttachments,
  releaseChatAttachmentPayload,
  releaseChatAttachmentPayloads,
  type ChatAttachment,
} from "@/utils/chatAttachments";
import { PANE_DRAG_MIME } from "@/utils/splitLayout";
import type {
  ChatMessage,
  ChatRole,
  JdSpendResult,
  MessageIdSource,
  TokenUsage,
} from "@/types/chat";

type ModelCatalogEntry = {
  id: string;
  name?: string;
  provider: string;
  alias?: string;
  available?: boolean;
  contextWindow?: number;
  reasoning?: boolean;
};

type ChatEventPayload = {
  runId?: string;
  sessionKey: string;
  agentId?: string;
  state: "delta" | "final" | "aborted" | "error";
  message?: unknown;
  deltaText?: string;
  /** 增量是 thinking 还是正文（"thinking" | "content" | undefined=正文） */
  channel?: "thinking" | "content";
  replace?: boolean;
  errorMessage?: string;
};

/**
 * 网关 `agent` 事件载荷（openclaw-v2026.7.1-2/src/infra/agent-events.ts:112）。
 *
 * 思考流走的是 `event: "agent"` + `stream: "thinking"`，data.delta 是增量，
 * data.text 是「累积到当前 chunk 的整段文本」（不能用作增量，会重复累加）。
 *
 * 这里只挑前端关心的子集；不识别的字段不读，避免被未来协议变化坑到。
 */
type AgentThinkingEventPayload = {
  runId?: string;
  sessionKey?: string;
  stream: "thinking";
  data?: {
    delta?: string;
    text?: string;
    replace?: boolean;
  };
};

// ---------------------------------------------------------------------------
// 父级契约（布局层）
// ---------------------------------------------------------------------------

const props = withDefaults(
  defineProps<{
    /** 窗格 id（布局层分配；单窗格模式为 `single`）。用于事件回传时标识自己。 */
    paneId: string;
    /** 本窗格当前渲染的会话 key（由布局层持有，见文件头说明）。 */
    sessionKey: string;
    /** 是否为活动窗格（活动窗格顶部有一条强调边，并负责同步路由）。 */
    active?: boolean;
    /** `pane` = 渲染窗格头（会话选择 + 拆分/关闭按钮）；`none` = 不渲染（单窗格模式）。 */
    chrome?: "none" | "pane";
    /** 是否展示 composer 里的「打开拆分视图」入口（窄屏 / 已在拆分态时为 false）。 */
    allowSplit?: boolean;
    /**
     * 是否展示**窗格头**里的「向下拆分 / 向右拆分」按钮。默认 `false`。
     *
     * 与 `allowSplit` 是两件事，不能合并：
     *   - `allowSplit` 管 composer 里的「打开拆分视图」（单窗格 → 拆分态的入口）；
     *   - `allowPaneSplit` 管窗格头的两个拆分按钮（拆分态 → 再拆一个窗格）。
     * 拆分态下 `allowSplit` 必须是 `false`（已经在拆分了，再给一个「打开拆分」是错的），
     * 而 `allowPaneSplit` 必须是 `true`；窄屏则两个都是 `false` —— 因为窄屏只渲染活动窗格，
     * 拆出来的新窗格肉眼不可见，按钮点了「什么也没发生」（旧版 `ui/`
     * `chat-page.ts:373-392` 的 `canSplit = !this.narrow` 就是这条口径，但它只把回调置空、
     * 按钮仍然渲染出来，于是窄屏会看到两个点了没反应的按钮，这里顺手修掉）。
     */
    allowPaneSplit?: boolean;
    /**
     * 二级目录是否收起。
     *
     * 折叠按钮原本就在本组件的 `.chat-top-left` 里；拆分视图下如果每个窗格都渲染一遍，
     * 会出现 N 个同样的按钮。所以状态与按钮都上提到布局层：只有**活动窗格**渲染它。
     */
    sideCollapsed?: boolean;
    /**
     * 手机形态：二级目录是**覆盖式抽屉**，本组件里的目录按钮改成「打开抽屉」的语义。
     *
     * 图标必须跟着换：手机端 `sideCollapsed` 被布局层忽略（抽屉里始终展开），
     * 继续用 `DArrowLeft/DArrowRight`（收起/展开）会给出错误的动作暗示。
     * 这么做也省掉了「手机顶部再加一行汉堡按钮」—— 这个按钮的位置本来就对。
     */
    sideDrawer?: boolean;
  }>(),
  {
    active: false,
    chrome: "none",
    allowSplit: false,
    allowPaneSplit: false,
    sideCollapsed: false,
    sideDrawer: false,
  },
);

const emit = defineEmits<{
  (e: "focusPane", paneId: string): void;
  (e: "sessionChange", paneId: string, sessionKey: string): void;
  (e: "openSplit"): void;
  (e: "splitRight", paneId: string): void;
  (e: "splitDown", paneId: string): void;
  (e: "closePane", paneId: string): void;
  (e: "toggleSide"): void;
  /** 开始拖动本窗格（拖到别的窗格边缘 → 拆分，由布局层处理落区）。 */
  (e: "paneDragStart", paneId: string): void;
  (e: "paneDragEnd"): void;
  /** 请求在右侧详情面板展开某条消息的完整内容（由布局层持有面板）。 */
  (e: "openDetail", message: ChatMessage): void;
}>();

const gateway = useGatewayStore();
const settings = useSettingsStore();
const agents = useAgentsStore();

/**
 * 本窗格渲染的会话 key：**完全由父级 prop 决定**（见文件头「为什么叫窗格」）。
 *
 * 刻意用 `||` 而不是 `??`：prop 可能是空串（布局层尚未就绪），
 * 而网关的 `chat.history` / `chat.send` 都要求 sessionKey 至少 1 个字符。
 *
 * ⚠️ 定义位置必须早于 `paneAgentId` / `assistant*`：那两组全部由它派生，而下面
 * `paneAgentId` 上的 `watch(..., { immediate: true })` 会在 setup 期间**立即求值** ——
 * 挪到后面会直接撞上 TDZ（Cannot access 'sessionKey' before initialization）。
 */
const sessionKey = computed<string>(() => props.sessionKey.trim() || settings.sessionKey || "main");

/**
 * 本窗格归属的 agentId（**per-pane，不是全局**）。
 *
 * 拆分视图下每个窗格的会话 key 自带 `agent:<id>:` 前缀（如 `agent:cel4:main`），
 * 所以每个窗格都能独立算出自己的 agent —— 这是「多 agent 同时对话、互不影响」的地基。
 *
 * ⚠️ 绝不能改用 `agents.selectedAgentId`：它派生自全局 `settings.sessionKey`，
 * 只代表**活动窗格**；用它会让所有窗格一起显示活动窗格的 agent
 * （症状：左窗格明明是 `agent:cel4:main` 的会话，标题和头像却是学习辅导员）。
 */
const paneAgentId = computed<string>(() => agents.agentIdForSession(sessionKey.value));

// 本窗格 agent 的运行时身份（名称/头像的最终来源）：窗格一出现就补齐一次，之后走 store 缓存。
watch(paneAgentId, (id) => void agents.ensureIdentity(id), { immediate: true });

// 窗格换 agent（下拉按组选择 / 左侧目录点击）→ 该 agent 的默认模型要重取。
// 刻意**不加** immediate：首屏统一由 onMounted 触达（此时下面那些 ref 才初始化完）。
watch(paneAgentId, () => void loadDefaultModel());

/**
 * 消息气泡旁的助手头像与名称 —— 取**本窗格 agent**，不是全局选中的 agent。
 *
 * 对齐上游 `chat-pane.ts`：每个 pane 有自己独立的 state，`assistantName` 由
 * `chat-state.ts` 的 `loadPageAssistantIdentity` **按 pane 会话**拉取
 * （`agent.identity.get { sessionKey }`）；渲染点见 `chat-message.ts` 的
 * `renderChatAvatar(role, { name, avatar }, ...)`。名称取该 agent 的身份名，
 * 头像取 agent 图片头像 / emoji / 文本头像，最终由 `ChatAvatar` 按
 * 「图片 → 文本 → 首字母 → 角色图标」降级渲染。
 */
const assistantName = computed(() => agents.nameForAgent(paneAgentId.value));
const assistantAvatar = computed(() => agents.avatarForAgent(paneAgentId.value));
const assistantAvatarStatus = computed(() => agents.avatarStatusForAgent(paneAgentId.value));
const assistantAvatarAgentId = computed(() => paneAgentId.value);

/**
 * 助手正文里的音频引用 → 播放器。
 *
 * 网关的 `chat.history` 记录里没有任何 attachment/media 字段（实测 `content` 只有
 * `{type:"text"}`），音频是 agent 写在正文里的**文件路径**，所以在文本层识别。
 * 结果按「消息对象 + 文本」缓存：`extractAudioReferences` 要扫全量正则，
 * 而消息列表在流式期间会频繁重渲染。
 */
const audioRefsCache = new WeakMap<ChatMessage, { text: string; refs: AudioReference[] }>();

function audioRefsFor(msg: ChatMessage): AudioReference[] {
  const cached = audioRefsCache.get(msg);
  if (cached && cached.text === msg.text) return cached.refs;
  // 已经被「附件位」渲染过的引用不再出第二个播放器：
  // `MEDIA:` 行会被 normalizeMessage 剥成 contentAttachments（出 AudioPlayer），
  // 顶层 MediaPaths 会进 historyMedia（出文件卡片）。这里再扫一遍正文就会重复。
  const covered = new Set<string>();
  for (const att of msg.contentAttachments ?? []) covered.add(att.url.trim().toLowerCase());
  for (const media of msg.historyMedia ?? []) covered.add(media.source.trim().toLowerCase());
  const refs = extractAudioReferences(msg.text).filter(
    (ref) => !covered.has(ref.raw.trim().toLowerCase()),
  );
  audioRefsCache.set(msg, { text: msg.text, refs });
  return refs;
}

/** 用户侧展示名（本项目未接入本地用户身份配置，沿用上游兜底文案「You/你」）。 */
const userName = resolveLocalUserName(null);

/**
 * 本会话「进行中的那一轮」的运行态 —— **存在组件外面，按会话分桶**
 * （见 `utils/chatRunState`）。
 *
 * 为什么不能用局部 ref：点「打开拆分视图」时布局层会**销毁并重建** ChatPane
 * （`v-if="!layout"` 换成了 `.chat-split-view` 子树，连 `paneId` 都变了）。
 * 局部 ref 会随之蒸发 ⇒ 用户看到「思考中」气泡消失、输入框退回「Enter 发送」，
 * 像是任务被打断（后端其实还在跑）。放到会话维度的桶里，重建后自然接得回来。
 *
 * 下面 5 个 `computed` 只是它的读写代理 —— 保留 `x.value` 的写法，
 * 组件里 50 多处既有引用与模板**一行都不用改**。
 */
const runState = computed(() => chatRunStateFor(sessionKey.value, paneAgentId.value));

const messages = ref<ChatMessage[]>([]);

/**
 * 会话历史分页（完整历史可回溯）。
 *
 * `historyHasMore`      后端是否还有更早消息（`chat.history` 响应的 hasMore）。
 * `historyNextOffset`   下一次「加载更早」要传的 offset（服务端游标）。
 * `loadingOlderHistory` 是否正在加载更早（防滚动抖动重复请求）。
 *
 * @author yangchenglin11@jd.com
 * @date 2026年9月16日 17:44:00
 * @version feature_web
 */
const historyHasMore = ref(false);
const historyNextOffset = ref<number | undefined>(undefined);
const loadingOlderHistory = ref(false);
/**
 * 单条消息正文的字符上限。
 *
 * 网关默认只给 8000 字符（`DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS`），超了就在尾部追加
 * `...(truncated)...` —— 长回复在历史里会被静默切掉。协议
 * `ChatHistoryParamsSchema.maxChars` 允许到 50 万，这里由请求端显式放大。
 */
const CHAT_HISTORY_MAX_CHARS = 200_000;

/**
 * 加载更早历史（会话分页「向上翻」）。
 *
 * 依赖后端 `chat.history` 的 offset 游标：每次请求 offset=historyNextOffset，
 * 返回更早一页消息 → 按稳定 id 去重后前置插到 messages 顶部，并保持滚动位置
 * 不跳动（插入后下一帧把 scrollTop 补回新增高度）。
 *
 * 触发：滚动到对话顶部附近自动调用（见 onThreadScroll）+ 顶部「加载更早」按钮。
 *
 * @author yangchenglin11@jd.com
 * @date 2026年9月16日 17:44:00
 * @version feature_web
 */
async function loadOlderHistory(): Promise<void> {
  if (loadingOlderHistory.value) return;
  if (!historyHasMore.value || historyNextOffset.value === undefined) return;
  const el = threadRef.value;
  const prevScrollHeight = el?.scrollHeight ?? 0;
  const prevScrollTop = el?.scrollTop ?? 0;
  // 翻页结果也是异步回来的：期间切了会话就必须整包丢弃，
  // 否则旧会话的更早一页会被前置插进新会话的列表里（同 `loadHistory` 的版本闸）。
  const requestKey = resolvedSessionKey();
  loadingOlderHistory.value = true;
  try {
    const res = await gateway.request<{
      messages?: unknown[];
      hasMore?: boolean;
      nextOffset?: number;
    }>("chat.history", {
      sessionKey: requestKey,
      limit: 200,
      offset: historyNextOffset.value,
      maxChars: CHAT_HISTORY_MAX_CHARS,
    });
    if (resolvedSessionKey() !== requestKey) return;
    const older = (res?.messages ?? [])
      .map((item, index) => normalizeMessage(item, index))
      .filter((item): item is ChatMessage => item !== null);
    if (older.length > 0) {
      // 按稳定 id 去重：offset 返回的边界条可能与已加载部分重叠，不能重复渲染
      const known = new Set(messages.value.map((m) => m.id));
      const unique = older.filter((m) => !known.has(m.id));
      if (unique.length > 0) {
        messages.value = [...unique, ...messages.value];
      }
    }
    historyHasMore.value = res?.hasMore === true;
    historyNextOffset.value =
      typeof res?.nextOffset === "number" ? res.nextOffset : undefined;
    // 游标随缓存一起更新，切回会话后还能继续翻更早历史
    const cacheKey = qualifySessionKey(sessionKey.value, paneAgentId.value) ?? resolvedSessionKey();
    setChatMessageCache(cacheKey, messages.value, {
      hasMore: res?.hasMore,
      nextOffset: res?.nextOffset,
    });
    // 保持视口不跳动：等 DOM 重排后把 scrollTop 补上新增高度
    await nextTick();
    const after = threadRef.value;
    if (after && prevScrollHeight > 0) {
      const delta = after.scrollHeight - prevScrollHeight;
      if (delta > 0) after.scrollTop = prevScrollTop + delta;
    }
  } catch {
    // 静默：翻页失败不打断主对话，保留游标下次可重试
  } finally {
    loadingOlderHistory.value = false;
  }
}

// 消息有变（发送 / 流式 / 删除）即刷新客户端缓存，保证切回本会话时秒回且含最新内容。
//
// ⚠️ `deep: true` 是**必须的**，不是可选优化：`messages` 是 `ref<ChatMessage[]>`，
// 对 ref 的非 deep watch 只跟踪 `source.value` 的**引用身份**，`push` / `splice` /
// 改某条消息的字段都**不会触发**（已用 Vue 运行时实测：`watch(ref([]))` push 后
// 回调 fired=0，`{deep:true}` 后 fired=1）。
// 少了它就表现为「会话缓存永远停在第一次 loadHistory 的内容」—— 本轮刚生成
// 的那条助手消息（连带它的附件/播放器）不在缓存里，切走再切回来（60s TTL 内）
// 或点刷新（命中缓存）就会被旧数组覆盖回去，于是「附件必须 F5 才出现」。
watch(
  messages,
  (list) => {
    // ⚠️ 空列表**绝不落缓存**：切到一个「本地还没有缓存」的会话时，`watch(sessionKey)`
    // 会先执行 `messages.value = []`，本回调随之以**新会话**为键写下一份空缓存。
    // 而 `loadHistory` 命中缓存会秒回（旧版甚至直接 return、根本不联网），
    // 于是 60s TTL 内每次切进去都是空白 —— 表现就是「历史消息不显示」。
    // 不缓存空列表的代价只是「空会话每次切换多一次 RPC」，这个代价是值得的。
    if (list.length === 0) return;
    const key = qualifySessionKey(sessionKey.value, paneAgentId.value) ?? resolvedSessionKey();
    // 存快照而不是活数组：`loadHistory` 命中缓存时会 `cached.filter(...)` 换成新数组，
    // 缓存若仍指向旧数组，之后的 push 就再也同步不进缓存了。
    setChatMessageCache(key, [...list]);
  },
  { deep: true },
);

/**
 * 模板真正遍历的消息列表 —— **只过滤渲染，不动数据**。
 *
 * `role: "system"` 是会话的内部记录（系统提示词回写 / 上下文压缩提示 / 通道管理类
 * 记录），不是对话内容。这里把它挡在渲染层之外，`messages` 本身保持完整：
 * 它还被用来算 index 派生的稳定 key、上下文占用统计、链式删除等，**一旦在数据源层面
 * 丢掉，删除 / 复制 / 统计就会错位**。详见 `utils/messageCommit.ts` 的
 * `isRenderableMessageRole`（也有单测钉住）。
 */
const visibleMessages = computed<ChatMessage[]>(() =>
  messages.value.filter((msg) => isRenderableMessageRole(msg.role)),
);

/**
 * 工具结果（role:"toolResult"）折叠成「Activity」卡片（移植上游
 * `chat-message.ts` 的 `renderActivityDisclosure`）：连续多条 toolResult 合并为
 * 一个折叠块，默认收起，无错误标红（2026-09-01 决策：工具卡片不标错误）。
 * 每条 toolResult 只带 `text`（无 toolName），上游 `extractToolCards` 兜底 name="tool"。
 *
 * 这里只负责「把哪些 messages 聚成一个组」：组 key = 该连续 run 第一条 toolResult 的 id。
 */
const toolGroupPlan = computed<{
  keyToTools: Map<string, ChatMessage[]>;
  msgIdToGroupKey: Map<string, string>;
}>(() => {
  const keyToTools = new Map<string, ChatMessage[]>();
  const msgIdToGroupKey = new Map<string, string>();
  const visible = visibleMessages.value;
  let i = 0;
  while (i < visible.length) {
    if (visible[i].role === "toolResult") {
      const key = visible[i].id;
      const group: ChatMessage[] = [];
      let j = i;
      while (j < visible.length && visible[j].role === "toolResult") {
        group.push(visible[j]);
        msgIdToGroupKey.set(visible[j].id, key);
        j++;
      }
      keyToTools.set(key, group);
      i = j;
    } else {
      i++;
    }
  }
  return { keyToTools, msgIdToGroupKey };
});

/** 集合里放的是「已展开」的组 key；默认空 = 全部收起。 */
const expandedToolGroups = ref<Set<string>>(new Set());

function toolGroupKey(msg: ChatMessage): string {
  return toolGroupPlan.value.msgIdToGroupKey.get(msg.id) ?? msg.id;
}

/** 一条 toolResult 只有它是所在连续 run 的第一条时才渲染折叠头 + 整个组，其余跳过。 */
function isToolGroupStart(msg: ChatMessage): boolean {
  return msg.role === "toolResult" && toolGroupKey(msg) === msg.id;
}

function toolGroupOf(msg: ChatMessage): ChatMessage[] {
  return toolGroupPlan.value.keyToTools.get(toolGroupKey(msg)) ?? [msg];
}

/**
 * 折叠块是否展开：仅用户手动展开过才算展开。
 *
 * ⚠️ 之前「含错误的组默认展开」是为了排障，但产品口径改为：工具执行过程
 * 与思考过程一样**默认折叠、中性展示**，不因含错误就标红 / 默认展开
 * （错误信息已在工具结果正文里，无需在折叠头再强调）。
 */
function isToolGroupExpanded(msg: ChatMessage): boolean {
  return expandedToolGroups.value.has(toolGroupKey(msg));
}

function toggleToolGroup(key: string): void {
  const next = new Set(expandedToolGroups.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expandedToolGroups.value = next;
}

const streamingText = computed<string>({
  get: () => runState.value.streamingText,
  set: (next) => {
    runState.value.streamingText = next;
  },
});
const streamingThinking = computed<string>({
  get: () => runState.value.streamingThinking,
  set: (next) => {
    runState.value.streamingThinking = next;
  },
});
const sending = computed<boolean>({
  get: () => runState.value.sending,
  set: (next) => {
    runState.value.sending = next;
  },
});
// ---------------------------------------------------------------------------
// 流式过程中的媒体提取：`MEDIA:` 行一旦在流式正文里打完，**立刻**渲染成
// 播放器 / 图片 / 下载卡片 —— 与 final 落库（shouldAdoptStreamedMedia 补媒体位）、
// 历史消息（loadHistory → normalizeMessage）三条链路同走 `splitMediaMarkers`，
// 口径一致，不依赖刷新或页面跳转。
// ---------------------------------------------------------------------------
const streamingMediaSplit = computed(() => splitMediaMarkers(streamingText.value));
const streamingMediaImages = computed(() =>
  streamingMediaSplit.value.media
    .map(inferMediaAttachment)
    .filter((att) => att.kind === "image"),
);
const streamingMediaAttachments = computed<ContentAttachmentItem[]>(() => {
  const out: ContentAttachmentItem[] = [];
  for (const att of streamingMediaSplit.value.media.map(inferMediaAttachment)) {
    if (att.kind === "image") continue; // 图片走上面 contentImages 的 <img> 线
    out.push({
      kind: att.kind,
      url: att.url,
      label: att.label,
      ...(att.mimeType ? { mimeType: att.mimeType } : {}),
    });
  }
  return out;
});

const loading = ref(false);
const input = ref("");
const threadRef = ref<HTMLElement | null>(null);
const paneRoot = ref<HTMLElement | null>(null);
const modelSelectorRef = ref<InstanceType<typeof ModelSelector> | null>(null);
const inputRef = ref<HTMLTextAreaElement | null>(null);
/** 输入框高度上限：到顶后输入框内部滚动，不把对话区/页面顶出滚动。 */
const COMPOSER_MAX_HEIGHT_PX = 200;

/** 输入框随内容自动撑高；清空（发送/切换会话）后自动缩回一行。 */
function autosizeComposer(): void {
  const el = inputRef.value;
  if (!el) return;
  el.style.height = "auto";
  const next = Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT_PX);
  el.style.height = `${next}px`;
  el.style.overflowY = el.scrollHeight > COMPOSER_MAX_HEIGHT_PX ? "auto" : "hidden";
}

watch(input, () => {
  void nextTick(autosizeComposer);
});

// ---------------------------------------------------------------------------
// 附件（移植自旧版 chat-composer.ts / attachment-payload-store.ts）
//
// 「上传」在本项目里不是独立 RPC：附件以 base64 随 `chat.send` 的 `attachments[]`
// 一起提交（旧版同理），因此这里的「进度」体现为**输入框上方的预览条**：
// 选中的文件立即出现缩略图 / 文件名卡片，发送成功后整条清空、payload 释放。
// ---------------------------------------------------------------------------

/** 已选中、尚未发送的附件（元数据 + 预览地址，见 utils/chatAttachments.ts）。 */
const attachments = ref<ChatAttachment[]>([]);
/** 正在读取（FileReader 还没读完）的文件数，>0 时预览条显示「读取中」。 */
const attachmentsReading = ref(0);
/** 附件菜单（旧版是 `<details>` + `<summary>`，这里用 Element Plus 的 popover 承载）。 */
const attachMenuOpen = ref(false);

/** 三个隐藏的 file input（与旧版同名同 accept：通用文件 / 图片 / 拍照）。 */
const fileInputRef = ref<HTMLInputElement | null>(null);
const photoInputRef = ref<HTMLInputElement | null>(null);
const cameraInputRef = ref<HTMLInputElement | null>(null);

/** 旧版 `canCompose`：未连接 / 正在发送 / 积分不足时不允许再挂附件。 */
const canAttach = computed(() => !sending.value && !insufficientCredits.value);

async function addAttachmentFiles(files: Iterable<File>): Promise<void> {
  const list = Array.from(files);
  if (list.length === 0) return;
  attachmentsReading.value += 1;
  try {
    const added = await readChatAttachments(list);
    if (added.length > 0) {
      attachments.value = [...attachments.value, ...added];
    }
  } catch (err) {
    ElMessage.error(`附件读取失败：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    attachmentsReading.value = Math.max(0, attachmentsReading.value - 1);
  }
}

/**
 * 文件选择框 `change`。
 *
 * 旧版是「累加 pending、归零才一次性提交」；这里改成 await 一次性提交并**保序**。
 * `input.value = ""` 必须保留：不清空的话，连续选同一个文件不会再触发 `change`。
 */
async function onAttachmentInputChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement | null;
  const files = input?.files;
  if (!files || files.length === 0) return;
  try {
    await addAttachmentFiles(files);
  } finally {
    if (input) input.value = "";
  }
}

function openFilePicker(): void {
  attachMenuOpen.value = false;
  if (!canAttach.value) return;
  fileInputRef.value?.click();
}

function openPhotoPicker(): void {
  attachMenuOpen.value = false;
  if (!canAttach.value) return;
  photoInputRef.value?.click();
}

function openCameraPicker(): void {
  attachMenuOpen.value = false;
  if (!canAttach.value) return;
  cameraInputRef.value?.click();
}

function removeAttachment(id: string): void {
  attachments.value = attachments.value.filter((item) => item.id !== id);
  releaseChatAttachmentPayload(id);
}

// ---------------------------------------------------------------------------
// 附件预览（点击附件打开安全地址）
// ---------------------------------------------------------------------------

/**
 * 附件 id → **已过白名单的**预览地址。
 *
 * 为什么做成 computed Map 而不是模板里现算：`chatAttachmentPreviewHref` 内部要
 * `new URL(...)` 解析，而模板里同一个附件要问两次（`href` 与「是否可点」的 class）。
 * 留 `null` 的条目就直接不在表里 —— 「查不到 = 不可点」。
 *
 * 覆盖**已发送**（气泡）与**待发送**（composer 预览条）两处：两边的 `previewUrl`
 * 都来自同一个 payload store（objectURL 优先）。
 */
const attachmentPreviewHrefs = computed<Map<string, string>>(() => {
  const map = new Map<string, string>();
  const collect = (list: readonly ChatAttachment[] | undefined): void => {
    for (const att of list ?? []) {
      const href = chatAttachmentPreviewHref(att);
      if (href) map.set(att.id, href);
    }
  };
  for (const msg of messages.value) {
    if (msg.role === "user") collect(msg.attachments);
  }
  collect(attachments.value);
  return map;
});

/**
 * 渲染期统一出口：把「已解析的绝对地址」变成**可下载的链接地址**。
 *
 * ## 规则：只有能被强制成下载的地址才给 href
 * - **网关托管的媒体**（`/__openclaw__/assistant-media?…`、`/media/…`）→ 追加 `download=1`，
 *   网关据此回 `Content-Disposition: attachment`；点击**只下载，不动当前页面、不弹窗**
 *   （没有这个标记时，图片 / 音视频会被浏览器就地渲染，整个聊天页被顶掉 —— 就是用户报的
 *   「agent 回复的附件会自动打开」）。
 * - `blob:` / `data:`（本地待发送附件、内联图片）→ 原样返回，靠锚点上的 `download`
 *   属性生效（同源 / 内联场景浏览器认这个属性）。
 * - **其余（远端第三方地址）→ 返回 `null`**：地址不在我们手里，改不了 disposition，
 *   跨源下 `download` 属性也会被浏览器忽略 —— 给了 href 就一定会「打开」。
 *   宁可不可点，也不让点击把聊天页面顶掉。
 */
function downloadHrefOrNull(resolvedUrl: string | null | undefined): string | null {
  const safe = contentMediaSafeHref(resolvedUrl ?? "");
  if (!safe) return null;
  const hosted =
    isGatewayHostedMediaUrl(safe, settings.gatewayHttpBase) || /^(?:data|blob):/i.test(safe);
  if (!hosted) return null;
  return withAssistantMediaDownload(safe, settings.gatewayHttpBase);
}

/** 锚点 `download` 的落盘文件名（远端地址浏览器会忽略它，只作同源兜底）。 */
function downloadFileName(label: string | null | undefined, fallback = "附件"): string {
  const name = typeof label === "string" ? label.trim() : "";
  return name || fallback;
}

/**
 * 附件下载点击（捕获阶段委托，原理见 `utils/downloadSave.ts` 文件头）。
 *
 * 明文 HTTP 站点下浏览器会**拦掉下载**（控制台 "should be served over HTTPS" +
 * 下载气泡「无法从网站上提取文件」），这不是网关返回的错。这里只在
 * `shouldSaveViaBlob` 认定的场景（非安全上下文 + 同源 http 地址）接管点击，
 * 改成 fetch → `blob:` 落盘；其余场景原样走 `<a href download>` 原生导航 ——
 * **不**改成 `window.open` / `location`，那会把 SPA 顶掉（见 `downloadHrefOrNull`）。
 */
async function onPaneDownloadClick(evt: MouseEvent): Promise<void> {
  const target = evt.target as Element | null;
  const anchor = target?.closest?.("a[download]") as HTMLAnchorElement | null;
  if (!anchor) return;
  const href = anchor.getAttribute("href") ?? "";
  const fallback = shouldSaveViaBlob({
    url: href,
    secureContext: window.isSecureContext,
    pageOrigin: window.location.origin,
  });
  if (!fallback) return;
  evt.preventDefault();
  const name = anchor.getAttribute("download") || "附件";
  try {
    await saveUrlViaBlob(href, name);
  } catch (err) {
    console.warn("[chat-pane] blob 下载兜底失败", err);
    ElMessage({
      message:
        `下载失败：${name}\n` +
        "当前站点是明文 HTTP，浏览器可能拦截文件下载；请改用 HTTPS 访问，或在下载气泡里点「保留」。",
      type: "error",
      duration: 6500,
      grouping: true,
    });
  }
}

function previewHrefOf(attachment: ChatAttachment): string | null {
  return downloadHrefOrNull(attachmentPreviewHrefs.value.get(attachment.id) ?? null);
}

function attachmentTooltip(attachment: ChatAttachment): string {
  const name = attachment.fileName ?? "附件";
  return previewHrefOf(attachment) ? `点击下载 ${name}` : name;
}

/**
 * 历史附件 → 可直接塞进 `<img src>` / `<a href>` 的**网关媒体地址**。
 *
 * 本地绝对路径（`/Users/.../media/inbound/x.png`）不能直接给浏览器用，必须包一层
 * `/__openclaw__/assistant-media?source=...&token=...`（见 `utils/assistantMedia.ts`
 * 文件头的实测约束：无鉴权 401、响应无 CORS 头、所以只能 `<img src>` 直出）。
 *
 * 同样做成 computed Map：`buildAssistantMediaUrl` 每次会 `URLSearchParams.toString()`
 * 拼串，而模板里每条附件要问 `src` / `href` / 「可点吗」三处。
 * key 用 `source`（`extractTranscriptMediaItems` 已按 source 去重）。
 */
const historyMediaUrls = computed<Map<string, string>>(() => {
  const map = new Map<string, string>();
  const base = settings.gatewayHttpBase;
  const token = settings.token;
  for (const msg of messages.value) {
    for (const item of msg.historyMedia ?? []) {
      if (map.has(item.key)) continue;
      const url = buildAssistantMediaUrl({ source: item.source, base, token });
      if (url) map.set(item.key, url);
    }
  }
  return map;
});

function historyMediaUrlOf(item: TranscriptMediaItem): string {
  return historyMediaUrls.value.get(item.key) ?? "";
}

/** 历史附件的**下载**地址。`:src` 仍用 `historyMediaUrlOf` —— 必须保持 inline 才能出缩略图。 */
function historyMediaHrefOf(item: TranscriptMediaItem): string | null {
  return downloadHrefOrNull(historyMediaUrlOf(item));
}

function historyMediaTooltip(item: TranscriptMediaItem): string {
  return historyMediaHrefOf(item) ? `点击下载 ${item.label}` : item.label;
}

// ---------------------------------------------------------------------------
// content 内嵌媒体（助手图片 / 助手附件卡片）
// ---------------------------------------------------------------------------

/**
 * `content` 块里的原始引用 → 可直出/可点开的地址。
 *
 * 与历史附件同一套解析（`buildAssistantMediaUrl`）：`data:` / http(s) / blob: 原样；
 * 站内托管路径补 token；本地绝对路径与 `media://inbound/<id>` 走
 * `/__openclaw__/assistant-media?source=&token=`。
 *
 * 同样用 computed Map 缓存：同一条消息在模板里要问 `src` / `href` / 「可点吗」多次，
 * 而 `buildAssistantMediaUrl` 每次都拼 `URLSearchParams`。
 * key 用「原始引用」，同一引用在不同消息里解析结果相同 —— 可以共用。
 */
const contentMediaUrls = computed<Map<string, string>>(() => {
  const map = new Map<string, string>();
  const base = settings.gatewayHttpBase;
  const token = settings.token;
  const collect = (source: string): void => {
    if (!source || map.has(source)) return;
    const url = buildAssistantMediaUrl({ source, base, token });
    if (url) map.set(source, url);
  };
  for (const msg of messages.value) {
    for (const image of msg.contentImages ?? []) collect(image.url);
    for (const att of msg.contentAttachments ?? []) collect(att.url);
  }
  // 流式过程中的媒体位也要能解析出 src / href（文件一边生成一边可点）
  for (const ref of streamingMediaSplit.value.media) collect(ref);
  return map;
});

function contentMediaUrlOf(source: string): string {
  return contentMediaUrls.value.get(source) ?? "";
}

/** `<img alt>`：上游 `renderMessageImages` 用的是 `img.alt ?? "Attached image"`，这里同口径。 */
function contentImageAlt(image: ContentImageBlock): string {
  return image.alt?.trim() || "附件图片";
}

/** `title`（悬停提示）：有 alt 就用 alt，否则提示可点击下载。 */
function contentImageTooltip(image: ContentImageBlock): string {
  return image.alt?.trim() || "点击下载图片";
}

/**
 * 附件卡片（文档 / 视频）的**下载**地址；音频走 `AudioPlayer` 不经过这里。
 *
 * 不再有 click 处理器：`<a :href download>` 的原生导航就足够 —— 带 `download=1` 时
 * 网关回 `attachment`，浏览器下载并**保留当前页面**，也就不需要（也不该有）`window.open`。
 */
function contentAttachmentHref(att: ContentAttachmentItem): string | null {
  return downloadHrefOrNull(contentMediaUrlOf(att.url));
}

/** 图片同上：也用 `<a download>`，绝不走 JS 打开。 */
function contentImageHref(image: ContentImageBlock): string | null {
  return downloadHrefOrNull(contentMediaUrlOf(image.url));
}

/** 流式气泡里的图片（手上只有原始引用，没有 block）：同一套下载地址。 */
function streamingImageHref(source: string): string | null {
  return downloadHrefOrNull(contentMediaUrlOf(source));
}

/** 旧版 `handleChatAttachmentPaste`：输入框里 Ctrl+V 截图可直接变成附件。 */
function onInputPaste(event: ClipboardEvent): void {
  if (!canAttach.value) return;
  const files = chatAttachmentFilesFromClipboard(event.clipboardData);
  if (files.length === 0) return;
  event.preventDefault();
  void addAttachmentFiles(files);
}

/** 旧版 `handleChatAttachmentDrop`：拖文件到对话区也能挂上。 */
function onAttachDrop(event: DragEvent): void {
  // 拖的是窗格（拆分落区）而不是文件 —— 交给布局层，别当附件吃掉。
  if (event.dataTransfer?.types.includes(PANE_DRAG_MIME)) return;
  if (!canAttach.value) return;
  const files = event.dataTransfer?.files;
  if (!files || files.length === 0) return;
  event.preventDefault();
  void addAttachmentFiles(files);
}

function onAttachDragOver(event: DragEvent): void {
  if (event.dataTransfer?.types.includes(PANE_DRAG_MIME)) return;
  if (!canAttach.value) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
}

/** 拖动窗格头 → 记录自定义 MIME，布局层据此识别并计算落区。 */
function onPaneDragStart(event: DragEvent): void {
  // ⚠️ 脚本里必须走 `props.paneId`：模板会解包 props，但 `<script setup>` 里不会。
  event.dataTransfer?.setData(PANE_DRAG_MIME, props.paneId);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  emit("paneDragStart", props.paneId);
}

function onPaneDragEnd(): void {
  emit("paneDragEnd");
}

type PendingTask = {
  id: string;
  text: string;
  /** 随引导一起下发的附件（流式中入队时拷贝，通常为空——流式阶段附件入口被禁用）。 */
  attachments?: ChatAttachment[];
  /** 上次提交失败标记，用于展示重试入口。 */
  failed?: boolean;
  /** 失败原因，展示用。 */
  error?: string;
};

const pendingTasks = ref<PendingTask[]>([]);
let pendingTaskSeed = 0;

/** 待执行队列按会话持久化（对齐旧版 chat-queue 的持久化意图），刷新不丢。 */
const PENDING_TASKS_KEY = "openclaw.web.pendingTasks.v1";
function persistPendingTasks(key: string): void {
  try {
    const map = JSON.parse(localStorage.getItem(PENDING_TASKS_KEY) ?? "{}") as Record<string, PendingTask[]>;
    if (pendingTasks.value.length > 0) map[key] = pendingTasks.value;
    else delete map[key];
    localStorage.setItem(PENDING_TASKS_KEY, JSON.stringify(map));
  } catch {
    /* 存储不可用（隐私模式 / 配额）时静默降级，不阻塞交互 */
  }
}
function hydratePendingTasks(key: string): void {
  try {
    const map = JSON.parse(localStorage.getItem(PENDING_TASKS_KEY) ?? "{}") as Record<string, PendingTask[]>;
    const list = map[key];
    if (Array.isArray(list)) pendingTasks.value = list.filter((t) => t && typeof t.text === "string");
  } catch {
    /* 忽略损坏数据 */
  }
}

/** 队列持久化的分桶 key：与消息缓存同源（规范会话 key），保证拆分视图多个窗格共享同一份。 */
function pendingTasksKey(): string {
  return qualifySessionKey(sessionKey.value, paneAgentId.value) ?? resolvedSessionKey();
}

/** 队列项提交失败：保留在队列里并标记，供 UI 提供「重试 / 移除」。 */
function markPendingTaskFailed(id: string, error: string): void {
  pendingTasks.value = pendingTasks.value.map((item) =>
    item.id === id ? { ...item, failed: true, error } : item,
  );
  persistPendingTasks(pendingTasksKey());
}

function enqueuePendingTask(): void {
  const text = input.value.trim();
  if (!text || !sending.value) return;
  pendingTaskSeed += 1;
  // 拷贝当前 composer 附件（防御性：流式阶段通常无附件，入口被禁用）
  const taskAttachments = attachments.value.length > 0 ? attachments.value.map((a) => ({ ...a })) : undefined;
  pendingTasks.value.push({
    id: `pending-${Date.now()}-${pendingTaskSeed}`,
    text,
    ...(taskAttachments ? { attachments: taskAttachments } : {}),
  });
  input.value = "";
  persistPendingTasks(pendingTasksKey());
}

function removePendingTask(id: string): void {
  pendingTasks.value = pendingTasks.value.filter((item) => item.id !== id);
  persistPendingTasks(pendingTasksKey());
}

function clearPendingTasks(): void {
  pendingTasks.value = [];
  persistPendingTasks(pendingTasksKey());
}

/** 当前流式回合的局部积分展示（用于发送中显示「已消耗 X 积分 · 剩余 Y 积分」）。
 *  与 `sending` 等同挂在运行态桶上，拆分视图重建窗格后不会丢。 */
const streamingSpend = computed<JdSpendResult | null>({
  get: () => runState.value.streamingSpend,
  set: (next) => {
    runState.value.streamingSpend = next;
  },
});

/**
 * 「本轮生成已结束、积分还在算」——流式气泡下方的「积分计算中」只由它驱动。
 *
 * 由 agent 事件 `stream=lifecycle, data.phase=end` 置位（见 `utils/agentLifecycle.ts`），
 * 由任何收尾路径（final / aborted / error / 停止 / 换会话）清零。
 *
 * ⚠️ 不要退回「按 `sending && streamingText` 猜」：那样思考与生成过程中就会一直显示
 * 积分计算中，而积分实际要等生成结束、网关轮询完才有（实测有 ~6.8s 真空）。
 */
const spendPending = computed<boolean>({
  get: () => runState.value.spendPending,
  set: (next) => {
    runState.value.spendPending = next;
  },
});
const expandedThinkingIds = ref<Set<string>>(new Set());

/** 可用模型列表（按 provider/model 去重，catalog 优先 + 历史聚合补充）。 */
const modelOptions = ref<ModelOption[]>([]);

/**
 * 当前会话的上下文窗口上限（tokens）。
 *
 * 对齐上游 `chat-thread.ts` 的 `threadContextWindow`：
 * `当前会话的 contextTokens` ?? `sessions.defaults.contextTokens`，
 * 两者都没有时再退到「当前模型在目录里的 contextWindow」，尽量让占用率能显示出来。
 */
const contextWindow = ref<number | null>(null);

/** 只接受正数（0 / NaN / 缺失一律视作未知）。 */
function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * 解析 "provider/modelId" 形式的模型 key；不合法返回 null。
 * 兼容不带 provider 前缀的写法（如 agent 配置里的 `model.primary`）。
 */
function splitModelKey(key: string): { provider: string; model: string } | null {
  const value = key.trim();
  if (!value) return null;
  const idx = value.indexOf("/");
  if (idx <= 0 || idx === value.length - 1) return null;
  const provider = value.slice(0, idx).trim();
  const model = value.slice(idx + 1).trim();
  if (!provider || !model) return null;
  return { provider, model };
}

/**
 * 网关侧「默认模型」：用户没显式选模型时实际会用的那个。
 *
 * 为什么前端要自己查：服务端 `chat.send` 的 final 帧在很多代理实现里不带
 * provider/model，模型选择器为空串时前端就退化成「不显示模型」。
 * 主动查一次即可让「使用默认模型」这种情况也能显示真实模型名。
 */
const effectiveDefaultModel = ref<{ provider: string; model: string } | null>(null);

/**
 * 本窗格的模型覆盖 key —— **规范会话 key**（与消息缓存 / 待执行队列同源）。
 *
 * 用规范 key 而不是原始 prop：裸 `id-<hash8>` 与 `agent:main:id-<hash8>` 必须落到
 * 同一个桶，否则「同一会话的两个窗格」会各选各的模型。
 */
const modelOverrideKey = computed<string>(
  () => qualifySessionKey(sessionKey.value, paneAgentId.value) || sessionKey.value,
);

/**
 * 透传给 ModelSelector 的 v-model：用 computed 显式桥接本地覆盖表 / Pinia store，
 * 确保外部 setter 调用能可靠地反向回流到组件 props。
 *
 * 读：本窗格会话的覆盖 > 全局偏好（`settings.selectedModel`，作为新窗格的初始值）。
 * 写：**只落本窗格会话的覆盖**，不再动全局偏好 —— 否则拆分视图下 A 窗格把模型
 * 从 DeepSeek 切成 GLM，B 窗格会跟着一起变。对齐旧版
 * `ui/src/lib/sessions/index.ts` 的 `modelOverrides`：以会话 key 为键，
 * 同一会话共享、不同会话互不影响。
 */
const selectedModelRef = computed<string>({
  get: () => readModelOverride(modelOverrideKey.value) ?? settings.selectedModel,
  set: (value: string) => writeModelOverride(modelOverrideKey.value, value),
});

/** 用户显式选中的模型；空串 = 使用默认模型。 */
const selectedModelParts = computed<{ provider: string; model: string } | null>(() =>
  splitModelKey(selectedModelRef.value),
);

/**
 * 实际生效的模型 = 显式选择 ?? 网关默认。
 * 积分行的「生成模型」与选择器标签都用它，避免默认模型时一片空白。
 */
const effectiveModelParts = computed<{ provider: string; model: string } | null>(
  () => selectedModelParts.value ?? effectiveDefaultModel.value,
);

/** 传给 ModelSelector 的默认模型 key（用于把「默认模型」标签渲染成真实模型名）。 */
const defaultModelKey = computed<string>(() =>
  effectiveDefaultModel.value
    ? `${effectiveDefaultModel.value.provider}/${effectiveDefaultModel.value.model}`
    : "",
);


// 切换模型时，模型的 contextWindow 可能不同（200k ↔ 16k），重拉一次
watch(selectedModelRef, () => {
  void loadContextWindow();
});

const streaming = computed(() => sending.value);

/**
 * 输入框占位符多状态（对齐旧版 chat-composer.ts:1893-1899 的 4 态）：
 * 未连接 / 流式中（加入待执行任务）/ 带附件 / 普通。
 */
const composerPlaceholder = computed<string>(() => {
  if (insufficientCredits.value) return "积分不足，请充值后再发送消息";
  if (!gateway.connected) return "未连接到网关，无法发送消息";
  if (streaming.value) return "输入消息加入待执行任务（Enter 添加，Shift+Enter 换行）";
  if (attachments.value.length > 0)
    return `输入消息，Enter 发送（已附加 ${attachments.value.length} 个文件）`;
  // 对齐旧版 chat-composer.ts:1899 的 `t("chat.composer.placeholder", { name })`
  //（zh-CN.ts:1608 = "给 {name} 发消息"）：名字取**本窗格** agent，不是全局选中的那个。
  return `给 ${assistantName.value} 发消息`;
});
const isThinking = computed(
  () => sending.value && !streamingText.value && !streamingThinking.value,
);

/**
 * 最近一次已知的积分余额。
 *
 * 取值优先级：本轮流式回合 > 从最新助手消息往前找第一条带 spendResult 的余额。
 * 用「最近一次」而不是「历史任意一次」：用户充值后下一条回复会带回新的正余额，
 * 横幅应当随之自动消失，不需要用户手动关掉。
 */
const latestBalance = computed<number | null>(() => {
  const streaming = streamingSpend.value?.balance;
  if (typeof streaming === "number") return streaming;
  for (let i = messages.value.length - 1; i >= 0; i -= 1) {
    const value = messages.value[i].spendResult?.balance;
    if (typeof value === "number") return value;
  }
  return null;
});

/**
 * 积分不足：网关返回的 balance 为 0 时提示充值。
 *
 * 判定用 `<= 0` 而非 `=== 0` —— 负余额同样属于已用尽，不该漏提示。
 * 为 null（尚无任何余额数据）时不提示，避免刚进页面就误报。
 */
const insufficientCredits = computed(
  () => latestBalance.value !== null && latestBalance.value <= 0,
);

const SUGGESTIONS = [
  "查看当前网关的连接状态和健康信息",
  "列出所有已配置的通道及其状态",
  "看看有哪些定时任务在运行",
  "统计一下各模型的用量",
];

/**
 * 上游 `chat.history` 的 message.content 数组里，part.type 是 OpenAI/Anthropic 风格的
 * 多模态标识。带 type === "thinking" / "reasoning" / "redacted_thinking" 的 part **是思考**，
 * 不是正文 —— 拼进 text 就会把思考过程塞给用户，污染最终展示。
 *
 * 上游 `openclaw-v2026.7.1-2/src/gateway/chat-display-projection.ts:1696` 已经在 chat.history
 * 端过滤了这些 part，前端这里再加一道兜底：万一上游契约变更（直接发 raw content），
 * 也能守住 UI 不被污染。同步见 `normalizeMessage` 把这类 part 的 thinking 字段抽到顶层。
 */
const THINKING_PART_TYPES = new Set(["thinking", "reasoning", "redacted_thinking"]);

function isThinkingPartType(type: unknown): boolean {
  return typeof type === "string" && THINKING_PART_TYPES.has(type);
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const record = part as Record<string, unknown>;
          // 思考类 part 跳过 —— 不要把思考内容塞进正文
          if (isThinkingPartType(record.type)) return "";
          if (typeof record.text === "string") return record.text;
          if (typeof record.content === "string") return record.content;
        }
        return "";
      })
      .join("");
  }
  return "";
}

/**
 * 从 content 数组里把所有思考类 part 的 thinking 字段聚合成一段字符串。
 *
 * 用途：上游 final 帧的 message.content 偶发会把思考塞进 type:"thinking" part 而顶层不补
 * `thinking` 字段（虽然当前契约里 `server-chat.ts:1022 emitChatTerminal` 不会这么干，
 * 仍作为防御层），这样 `normalizeMessage` 就能正确还原思考折叠块的内容。
 */
function extractThinkingFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    if (!isThinkingPartType(record.type)) continue;
    if (typeof record.thinking === "string" && record.thinking) {
      parts.push(record.thinking);
    } else if (typeof record.text === "string" && record.text) {
      parts.push(record.text);
    }
  }
  return parts.join("\n\n");
}

/** 从对象里按候选 key 顺序取第一个数字字段。 */
function readNumber(source: Record<string, unknown> | null, keys: string[]): number {
  if (!source) return 0;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

/**
 * 读取单条消息的 token 用量。
 *
 * 兼容上游 `extractGroupMeta` 认识的几种写法：
 * `input` / `inputTokens`（以及 OpenAI 风格的 `prompt_tokens`），
 * `cacheRead` / `cache_read_input_tokens`，`cacheWrite` / `cache_creation_input_tokens`。
 * 全为 0 时返回 undefined —— 上下文占用百分比不会在无用量数据时瞎猜。
 */
function extractUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = raw as Record<string, unknown>;
  const direct: TokenUsage = {
    input: readNumber(usage, ["input", "inputTokens", "prompt_tokens", "promptTokens"]),
    output: readNumber(usage, ["output", "outputTokens", "completion_tokens", "completionTokens"]),
    cacheRead: readNumber(usage, ["cacheRead", "cache_read_input_tokens", "cacheReadTokens"]),
    cacheWrite: readNumber(usage, [
      "cacheWrite",
      "cache_creation_input_tokens",
      "cacheWriteTokens",
    ]),
    // 部分代理只报 total（如 `{ totalTokens: 12000 }`），保留下来供 contextUsedTokensOf 兜底用。
    totalTokens: readNumber(usage, ["totalTokens", "total_tokens", "total"]),
  };
  if (
    direct.input ||
    direct.output ||
    direct.cacheRead ||
    direct.cacheWrite ||
    (typeof direct.totalTokens === "number" && direct.totalTokens > 0)
  ) {
    return direct;
  }
  // 部分实现把 usage 嵌在 message.usage 里
  const nested = usage.usage ?? usage.tokens;
  if (nested && typeof nested === "object" && nested !== usage) {
    const fromNested = extractUsage(nested);
    if (fromNested) return fromNested;
  }
  return undefined;
}

/*
 * 上下文用量与占用百分比统一走 `@/utils/contextUsage`（纯函数，有单测）：
 *   已用   = `input + cacheRead + cacheWrite`（**不含 output**，与旧版 UI / 上游
 *            `normalizeUsage` 一致；含 output 会让「已用」数值对不上旧版显示）
 *   剩余   = `max(0, contextWindow − 已用)`
 *   百分比 = `round(已用 / contextWindow * 100)`，上限 100；无数据/无窗口 → null
 * 弹层里数字一律 `toLocaleString("zh-CN")` 全量展示（不压缩成 k/M）。
 *
 * 旧版实测可反推验证（窗口 1,048,576 / input 917 / cacheRead 26,624 / output 92）：
 *   已用 27,541 · 剩余 1,021,035 · 占用 3%  —— 三者完全吻合。
 */

/**
 * 消息的**跨刷新稳定身份**。
 *
 * 网关 `chat.history` 的记录里没有顶层 `id`，只有：
 * - 助手消息：`responseId`（`chatcmpl-…`，同时也是积分查询的 key，历史与流式 final 都带）
 * - 用户消息：`idempotencyKey`
 * - 两条都有：`__openclaw.id`（transcript 内部 id）
 *
 * 「删除消息」需要本地持久化，因此必须用这些稳定字段做 key —— 不能沿用
 * `msg-<index>-<Date.now()>`（每次拉历史都变，删了刷新就复活）。
 * `responseId` 排在 `__openclaw.id` 之前：流式 final 帧不带 `__openclaw`，
 * 两边都用 `responseId` 才能让「刚删的」和「刷新后拉到的」对上号。
 */
function stableMessageKey(record: Record<string, unknown>, index: number): string {
  if (typeof record.responseId === "string" && record.responseId) {
    return `resp-${record.responseId}`;
  }
  const transcript = record.__openclaw;
  if (transcript && typeof transcript === "object" && !Array.isArray(transcript)) {
    const id = (transcript as Record<string, unknown>).id;
    if (typeof id === "string" && id) return `oc-${id}`;
  }
  if (typeof record.id === "string" && record.id) return `id-${record.id}`;
  if (typeof record.idempotencyKey === "string" && record.idempotencyKey) {
    return `idem-${record.idempotencyKey}`;
  }
  const ts = typeof record.timestamp === "number" ? record.timestamp : 0;
  return `ts-${ts}-${index}`;
}

/**
 * 解析消息在网关记录里的**原始 id**（供「复制消息 id」按钮使用）。
 *
 * 与 `stableMessageKey` 的区别：这里返回**不带前缀的原值**。
 * 本地删除集合需要前缀来避免不同来源撞 key，但用户复制出去的 id 是要拿去
 * grep transcript / 日志 / 工单里对账的，加前缀反而搜不到。
 *
 * 返回 null 表示记录里没有任何稳定字段，调用方回落到 `stableMessageKey` 的结果。
 */
function resolveMessageId(
  record: Record<string, unknown>,
): { value: string; source: MessageIdSource } | null {
  if (typeof record.responseId === "string" && record.responseId) {
    return { value: record.responseId, source: "responseId" };
  }
  const transcript = record.__openclaw;
  if (transcript && typeof transcript === "object" && !Array.isArray(transcript)) {
    const id = (transcript as Record<string, unknown>).id;
    if (typeof id === "string" && id) return { value: id, source: "transcriptId" };
  }
  if (typeof record.id === "string" && record.id) {
    return { value: record.id, source: "recordId" };
  }
  if (typeof record.idempotencyKey === "string" && record.idempotencyKey) {
    return { value: record.idempotencyKey, source: "idempotencyKey" };
  }
  return null;
}

/** `MessageIdSource` → tooltip 里展示的字段名。 */
const MESSAGE_ID_SOURCE_LABEL: Record<MessageIdSource, string> = {
  responseId: "responseId",
  transcriptId: "__openclaw.id",
  recordId: "id",
  idempotencyKey: "idempotencyKey",
  derived: "本地派生",
};

/** 跨来源合并去重（正文 `MEDIA:` 与 `content` 块可能指向同一个文件）。 */
function dedupeContentImages(images: readonly ContentImageBlock[]): ContentImageBlock[] {
  const out: ContentImageBlock[] = [];
  const seen = new Set<string>();
  for (const image of images) {
    if (!image.url || seen.has(image.url)) continue;
    seen.add(image.url);
    out.push(image);
  }
  return out;
}

function dedupeContentAttachments(items: readonly ContentAttachmentItem[]): ContentAttachmentItem[] {
  const out: ContentAttachmentItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.url) continue;
    const key = `${item.kind}\u0000${item.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function normalizeMessage(raw: unknown, index: number): ChatMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const role = (typeof record.role === "string" ? record.role : "assistant") as ChatRole;
  const rawContent = record.content ?? record.text;
  const extractedText = extractText(rawContent);
  // 正文里的 `MEDIA:<引用>` 文本约定（旧版 `message-normalizer.expandTextContent` 的对应物）。
  // 实测：助手让文件「出现」在对话里就是靠正文写一行 `MEDIA:/.../x.pdf`，那条消息的字段里
  // **没有 `MediaPaths`** —— 不解析的话既没有可点/可下载的按钮，那行 `MEDIA:` 还会直接露出来。
  // `splitMediaMarkers` 会把可渲染的引用剥离出来（不可渲染的相对引用按上游口径保留原文）。
  const mediaMarker = splitMediaMarkers(extractedText);
  const text = mediaMarker.text;
  const markerAttachments = mediaMarker.media.map(inferMediaAttachment);
  // 顶层 thinking 字段优先；没有时从 content 数组里把 type:"thinking" part 的 thinking 字段抽出来
  // —— 上游 `server-chat.ts:1022 emitChatTerminal` 不会这么干，但防御未来契约变化。
  const thinkingFromTop = typeof record.thinking === "string" ? record.thinking : undefined;
  const thinkingFromContent = extractThinkingFromContent(rawContent);
  const thinking =
    thinkingFromTop ?? (thinkingFromContent ? thinkingFromContent : undefined);
  const completionId =
    typeof record.responseId === "string" && record.responseId
      ? record.responseId
      : typeof record.id === "string" && record.id
        ? record.id
        : undefined;
  const resolvedId = resolveMessageId(record);
  const spendResultRecord =
    record.spendResult && typeof record.spendResult === "object"
      ? (record.spendResult as Record<string, unknown>)
      : null;
  const spendResult =
    typeof spendResultRecord?.spend === "number" &&
    typeof spendResultRecord.balance === "number"
      ? { spend: spendResultRecord.spend, balance: spendResultRecord.balance }
      : undefined;
  // 顶层 MediaPaths 只挂在 user 轮次（实测：assistant / toolResult 都没有），
  // 所以「气泡附件条」只对 user 生效；非 user 的媒体全在 content 块里，走下面两条。
  const historyMedia = role === "user" ? extractTranscriptMediaItems(record) : [];
  // 图片类引用走 `<img>` 缩略图，其余（pdf/音视频…）走附件卡片；两者再与 `content` 块合并去重。
  const allContentImages = dedupeContentImages([
    ...extractContentImages(record),
    ...markerAttachments.filter((att) => att.kind === "image").map((att) => ({ url: att.url })),
  ]);
  // user 的顶层 MediaPaths 图片已经由气泡附件条渲染过 —— 这里滤掉，避免同一张图出现两次。
  const contentImages =
    role === "user" ? contentImagesExcludingTranscriptMedia(record, allContentImages) : allContentImages;
  const contentAttachments = dedupeContentAttachments([
    ...extractContentAttachments(record),
    ...markerAttachments
      .filter((att) => att.kind !== "image")
      .map((att) => ({
        kind: (att.kind === "video" ? "video" : att.kind === "audio" ? "audio" : "document") as
          | "audio"
          | "video"
          | "document",
        url: att.url,
        label: att.label,
        ...(att.mimeType ? { mimeType: att.mimeType } : {}),
      })),
  ]);
  // user 的气泡附件条已经把顶层 MediaPaths 全渲染了（含非图片），
  // `attachment` 块若与其中某条同源，再渲染一次就是重复卡片 —— 这里按 url 滤掉。
  const visibleContentAttachments =
    role === "user"
      ? contentAttachments.filter(
          (att) => !historyMedia.some((media) => media.source === att.url),
        )
      : contentAttachments;
  return {
    id: stableMessageKey(record, index),
    role,
    text,
    thinking,
    ts: typeof record.timestamp === "number" ? record.timestamp : undefined,
    provider: typeof record.provider === "string" ? record.provider : undefined,
    model: typeof record.model === "string" ? record.model : undefined,
    completionId,
    spendResult,
    usage: extractUsage(record.usage ?? record.tokens),
    ...(historyMedia.length > 0 ? { historyMedia } : {}),
    ...(contentImages.length > 0 ? { contentImages } : {}),
    ...(visibleContentAttachments.length > 0 ? { contentAttachments: visibleContentAttachments } : {}),
    rawId: resolvedId?.value,
    rawIdSource: resolvedId?.source,
  };
}

/** 距底多少像素内算「在近底」，超过则视为用户在看历史、暂停自动跟随（对齐旧版 scroll.ts:5）。 */
const NEAR_BOTTOM_PX = 450;
/** 距顶多少像素内算「在顶」，触发自动加载更早历史（对齐旧版「滚到顶翻页」习惯）。 */
const NEAR_TOP_PX = 120;
/** 是否跟随到底部：用户上滑看历史时置 false，新 token 不再把视口拽回底部。 */
const followScroll = ref(true);

function onThreadScroll(): void {
  const el = threadRef.value;
  if (!el) return;
  const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  followScroll.value = distanceFromBottom <= NEAR_BOTTOM_PX;
  // 触顶自动加载更早历史：距顶很近且后端还有更早且未在加载中
  if (el.scrollTop <= NEAR_TOP_PX && historyHasMore.value && !loadingOlderHistory.value) {
    void loadOlderHistory();
  }
}

function jumpToBottom(): void {
  followScroll.value = true;
  void scrollToBottom(true);
}

async function scrollToBottom(force = false): Promise<void> {
  await nextTick();
  const el = threadRef.value;
  // 非强制且用户已上滑：跳过，避免打断看历史（对齐旧版 chatFollowLocked）。
  if (!force && !followScroll.value) return;
  if (el) el.scrollTop = el.scrollHeight;
}

/**
 * 发请求前兜底会话 key：网关要求 `sessionKey` 至少 1 个字符，
 * 空串会直接报 `invalid chat.history params: at /sessionKey: must not have fewer than 1 characters`。
 * 正常情况下 store 已经保证非空，这里是最后一道闸。
 */
function resolvedSessionKey(): string {
  // sessionKey 现在是 prop 派生的 computed，**不能回写**（回写会与父级持有的
  // 布局状态打架）；空值时只在本函数内兜底，同时通知父级纠正。
  const key = sessionKey.value.trim();
  if (key) return key;
  const fallback = settings.sessionKey.trim() || "main";
  emit("sessionChange", props.paneId, fallback);
  return fallback;
}

/**
 * 事件隔离：这条 `chat` / `agent` 事件属于当前会话吗？
 *
 * ⚠️ 必须用 `sessionKeysMatch`（先补全成规范形态再比），**不能**用
 * `areUiSessionKeysEquivalent`：后者只把裸 `main` 补成 `agent:main:main`，
 * 补不出 `id-<hash8>` 的 agent 前缀。
 *
 * 背景：本视图持有的 `sessionKey` 可能是入口 token 派生的**裸 key**（`id-<hash8>`），
 * 而网关广播事件里的 `sessionKey` 一律是**带 agent 前缀的规范 key**（`agent:main:id-<hash8>`）。
 * 用错比较函数 = 所有流式事件都被当成「别的会话」丢掉，包括 `chat` 的 `state:"error"`，
 * 于是 `sending` 永远停在 true，UI 卡在三点「思考中」，正文 / 思考 / 错误全都不显示。
 *
 * 事件没带 sessionKey 时返回 true（不过滤），保持原有「不猜、放行」的策略。
 */
function isEventForCurrentSession(sessionKeyValue: unknown): boolean {
  if (typeof sessionKeyValue !== "string" || !sessionKeyValue.trim()) return true;
  return sessionKeysMatch(sessionKeyValue, sessionKey.value, paneAgentId.value);
}

/**
 * 加载可用模型列表。优先探测 `models.list` RPC（如果服务端实现了的话），
 * 然后从当前会话历史消息里聚合作补充数据来源。
 *
 * 后端不支持时也能优雅降级为「历史用过的模型」，保证选择器始终有数据可用。
 */
async function loadModelList(): Promise<void> {
  const seen = new Map<string, ModelOption>();

  // 1) 后端目录
  try {
    const res = await gateway.request<{
      models?: ModelCatalogEntry[];
      catalog?: ModelCatalogEntry[];
    }>("models.list", {});
    const list = Array.isArray(res?.models)
      ? res!.models
      : Array.isArray(res?.catalog)
        ? res!.catalog
        : [];
    for (const m of list) {
      if (!m || typeof m.provider !== "string" || typeof m.id !== "string") continue;
      const key = `${m.provider}/${m.id}`;
      if (seen.has(key)) continue;
      seen.set(key, {
        key,
        label: m.alias ?? m.name ?? m.id,
        provider: m.provider,
        contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : undefined,
        reasoning: m.reasoning === true,
        source: "catalog",
      });
    }
  } catch {
    // 后端未暴露 models.list —— 静默回退到历史聚合
  }

  // 2) 历史消息聚合
  for (const msg of messages.value) {
    if (msg.role !== "assistant") continue;
    if (typeof msg.provider !== "string" || typeof msg.model !== "string") continue;
    const key = `${msg.provider}/${msg.model}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      key,
      label: msg.model,
      provider: msg.provider,
      source: "history",
    });
  }

  modelOptions.value = Array.from(seen.values()).sort((a, b) => {
    if (a.source !== b.source) return a.source === "catalog" ? -1 : 1;
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
    return a.label.localeCompare(b.label);
  });
}

/**
 * 查询网关生效的「默认模型」，写入 `effectiveDefaultModel`。
 *
 * 数据来源（按可靠性排序，任一成功即止）：
 * 1. `agents.list` → `agents[defaultId].model.primary`，例如 "jd-llm/DeepSeek-V4-Flash"
 * 2. `sessions.list` → `defaults.modelProvider` + `defaults.model`
 *
 * 两条路都失败时静默降级：选择器显示「默认模型」文案，聊天与积分行不受影响。
 */
async function loadDefaultModel(): Promise<void> {
  try {
    const res = await gateway.request<{
      defaultId?: string;
      agents?: Array<{ id?: string; model?: { primary?: string } }>;
    }>("agents.list", {});
    const list = Array.isArray(res?.agents) ? res.agents : [];
    // 取**本窗格 agent** 的默认模型：拆分视图下不同窗格属于不同 agent，用网关
    // `defaultId` 那条会让「默认模型」标签与积分行显示成别的 agent 的模型。
    // ⚠️ 局部变量刻意不叫 `agents` —— 那会 shadow 掉上面的 store 单例（原来是这么写的）。
    const agent =
      list.find((item) => item?.id === paneAgentId.value) ??
      list.find((item) => item?.id === res?.defaultId) ??
      list[0];
    const primary = typeof agent?.model?.primary === "string" ? agent.model.primary : "";
    const parts = splitModelKey(primary);
    if (parts) {
      effectiveDefaultModel.value = parts;
      return;
    }
  } catch {
    // 网关未暴露 agents.list —— 继续尝试 sessions.list
  }

  try {
    const res = await gateway.request<{
      defaults?: { modelProvider?: string; model?: string };
    }>("sessions.list", {});
    const provider = res?.defaults?.modelProvider?.trim() ?? "";
    const model = res?.defaults?.model?.trim() ?? "";
    if (provider && model) effectiveDefaultModel.value = { provider, model };
  } catch {
    // 静默降级
  }
}

/**
 * 读取当前会话的上下文窗口上限，写入 `contextWindow`。
 *
 * 数据来源（按可靠性排序）：
 * 1. `sessions.list` 里当前 session 行的 `contextTokens`
 * 2. `sessions.list` 的 `defaults.contextTokens`
 * 3. 当前模型在模型目录里的 `contextWindow`（`models.list`，可选）
 *
 * 全部拿不到时保持 null —— 占用率不显示，而不是显示错误的 0%。
 */
async function loadContextWindow(): Promise<void> {
  let next: number | null = null;
  try {
    const res = await gateway.request<SessionsListResult>("sessions.list", {
      limit: 200,
      includeGlobal: true,
      includeUnknown: true,
    });
    // 顺手把整张列表留给窗格头的会话下拉 —— 旧版 chat-pane.ts:renderPaneHeader
    // 也是用同一份 `state.sessionsResult`，不额外发请求。
    sessionRows.value = res?.sessions ?? [];
    const key = resolvedSessionKey();
    const current = sessionRows.value.find((row) =>
      sessionKeysMatch(row.key, key, paneAgentId.value),
    );
    next = positiveNumber(current?.contextTokens) ?? positiveNumber(res?.defaults?.contextTokens);
  } catch {
    // 网关未暴露 sessions.list —— 继续尝试模型目录
  }
  if (next === null) {
    const parts = effectiveModelParts.value;
    const catalogKey = parts ? `${parts.provider}/${parts.model}` : "";
    const match = catalogKey ? modelOptions.value.find((m) => m.key === catalogKey) : undefined;
    next = positiveNumber(match?.contextWindow);
  }
  contextWindow.value = next;
}

// ---------------------------------------------------------------------------
// 窗格头（拆分视图下的会话下拉）
// ---------------------------------------------------------------------------

/** 同一次 `sessions.list` 的结果，供窗格头下拉复用（见 loadContextWindow）。 */
const sessionRows = ref<SessionsListResult["sessions"]>([]);

/**
 * 窗格头下拉里一条会话的展示名。
 *
 * 入口 token 派生的会话 key（裸 `id-<hash>` / `agent:<id>:id-<hash>`）拿不到
 * label / displayName，`sessionDisplayNameFor` 只能回落成裸 id —— 下拉里就是
 * 「id-xxxxxxxx」这样一行无意义的 id。这种 id 形态的展示名改用 **agent 展示
 * 名**（这类会话是各 agent 的网页入口会话，agent 名才是有效信息）；其余会话
 * （主会话 / 渠道联系人 / cron…）保持原解析结果不动。
 */
function paneSessionOptionLabel(
  key: string,
  row?: { label?: string; displayName?: string } | null,
  agentId = "",
): string {
  const name = agents.sessionDisplayNameFor(key, row);
  if (name && name !== key && !ENTRY_SESSION_ID_RE.test(name)) return name;
  return agents.nameForAgent(agentId);
}

/** 入口 token 会话的裸 id 形态：`id-<hash>`（旧下拉里「id-09fb9e55」那一行）。 */
const ENTRY_SESSION_ID_RE = /^id-[0-9a-z]{6,}$/i;

/**
 * 窗格头下拉的候选：跨 agent 的**全部会话，按 agent 分组**（模板里渲染成 `<optgroup>`）。
 *
 * 产品口径：窗格内换 agent 有**两条**路 ——
 *   ① 本下拉按组选择（选出别的 agent 的会话 = 本窗格换 agent）；
 *   ② 点击左侧目录（那条走 `settings.sessionKey`，布局层只改**活动窗格**）。
 * 两条都必须支持，所以这里**不做**「按本窗格 agent 过滤」。旧版
 * `chat-pane.ts:726 renderPaneHeader` 是过滤的，但那时窗格换 agent 另有独立控件
 * （`onAgentChange`），本项目的产品口径是把 agent 选择收进这一个下拉。
 *
 * 分组顺序：本窗格 agent 排最前（当前选中项最容易被找到）。
 */
const paneSessionGroups = computed<
  Array<{ agentId: string; label: string; options: Array<{ key: string; label: string }> }>
>(() => {
  const seen = new Set<string>();
  const byAgent = new Map<string, Array<{ key: string; label: string }>>();

  for (const row of sessionRows.value) {
    const key = typeof row?.key === "string" ? row.key.trim() : "";
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const agentId = agents.agentIdForSession(key);
    const options = byAgent.get(agentId) ?? [];
    options.push({ key, label: paneSessionOptionLabel(key, row, agentId) });
    byAgent.set(agentId, options);
  }

  // 当前会话若还没落库（网关列表里没有），补到它所属 agent 的组里 —— 否则
  // 下拉的 model-value 找不到对应 option，会显示成组里第一项，用户看到的就是
  // 「窗格头显示的会话和实际会话对不上」（旧版同样做了这个补位）。
  const currentKey = sessionKey.value.trim();
  if (currentKey && !seen.has(currentKey)) {
    const agentId = paneAgentId.value;
    const options = byAgent.get(agentId) ?? [];
    options.unshift({
      key: currentKey,
      label: paneSessionOptionLabel(currentKey, undefined, paneAgentId.value),
    });
    byAgent.set(agentId, options);
  }

  const ids = [...byAgent.keys()].sort((a, b) =>
    a === paneAgentId.value ? -1 : b === paneAgentId.value ? 1 : 0,
  );
  return ids.map((agentId) => ({
    agentId,
    label: agents.nameForAgent(agentId),
    options: byAgent.get(agentId) ?? [],
  }));
});

function onPaneSessionSelect(value: string | number | boolean | undefined): void {
  const next = typeof value === "string" ? value.trim() : "";
  if (!next || next === sessionKey.value) return;
  emit("sessionChange", props.paneId, next);
}

/** 一条消息可复制的内容：正文（不含思考过程），与上游 resolveNormalizedMessageMarkdown 一致。 */
function messageCopyText(msg: ChatMessage): string {
  return (msg.text ?? "").trim();
}

/** 是否有可复制内容（决定复制按钮是否可点）。 */
function canCopyMessage(msg: ChatMessage): boolean {
  return messageCopyText(msg).length > 0;
}

/**
 * 是否可打开「详情」面板（右侧展开完整消息）。
 *
 * 对齐上游 `resolveMessageActionDetails`：只对**助手消息**提供「详情」入口，
 * 且必须有正文（或思考过程）。用户消息无需在右侧面板展开（内容已在气泡里完整呈现）。
 */
function canOpenDetail(msg: ChatMessage): boolean {
  if (msg.role !== "assistant") return false;
  return (msg.text ?? "").trim().length > 0 || Boolean(msg.thinking);
}

/**
 * 是否有可展示的消息元信息（决定积分/操作行是否出现）。
 *
 * 有可复制内容时也要出现 —— 这行同时承载「复制 / 删除」操作按钮。
 *
 * 上下文占用原本在此行显示；现在迁到了输入框右下角（持续展示最后一条带
 * usage 的消息的占用），所以这里的判断不再含上下文。
 */
function hasMessageMeta(msg: ChatMessage): boolean {
  return (
    Boolean(msg.spendResult) ||
    msg.spendLoading === true ||
    canCopyMessage(msg)
  );
}

/**
 * 最后一条带 usage 的消息（用于底部右下角持续展示上下文占用）。
 *
 * 上下文是「这条对话的当前状态」—— 只有最新一轮的 assistant 消息携带
 * 服务端回传的 `usage`，因此取它就够。messages 切换 / 新回复到达时
 * 这个值会自动更新（computed 依赖 messages.value）。
 */
const latestContextMsg = computed<ChatMessage | null>(() => {
  for (let i = messages.value.length - 1; i >= 0; i -= 1) {
    if (contextPercentOf(messages.value[i].usage, contextWindow.value) !== null) {
      return messages.value[i];
    }
  }
  return null;
});

const latestContextPercent = computed<number | null>(() =>
  contextPercentOf(latestContextMsg.value?.usage, contextWindow.value),
);

const latestContextClass = computed<string>(() =>
  contextPercentClassOf(latestContextPercent.value),
);

/**
 * 弹层标题行右侧文案 = `已用 / 上限`（旧版 `model.detail`，紧凑格式 `56.2k / 204.8k`）。
 * 口径与百分比同源（不含 output），只是把两个数换成 k/M 紧凑写法。
 */
const latestContextDetail = computed<string>(() =>
  contextWindowDetailOf(latestContextMsg.value?.usage, contextWindow.value),
);

/**
 * 上下文占用环的表盘几何（逐字对齐旧版 `chat-composer.ts:1565-1566 / 1618-1641`）：
 * `r = 6.5` 的 16×16 SVG，弧长用 `dasharray = 周长`、`dashoffset = 周长 ×(1 − pct/100)` 表达，
 * 配合 `transform: rotate(-90deg)` 让 0% 从 12 点起画。
 */
const CTX_RING_RADIUS = 6.5;
const CTX_RING_CIRCUMFERENCE = 2 * Math.PI * CTX_RING_RADIUS;

const latestContextDashOffset = computed<number>(
  () => CTX_RING_CIRCUMFERENCE * (1 - (latestContextPercent.value ?? 0) / 100),
);

// ── 复制为 Markdown（移植自上游 components/copy-button.ts） ──

const COPY_FEEDBACK_MS = 1500;
const COPY_ERROR_MS = 2000;

type CopyState = "copied" | "error";

/** 反馈键 -> 临时反馈态；无键 = 空闲。 */
const copyStates = ref<Record<string, CopyState>>({});
const copyTimers = new Map<string, number>();

/**
 * 反馈键：`msg.id` 给「复制正文」用，`msg.id + "#id"` 给「复制消息 id」用。
 * 两条按钮共用一个状态机但互不影响，避免点 A 亮 B。
 */
const MESSAGE_ID_COPY_SUFFIX = "#id";

function messageIdCopyKey(msg: ChatMessage): string {
  return msg.id + MESSAGE_ID_COPY_SUFFIX;
}

function copyStateOf(msg: ChatMessage): CopyState | "" {
  return copyStates.value[msg.id] ?? "";
}

function copyTitleOf(msg: ChatMessage): string {
  const state = copyStateOf(msg);
  if (state === "copied") return "已复制";
  if (state === "error") return "复制失败";
  return canCopyMessage(msg) ? "复制为 Markdown" : "无可复制内容";
}

function setCopyState(key: string, state: CopyState, clearAfterMs: number): void {
  copyStates.value = { ...copyStates.value, [key]: state };
  const previous = copyTimers.get(key);
  if (previous !== undefined) window.clearTimeout(previous);
  copyTimers.set(
    key,
    window.setTimeout(() => {
      copyTimers.delete(key);
      const next = { ...copyStates.value };
      delete next[key];
      copyStates.value = next;
    }, clearAfterMs),
  );
}

/**
 * 复制该条消息正文。
 *
 * 复用 `copyToClipboard`（安全上下文 API + execCommand 兜底），
 * 成功显示对勾 1.5s，失败显示警告 2s —— 时长与上游一致。
 */
async function copyMessage(msg: ChatMessage): Promise<void> {
  const text = messageCopyText(msg);
  if (!text) return;
  const ok = await copyToClipboard(text);
  setCopyState(msg.id, ok ? "copied" : "error", ok ? COPY_FEEDBACK_MS : COPY_ERROR_MS);
  // grouping: 连点多次只保留一条「已复制」提示，避免 toast 堆叠。
  if (ok) {
    ElMessage({ message: "已复制到剪贴板", type: "success", grouping: true });
  } else {
    ElMessage({ message: "复制失败，请手动选择文本复制", type: "error", grouping: true });
  }
}

// ── 复制消息 id ──

/**
 * 要复制的消息 id 文本。
 *
 * 优先网关原值（`rawId`，如 `chatcmpl-…`），取不到时回落本地稳定键 `msg.id`
 * （此时带 `resp-` / `oc-` 前缀，属于「只在本机有意义」的兜底值，
 * tooltip 会把来源标为「本地派生」以免误用）。
 */
function messageIdText(msg: ChatMessage): string {
  return (msg.rawId ?? msg.id ?? "").trim();
}

/** 是否有可复制的 id（实际上稳定键永远存在，留个判断防御空值）。 */
function canCopyMessageId(msg: ChatMessage): boolean {
  return messageIdText(msg).length > 0;
}

function idCopyStateOf(msg: ChatMessage): CopyState | "" {
  return copyStates.value[messageIdCopyKey(msg)] ?? "";
}

/** 悬浮提示：既说明这个 id 来自哪个字段，也把原值摊开方便肉眼核对。 */
function idCopyTitleOf(msg: ChatMessage): string {
  const state = idCopyStateOf(msg);
  if (state === "copied") return "已复制消息 id";
  if (state === "error") return "复制失败";
  if (!canCopyMessageId(msg)) return "无可复制的消息 id";
  const source = msg.rawIdSource
    ? MESSAGE_ID_SOURCE_LABEL[msg.rawIdSource]
    : "本地派生";
  return `复制消息 id（来源 ${source}）\n${messageIdText(msg)}`;
}

/**
 * 复制该条消息的 id。
 *
 * 与「复制正文」共用反馈状态机（键加 `#id` 后缀隔离），成功/失败提示文案区分开，
 * 避免用户分不清复制的是正文还是 id。
 */
async function copyMessageId(msg: ChatMessage): Promise<void> {
  const text = messageIdText(msg);
  if (!text) return;
  const ok = await copyToClipboard(text);
  setCopyState(
    messageIdCopyKey(msg),
    ok ? "copied" : "error",
    ok ? COPY_FEEDBACK_MS : COPY_ERROR_MS,
  );
  if (ok) {
    ElMessage({ message: `已复制消息 id：${text}`, type: "success", grouping: true });
  } else {
    ElMessage({ message: "复制失败，请手动选择文本复制", type: "error", grouping: true });
  }
}

/**
 * 悬浮复制按钮的标题：复用 copyStateOf 反馈态，避免「复制成功了按钮文案不更新」。
 */
function hoverCopyTitleOf(msg: ChatMessage): string {
  const state = copyStateOf(msg);
  if (state === "copied") return "已复制";
  if (state === "error") return "复制失败，请手动选择文本复制";
  return canCopyMessage(msg) ? "复制这条消息" : "无可复制内容";
}

// ── 删除消息（移植自上游 renderDeleteButton） ──

/** 「不再询问」的本地记忆键，与上游同名。 */
const SKIP_DELETE_CONFIRM_KEY = "openclaw:skipDeleteConfirm";
const DELETE_CONFIRM_MARGIN_PX = 8;
const DELETE_CONFIRM_GAP_PX = 6;

/** 当前打开确认浮层的消息 id；null = 未打开。 */
const deleteConfirmId = ref<string | null>(null);
/** 「不再询问」勾选态（每次打开重置）。 */
const deleteConfirmRemember = ref(false);
/** 浮层坐标（null = 尚未测量，先隐藏避免闪到左上角）。 */
const deleteConfirmPos = ref<{ left: number; top: number; placement: "above" | "below" } | null>(
  null,
);
/** 浮层 DOM 引用（用于测量宽高）。 */
const deleteConfirmEl = ref<HTMLElement | null>(null);
/** 触发按钮元素（用于定位与「点外面关闭」判定）。 */
let deleteConfirmTrigger: HTMLElement | null = null;
/** 一次性监听器的清理函数。 */
let deleteConfirmCleanup: (() => void) | null = null;

function shouldSkipDeleteConfirm(): boolean {
  try {
    return window.localStorage.getItem(SKIP_DELETE_CONFIRM_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberSkipDeleteConfirm(): void {
  try {
    window.localStorage.setItem(SKIP_DELETE_CONFIRM_KEY, "1");
  } catch {
    // 隐私模式等场景写不进，忽略即可。
  }
}

/** 把浮层贴到触发按钮旁边；上方空间不足时翻到下方（与上游同算法）。 */
function positionDeleteConfirm(): void {
  const trigger = deleteConfirmTrigger;
  const popover = deleteConfirmEl.value;
  if (!trigger || !popover) return;
  const triggerRect = trigger.getBoundingClientRect();
  const popoverRect = popover.getBoundingClientRect();
  const margin = DELETE_CONFIRM_MARGIN_PX;
  const gap = DELETE_CONFIRM_GAP_PX;
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = document.documentElement.clientHeight;
  const popoverWidth = Math.min(popoverRect.width, viewportWidth - margin * 2);
  const popoverHeight = Math.min(popoverRect.height, viewportHeight - margin * 2);
  const spaceAbove = triggerRect.top - margin - gap;
  const spaceBelow = viewportHeight - triggerRect.bottom - margin - gap;
  const placeBelow = spaceAbove < popoverHeight && spaceBelow >= spaceAbove;
  const clamp = (value: number, min: number, max: number) =>
    max < min ? min : Math.min(Math.max(value, min), max);
  const left = clamp(triggerRect.left, margin, viewportWidth - margin - popoverWidth);
  const desiredTop = placeBelow ? triggerRect.bottom + gap : triggerRect.top - gap - popoverHeight;
  const top = clamp(desiredTop, margin, viewportHeight - margin - popoverHeight);
  deleteConfirmPos.value = {
    left: Math.round(left),
    top: Math.round(top),
    placement: placeBelow ? "below" : "above",
  };
}

function closeDeleteConfirm(): void {
  deleteConfirmCleanup?.();
  deleteConfirmCleanup = null;
  deleteConfirmId.value = null;
  deleteConfirmPos.value = null;
  deleteConfirmTrigger = null;
  deleteConfirmRemember.value = false;
}

/** 打开浮层，并挂上「点外面/滚动/Esc 关闭」的一次性监听。 */
function openDeleteConfirm(msg: ChatMessage, trigger: HTMLElement | null): void {
  deleteConfirmTrigger = trigger;
  deleteConfirmRemember.value = false;
  deleteConfirmPos.value = null;
  deleteConfirmId.value = msg.id;
  void nextTick(() => {
    positionDeleteConfirm();
    // 等这一拍 click 事件走完再挂监听，否则同一次点击会立刻把浮层关掉。
    const onOutsideClick = (evt: MouseEvent) => {
      const target = evt.target;
      if (!(target instanceof Node)) return;
      if (deleteConfirmEl.value?.contains(target)) return;
      if (trigger?.contains(target)) return;
      closeDeleteConfirm();
    };
    const onKeydown = (evt: KeyboardEvent) => {
      if (evt.key === "Escape") closeDeleteConfirm();
    };
    const onReflow = () => positionDeleteConfirm();
    const raf = window.requestAnimationFrame(() => {
      document.addEventListener("click", onOutsideClick, true);
      document.addEventListener("keydown", onKeydown, true);
      window.addEventListener("resize", onReflow);
      // 捕获阶段监听，滚动容器内部滚动也能跟上。
      window.addEventListener("scroll", onReflow, true);
    });
    deleteConfirmCleanup = () => {
      window.cancelAnimationFrame(raf);
      document.removeEventListener("click", onOutsideClick, true);
      document.removeEventListener("keydown", onKeydown, true);
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
  });
}

/**
 * 点删除按钮：已勾过「不再询问」则直接删；浮层已开着则再点一次收起。
 */
function requestDeleteMessage(msg: ChatMessage, evt: MouseEvent): void {
  if (shouldSkipDeleteConfirm()) {
    removeMessage(msg.id);
    return;
  }
  if (deleteConfirmId.value === msg.id) {
    closeDeleteConfirm();
    return;
  }
  const trigger = evt.currentTarget instanceof HTMLElement ? evt.currentTarget : null;
  openDeleteConfirm(msg, trigger);
}

/** 浮层里点「删除」：按需记住「不再询问」，然后删除。 */
function confirmDeleteMessage(): void {
  const id = deleteConfirmId.value;
  if (!id) return;
  if (deleteConfirmRemember.value) rememberSkipDeleteConfirm();
  // 先关浮层再删，避免消息消失后浮层还挂在旧坐标上。
  const cleanup = deleteConfirmCleanup;
  deleteConfirmCleanup = null;
  cleanup?.();
  deleteConfirmId.value = null;
  deleteConfirmPos.value = null;
  deleteConfirmTrigger = null;
  deleteConfirmRemember.value = false;
  removeMessage(id);
}

/**
 * 删除一条消息。
 *
 * 网关没有「删除单条消息」的 RPC（`chat.message.delete` / `messages.delete` 等一律 unknown method），
 * 所以只能前端移除 + **本地记住被删的稳定 id**，让后续 `chat.history` 拉回来的记录被过滤掉 ——
 * 否则刷新一次就复活。代价：网关侧 transcript 未变，换浏览器/换客户端仍能看到该条。
 */
function removeMessage(id: string): void {
  const index = messages.value.findIndex((msg) => msg.id === id);
  if (index >= 0) {
    // 删消息同时回收它的附件 objectURL（气泡没了，预览图不该继续占内存）。
    const removed = messages.value[index];
    if (removed.attachments?.length) releaseChatAttachmentPayloads(removed.attachments);
    messages.value.splice(index, 1);
  }
  persistDeletedMessageId(id);
  closeDeleteConfirm();
}

/** 每条会话各自记录被删除的消息 id（键 = resolvedSessionKey()）。 */
const DELETED_MESSAGES_KEY = "openclaw.web.deletedMessages.v1";
/** 单会话最多记多少条，避免长会话把 localStorage 撑爆。 */
const DELETED_MESSAGES_MAX = 500;

type DeletedMessagesMap = Record<string, string[]>;

/** 当前会话被删掉的消息 id；`chat.history` 结果会据此过滤。 */
const deletedMessageIds = ref<Set<string>>(new Set());

function readDeletedMessagesMap(): DeletedMessagesMap {
  try {
    const raw = window.localStorage.getItem(DELETED_MESSAGES_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: DeletedMessagesMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        out[key] = value.filter((item): item is string => typeof item === "string" && item.length > 0);
      }
    }
    return out;
  } catch {
    // 解析失败（手工改坏 / 旧格式）当作空表，不要让删除功能整体挂掉。
    return {};
  }
}

function writeDeletedMessagesMap(map: DeletedMessagesMap): void {
  try {
    window.localStorage.setItem(DELETED_MESSAGES_KEY, JSON.stringify(map));
  } catch {
    // 隐私模式 / 配额满：写不进也不影响本次会话内的删除。
  }
}

/** 从本地读取当前会话的已删集合（拉历史 / 切会话时同步一次）。 */
function loadDeletedMessageIds(): void {
  const key = resolvedSessionKey();
  deletedMessageIds.value = new Set(readDeletedMessagesMap()[key] ?? []);
}

/** 记下一条已删消息，并同步内存集合。 */
function persistDeletedMessageId(id: string): void {
  const key = resolvedSessionKey();
  const map = readDeletedMessagesMap();
  const list = map[key] ?? [];
  if (!list.includes(id)) list.push(id);
  map[key] = list.slice(-DELETED_MESSAGES_MAX);
  writeDeletedMessagesMap(map);
  const next = new Set(deletedMessageIds.value);
  next.add(id);
  deletedMessageIds.value = next;
}

const deleteConfirmStyle = computed<Record<string, string>>((): Record<string, string> => {
  const pos = deleteConfirmPos.value;
  if (!pos) return { visibility: "hidden" };
  return { left: `${pos.left}px`, top: `${pos.top}px`, visibility: "visible" };
});

/**
 * 历史上一次请求的序号：会话快速切换 / 连点刷新时，**只允许最新一次结果写回视图与缓存**。
 * 对齐旧版 `ui/src/pages/chat/chat-history.ts:82-106 shouldApplyChatHistoryResult`。
 */
let historyRequestSeq = 0;

/**
 * 把「后台会话暂存的终止回复」按稳定 id 去重合并进来（见 `utils/chatMessageCache`
 * 的 `noteBackgroundAssistantMessage`）。
 *
 * 暂存条目**不在这里销毁** —— 服务端 transcript 落库偶尔晚于终止帧，
 * 早清会让刚切回来的那一瞬间又看不到回复；由服务端结果确认包含后才清。
 */
function mergeBackgroundAssistantMessages(cacheKey: string, base: ChatMessage[]): ChatMessage[] {
  const pending = readBackgroundAssistantMessages(cacheKey);
  if (pending.length === 0) return base;
  const known = new Set(base.map((item) => item.id));
  const extra = pending.filter((item) => !known.has(item.id));
  return extra.length > 0 ? [...base, ...extra] : base;
}

/**
 * 请求期间本地新增的尾部消息（乐观用户气泡 / 刚落库的助手回复）不能被服务端响应抹掉。
 *
 * `messages` 是**原地 push** 的数组，所以「同一个数组对象 + 前缀逐项全等」就说明
 * 后面那几条是请求发出之后才出现的。服务端结果里没有的那些追加回去。
 * 简化版对齐旧版 `ui/src/pages/chat/chat-history.ts:287 preserveOptimisticTailMessages`。
 */
function preserveLocalTailMessages(
  serverMessages: ChatMessage[],
  snapshot: ChatMessage[],
): ChatMessage[] {
  const current = messages.value;
  if (current === snapshot || current.length <= snapshot.length) return serverMessages;
  if (snapshot.some((item, index) => current[index] !== item)) return serverMessages;
  const present = new Set(serverMessages.map((item) => item.id));
  const tail = current.slice(snapshot.length).filter((item) => !present.has(item.id));
  return tail.length > 0 ? [...serverMessages, ...tail] : serverMessages;
}

/** `chat.history` 的响应形状（`loadHistory` / `loadOlderHistory` 共用字段）。 */
type ChatHistoryResponse = {
  messages?: unknown[];
  sessionId?: string;
  hasMore?: boolean;
  nextOffset?: number;
  totalMessages?: number;
};

/**
 * 这条错误是不是「网关不认我传的参数」？
 *
 * `ChatHistoryParamsSchema` 是 `additionalProperties: false`
 * （`packages/gateway-protocol/src/schema/logs-chat.ts:30-39`），校验失败时
 * 网关回 `INVALID_REQUEST: invalid chat.history params: at /…: must NOT have additional properties`。
 */
function isChatHistoryParamsRejected(err: unknown): boolean {
  return (
    err instanceof GatewayRequestError &&
    err.gatewayCode === "INVALID_REQUEST" &&
    /invalid chat\.history params/i.test(err.message)
  );
}

/**
 * 拉历史时的**入参降级**（预发「历史消息不显示」的一条已知成因）。
 *
 * 本文件的请求带了 `offset: 0` 与放大的 `maxChars`（网关默认只给 8000 字符正文，
 * 长回复会被截断并追加 `...(truncated)...`）。但 schema 是
 * `additionalProperties: false` ⇒ **前端产物比网关新**（老网关的 schema 里没有这两个字段）
 * 时整条请求会被判 `INVALID_REQUEST` —— 表现就是「一条历史都不显示」，而且
 * 报错文案只出现在 toast 里，很容易被当成空会话。
 *
 * 命中该错误就退化成最小入参（`sessionKey` + `limit`）再试一次：
 * 代价是拿不到 `hasMore/nextOffset`（翻页在那种网关上本来就不可用）与长正文截断，
 * 但至少**历史能显示出来**。
 */
async function requestChatHistory<T>(params: {
  sessionKey: string;
  limit: number;
  offset: number;
  maxChars: number;
}): Promise<T> {
  try {
    return await gateway.request<T>("chat.history", params);
  } catch (err) {
    if (!isChatHistoryParamsRejected(err)) throw err;
    return await gateway.request<T>("chat.history", {
      sessionKey: params.sessionKey,
      limit: params.limit,
    });
  }
}

async function loadHistory(options?: { skipCache?: boolean }): Promise<void> {
  loading.value = true;
  // 先同步已删集合（本地、便宜），后面缓存命中也要用。
  loadDeletedMessageIds();
  const deleted = deletedMessageIds.value;
  const cacheKey = qualifySessionKey(sessionKey.value, paneAgentId.value) ?? resolvedSessionKey();
  const requestKey = resolvedSessionKey();
  // ⚠️ 请求版本闸 + 会话快照：`chat.history` 是异步的，期间用户完全可能已经切到别的会话
  // （预发等慢环境是必然而不是偶然）。没有这道闸时，旧会话的响应会写进新会话的视图，
  // 紧接着被 `messages` 的深 watch 以**新会话**为键写进缓存 ⇒ 那个会话随后切进去就是
  // 「没有历史 / 内容是别人的」，且缓存命中分支不再回源，只能等 TTL 过期或点刷新。
  const seq = ++historyRequestSeq;
  const isCurrent = () =>
    seq === historyRequestSeq &&
    (qualifySessionKey(sessionKey.value, paneAgentId.value) ?? resolvedSessionKey()) === cacheKey;
  // 缓存命中：先秒回（对齐旧版 session-message-cache），但**不停在这里** —— 继续走一次
  // 服务端回源（stale-while-revalidate）。否则一条空 / 串会话 / 过期的缓存会把该会话锁死在
  // 「没有历史」的样子，而唯一的出口是刷新按钮。旧版这里直接 `return`，是「历史不显示」的放大器。
  // ⚠️ skipCache 时先清缓存，确保用户点刷新时一定拿到服务端最新数据（含服务端附件位）。
  if (options?.skipCache) clearChatMessageCache(cacheKey);
  const cached = getChatMessageCache(cacheKey);
  if (cached) {
    messages.value = mergeBackgroundAssistantMessages(
      cacheKey,
      cached.filter((item) => !deleted.has(item.id)),
    );
    // 恢复分页游标：缓存命中也能继续「加载更早」（直接用上次 offset，免联网探测）
    const cursor = getChatHistoryCursor(cacheKey);
    historyHasMore.value = cursor?.hasMore === true;
    historyNextOffset.value = cursor?.nextOffset;
    await scrollToBottom(true);
    void fetchMissingSpendResults();
    void loadModelList();
  }
  // 回源快照：只认「请求发出之后」新增的尾部消息（见 `preserveLocalTailMessages`）。
  const snapshot = messages.value;
  try {
    const res = await requestChatHistory<ChatHistoryResponse>({
      sessionKey: requestKey,
      limit: 200,
      // ⚠️ 必须**显式**传 offset:0：不传 offset 时网关走 `readChatHistoryPage` 的
      // 「无 offset 分支」，响应里根本没有 hasMore / nextOffset / totalMessages
      // （`src/gateway/server-methods/chat.ts:3044-3070`）。拿不到 hasMore，
      // historyHasMore 恒为 false ⇒「加载更早历史」既不会自动触发、点了也直接 return。
      offset: 0,
      maxChars: CHAT_HISTORY_MAX_CHARS,
    });
    // 迟到的响应（期间切了会话 / 又发起了新请求）：整包丢弃，绝不写进当前视图与缓存。
    if (!isCurrent()) return;
    // 先同步本次请求所属会话的「已删集合」，再据此过滤 —— 删除后刷新才不会再冒出来。
    loadDeletedMessageIds();
    const deletedNow = deletedMessageIds.value;
    const serverMessages = (res?.messages ?? [])
      .map((item, index) => normalizeMessage(item, index))
      .filter(
        (item): item is ChatMessage =>
          // ⚠️ 不能只留 `Boolean(item.text)`：用户「只传附件、一个字都没打」时
          // content 是空串，但消息本身有效（网关 `chat-display-projection.ts:1453-1459`
          // 与旧版 `chat-history.ts:169 isEmptyUserTextOnlyMessage` 都特意用
          // MediaPaths 把它保住）。只看文本会把**整条消息连同附件一起吞掉**，
          // 表现为「刷新后这条消息凭空消失」。
          // 同理：助手只回了一张图 / 一个 TTS 音频时也没有正文，别把图吞了。
          item !== null &&
          (Boolean(item.text) ||
            Boolean(item.historyMedia?.length) ||
            Boolean(item.contentImages?.length) ||
            Boolean(item.contentAttachments?.length)) &&
          !deletedNow.has(item.id),
      );
    // 服务端已经落库的那几条从暂存里清掉；还没落库的留着，下次切回来再合并。
    clearBackgroundAssistantMessages(
      cacheKey,
      new Set(serverMessages.map((item) => item.id)),
    );
    messages.value = mergeBackgroundAssistantMessages(
      cacheKey,
      preserveLocalTailMessages(serverMessages, snapshot),
    );
    // 记录后端给出的分页游标：还有更早则允许「加载更早」继续翻页
    historyHasMore.value = res?.hasMore === true;
    historyNextOffset.value =
      typeof res?.nextOffset === "number" ? res.nextOffset : undefined;
    await scrollToBottom();
    // 写入客户端缓存：切回本会话时秒回，避免重复联网（对齐旧版 session-message-cache）。
    // 同时带上分页游标，切回后仍能继续加载更早历史。
    setChatMessageCache(cacheKey, messages.value, {
      hasMore: res?.hasMore,
      nextOffset: res?.nextOffset,
    });
    await scrollToBottom(true);
    // 异步拉取历史消息的积分（不阻塞内容渲染）
    void fetchMissingSpendResults();
    // 加载完成后从历史补充模型列表
    void loadModelList();
  } catch (err) {
    // 失败一律不落缓存（保持上一次的好数据），且只在仍是当前会话时才打扰用户。
    if (isCurrent()) {
      ElMessage.error(`加载会话历史失败：${err instanceof Error ? err.message : String(err)}`);
    }
  } finally {
    if (isCurrent()) loading.value = false;
  }
}

/**
 * 这一轮的助手回复结束后，把服务端投影出来的**媒体位**补到刚落库的消息上。
 *
 * ## 为什么必须回源（live final 帧天生没有媒体）
 * 网关的 final 帧是这样捏 message 的（见 `src/gateway/server-chat.ts: emitChatTerminal`）：
 * ```ts
 * { role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() }
 * ```
 * 纯文本。**没有 MediaPaths，也没有 content 里的 image/audio 块** —— 那些是
 * `chat.history` 的 display projection（`chat-display-projection.ts`）才附的东西。
 *
 * 所以只有「助手在正文里手写了 `MEDIA:/…mp3`」的轮次客户端才解得出来；文件由工具产出、
 * 正文没写 `MEDIA:` 的轮次，最新消息会**永远没有附件/播放器**，只有 F5 刷新（走
 * `chat.history`）才出现 —— 这正是要修的现象。
 *
 * ## 做法：回源一趟，但只改媒体字段
 * 拉最近几条历史 → `normalizeMessage`（与历史渲染完全同一条口径）→ 找到当前这一轮
 * → **只**把 contentAttachments / contentImages / historyMedia 合并上去，文本、积分、
 * thinking 一概不动，也不重排数组。补不上（跨会话串了 / 请求失败）就静默保持现状。
 */
async function backfillAssistantMedia(target: ChatMessage): Promise<void> {
  if (!needsHistoryMediaBackfill(target)) return; // 已有媒体位（正文写了 MEDIA:）就不打扰
  try {
    const res = await gateway.request<{ messages?: unknown[] }>("chat.history", {
      sessionKey: resolvedSessionKey(),
      limit: 8,
    });
    const candidates = (res?.messages ?? [])
      .map((item, index) => normalizeMessage(item, index))
      .filter((item): item is ChatMessage => item !== null);
    const match = findSameTurnAssistant(candidates, target);
    if (!match) return;
    const index = messages.value.findIndex((item) => item.id === target.id);
    if (index === -1) return;
    const current = messages.value[index];
    if (!current) return;
    messages.value[index] = {
      ...current,
      ...(match.contentAttachments?.length
        ? {
            contentAttachments: dedupeContentAttachments([
              ...(current.contentAttachments ?? []),
              ...match.contentAttachments,
            ]),
          }
        : {}),
      ...(match.contentImages?.length
        ? {
            contentImages: dedupeContentImages([
              ...(current.contentImages ?? []),
              ...match.contentImages,
            ]),
          }
        : {}),
      ...(match.historyMedia?.length ? { historyMedia: match.historyMedia } : {}),
    };
    await scrollToBottom();
  } catch {
    // 静默：补不上就维持「和以前一样」，绝不能因为兜底流程打断主对话。
  }
}

/**
 * 收集尚未拿到 spendResult 的历史消息 completionId，调用 gateway 的
 * `chat.spend.getBatch` 批量补全。失败/单条 null 不影响其他消息。
 * 期间为涉及的消息设置 `spendLoading = true`，UI 会展示「积分计算中」；
 * 请求结束后（成功或失败）清掉该标志。
 */
async function fetchMissingSpendResults(): Promise<void> {
  const pending = messages.value.filter((m) => !m.spendResult && m.completionId);
  if (pending.length === 0) return;
  const ids = pending.map((m) => m.completionId as string);
  for (const msg of pending) {
    msg.spendLoading = true;
  }
  try {
    const res = await gateway.request<{
      results?: Record<string, { spend: number | null; balance: number | null }>;
    }>("chat.spend.getBatch", { responseIds: ids });
    const results = res?.results ?? {};
    for (const msg of pending) {
      const r = msg.completionId ? results[msg.completionId] : undefined;
      if (r && typeof r.spend === "number" && typeof r.balance === "number") {
        msg.spendResult = { spend: r.spend, balance: r.balance };
      }
      msg.spendLoading = false;
    }
  } catch {
    // 静默失败：清掉 loading 标志，不弹错误提示，避免影响主聊天流
    for (const msg of pending) {
      msg.spendLoading = false;
    }
  }
}

/** 本轮生成内被引导的次数（流式气泡顶部「已引导 N 次」徽标用）。
 *  同样挂在运行态桶上，避免拆分视图重建窗格时徽标被清零。 */
const steerCount = computed<number>({
  get: () => runState.value.steerCount,
  set: (next) => {
    runState.value.steerCount = next;
  },
});

/**
 * 已提交网关「引导」、但所属那一轮还没开始产出的用户消息。
 *
 * ⚠️ 这些消息**必须渲染在流式助手气泡的下方**（模板里紧跟 streaming row 之后）。
 * 一旦 push 进 `messages`，模板顺序就是「消息在上、思考中气泡在下」——
 * 用户看到的就是「引导发送的消息显示到了思考中的上面」。
 * 等被引导那一轮真正开始产出（首个 thinking / delta 帧）才 promote 进 `messages`，
 * 那时它排在气泡上方才是正确的历史顺序（用户消息 → 助手回复）。
 */
const steeredMessages = ref<ChatMessage[]>([]);

/**
 * 旧 run 是否已经终止、接下来的产出属于「被引导的那一轮」。
 *
 * 依据实测（2026-09-11，`sessions.steer`）：网关收到 steer 后**先 `chat.abort` 当前 run**
 * （前端收到 `chat state=aborted`，ack 带 `interruptedActiveRun: true`），随后才跑被引导的消息。
 * 只有越过这个边界之后到达的产出，才允许把引导消息并入历史 —— 否则旧 run 的迟到帧
 * 会把引导消息提前顶到气泡上方。
 */
const awaitingSteeredRun = ref(false);

/** 把排在最前的一条引导消息并入历史（它所属的那一轮已经开始产出 / 已经终止）。 */
function promoteNextSteeredMessage(): void {
  const next = steeredMessages.value.shift();
  if (next) messages.value.push(next);
}

/** 被引导的那一轮开始产出：引导消息并入历史，让这一轮的气泡排到它下面。 */
function markSteeredRunProducing(): void {
  if (!awaitingSteeredRun.value || steeredMessages.value.length === 0) return;
  promoteNextSteeredMessage();
  awaitingSteeredRun.value = false;
  void scrollToBottom();
}

/**
 * 「发送 / 引导」失败时的统一提示。
 *
 * ⚠️ **别退回** `ElMessage.error(\`发送失败：${err.message}\`)`：RPC 被拒时 `err.message` 是网关的
 * **英文原文**（例：`Agent "cet4" no longer exists in configuration`），而 `localizeChatError`
 * 才是全站唯一的中文文案来源 —— `chat` 事件的 `state: "error"` 路径已经在用它（见 `handleEvent`）。
 * 两条路径共用同一个函数，才不会出现「同一条错误在事件路径显示中文、在发送路径显示英文」。
 *
 * `retryable` 复用 `state: "error"` 那套语义，只用来决定 toast 停留时长（中文两行，3s 偏短）。
 */
function notifyActionFailure(action: string, err: unknown): void {
  const raw = err instanceof Error ? err.message : String(err);
  const friendly = localizeChatError(raw);
  ElMessage({
    message: friendly.detail
      ? `${action}：${friendly.title}\n${friendly.detail}`
      : `${action}：${friendly.title}`,
    type: "error",
    duration: friendly.retryable ? 4500 : 6500,
    grouping: true,
  });
}

async function send(textOverride?: string): Promise<boolean> {
  const text = (textOverride ?? input.value).trim();
  if (sending.value) return false;

  // 附件只在「非流式发送」这条路径上带出去（流式阶段回车走的是待执行队列，
  // 队列项只带文本 —— 见 onAttachDrop 附近的说明，以及下方 canAttach 的用途）。
  const outgoing = textOverride === undefined && attachments.value.length > 0 ? attachments.value : [];
  const apiAttachments = buildApiAttachments(outgoing);
  // 旧版同样允许「只有附件、没有文字」的发送。
  if (!text && !apiAttachments) return false;

  const localMessageId = `local-${Date.now()}`;
  messages.value.push({
    id: localMessageId,
    role: "user",
    text,
    ts: Date.now(),
    ...(outgoing.length > 0 ? { attachments: outgoing.map((item) => ({ ...item })) } : {}),
  });
  if (textOverride === undefined) input.value = "";
  sending.value = true;
  streamingText.value = "";
  streamingThinking.value = "";
  streamingSpend.value = null;
  // 新一轮开始：清掉上一轮可能残留的「积分计算中」（正常路径下 final 已经清过，
  // 但「final 缺失 + 引导排队」这类异常收尾可能没走到）
  spendPending.value = false;
  steerCount.value = 0;
  steeredMessages.value = [];
  awaitingSteeredRun.value = false;
  await scrollToBottom();

  // 附带模型选择：始终传 modelProvider/model（空串代表「使用默认模型」，
  // 让后端有机会清空 session 上的 providerOverride/modelOverride 并回到 agent 默认）。
  const modelParts = selectedModelParts.value;
  const modelProvider = modelParts?.provider ?? "";
  const modelId = modelParts?.model ?? "";

  try {
    await gateway.request("chat.send", {
      sessionKey: resolvedSessionKey(),
      message: text,
      deliver: false,
      idempotencyKey: `run-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      modelProvider,
      model: modelId,
      // 附件（base64）随消息一起提交；无附件时**不带该字段**，避免网关把空数组当异常入参。
      // 网关入参形状见 src/gateway/server-methods/attachment-normalize.ts。
      ...(apiAttachments ? { attachments: apiAttachments } : {}),
    });
    if (outgoing.length > 0) {
      // 发送成功才清空 composer，并丢掉 base64（保留 objectURL，让刚发出的这条
      // 用户气泡继续显示缩略图）。失败时附件留在 composer，方便直接重试。
      attachments.value = [];
      discardChatAttachmentDataUrls(outgoing);
    }
    return true;
  } catch (err) {
    sending.value = false;
    streamingText.value = "";
    streamingThinking.value = "";
    // ⚠️ 请求发出**之前**已经清空了输入框、并乐观推了一条本地用户气泡（见函数前半段）。
    // 失败时这两件事都必须还原，否则会出现：
    //   ① 聊天记录里躺着一条「看起来发过了、其实从没发出去」的消息（UI 在说谎）；
    //   ② 用户刚打的字没了 —— 于是「重试」根本无从谈起。
    // 这与本文件 `steer()` 的失败处理是同一套约定（它已经会剔除 steeredMessage）。
    // 输入框只在仍为空时回填：等待期间用户又打了新内容的话，别覆盖掉。
    if (textOverride === undefined && !input.value) input.value = text;
    messages.value = messages.value.filter((message) => message.id !== localMessageId);
    notifyActionFailure("发送失败", err);
    return false;
  }
}

/**
 * 「引导」发送：把任务交给网关接管当前会话（换方向），**不打断整个回合**。
 *
 * ⚠️ 必须用 `sessions.steer`，不要用 `sessions.send`（2026-09-11 实测对比）：
 * - `sessions.steer`：网关先 `chat.abort` 当前 run 并等它真正结束，再跑这条消息，
 *   ack 带 `interruptedActiveRun: true`。事件序列确定：`chat aborted` → 新 run 的
 *   thinking/delta → `chat final`。
 * - `sessions.send`：**不 abort 就抢占 session**，触发 `EmbeddedAttemptSessionTakeoverError`，
 *   当前 run 被一个空 `final` 草草结束、新消息报「当前会话正在处理中，请稍后。」（消息根本没跑）。
 *
 * 前端要做的只是「别把被打断当成结束」：引导消息先落到气泡下方的 steeredMessages，
 * 旧 run 终止时保持气泡继续「思考中」，等被引导那一轮开始产出再把它并入历史。
 */
async function steer(textOverride?: string): Promise<void> {
  const text = (textOverride ?? input.value).trim();
  if (!text || !sending.value) return;

  const steeredMessage: ChatMessage = {
    id: `steer-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    role: "user",
    text,
    ts: Date.now(),
  };
  // 先落本地再发请求：网关的 abort 帧可能先于 ack 到达，那时必须已经在等引导轮接管了。
  steeredMessages.value.push(steeredMessage);
  if (textOverride === undefined) input.value = "";
  steerCount.value += 1;
  // 新的一次引导会重新打断当前 run，边界需要重置
  awaitingSteeredRun.value = false;
  await scrollToBottom();

  try {
    await gateway.request("sessions.steer", {
      key: resolvedSessionKey(),
      message: text,
      idempotencyKey: `follow-up-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    });
  } catch (err) {
    steeredMessages.value = steeredMessages.value.filter(
      (message) => message.id !== steeredMessage.id,
    );
    steerCount.value = Math.max(0, steerCount.value - 1);
    // 与 `send()` 同一约定：输入框是在请求前清掉的，失败要还回去（仍为空时才回填）。
    if (textOverride === undefined && !input.value) input.value = text;
    notifyActionFailure("引导失败", err);
    throw err;
  }
}

async function steerPendingTask(item: PendingTask): Promise<void> {
  try {
    await steer(item.text);
    removePendingTask(item.id);
  } catch (err) {
    // 保留待执行任务并标记失败，允许用户重试或手动删除（对齐旧版 chat-queue 的失败态）。
    markPendingTaskFailed(item.id, err instanceof Error ? err.message : String(err));
  }
}

/** 非流式发送；流式阶段先加入待执行列表。 */
async function submitComposer(): Promise<void> {
  // 积分不足校验：剩余积分 <= 0 时禁止发送（按钮已禁用，这里兜底 Enter 路径）
  if (!sending.value && insufficientCredits.value) return;
  if (sending.value) {
    enqueuePendingTask();
  } else {
    await send();
  }
}

async function abort(): Promise<void> {
  try {
    await gateway.request("chat.abort", { sessionKey: resolvedSessionKey() });
  } catch {
    /* 中断失败不阻塞界面 */
  } finally {
    finalizeStreaming();
  }
}

/**
 * 导出本窗格整段对话为 Markdown 文件。
 *
 * 与「复制为 Markdown」按钮的差别：复制只取**单条**消息的正文，导出则是
 * **整段对话**的结构化 Markdown（会话标题 + 逐条角色 + 时间戳），见
 * `utils/exportChat.ts`。二者不能互相替代 —— 复制服务于「把某条回复粘走」，
 * 导出服务于「存档/分享整场对话」。
 */
function exportConversation(): void {
  const ok = exportChatMarkdown(
    messages.value,
    assistantName.value,
    settings.gatewayHttpBase,
    settings.token,
  );
  if (!ok) {
    ElMessage({ message: "当前没有可导出的消息", type: "warning", grouping: true });
    return;
  }
  ElMessage({ message: "对话已导出为 Markdown", type: "success", grouping: true });
}

/**
 * 把当前流式的正文 / 思考落地成一条助手消息（**不动 sending**）。
 *
 * 单独抽出来是给「引导打断」用：那条路径要保留气泡（继续显示思考中），
 * 但已经产出的内容必须落到历史里，不能因为换方向而丢掉。
 */
function commitStreamingMessage(): void {
  // 用落地时刻实际生效的模型回填，保证积分行能显示「生成模型」——
  // 即使服务端 final 帧没带 provider/model，本地客户端也能补上。
  // 注意用 effectiveModelParts（显式选择 ?? 网关默认），否则「使用默认模型」时会是空白。
  const parts = effectiveModelParts.value;
  const text = streamingText.value;
  const thinking = streamingThinking.value || undefined;
  if (!text.trim() && !thinking?.trim()) return;
  // ⚠️ 必须过 `normalizeMessage`，不能手搓对象：
  // 助手把 mp3 / pdf 交给用户靠的是正文里的 `MEDIA:<路径>` 行，而那一行**只有**
  // normalize 才会被剥出来变成 `contentAttachments`（界面上的下载卡片 / `<audio>` 播放器）。
  // 手搓对象既没有附件位、正文里又会留着 `MEDIA:/…mp3` 这行脏文本 —— 表现为
  // 「下载按钮刷新页面之后才出现」（刷新走 loadHistory，那条路是 normalize 过的）。
  const normalized = normalizeMessage(
    {
      role: "assistant",
      content: text,
      ...(thinking ? { thinking } : {}),
      timestamp: Date.now(),
      ...(parts?.provider ? { provider: parts.provider } : {}),
      ...(parts?.model ? { model: parts.model } : {}),
      ...(streamingSpend.value ? { spendResult: streamingSpend.value } : {}),
    },
    messages.value.length,
  );
  if (normalized) {
    messages.value.push({
      ...normalized,
      provider: parts?.provider ?? normalized.provider,
      model: parts?.model ?? normalized.model,
      text: resolveCommittedText(normalized, text),
      thinking: normalized.thinking || thinking,
      spendResult: normalized.spendResult ?? streamingSpend.value ?? undefined,
    });
  } else {
    messages.value.push({
      id: `assistant-${Date.now()}`,
      role: "assistant",
      text,
      thinking,
      ts: Date.now(),
      provider: parts?.provider,
      model: parts?.model,
      spendResult: streamingSpend.value ?? undefined,
    });
  }
  // 新增的 assistant 消息可能携带 model/provider，重新聚合模型列表
  void loadModelList();
}

/**
 * 「引导」把当前 run 打断后的收尾：内容落地 + 气泡保持「思考中」。
 *
 * 不能走 finalizeStreaming()：那会把 sending 置 false，整块流式气泡消失，
 * 用户看到的就是「引导之后思考被中断了」。这里刻意保留 sending=true，
 * 让被打断的这一刻无缝转成「思考中」，等被引导那一轮接管同一个气泡。
 */
function holdStreamingBubbleForSteer(): void {
  commitStreamingMessage();
  streamingText.value = "";
  streamingThinking.value = "";
  streamingSpend.value = null;
  // 被打断的旧 run 的积分不会再有 final 帧带回来（积分随 aborted 帧一起丢），
  // 所以不能把「积分计算中」挂在气泡上等 —— 气泡马上要转回「思考中」接新一轮。
  spendPending.value = false;
  sending.value = true;
  awaitingSteeredRun.value = true;
  void scrollToBottom();
}

function finalizeStreaming(skipCommit = false): void {
  if (!skipCommit) commitStreamingMessage();
  streamingText.value = "";
  streamingThinking.value = "";
  streamingSpend.value = null;
  spendPending.value = false;
  sending.value = false;
  // 路由切换 / 用户手动 abort / chat 事件自然结束 —— 全部清零 steerCount
  steerCount.value = 0;
  awaitingSteeredRun.value = false;
  // 没来得及开跑的引导消息并入历史，避免它们从列表里凭空消失
  while (steeredMessages.value.length > 0) promoteNextSteeredMessage();
  void scrollToBottom();
}

function toggleThinking(id: string): void {
  if (expandedThinkingIds.value.has(id)) {
    expandedThinkingIds.value.delete(id);
  } else {
    expandedThinkingIds.value.add(id);
  }
  // 触发响应式
  expandedThinkingIds.value = new Set(expandedThinkingIds.value);
}

/**
 * 是否属于「思考流」的 agent 事件（上游 openclaw-v2026.7.1-2/src/gateway/server-chat.ts:1133）。
 *
 * 历史背景：早期实现只订阅 `event === "chat"`，把 `payload.channel === "thinking"`
 * 当作思考通道；实测后端 `chat` 事件从来不会带 `channel` 字段（delta/final 都只有
 * `deltaText` + `message.content: [{type:"text",text}]`），导致 `streamingThinking`
 * 永远是空、UI 走 `isThinking` 三 dot 兜底。
 *
 * 真实通道：网关在 `server-chat.ts:1071 sendAgentPayload` 把上游 `stream: "thinking"`
 * 的 agent 事件以 `event: "agent"` 广播给 control-ui；前端必须订阅这个事件流才能
 * 看到思考过程。
 */
function isThinkingAgentEvent(
  evt: { event: string; payload?: unknown },
): evt is { event: "agent"; payload: AgentThinkingEventPayload } {
  if (evt.event !== "agent") return false;
  const payload = evt.payload as AgentThinkingEventPayload | null | undefined;
  if (!payload || typeof payload !== "object") return false;
  return payload.stream === "thinking";
}

/**
 * 「别的会话」的 chat 帧：视图不动，但这一次 run 必须收干净。
 *
 * 场景：会话 A 正在生成 → 用户点侧栏切到 B。此后 A 的所有帧都过不了
 * `isEventForCurrentSession`。**如果连终止帧一起丢掉**：
 * ① A 的助手回复谁都没接（内存里没有，消息缓存也停在切换前那一刻）⇒ 切回 A 看不到回复
 *    （60s 内命中缓存时连回源都不发，这才是「历史消息不显示」的现场）；
 * ② A 的运行态桶（`utils/chatRunState`）里 `sending` 永远是 true —— 只有
 *    `finalizeStreaming()` 会清它，而它在别的会话里永远不会被调到 ⇒ 输入框卡在
 *    「正在生成」、回车只会进待执行队列，整个会话看起来被中断，只有刷新页面能救。
 *
 * 对齐旧版 `ui/src/pages/chat/chat-gateway.ts:156-177`：非当前会话的 `final`
 * 写进该会话的暂存（`noteBackgroundAssistantMessage`，`loadHistory` 时按 id 去重合并），
 * 并顺手把该会话的运行态归零。
 *
 * ⚠️ 这**不会**让服务端 run 继续跑或停下来 —— 服务端压根没收到任何请求
 * （web 只在点「停止」时发 `chat.abort`）。这里只是「把已经在路上的结果留住」。
 * ⚠️ `aborted` **刻意不处理**：引导（`sessions.steer`）会先中断当前 run，那个瞬间
 * 同一会话的另一个窗格正靠 `sending` 撑着「思考中」气泡；在别的窗格里把它归零会让
 * 那一轮后续的 delta 被 `if (!sending.value) return` 丢掉。被引导的那一轮结束时
 * 会走 `final`，同样能收干净。
 */
function handleBackgroundSessionChatEvent(payload: ChatEventPayload): void {
  if (payload.state !== "final" && payload.state !== "error") return;
  const agentId = agents.agentIdForSession(payload.sessionKey);
  if (payload.state === "final") {
    // 只暂存 `final`：`aborted` / `error` 的正文可能与已落库的历史重复，
    // 而它们缺 `responseId` 时稳定 id 会按时间戳派生，去重对不上号就会多一条。
    const message = normalizeMessage(payload.message, 0);
    if (message && hasVisibleMessageContent(message)) {
      const key = qualifySessionKey(payload.sessionKey, agentId) || payload.sessionKey;
      noteBackgroundAssistantMessage(key, message);
    }
  }
  resetChatRunStateForSession(payload.sessionKey, agentId);
}

function handleEvent(evt: { event: string; payload?: unknown }): void {
  // 「本轮生成已结束」：网关广播这个信号时，带 `spendResult` 的 `chat state=final`
  // 还在等积分轮询（实测 ~6.8s），所以这里是**唯一**能显示「积分计算中」的时刻
  // ——见 `utils/agentLifecycle.ts` 的时序图。必须在下面的 `evt.event !== "chat"`
  // 兜底之前处理。
  if (isReplyFinishedAgentEvent(evt)) {
    const payload = evt.payload;
    // 会话隔离：别的会话的收尾信号不能点亮本窗格的加载态。
    if (!isEventForCurrentSession(payload.sessionKey)) return;
    // 只在发送中标记。`sending=false` 时说明本轮早已收尾（例如 WS 乱序把 final
    // 排在 lifecycle 之前），此时气泡已经没了，标记只会变成幽灵加载态。
    if (!sending.value) return;
    spendPending.value = true;
    return;
  }

  // 思考流：先于 chat 事件处理，让 `streamingThinking` 在 chat delta 之前就累积好，
  // 避免「先看到正文、再补上思考」造成的拼接感。
  if (isThinkingAgentEvent(evt)) {
    const payload = evt.payload;
    // 会话隔离：切到别的会话后，旧会话的思考增量不应再落进当前视图。
    if (!isEventForCurrentSession(payload.sessionKey)) return;
    // 仅在发送中累积。idle / 已完成 / 已 abort 的迟到帧直接丢弃。
    // 注意：引导打断旧 run 时会刻意保持 sending=true，所以被引导那一轮的思考能接上同一个气泡。
    if (!sending.value) return;
    const data = payload.data ?? {};
    markSteeredRunProducing();
    // 优先用 delta —— 上游 `shouldAdvanceAgentTextThrottle` 用 `data.delta` 标记真正增量。
    // text 是「到本 chunk 为止的整段文本」，用作 delta 的兜底，但只在 delta 缺失时取一次。
    let delta = "";
    if (typeof data.delta === "string" && data.delta.length > 0) {
      delta = data.delta;
    } else if (typeof data.text === "string" && data.text.length > 0) {
      // 没有 delta 时，按 text 整体替换（避免重复累加；上游没给 delta 就认整段）
      streamingThinking.value = data.text;
      void scrollToBottom();
      return;
    }
    if (!delta) return;
    streamingThinking.value = data.replace === true ? delta : streamingThinking.value + delta;
    void scrollToBottom();
    return;
  }

  if (evt.event !== "chat") return;
  const payload = evt.payload as ChatEventPayload | undefined;
  if (!payload) return;

  // 会话隔离：切到别的会话后，旧会话的流式帧不应再落进当前视图。
  // 但**终止帧不能直接丢** —— 见 `handleBackgroundSessionChatEvent`。
  if (!isEventForCurrentSession(payload.sessionKey)) {
    handleBackgroundSessionChatEvent(payload);
    return;
  }

  switch (payload.state) {
    case "delta": {
      const delta = payload.deltaText ?? "";
      // 被引导那一轮开始产出正文 —— 引导消息并入历史，气泡继续排在它下面
      if (delta) markSteeredRunProducing();
      if (payload.channel === "thinking") {
        streamingThinking.value = payload.replace ? delta : streamingThinking.value + delta;
      } else {
        streamingText.value = payload.replace ? delta : streamingText.value + delta;
      }
      void scrollToBottom();
      break;
    }
    case "final": {
      const normalized = normalizeMessage(payload.message, messages.value.length);
      // 当服务端 final 帧未带 provider/model（很多代理实现就是这样），
      // 用本地实际生效的模型回填，确保积分行的「生成模型」始终可见。
      const fallbackParts = effectiveModelParts.value;
      // final 帧可能没带 message（异常兜底路径），但前端已经累积了流式正文 / 思考。
      // 这种情况下走「落地流式内容」分支，避免用户看到「思考中」永远不消失。
      const streamedText = streamingText.value;
      const streamedThinking = streamingThinking.value;
      const hasStreamedContent =
        streamedText.trim().length > 0 || streamedThinking.trim().length > 0;
      // ⚠️ 判定必须包含媒体（见 `utils/messageCommit.ts` 文件头）：
      // 只回一个 mp3 / 一张图时，正文里的 `MEDIA:` 行被 normalize 剥走后 `text` 是空串，
      // 只判 `text || thinking` 会让这类回复掉进下面的兜底分支，生成一条没有附件位的
      // 手搓消息 —— 用户就得刷新页面才能看到下载按钮 / `<audio>` 播放器。
      if (hasVisibleMessageContent(normalized)) {
        // 如果 final 携带 spendResult，合并到本次推送
        if (normalized.spendResult) streamingSpend.value = normalized.spendResult;
        // 已在本机删掉的回复不再回填，避免重发 / 重连时把删掉的内容塞回来
        if (!deletedMessageIds.value.has(normalized.id)) {
          // 这条 final 属于被引导的那一轮：先把引导消息并入历史，再落助手回复，
          // 历史顺序才是「用户消息 → 助手回复」。旧 run 的 final 不会走这里
          // （它被打断时收到的是 aborted / 空 final）。
          if (awaitingSteeredRun.value && steeredMessages.value.length > 0) {
            promoteNextSteeredMessage();
            awaitingSteeredRun.value = false;
          }
          // final 帧的文本是服务端投影过的，偶尔会丢掉正文里的 `MEDIA:` 行，
          // 而本地流式正文里还留着 —— 用它把附件位补回来；否则首次返回没有
          // 下载入口，只有刷新（走 chat.history，那份正文带 `MEDIA:` 行）才出现。
          const streamedMedia = splitMediaMarkers(streamedText).media;
          const adoptStreamed = shouldAdoptStreamedMedia(normalized, streamedMedia.length);
          const streamedAttachments = adoptStreamed
            ? streamedMedia
                .map(inferMediaAttachment)
                .filter((att) => att.kind !== "image")
                .map((att) => ({
                  kind: (att.kind === "audio"
                    ? "audio"
                    : att.kind === "video"
                      ? "video"
                      : "document") as "audio" | "video" | "document",
                  url: att.url,
                  label: att.label,
                  ...(att.mimeType ? { mimeType: att.mimeType } : {}),
                }))
            : [];
          const streamedImages = adoptStreamed
            ? streamedMedia
                .map(inferMediaAttachment)
                .filter((att) => att.kind === "image")
                .map((att) => ({ url: att.url }))
            : [];
          const committed = adoptStreamed
            ? {
                ...normalized,
                contentAttachments: dedupeContentAttachments([
                  ...(normalized.contentAttachments ?? []),
                  ...streamedAttachments,
                ]),
                contentImages: dedupeContentImages([
                  ...(normalized.contentImages ?? []),
                  ...streamedImages,
                ]),
                // 正文里若还残留 `MEDIA:` 原文，在这里剥掉，保证「卡片 + 干净正文」
                // 与刷新后的历史消息表现一致。
                text: splitMediaMarkers(normalized.text).text,
              }
            : normalized;
          const pushed: ChatMessage = {
            ...committed,
            provider: normalized.provider ?? fallbackParts?.provider,
            model: normalized.model ?? fallbackParts?.model,
            // 不能再写 `normalized.text || streamedText`：纯媒体回复的 streamedText
            // 里是被剥走之前的那行 `MEDIA:/…mp3`，回落它等于把脏文本又贴回正文。
            text: resolveCommittedText(normalized, streamedText),
            thinking: normalized.thinking || streamedThinking || undefined,
            spendResult: normalized.spendResult ?? streamingSpend.value ?? undefined,
          };
          messages.value.push(pushed);
          // final 推送可能带 model/provider，刷新选择器
          void loadModelList();
          // live final 帧天生不带媒体字段 —— 这一轮的附件/播放器只能回源补齐（见
          // `backfillAssistantMedia` 注释）。只在本条一个媒体位都没有时才发请求。
          void backfillAssistantMedia(pushed);
        }
      } else if (hasStreamedContent) {
        // final 帧无效（缺 message），但前端已经流到了文本 / 思考 —— 必须把已产出
        // 的内容落进历史再清空流式态，否则用户视角就是「思考中」永远卡住。
        if (awaitingSteeredRun.value && steeredMessages.value.length > 0) {
          promoteNextSteeredMessage();
          awaitingSteeredRun.value = false;
        }
        commitStreamingMessage();
        // 落库后必须走 finalizeStreaming 清掉 sending/streaming 态；传入 skipCommit=true
        // 避免 commitStreamingMessage 被二次调用导致重复消息。
        finalizeStreaming(true);
        scheduleNextPendingTask();
        break;
      } else {
        // 真·空 final = 网关用终止帧收掉被打断的 run
        if (steeredMessages.value.length === 0) {
          finalizeStreaming();
          return;
        }
        // 还有引导在排队：不能收掉气泡（用户视角就是「思考被中断」），
        // 落地已产出的部分，气泡原地转回「思考中」，等被引导那一轮接管。
        holdStreamingBubbleForSteer();
        return;
      }
      streamingText.value = "";
      streamingThinking.value = "";
      streamingSpend.value = null;
      // 积分已经随 final 帧落到消息上了（`pushed.spendResult`）——加载态到此结束，
      // 数值由消息自己的 `.content-credits` 渲染。final 没带数值时一并结束，
      // 不做无谓的二次查询（见 `utils/agentLifecycle.ts` 的口径说明）。
      spendPending.value = false;
      if (steeredMessages.value.length > 0) {
        // 未完成的引导还在排队：保持「进行中 = 思考中」，别让气泡消失
        sending.value = true;
        awaitingSteeredRun.value = true;
      } else {
        sending.value = false;
        steerCount.value = 0;
        awaitingSteeredRun.value = false;
      }
      void scrollToBottom();
      scheduleNextPendingTask();
      break;
    }
    case "aborted": {
      // 引导提交时网关会先中断当前 run（sessions.steer 的 interruptedActiveRun）。
      // 这不是「用户停止」，而是「换方向」：内容落地 + 气泡保持「思考中」。
      if (steeredMessages.value.length > 0) {
        holdStreamingBubbleForSteer();
        break;
      }
      finalizeStreaming();
      break;
    }
    case "error": {
      // 有引导排队时，错误基本来自被引导的那一轮（旧 run 被打断走的是 aborted）：
      // 先把它并入历史，避免它一直挂在气泡下面不再有产出。
      while (steeredMessages.value.length > 0) promoteNextSteeredMessage();
      awaitingSteeredRun.value = false;
      streamingText.value = "";
      streamingThinking.value = "";
      streamingSpend.value = null;
      spendPending.value = false;
      sending.value = false;
      const friendly = localizeChatError(payload.errorMessage ?? "");
      ElMessage({
        message: formatFriendlyError(friendly),
        type: "error",
        // 5s 让 retryable=false 的（鉴权失败 / 余额不足 / 锁竞争）也来得及看清；
        // ElMessage 默认 3000ms 对中文两行来说偏短。
        duration: friendly.retryable ? 4500 : 6500,
        grouping: true,
      });
      break;
    }
  }
}

let unsubscribe: (() => void) | null = null;

onMounted(() => {
  unsubscribe = gateway.onEvent(handleEvent);
  void agents.ensureLoaded();
  // 刷新后恢复本会话未提交的引导队列（入队 / 移除时已写盘）
  hydratePendingTasks(pendingTasksKey());
  void loadHistory();
  void loadDefaultModel();
  // 模型目录先就绪，上下文窗口才有第三层兜底
  void loadModelList().then(() => loadContextWindow());
});

onBeforeUnmount(() => {
  unsubscribe?.();
  closeDeleteConfirm();
  for (const timer of copyTimers.values()) window.clearTimeout(timer);
  copyTimers.clear();
  // 关窗格（拆分视图下很常见）时必须回收附件 objectURL，否则反复拆分/关闭会一路泄漏。
  releaseChatAttachmentPayloads(attachments.value);
  for (const message of messages.value) {
    if (message.attachments?.length) releaseChatAttachmentPayloads(message.attachments);
  }
});

/**
 * 会话切换（侧栏点头像 / 本窗格头部下拉 / 布局层换会话）：重置流式态并重新拉历史。
 *
 * 组件实例在会话变化时**不会被重建**（Vue 复用同一实例），必须显式监听，
 * 否则切了会话内容还是上一个会话的。
 *
 * 旧的 `watch([route.query.session, settings.sessionKey])` 已下沉到布局层：
 * 窗格只认 `sessionKey` prop，拆分视图下 N 个窗格各监听自己的 prop，互不干扰。
 */
watch(
  () => sessionKey.value,
  (next, previous) => {
    if (!next || next === previous) return;
    // 切走的那个会话的附件 payload 必须释放：objectURL 不释放会一路泄漏，
    // 而且下次切回来时预览会指到旧 blob。
    releaseChatAttachmentPayloads(attachments.value);
    attachments.value = [];
    messages.value = [];
    // 切换会话：重置历史分页游标，避免把上一个会话的翻页进度带到新会话
    historyHasMore.value = false;
    historyNextOffset.value = undefined;
    loadingOlderHistory.value = false;
    // ⚠️ 运行态现在按会话放在组件外：切到的这个会话**正有一轮在跑**时不能清，
    // 否则会把「另一个窗格里正在进行的同一个会话的任务」一起打断。
    // 此时直接接管它的运行态（同一个 run，换个窗格接着显示）。
    if (!runState.value.sending) {
      streamingText.value = "";
      streamingThinking.value = "";
      streamingSpend.value = null;
      spendPending.value = false;
      sending.value = false;
      steerCount.value = 0;
    }
    steeredMessages.value = [];
    awaitingSteeredRun.value = false;
    // 队列按会话持久化：切回来要恢复该会话待执行的任务，而不是清空
    hydratePendingTasks(pendingTasksKey());
    expandedThinkingIds.value = new Set();
    void loadHistory();
    // 上下文窗口可能随会话变化（每个会话有自己的 contextTokens）
    void loadContextWindow();
    // 换会话可能连带换 agent（窗格头下拉按组选别的 agent 时就是这条路）
    // → 该 agent 的默认模型要跟着重取
    void loadDefaultModel();
  },
);

async function consumeNextPendingTask(): Promise<void> {
  if (sending.value || pendingTasks.value.length === 0) return;
  const next = pendingTasks.value[0];
  if (await send(next.text)) removePendingTask(next.id);
}

function scheduleNextPendingTask(): void {
  if (pendingTasks.value.length === 0) return;
  void consumeNextPendingTask();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    // 流式阶段回车加入待执行列表，非流式直接发送。
    void submitComposer();
  }
}

function useSuggestion(text: string): void {
  input.value = text;
  inputRef.value?.focus();
}

function formatCredits(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  if (value >= 10000) return `${(value / 1000).toFixed(1)}`;
  return value.toLocaleString("zh-CN");
}

/**
 * 剩余积分展示：服务端可能返回负数（透支）——按需求负数与 0 统一显示 0。
 * 只用于展示层，`latestBalance` / `insufficientCredits` 判定仍用原始值。
 */
function formatBalance(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return formatCredits(Math.max(0, value));
}
</script>

<template>
  <!-- 窗格根节点：整块对话区（头部 + 消息流 + 输入框）。
       拖拽文件到任意位置都能挂附件（与旧版 chat-pane 的 drag 行为一致）。 -->
  <div
    ref="paneRoot"
    class="chat-pane"
    :data-pane-id="paneId"
    :class="{ 'chat-pane--active': active && chrome === 'pane' }"
    @pointerdown.capture="emit('focusPane', paneId)"
    @click.capture="onPaneDownloadClick"
    @dragover="onAttachDragOver"
    @drop="onAttachDrop"
  >
    <!-- 窗格头：只在拆分视图下渲染（`chrome === 'pane'`）。
         旧版 chat-pane.ts:renderPaneHeader —— 会话下拉 + 向下拆分 + 向右拆分 + 关闭。 -->
    <div
      v-if="chrome === 'pane'"
      class="chat-pane__header"
      draggable="true"
      @dragstart="onPaneDragStart"
      @dragend="onPaneDragEnd"
    >
      <label class="chat-pane__session-label">
        <span class="sr-only">窗格会话</span>
        <el-select
          class="chat-pane__session-select"
          :model-value="sessionKey"
          :data-session-key="sessionKey"
          aria-label="窗格会话"
          popper-class="chat-pane__session-select-popper"
          @change="onPaneSessionSelect"
        >
          <el-option-group
            v-for="group in paneSessionGroups"
            :key="group.agentId"
            :label="group.label"
          >
            <el-option
              v-for="option in group.options"
              :key="option.key"
              :label="option.label"
              :value="option.key"
            />
          </el-option-group>
        </el-select>
      </label>
      <div class="chat-pane__actions">
        <!-- 两个拆分按钮只在 `allowPaneSplit` 时渲染（窄屏 / 单窗格不渲染，
             理由见 props 里 `allowPaneSplit` 的说明）。「关闭窗格」**始终保留**：
             窄屏下它是关掉多余窗格、回到单窗格的唯一入口（对齐 ui
             `chat-page.ts:374-375` 的「keep session switching and close available」）。 -->
        <template v-if="allowPaneSplit">
          <el-tooltip content="向下拆分" placement="bottom">
            <el-button
              text
              class="chat-pane__action"
              aria-label="向下拆分"
              @click="emit('splitDown', paneId)"
            >
              <ChatIcon name="panelBottomOpen" />
            </el-button>
          </el-tooltip>
          <el-tooltip content="向右拆分" placement="bottom">
            <el-button
              text
              class="chat-pane__action"
              aria-label="向右拆分"
              @click="emit('splitRight', paneId)"
            >
              <ChatIcon name="panelRightOpen" />
            </el-button>
          </el-tooltip>
        </template>
        <el-tooltip content="关闭窗格" placement="bottom">
          <el-button
            text
            class="chat-pane__action"
            aria-label="关闭窗格"
            @click="emit('closePane', paneId)"
          >
            <ChatIcon name="x" />
          </el-button>
        </el-tooltip>
      </div>
    </div>

    <header class="chat-top">
      <div class="chat-top-left">
        <!-- 二级目录折叠按钮：拆分视图下只由活动窗格渲染（见 sideCollapsed 的说明）。
             ⚠️ 但**槽位 `side-toggle-slot` 每个窗格都要渲染**（未选中窗格里是空占位）。
             以前直接把按钮 `v-if` 掉：活动窗格比其它窗格多占 24px 宽 + 2px 高
             ⇒ 头像/标题右移 34px、行高 45→47，选中与未选中窗格的头部对不齐。 -->
        <span class="side-toggle-slot">
          <el-tooltip
            v-if="active"
            :content="sideDrawer ? '打开对话目录' : sideCollapsed ? '展开目录' : '收起目录'"
            placement="bottom"
          >
            <el-button
              text
              size="small"
              class="side-toggle"
              :aria-label="sideDrawer ? '打开对话目录' : sideCollapsed ? '展开目录' : '收起目录'"
              @click="emit('toggleSide')"
            >
              <!-- 手机端（sideDrawer）：用汉堡图标表示「打开抽屉」。
                   桌面端维持旧版的收起/展开箭头，行为与观感都不变。 -->
              <el-icon v-if="sideDrawer"><component is="Menu" /></el-icon>
              <el-icon v-else><component :is="sideCollapsed ? 'DArrowRight' : 'DArrowLeft'" /></el-icon>
            </el-button>
          </el-tooltip>
        </span>
        <ChatAvatar
          role="assistant"
          :name="assistantName"
          :avatar="assistantAvatar"
          :avatar-status="assistantAvatarStatus"
          :agent-id="assistantAvatarAgentId"
          :token="settings.token"
          :size="24"
        />
        <span class="chat-title">{{ assistantName }}</span>
        <!-- <span class="chat-session mono">{{ sessionKey }}</span> -->
        <RefreshButton class="chat-refresh" :loading="loading" @refresh="loadHistory({ skipCache: true })" />
      </div>
    </header>

    <!-- 积分不足横幅：网关返回的 balance 为 0 时常驻提示，充值后带回正余额会自动消失 -->
    <el-alert
      v-if="insufficientCredits"
      class="credits-alert"
      type="warning"
      :closable="false"
      show-icon
    >
      <template #title>积分不足，请前往充值页面充值</template>
    </el-alert>

    <div ref="threadRef" class="chat-thread" @scroll.passive="onThreadScroll">
      <!-- 用户上滑看历史时，流式新消息不再把视口拽回底部；这里给一个「跳到底部」入口 -->
      <button
        v-if="!followScroll && (messages.length > 0 || streamingText)"
        class="thread-jump-bottom"
        type="button"
        @click="jumpToBottom"
      >
        ↓ 下方有新消息
      </button>
      <div class="chat-inner">
        <div v-if="!messages.length && !streamingText && !streamingThinking" class="chat-empty">
          <span class="empty-mark">
            <ChatAvatar
              role="assistant"
              :name="assistantName"
              :avatar="assistantAvatar"
              :avatar-status="assistantAvatarStatus"
              :agent-id="assistantAvatarAgentId"
              :token="settings.token"
              :size="56"
            />
          </span>
          <div class="empty-title">有什么可以帮你？</div>
          <div class="empty-sub">
            {{ assistantName }} · 基于网关的会话智能体，随时提问或下达指令
          </div>
          <div class="empty-suggestions">
            <el-button
              v-for="s in SUGGESTIONS"
              :key="s"
              class="suggestion"
              round
              @click="useSuggestion(s)"
            >
              {{ s }}
            </el-button>
          </div>
        </div>

        <!-- 会话历史向上翻页：触顶自动加载之外，给一个显式按钮入口（也可点击触发） -->
        <button
          v-if="historyHasMore || loadingOlderHistory"
          class="thread-load-earlier"
          type="button"
          :disabled="loadingOlderHistory"
          @click="loadOlderHistory"
        >
          {{ loadingOlderHistory ? "正在加载更早消息…" : "加载更早消息" }}
        </button>

        <template v-for="msg in visibleMessages" :key="msg.id">
          <!-- 用户消息：右侧蓝底气泡 -->
          <div v-if="msg.role === 'user'" class="row row-user">
            <div class="bubble-user-wrap">
              <div class="bubble bubble-user">
                <!-- 已发送的附件：图片直接出缩略图，其他文件出文件名卡片（旧版
                     renderChatAttachmentMessages / renderAssistantAttachments 的消息侧对应物）。
                     点击**只下载**：走 `<a download>` + 白名单 href（旧版 chat-message.ts:2175-2202 的
                     `chat-assistant-attachment-card__link`），拿不到安全地址时
                     **不渲染 href**，节点退化成纯展示（不出现「能点但没反应」）。
                     刻意**没有** click 处理器 / `window.open` —— 网关对 image/audio/video 回
                     `Content-Disposition: inline`，一旦 JS 打开就会把整个聊天页顶掉。 -->
                <div v-if="msg.attachments?.length" class="bubble-user__attachments">
                  <a
                    v-for="att in msg.attachments"
                    :key="att.id"
                    class="bubble-user__attachment"
                    :class="{ 'bubble-user__attachment--previewable': !!previewHrefOf(att) }"
                    :href="previewHrefOf(att) ?? undefined"
                    :download="downloadFileName(att.fileName)"
                    :title="attachmentTooltip(att)"
                    :aria-label="attachmentTooltip(att)"
                  >
                    <img
                      v-if="isImageAttachment(att) && getChatAttachmentPreviewUrl(att)"
                      class="bubble-user__image"
                      :src="getChatAttachmentPreviewUrl(att) ?? ''"
                      alt="附件图片"
                    />
                    <span v-else class="bubble-user__file">
                      <ChatIcon class="bubble-user__file-icon" name="paperclip" />
                      <span class="bubble-user__file-name">{{ att.fileName ?? "附件" }}</span>
                    </span>
                  </a>
                </div>
                <!-- 历史消息自带的附件（刷新后 / 换会话后）：来源是网关 `chat.history`
                     的 `MediaPath(s)`，经 `/__openclaw__/assistant-media?source=&token=` 直出。
                     图片出缩略图，其余一律文件卡片 —— 与页内附件同一套样式与交互。 -->
                <div v-if="msg.historyMedia?.length" class="bubble-user__attachments">
                  <a
                    v-for="media in msg.historyMedia"
                    :key="media.key"
                    class="bubble-user__attachment"
                    :class="{ 'bubble-user__attachment--previewable': !!historyMediaHrefOf(media) }"
                    :href="historyMediaHrefOf(media) || undefined"
                    :download="downloadFileName(media.label)"
                    :title="historyMediaTooltip(media)"
                    :aria-label="historyMediaTooltip(media)"
                  >
                    <img
                      v-if="media.kind === 'image' && historyMediaUrlOf(media)"
                      class="bubble-user__image"
                      :src="historyMediaUrlOf(media)"
                      :alt="`附件图片 ${media.label}`"
                    />
                    <span v-else class="bubble-user__file">
                      <ChatIcon class="bubble-user__file-icon" name="paperclip" />
                      <span class="bubble-user__file-name">{{ media.label }}</span>
                    </span>
                  </a>
                </div>
                <!-- `content` 数组里内嵌的图片块（旧版 `renderMessageImages` 对 user 也渲染）。
                     这里拿到的是 `contentImagesExcludingTranscriptMedia` 的结果 ——
                     与上面附件条同源（顶层 MediaPaths）的那些不会出现第二次。 -->
                <div v-if="msg.contentImages?.length" class="bubble-user__attachments">
                  <template v-for="(image, i) in msg.contentImages" :key="`${msg.id}-cimg-${i}`">
                    <a
                      v-if="contentImageHref(image)"
                      class="bubble-user__attachment bubble-user__attachment--previewable"
                      :href="contentImageHref(image) ?? undefined"
                      :download="downloadFileName(image.alt, '附件图片')"
                      :title="contentImageTooltip(image)"
                      :aria-label="contentImageTooltip(image)"
                    >
                      <img
                        class="bubble-user__image"
                        :src="contentMediaUrlOf(image.url)"
                        :alt="contentImageAlt(image)"
                      />
                    </a>
                  </template>
                </div>
                <!-- `content` 里的 `attachment` 块（非图片）：与附件条同源的已被滤掉 -->
                <div v-if="msg.contentAttachments?.length" class="bubble-user__attachments">
                  <template v-for="(att, i) in msg.contentAttachments" :key="`${msg.id}-catt-${i}`">
                    <a
                      v-if="att.kind !== 'audio' && contentAttachmentHref(att)"
                      class="bubble-user__attachment bubble-user__attachment--previewable"
                      :href="contentAttachmentHref(att) ?? undefined"
                      :download="downloadFileName(att.label)"
                      :title="att.label"
                      :aria-label="att.label"
                    >
                      <span class="bubble-user__file">
                        <ChatIcon class="bubble-user__file-icon" name="paperclip" />
                        <span class="bubble-user__file-name">{{ att.label }}</span>
                      </span>
                    </a>
                    <AudioPlayer v-else-if="att.kind === 'audio'" :source="att.url" :label="att.label" />
                  </template>
                </div>
                <span v-if="msg.text" class="bubble-user__text">{{ msg.text }}</span>
              </div>
              <!-- 悬浮滑入的快捷复制按钮 + 该消息的时间戳（纯图标，背景透明，距气泡底 8px） -->
              <span v-if="canCopyMessage(msg)" class="bubble-actions">
                <span v-if="msg.ts" class="bubble-actions__time">{{ formatDateTimeMinute(msg.ts) }}</span>
                <el-button
                  class="bubble-action"
                  text
                  size="small"
                  :title="hoverCopyTitleOf(msg)"
                  :aria-label="hoverCopyTitleOf(msg)"
                  @click="copyMessage(msg)"
                >
                  <el-icon v-if="copyStateOf(msg) === 'copied'"><Check /></el-icon>
                  <el-icon v-else-if="copyStateOf(msg) === 'error'"><WarningFilled /></el-icon>
                  <el-icon v-else><CopyDocument /></el-icon>
                </el-button>
              </span>
            </div>
            <span class="msg-avatar">
              <ChatAvatar role="user" :name="userName" :size="32" />
            </span>
          </div>

          <!-- 助手消息：左侧头像 + 内容 -->
          <div v-else-if="msg.role === 'assistant'" class="row row-assistant">
            <span class="msg-avatar">
              <ChatAvatar
                role="assistant"
                :name="assistantName"
                :avatar="assistantAvatar"
                :avatar-status="assistantAvatarStatus"
                :agent-id="assistantAvatarAgentId"
                :token="settings.token"
                :size="32"
              />
            </span>
            <div class="content">
              <div class="content-meta">
                <span class="content-name">{{ assistantName }}</span>
                <span v-if="msg.ts" class="content-time">{{ formatTime(msg.ts) }}</span>
              </div>

              <!-- 思考过程：可折叠块 -->
              <div v-if="msg.thinking" class="thinking-fold">
                <el-button
                  class="thinking-fold-head"
                  text
                  size="small"
                  @click="toggleThinking(msg.id)"
                >
                  <span>思考过程</span>
                  <span class="thinking-fold-icon" :class="{ open: expandedThinkingIds.has(msg.id) }"><el-icon><ArrowRightBold /></el-icon></span>
                </el-button>
                <div v-if="expandedThinkingIds.has(msg.id)" class="thinking-fold-body">
                  {{ msg.thinking }}
                </div>
              </div>

              <MarkdownView :text="msg.text" />

              <!-- 助手回复 / 工具结果里 `content` 数组内嵌的图片块（旧版 `chat-message.ts`
                   的 `renderMessageImages` 对应物）。⚠️ 网关会把 toolResult 里图片的
                   base64 抹掉只留占位 `omitted:true`（见 `utils/contentMedia.ts` 文件头），
                   那种块在**解析期**就已跳过 —— 所以这里不会出现裂图。
                   `:empty { display:none }` 兜住「有块但都解析不出地址」的空容器。 -->
              <div v-if="msg.contentImages?.length" class="content-media__images">
                <template v-for="(image, i) in msg.contentImages" :key="`${msg.id}-img-${i}`">
                  <!-- 包一层 <a>：图片也算「附件」，点击只**下载**（`download=1` 让网关回
                       attachment）。以前是裸 <img> + JS 打开，那样会把整个聊天页顶掉。 -->
                  <a
                    v-if="contentMediaUrlOf(image.url)"
                    class="content-media__image-link"
                    :href="contentImageHref(image) ?? undefined"
                    :download="downloadFileName(image.alt, '附件图片')"
                    :title="contentImageTooltip(image)"
                  >
                    <img
                      class="content-media__image"
                      :src="contentMediaUrlOf(image.url)"
                      :alt="contentImageAlt(image)"
                      :width="image.width"
                      :height="image.height"
                    />
                  </a>
                </template>
              </div>

              <!-- 内嵌非图片附件：音频（TTS）出播放器，视频 / 文档出可点开的文件卡片。
                   `AudioPlayer` 内部自己走 `buildAssistantMediaUrl`，所以传**原始引用**；
                   卡片同理，`href` 由渲染期白名单给出（不安全就不带 href → 纯展示）。 -->
              <template v-for="(att, i) in msg.contentAttachments ?? []" :key="`${msg.id}-att-${i}`">
                <AudioPlayer v-if="att.kind === 'audio'" :source="att.url" :label="att.label" />
                <a
                  v-else
                  class="content-media__card"
                  :class="{ 'content-media__card--previewable': !!contentAttachmentHref(att) }"
                  :href="contentAttachmentHref(att) ?? undefined"
                  :download="downloadFileName(att.label)"
                  :title="att.label"
                  :aria-label="att.label"
                >
                  <ChatIcon class="content-media__card-icon" name="paperclip" />
                  <span class="content-media__card-name">{{ att.label }}</span>
                </a>
              </template>

              <!-- 正文里出现音频文件引用（如 /root/media/outbound/xxx.mp3）时给出播放控件 -->
              <AudioPlayer
                v-for="ref in audioRefsFor(msg)"
                :key="ref.raw"
                :source="ref.raw"
                :label="ref.label"
              />

              <!-- 消息元信息行：积分 + 上下文占用，两者都拿不到时不渲染 -->
              <div v-if="hasMessageMeta(msg)" class="content-credits">
                <template v-if="msg.spendResult">
                  <!-- <span class="credits-item">
                    <span class="credits-label">消耗积分</span>
                    <span class="credits-value spend">{{ formatCredits(msg.spendResult.spend) }}</span>
                  </span>
                  <span class="credits-divider" /> -->
                  <span class="credits-item">
                    <span class="credits-label">剩余积分</span>
                    <span class="credits-value balance">{{ formatBalance(msg.spendResult.balance) }}</span>
                  </span>
                  <span v-if="msg.provider && msg.model" class="credits-divider" />
                  <span v-if="msg.provider && msg.model" class="credits-item credits-item-model" :title="`${msg.provider}/${msg.model}`">
                    <!-- <span class="credits-label">生成模型</span> -->
                    <span class="credits-value model">{{ msg.model }}</span>
                  </span>
                </template>
                <span v-else-if="msg.spendLoading" class="credits-loading">
                  <el-icon class="is-loading"><Loading /></el-icon>
                  <span>积分计算中</span>
                </span>

                <!-- 操作按钮：删除 / 复制（移植自上游 chat-message.ts 的 footer actions） -->
                <span
                  v-if="msg.spendResult || msg.spendLoading"
                  class="credits-divider"
                />
                <span class="msg-actions">
                  <el-button
                    v-if="canOpenDetail(msg)"
                    class="msg-action msg-action--detail"
                    text
                    size="small"
                    title="查看详情"
                    aria-label="查看详情"
                    @click="emit('openDetail', msg)"
                  >
                    <el-icon><View /></el-icon>
                  </el-button>
                  <el-button
                    class="msg-action msg-action--delete"
                    text
                    size="small"
                    title="删除这条消息"
                    aria-label="删除消息"
                    @click="requestDeleteMessage(msg, $event)"
                  >
                    <el-icon><Delete /></el-icon>
                  </el-button>
                  <el-button
                    class="msg-action msg-action--copy"
                    text
                    size="small"
                    :class="copyStateOf(msg) ? `is-${copyStateOf(msg)}` : ''"
                    :title="copyTitleOf(msg)"
                    aria-label="复制为 Markdown"
                    :disabled="!canCopyMessage(msg)"
                    @click="copyMessage(msg)"
                  >
                    <el-icon v-if="copyStateOf(msg) === 'copied'"><Check /></el-icon>
                    <el-icon v-else-if="copyStateOf(msg) === 'error'"><WarningFilled /></el-icon>
                    <el-icon v-else><CopyDocument /></el-icon>
                  </el-button>
                  <el-button
                    class="msg-action msg-action--id"
                    text
                    size="small"
                    :class="idCopyStateOf(msg) ? `is-${idCopyStateOf(msg)}` : ''"
                    :title="idCopyTitleOf(msg)"
                    aria-label="复制消息 id"
                    :disabled="!canCopyMessageId(msg)"
                    @click="copyMessageId(msg)"
                  >
                    <el-icon v-if="idCopyStateOf(msg) === 'copied'"><Check /></el-icon>
                    <el-icon v-else-if="idCopyStateOf(msg) === 'error'"><WarningFilled /></el-icon>
                    <el-icon v-else><DocumentCopy /></el-icon>
                  </el-button>
                </span>
              </div>
            </div>
          </div>

          <!-- 工具结果：折叠进「思考过程」卡片（移植上游 chat-message.ts
               `renderActivityDisclosure`）。连续多条 toolResult 合并为一个折叠块。
               默认折叠；不再标红、不再显示 "includes errors"（工具执行过程按
               正常思考过程中性展示）。每条 toolResult 只带 `text`（无 toolName），
               上游 `extractToolCards` 兜底 name="tool"。 -->
          <div
            v-else-if="msg.role === 'toolResult' && isToolGroupStart(msg)"
            class="row row-assistant"
          >
            <span class="msg-avatar">
              <ChatAvatar
                role="assistant"
                :name="assistantName"
                :avatar="assistantAvatar"
                :avatar-status="assistantAvatarStatus"
                :agent-id="assistantAvatarAgentId"
                :token="settings.token"
                :size="32"
              />
            </span>
            <div class="content">
              <div class="chat-activity-group">
                <button
                  class="chat-activity-group__summary"
                  type="button"
                  :aria-expanded="isToolGroupExpanded(msg)"
                  @click="toggleToolGroup(toolGroupKey(msg))"
                >
                  <span class="chat-activity-group__icon">⚡</span>
                  <span class="chat-activity-group__label"
                    >思考过程 · {{ toolGroupOf(msg).length }} 步</span
                  >
                  <span
                    class="collapse-chevron"
                    :class="{
                      'collapse-chevron--collapsed': !isToolGroupExpanded(msg),
                    }"
                    aria-hidden="true"
                    ><el-icon><ArrowDownBold /></el-icon></span
                  >
                </button>
                <div
                  v-if="isToolGroupExpanded(msg)"
                  class="chat-activity-group__body"
                >
                  <template v-for="t in toolGroupOf(msg)" :key="t.id">
                    <div class="chat-tool-msg">
                      <div class="chat-tool-msg__head">
                        <span class="chat-tool-msg__icon">⚡</span>
                        <span class="chat-tool-msg__label">tool</span>
                      </div>
                      <pre v-if="t.text" class="chat-tool-msg__body">{{ t.text }}</pre>
                    </div>
                  </template>
                </div>
              </div>
            </div>
          </div>
          <!-- 同一连续 run 里后续 toolResult：折叠头已在首条渲染，这里静默跳过 -->
          <template v-else-if="msg.role === 'toolResult'"></template>

          <!-- 工具调用（role:"tool"）：结构化卡片（对齐旧版 chat-tool-cards）。
               与 toolResult 折叠块并列；本部署通常只下发 toolResult，此分支为防御性实现。 -->
          <div
            v-else-if="msg.role === 'tool'"
            class="row row-assistant"
          >
            <span class="msg-avatar">
              <ChatAvatar
                role="assistant"
                :name="assistantName"
                :avatar="assistantAvatar"
                :avatar-status="assistantAvatarStatus"
                :agent-id="assistantAvatarAgentId"
                :token="settings.token"
                :size="32"
              />
            </span>
            <div class="content">
              <div class="chat-tool-msg">
                <div class="chat-tool-msg__head">
                  <span class="chat-tool-msg__icon">🔧</span>
                  <span class="chat-tool-msg__label">{{ msg.toolName || "tool" }}</span>
                  <span v-if="msg.status" class="chat-tool-msg__status">{{ msg.status }}</span>
                </div>
                <pre v-if="msg.text" class="chat-tool-msg__body">{{ msg.text }}</pre>
              </div>
            </div>
          </div>

          <div v-else class="row row-system">
            <span class="system-text">{{ msg.text }}</span>
          </div>
        </template>

        <!-- 流式中：思考 + 正文 + 引导徽标共存于同一气泡（workbuddy 风格）。
             早期实现是 v-if/v-else-if 三段互斥，导致思考阶段"挡住"正文看不到 —— 现在改为单 row、单头像、单 content 容器，按顺序渲染各部分。 -->
        <div v-if="sending" class="row row-assistant">
          <span class="msg-avatar">
            <ChatAvatar
              role="assistant"
              :name="assistantName"
              :avatar="assistantAvatar"
              :avatar-status="assistantAvatarStatus"
              :agent-id="assistantAvatarAgentId"
              :token="settings.token"
              :size="32"
            />
          </span>
          <div class="content">
            <!-- 引导徽标：当前回合内被引导次数 > 0 时显示，告诉用户「这一轮换过方向」 -->
            <div v-if="steerCount > 0" class="steer-badge" :title="`本轮已引导 ${steerCount} 次`">
              <span class="steer-badge-dot" />
              <span>已引导 {{ steerCount }} 次</span>
            </div>

            <!-- 思考过程：流式阶段强制展开；final/abort/error 后被 messages 列表的助手消息替换（那里走默认折叠态）。
                 ⚠️ 整个气泡只允许出现**一个**思考指示，文案统一为「思考中」：
                 此前这里写「正在思考」、下面兜底又写一个三点「思考中」，同一个气泡里
                 出现两个思考标签。现在两种状态共用同一套「三点 + 思考中」头，只是
                 「有思考内容时多一段正文」的区别。 -->
            <div v-if="streamingThinking" class="thinking-fold">
              <div class="thinking-fold-head open">
                <span class="thinking"><i class="dot" /><i class="dot" /><i class="dot" /> 思考中</span>
                <span class="thinking-fold-icon open"><el-icon><ArrowRightBold /></el-icon></span>
              </div>
              <div class="thinking-fold-body thinking-fold-body-live">
                {{ streamingThinking }}<span class="caret" />
              </div>
            </div>

            <!-- 正文 -->
            <template v-if="streamingText">
              <div class="content-meta">
                <span class="content-name">{{ assistantName }}</span>
                <span class="content-time">生成中</span>
              </div>
              <MarkdownView :text="streamingMediaSplit.text" :streaming="true" />

              <!-- 流式过程中正文里出现的媒体：`MEDIA:` 行剥离后立刻渲染，
                   交互（播放 / 预览 / 下载）与落库后的消息气泡完全同一套。 -->
              <div v-if="streamingMediaImages.length" class="content-media__images">
                <a
                  v-for="(image, i) in streamingMediaImages"
                  :key="`streaming-img-${i}`"
                  class="content-media__image-link"
                  :href="streamingImageHref(image.url) ?? undefined"
                  :download="downloadFileName(image.label, '附件图片')"
                  :title="image.label"
                >
                  <img
                    class="content-media__image"
                    :src="contentMediaUrlOf(image.url)"
                    :alt="image.label"
                  />
                </a>
              </div>
              <template v-for="(att, i) in streamingMediaAttachments" :key="`streaming-att-${i}`">
                <AudioPlayer v-if="att.kind === 'audio'" :source="att.url" :label="att.label" />
                <a
                  v-else
                  class="content-media__card"
                  :class="{ 'content-media__card--previewable': !!contentAttachmentHref(att) }"
                  :href="contentAttachmentHref(att) ?? undefined"
                  :download="downloadFileName(att.label)"
                  :title="att.label"
                  :aria-label="att.label"
                >
                  <ChatIcon class="content-media__card-icon" name="paperclip" />
                  <span class="content-media__card-name">{{ att.label }}</span>
                </a>
              </template>
              <span class="caret caret-inline" />
              <!-- 积分行：**只在「本轮生成已结束、积分还在算」时出现**（`spendPending`）。
                   思考 / 生成过程中一律不显示积分 —— 积分本来就要等生成结束、
                   网关轮询完才有（`utils/agentLifecycle.ts` 里有实测时序）。
                   算完之后数值随 final 帧落到消息上，由消息自己的 `.content-credits`
                   渲染，所以这里**没有**「已有数值」的分支：一旦有数值，气泡已经被
                   落库的那条消息取代了。 -->
              <div v-if="spendPending" class="content-credits">
                <span class="credits-loading">
                  <el-icon class="is-loading"><Loading /></el-icon>
                  <span>积分计算中</span>
                </span>
              </div>
            </template>

            <!-- 兜底三dot：sending=true，但思考和正文都还没到（首屏几百毫秒的占位）。
                 引导打断当前 run 后也会回到这里：气泡原地转「思考中」，不整块消失。 -->
            <span v-else-if="isThinking" class="thinking"><i class="dot" /><i class="dot" /><i class="dot" /> 思考中</span>
          </div>
        </div>

        <!-- 已引导、等当前 run 结束后执行的消息。
             刻意渲染在流式气泡**下方**（模板最后一个节点）：引导消息永远排在最新位置，
             而不是被 push 进 messages 后顶到「思考中」上面去。
             等被引导那一轮开始产出时，脚本会把它 promote 进 messages（排到气泡上方，即正确历史顺序）。 -->
        <template v-for="msg in steeredMessages" :key="msg.id">
          <div class="row row-user row-user-steered">
            <div class="bubble bubble-user bubble-user-steered">
              <span class="steered-tag" title="已提交网关，等当前回复结束后执行">
                <span class="steered-tag-dot" />
                <span>已引导 · 排队中</span>
              </span>
              <span class="steered-text">{{ msg.text }}</span>
            </div>
            <span class="msg-avatar">
              <ChatAvatar role="user" :name="userName" :size="32" />
            </span>
          </div>
        </template>
      </div>
    </div>

    <!-- 删除确认浮层（固定定位，紧贴触发按钮；移植自上游 chat-delete-confirm） -->
    <div
      v-if="deleteConfirmId"
      ref="deleteConfirmEl"
      class="delete-confirm"
      :data-placement="deleteConfirmPos?.placement ?? 'above'"
      :style="deleteConfirmStyle"
      role="dialog"
      aria-modal="false"
    >
      <p class="delete-confirm__text">删除这条消息？</p>
      <label class="delete-confirm__remember">
        <input v-model="deleteConfirmRemember" type="checkbox" class="delete-confirm__check" />
        <span>不再询问</span>
      </label>
      <div class="delete-confirm__actions">
        <el-button class="delete-confirm__cancel" size="small" @click="closeDeleteConfirm">
          取消
        </el-button>
        <el-button class="delete-confirm__yes" type="danger" size="small" @click="confirmDeleteMessage">
          删除
        </el-button>
      </div>
    </div>

    <footer class="chat-composer">
      <div v-if="pendingTasks.length" class="pending-tasks" role="status" aria-live="polite">
        <div class="pending-tasks__header">
          <span>待执行任务（{{ pendingTasks.length }}）</span>
          <el-button
            class="pending-tasks__clear"
            text
            title="清空待执行任务"
            aria-label="清空待执行任务"
            @click="clearPendingTasks"
          >
            <el-icon><CloseBold /></el-icon>
          </el-button>
        </div>
        <div class="pending-tasks__list">
          <div v-for="item in pendingTasks" :key="item.id" class="pending-tasks__item">
            <span class="pending-tasks__text" :title="item.text">{{ item.text }}</span>
            <div class="pending-tasks__actions">
              <el-button
                class="pending-tasks__steer"
                size="small"
                :disabled="!streaming"
                title="提交到网关队列，不中断当前思考"
                @click="steerPendingTask(item)"
              >
                <el-icon><Promotion /></el-icon>
                <span>引导</span>
              </el-button>
              <el-button
                class="pending-tasks__remove"
                text
                title="删除待执行任务"
                aria-label="删除待执行任务"
                @click="removePendingTask(item.id)"
              >
                <el-icon><Delete /></el-icon>
              </el-button>
            </div>
          </div>
        </div>
      </div>
      <div class="composer-box" :class="{ 'is-steering': streaming }">
        <!-- 三个隐藏 file input（与旧版同名同 accept）：
             通用文件 / 图片 / 拍照（capture=environment 走后置摄像头）。
             拍照与照片两个入口在菜单里被 CSS 隐藏（产品决定，见 .attach-menu__option--hidden-media），
             但 input 与跳转逻辑保留，便于日后恢复。 -->
        <input
          ref="fileInputRef"
          class="chat-file-input"
          type="file"
          :accept="CHAT_ATTACHMENT_ACCEPT"
          multiple
          :disabled="!canAttach"
          @change="onAttachmentInputChange"
        />
        <input
          ref="photoInputRef"
          class="chat-file-input"
          type="file"
          accept="image/*"
          multiple
          :disabled="!canAttach"
          @change="onAttachmentInputChange"
        />
        <input
          ref="cameraInputRef"
          class="chat-file-input"
          type="file"
          accept="image/*"
          capture="environment"
          :disabled="!canAttach"
          @change="onAttachmentInputChange"
        />

        <!-- 附件预览条（旧版 .chat-attachments-preview）：选中即出现，发送成功后清空 -->
        <div
          v-if="attachments.length > 0 || attachmentsReading > 0"
          class="chat-attachments-preview"
          role="list"
          aria-label="待发送附件"
        >
          <div
            v-for="att in attachments"
            :key="att.id"
            class="chat-attachment-thumb"
            :class="{ 'chat-attachment-thumb--file': !isImageAttachment(att) }"
            role="listitem"
          >
            <!-- 预览区可点击（与气泡内附件同一套白名单 href）。
                 注意：不能把整个 `.chat-attachment-thumb` 包成 <a> ——
                 右上角的「移除」按钮会变成 <a> 内的交互元素（非法嵌套 + 点移除会连带导航）。 -->
            <a
              v-if="isImageAttachment(att) && getChatAttachmentPreviewUrl(att)"
              class="chat-attachment-thumb__image-link"
              :href="previewHrefOf(att) ?? undefined"
              :download="downloadFileName(att.fileName)"
              :title="attachmentTooltip(att)"
              :aria-label="attachmentTooltip(att)"
            >
              <img :src="getChatAttachmentPreviewUrl(att) ?? ''" alt="附件预览" />
            </a>
            <a
              v-else
              class="chat-attachment-file"
              :href="previewHrefOf(att) ?? undefined"
              :download="downloadFileName(att.fileName)"
              :title="attachmentTooltip(att)"
              :aria-label="attachmentTooltip(att)"
            >
              <ChatIcon class="chat-attachment-file__icon" name="paperclip" />
              <span class="chat-attachment-file__text">
                <span class="chat-attachment-file__name">{{ att.fileName ?? "附件" }}</span>
                <span v-if="formatAttachmentSize(att.sizeBytes)" class="chat-attachment-file__size">
                  {{ formatAttachmentSize(att.sizeBytes) }}
                </span>
              </span>
            </a>
            <button
              class="chat-attachment-remove"
              type="button"
              title="移除附件"
              aria-label="移除附件"
              @click="removeAttachment(att.id)"
            >
              &times;
            </button>
          </div>
          <div v-if="attachmentsReading > 0" class="chat-attachments-reading" role="status">
            读取中…
          </div>
        </div>

        <textarea
          ref="inputRef"
          v-model="input"
          class="composer-input"
          rows="1"
          :disabled="insufficientCredits"
          :placeholder="composerPlaceholder"
          @keydown="onKeydown"
          @paste="onInputPaste"
        />
        <div class="composer-bar">
          <div class="composer-bar-left">
            <!-- 附件入口（旧版 chat-composer.ts:2270-2322 的 <details> 菜单）。
                 图标用 Element Plus 的 Plus（<el-icon><Plus /></el-icon>）。 -->
            <el-popover
              v-model:visible="attachMenuOpen"
              placement="top-start"
              :width="152"
              :show-arrow="false"
              :offset="6"
              trigger="click"
              popper-class="chat-attach-popover"
            >
              <template #reference>
                <button
                  class="composer-attach"
                  type="button"
                  title="添加附件"
                  aria-label="添加附件"
                  :aria-expanded="attachMenuOpen"
                  :disabled="!canAttach"
                >
                  <el-icon><Plus /></el-icon>
                </button>
              </template>
              <div class="attach-menu" role="menu" aria-label="添加附件">
                <button
                  type="button"
                  class="attach-menu__option attach-menu__option--hidden-media"
                  role="menuitem"
                  @click="openCameraPicker"
                >
                  <ChatIcon name="camera" />
                  <span>拍照</span>
                </button>
                <button
                  type="button"
                  class="attach-menu__option attach-menu__option--hidden-media"
                  role="menuitem"
                  @click="openPhotoPicker"
                >
                  <ChatIcon name="image" />
                  <span>照片</span>
                </button>
                <button type="button" class="attach-menu__option" role="menuitem" @click="openFilePicker">
                  <ChatIcon name="folder" />
                  <span>文件</span>
                </button>
              </div>
            </el-popover>
            <!-- 拆分视图入口（旧版 chat-controls.ts:376-389）：紧贴附件入口右侧。
                 图标复用 ui 层 panelRightOpen；仅在单窗格模式且视口够宽时出现
                 （宽屏判定在布局层）。 -->
            <el-tooltip v-if="allowSplit" content="打开拆分视图" placement="top">
              <el-button
                text
                class="chat-open-split-view"
                aria-label="打开拆分视图"
                @click="emit('openSplit')"
              >
                <ChatIcon name="panelRightOpen" />
              </el-button>
            </el-tooltip>
            <!-- 导出对话：整段会话存成 Markdown 文件（与单条「复制为 Markdown」区分）。 -->
            <el-tooltip content="导出对话为 Markdown" placement="top">
              <el-button
                text
                class="chat-export-conversation"
                aria-label="导出对话为 Markdown"
                @click="exportConversation"
              >
                <el-icon><Download /></el-icon>
              </el-button>
            </el-tooltip>
            <span v-if="streaming" class="composer-status">
              <el-icon class="is-loading"><Loading /></el-icon>
              <span>正在生成{{ steerCount > 0 ? ` · 已引导 ${steerCount} 次` : "" }}</span>
            </span>
            <span v-else class="composer-hint">Enter 发送 · Shift+Enter 换行</span>
          </div>
          <div class="composer-bar-right">
            <!--
              上下文占用：迁自消息底部（之前每条消息都显示一次，重复且占地方）。
              现在持续显示「最后一条带 usage 的消息」的占用，单点更易观察。
              hover 弹 el-popover 展示明细（参考 workbuddy 简洁态：百分比 + 已使用/总量）。
            -->
            <el-popover
              v-if="latestContextPercent !== null"
              placement="top-start"
              :width="340"
              :show-arrow="false"
              trigger="hover"
              :hide-after="0"
              popper-class="ctx-popover"
            >
              <template #reference>
                <span
                  class="credits-ctx"
                  :class="latestContextClass"
                  :aria-label="`上下文占用 ${latestContextPercent}%`"
                >
                  <!-- 环 = SVG 表盘（对齐旧版 chat-composer.ts:1618-1641 的
                       .context-ring__dial / __track / __fill）：16×16、
                       r=CTX_RING_RADIUS、dasharray=周长、dashoffset=周长×(1−pct/100)。 -->
                  <svg class="ctx-ring" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                    <circle class="ctx-ring__track" cx="8" cy="8" :r="CTX_RING_RADIUS" />
                    <circle
                      class="ctx-ring__fill"
                      cx="8"
                      cy="8"
                      :r="CTX_RING_RADIUS"
                      :stroke-dasharray="CTX_RING_CIRCUMFERENCE.toFixed(2)"
                      :stroke-dashoffset="latestContextDashOffset.toFixed(2)"
                    />
                  </svg>
                  <!-- 只展示数值：**不带「ctx」单位**（对齐旧版 context-ring__pct 的 `${pct}%`）。 -->
                  <span class="ctx-text">{{ latestContextPercent }}%</span>
                </span>
              </template>
              <div
                v-if="latestContextMsg"
                class="ctx-detail"
                :class="latestContextClass"
              >
                <!-- 标题行 + 占用进度条：与旧版 renderContextNotice 逐字对齐
                     （ui/src/pages/chat/components/chat-composer.ts:1643-1662）。
                     旧版：`上下文窗口` + `${model.detail} · ${percentage}`，
                     其中 detail = `已用 / 上限`（`formatCompactTokenCount` 的 k/M 紧凑写法，
                     如 `56.2k / 204.8k`）；随后是一条 role="progressbar" 的进度条，
                     fill 宽度 = pct%。这里用 latestContextDetail 承载同一文案。
                     弹层只保留这两块（与参考截图一致）：明细行、已用·剩余行、≥90% 告警块已移除；
                     数字口径不变，仍由 utils/contextUsage.ts 的单测锁死。
                     ⚠️ 百分比必须留在标题行、且不在任何条件分支内 —— 曾被塞进
                     `v-if="usage?.output"`，代理不上报 output 时整个百分比会消失。 -->
                <div class="ctx-detail__header">
                  <span class="ctx-detail__header-title">上下文窗口</span>
                  <strong class="ctx-detail__header-value">
                    {{ latestContextDetail }} · {{ latestContextPercent }}%
                  </strong>
                </div>
                <div
                  class="ctx-detail__bar"
                  role="progressbar"
                  :aria-label="`上下文占用 ${latestContextPercent}%`"
                  aria-valuemin="0"
                  aria-valuemax="100"
                  :aria-valuenow="latestContextPercent ?? 0"
                >
                  <span :style="{ width: `${latestContextPercent ?? 0}%` }" />
                </div>
              </div>
            </el-popover>
            <!-- 只用「知道窗口、还没有用量」的兜底态：与上方数据态**同一套环 + 数值**结构
                 （旧版 chat-composer.ts:1618-1641 —— 环 + `${pct}%`，占比为 0 时就画空环）。
                 这里按 0% 画（dashoffset = 整周长 → 整圈留白），文案只留数值，不再出现
                 「— ctx」这种带单位的占位。 -->
            <span
              v-else-if="contextWindow"
              class="credits-ctx credits-ctx--idle"
              :aria-label="`上下文占用 0%`"
              :title="`上下文窗口 ${contextWindow.toLocaleString('zh-CN')} tokens · 暂无用量数据`"
            >
              <svg class="ctx-ring" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                <circle class="ctx-ring__track" cx="8" cy="8" :r="CTX_RING_RADIUS" />
                <circle
                  class="ctx-ring__fill"
                  cx="8"
                  cy="8"
                  :r="CTX_RING_RADIUS"
                  :stroke-dasharray="CTX_RING_CIRCUMFERENCE.toFixed(2)"
                  :stroke-dashoffset="CTX_RING_CIRCUMFERENCE.toFixed(2)"
                />
              </svg>
              <!-- 兜底态同样「只留数值」：0%（不带「ctx」单位），
                   与数据态的 `{{ pct }}%` 结构一致，避免出现/消失导致的宽度跳动。 -->
              <span class="ctx-text">0%</span>
            </span>
            <ModelSelector
              ref="modelSelectorRef"
              v-model="selectedModelRef"
              :models="modelOptions"
              :default-key="defaultModelKey"
              :disabled="streaming"
            />
            <VoiceButton v-show="false" :disabled="streaming" />
            <!-- 非流式显示发送按钮；流式时仅显示停止按钮，Enter 仍可添加待执行任务。 -->
            <el-button
              v-if="streaming"
              type="primary"
              class="send-button send-button-stop"
              title="停止生成"
              aria-label="停止生成"
              @click="abort"
            >
              <svg t="1789090642894" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="5455" width="1.5em" height="1.5em"><path d="M213.333333 298.666667a85.333333 85.333333 0 0 1 85.333334-85.333334h426.666666a85.333333 85.333333 0 0 1 85.333334 85.333334v426.666666a85.333333 85.333333 0 0 1-85.333334 85.333334H298.666667a85.333333 85.333333 0 0 1-85.333334-85.333334V298.666667z m512 0H298.666667v426.666666h426.666666V298.666667z" fill="#d93b3b" p-id="5456"></path></svg>
              <span>停止</span>
            </el-button>
            <el-button
              v-else
              type="primary"
              class="send-button send-button-primary"
              :disabled="insufficientCredits || (!input.trim() && attachments.length === 0)"
              title="发送（Enter）"
              aria-label="发送"
              @click="submitComposer"
            >
              <el-icon class="send-icon" aria-hidden="true"><Promotion /></el-icon>
              <span>发送</span>
            </el-button>
          </div>
        </div>
      </div>
    </footer>
  </div>
</template>

<style scoped>
/* 对话窗格 = 头部 + 消息流 + 输入框。布局层（ChatView.vue）负责摆放多个窗格。 */
.chat-pane {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  position: relative;
}

/* 拆分视图下标记活动窗格：窗格**顶部**一条蓝色横线（旧版 .chat-pane__header.chat-pane--active）。
 *
 * ⚠️ 这条线必须挂在 `.chat-pane__header` 上，**不能**挂在 `.chat-pane` 根节点上：
 * inset box-shadow 的绘制层级是「元素自身背景之上、子元素背景之下」，而 `.chat-pane__header`
 * 是不透明白底且铺满窗格顶部 ⇒ 挂在根节点上的线会被整个盖住，等于没画。
 * （实测：根节点的 computed shadow 是 `rgb(59,130,246) 0px 2px 0px 0px inset`，
 *  但窗格最顶端 6px 的像素采样是纯白。）
 * 只在拆分视图（`chrome === 'pane'`）下才加这个 class，此时窗格头必然存在；
 * 单窗格 / 窄屏单窗格用 `chrome="none"`，不画线（没有需要区分的对象）。 */
.chat-pane--active > .chat-pane__header {
  box-shadow: inset 0 4px 0 0 var(--wb-accent);
}

/* ============== 窗格头（仅拆分视图渲染） ============== */

.chat-pane__header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  min-width: 0;
  min-height: 36px;
  padding: 2px 6px 4px 10px;
  border-bottom: 1px solid var(--wb-border);
  background: var(--wb-bg-card);
}

.chat-pane__session-label {
  flex: 1 1 auto;
  min-width: 0;
}

/* 会话 / agent 下拉：换成 el-select 后把外观压回「窗格头里的一行小字」 */
.chat-pane__session-select {
  width: 100%;
  min-width: 0;
}

.chat-pane :deep(.chat-pane__session-select .el-select__wrapper) {
  min-height: 24px;
  padding: 0 4px;
  border: 0;
  box-shadow: none;
  background: transparent;
  font-size: 12px;
}

.chat-pane :deep(.chat-pane__session-select .el-select__wrapper:hover) {
  background: var(--wb-bg-hover);
}

.chat-pane :deep(.chat-pane__session-select .el-select__selected-item) {
  color: var(--wb-text-primary);
  font-size: 12px;
}

.chat-pane :deep(.chat-pane__session-select .el-select__placeholder) {
  font-size: 12px;
}

.chat-pane__actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
}

/* 纯图标按钮必须显式定尺寸：el-button 会被 --el-button-size 撑成 32px 正方形 */
.chat-pane :deep(.chat-pane__action.el-button) {
  width: 28px;
  min-width: 28px;
  height: 28px;
  min-height: 28px;
  padding: 5px;
  color: var(--wb-text-secondary);
}

/* 拆分入口紧贴 composer 左下角的附件入口（`.composer-attach`，26px）：
   尺寸与圆角都对齐它，两个图标才像一组工具按钮而不是两个控件。 */
.chat-pane :deep(.chat-open-split-view.el-button),
.chat-pane :deep(.chat-export-conversation.el-button) {
  width: 26px;
  min-width: 26px;
  height: 26px;
  min-height: 26px;
  padding: 5px;
  margin: 0;
  border-radius: 50%;
  color: var(--wb-text-secondary);
}

.chat-pane :deep(.chat-pane__action.el-button:hover),
.chat-pane :deep(.chat-open-split-view.el-button:hover),
.chat-pane :deep(.chat-export-conversation.el-button:hover) {
  color: var(--wb-accent-strong);
  background: var(--wb-bg-hover);
}

/* ============== 顶部 session 信息条 ============== */

.chat-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 20px;
  border-bottom: 1px solid var(--wb-border);
  flex-shrink: 0;
  background: var(--wb-bg-card);
}

.chat-top-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.chat-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--wb-text-primary);
}


/* 折叠按钮槽位：固定 24×24，**每个窗格都占位**（模板注释里有原因）。
   有按钮 / 没按钮时行高与头像偏移完全一致，选中与未选中窗格的头部才对得齐。 */
.side-toggle-slot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 24px;
  width: 24px;
  height: 24px;
}

/* 二级目录收起/展开按钮 */
.side-toggle {
  font-size: 16px !important;
  padding: 4px !important;
  height: 24px !important;
  color: var(--wb-text-secondary) !important;
}

.side-toggle:hover {
  color: var(--wb-accent-strong) !important;
}

.chat-session {
  font-size: 12px;
  color: var(--wb-text-secondary);
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--wb-bg-card);
  border: 1px solid var(--wb-border);
}

.chat-hint {
  font-size: 12px;
  color: var(--wb-text-tertiary);
}

/* ============== 积分不足横幅 ============== */

.credits-alert {
  flex-shrink: 0;
  border-radius: 0 !important;
  border-left: none !important;
  border-right: none !important;
  border-top: none !important;
  padding: 8px 20px !important;
  background: rgba(245, 158, 11, 0.10) !important;
  border-bottom: 1px solid rgba(245, 158, 11, 0.35) !important;
}

.credits-alert :deep(.el-alert__icon) {
  color: #d97706 !important;
  font-size: 15px !important;
}

.credits-alert :deep(.el-alert__title) {
  font-size: 13px !important;
  font-weight: 600 !important;
  color: #b45309 !important;
  line-height: 1.5;
}

html.dark .credits-alert {
  background: rgba(245, 158, 11, 0.14) !important;
}

html.dark .credits-alert :deep(.el-alert__icon) {
  color: #fbbf24 !important;
}

html.dark .credits-alert :deep(.el-alert__title) {
  color: #fcd34d !important;
}

/* ============== 对话流 ============== */

.chat-thread {
  position: relative;
  flex: 1;
  overflow-y: auto;
}

/* 用户上滑看历史时出现的「跳到底部」入口（对齐旧版 chatNewMessagesBelow 指示条） */
.thread-jump-bottom {
  position: absolute;
  left: 50%;
  bottom: 16px;
  transform: translateX(-50%);
  z-index: 5;
  padding: 6px 14px;
  border: 1px solid var(--el-color-primary-light-5, #b3d8ff);
  border-radius: 16px;
  background: var(--el-color-primary-light-9, #ecf5ff);
  color: var(--el-color-primary, #409eff);
  font-size: 12px;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
}

.thread-jump-bottom:hover {
  background: var(--el-color-primary-light-8, #d9ecff);
}

/* 会话历史向上翻页入口（触顶自动加载之外的手动触发） */
.thread-load-earlier {
  display: block;
  width: max-content;
  margin: 0 auto 8px;
  padding: 4px 12px;
  border: 1px solid var(--el-border-color, #dcdfe6);
  border-radius: 14px;
  background: transparent;
  color: var(--el-text-color-secondary, #909399);
  font-size: 12px;
  cursor: pointer;
}

.thread-load-earlier:hover:not(:disabled) {
  border-color: var(--el-color-primary-light-5, #b3d8ff);
  color: var(--el-color-primary, #409eff);
}

.thread-load-earlier:disabled {
  cursor: default;
  opacity: 0.7;
}

.chat-inner {
  /* 760 → 1100：拆分视图单窗格常有 800~1000px 宽，760 上限让正文两侧空出
     一大截；放宽上限并收窄左右 padding（20 → 16），把横向空间还给内容。
     ⚠️ .pending-tasks / .composer-box 与本列对齐，宽度要同步改。 */
  max-width: 1100px;
  margin: 0 auto;
  padding: 28px 16px 24px;
}

/* 空状态欢迎页 */
.chat-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 80px 20px;
}

/* 空状态头像：直接复用消息头像组件（agent 图片头像 / emoji / 首字母） */
.empty-mark {
  display: inline-flex;
  margin-bottom: 22px;
  filter: drop-shadow(0 8px 20px rgba(37, 99, 235, 0.22));
}

.empty-title {
  font-size: 22px;
  font-weight: 600;
  color: var(--wb-text-primary);
  margin-bottom: 6px;
  letter-spacing: -0.01em;
}

.empty-sub {
  font-size: 13px;
  color: var(--wb-text-secondary);
  margin-bottom: 26px;
}

.empty-suggestions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: center;
  max-width: 540px;
}

.suggestion {
  padding: 8px 16px;
  border-radius: 999px;
  border: 1px solid var(--wb-border-strong);
  background: var(--wb-bg-card);
  color: var(--wb-text-primary);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s var(--wb-ease);
}
.suggestion.el-button {
  height: auto;
  min-height: auto;
}

.suggestion:hover {
  border-color: var(--wb-accent);
  color: var(--wb-accent-strong);
  background: var(--wb-accent-soft);
}

/* ============== 消息行 ============== */

.row {
  display: flex;
  margin-bottom: 24px;
}

.row-user {
  justify-content: flex-end;
  align-items: flex-start;
  gap: 12px;
}

/* 消息头像占位（保证与气泡顶部对齐） */
.msg-avatar {
  display: inline-flex;
  flex-shrink: 0;
  margin-top: 2px;
}

/* 用户消息气泡的 wrapper：让 hover 滑入的快捷复制按钮绝对定位在气泡右下角。
   ⚠️ 宽度上限只由这一层承担（72%）。不要把同一个 max-width 也写到 .bubble-user 上 ——
   百分比 max-width 是相对**包含块**解析的，两层 72% 会相乘变成 51.84%，
   表现为「气泡明显变窄」（曾出现的回归）。 */
.bubble-user-wrap {
  position: relative;
  display: inline-block;
  max-width: 72%;
}

.bubble-user {
  /* 宽度已被 .bubble-user-wrap 限制，这里显式 100% 避免再次收窄 */
  max-width: 100%;
  padding: 10px 16px;
  border-radius: 18px;
  border-bottom-right-radius: 4px;
  background: var(--wb-accent-strong);
  color: #fff;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.6;
  font-size: 14px;
  box-shadow: 0 2px 8px rgba(37, 99, 235, 0.18);
}

/* 已引导 / 排队中的用户消息：气泡略淡 + 顶部一枚排队标签，
   与「已经发出去的消息」区分开（它还挂在最新位置，等当前 run 结束后执行）。
   这一支没有 .bubble-user-wrap 包裹，所以宽度上限要自己带。 */
.bubble-user-steered {
  max-width: 72%;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  background: rgba(37, 99, 235, 0.72);
  box-shadow: 0 2px 8px rgba(37, 99, 235, 0.10);
}

.steered-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  line-height: 1;
  opacity: 0.88;
  user-select: none;
}

.steered-tag-dot {
  display: inline-block;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #fff;
  animation: steered-tag-pulse 1.6s ease-in-out infinite;
}

@keyframes steered-tag-pulse {
  0%, 100% { box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.35); }
  50% { box-shadow: 0 0 0 4px rgba(255, 255, 255, 0.10); }
}

.steered-text {
  white-space: pre-wrap;
  word-break: break-word;
}

/* ============== 悬浮滑入的快捷复制按钮 ==============
   仅用于**我方发出的消息**（.row-user 里的蓝色气泡）。助手回复不加这个按钮 ——
   助手侧本来就有 credits-row 的复制 / 删除 / id 按钮，鼠标移上去不应再出现额外控件。

   hover 气泡时在右下角滑入「时间戳 + 复制图标」组合。按钮**背景透明**、无边框、无阴影。
   时间戳放在按钮**左侧**（.bubble-actions 是 inline-flex + gap 自然布局）。
   默认 opacity:0 + translateY(6px)（从下方浮起），.row-user:hover 时滑到原位。
   距气泡底 8px：按钮 24px 高 + bottom:-32px → 顶边 = bubble.bottom + 8px。

   ⚠️ **hover bridge**（.bubble-actions::before）：按钮与气泡之间有 8px 的视觉/物理间距，
   这 8px 是不属于任何元素的「死区」——鼠标从气泡往按钮移动时一旦进入这段间隙，
   就离开了 .bubble-actions 的盒模型，:hover 状态在 DOM 树上不再保持，
   .row-user:hover 失活 → 按钮瞬间 opacity:0 + pointer-events:none，永远到不了。
   WorkBuddy 的做法是让按钮**作为 .chat-group 的 in-flow 子元素**自然紧贴气泡下方，
   没有间隙就根本没有这个问题（见 upstream ui/src/styles/chat/grouped.css）。
   我们这里保留「绝对定位在气泡右下角」的视觉（按钮浮在气泡旁边而不是下方一行），
   所以用 ::before 伪元素**透明向上延伸 8px**，把这 8px 间隙纳入 .bubble-actions 的盒模型，
   鼠标穿过间隙时仍在 .bubble-actions 子树内，:hover 状态（含冒泡给 .row-user）保持为 true，
   按钮保持 opacity:1 + pointer-events:auto，可点击。::before 不阻挡气泡的视觉（透明），
   也不阻挡其他点击（z-index 仍由 .bubble-actions 自身管理）。*/
.bubble-actions {
  position: absolute;
  right: 0;
  bottom: -24px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  opacity: 0;
  transform: translateY(6px);
  pointer-events: none;
  transition:
    opacity 0.16s var(--wb-ease),
    transform 0.16s var(--wb-ease);
  z-index: 2;
}
/* 透明 hover bridge：覆盖按钮与气泡之间的 8px 间隙，让鼠标穿过间隙时
   .bubble-actions 的 :hover 状态保持，.row-user:hover 同步保持。 */
.bubble-actions::before {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  top: -8px;
  height: 8px;
  pointer-events: auto;     /* 继承父元素的 none，这里显式恢复 auto 让 hover 命中 */
}
/* 复制按钮：纯图标、背景透明、无边框、无阴影；hover 时只换图标颜色 */
.bubble-action.el-button {
  width: 24px;
  min-width: 24px;
  height: 24px;
  min-height: 24px;
  padding: 0;
  border: none;
  background: transparent;
  box-shadow: none;
  color: var(--wb-text-secondary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: color 0.15s var(--wb-ease);
}
/* el-button 内层 slot span 不带 scoped 属性，居中必须靠 :deep */
:deep(.bubble-action.el-button > span) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.bubble-action.el-button:hover {
  color: var(--wb-accent-strong);
  background: transparent;
}
.bubble-action.el-button .el-icon {
  font-size: 14px;
}
/* 时间戳（YYYY-MM-DD HH:MM）：等宽数字 + 三级色，避免抢占按钮焦点 */
.bubble-actions__time {
  font-size: 11px;
  line-height: 1;
  color: var(--wb-text-tertiary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  user-select: none;
}
/* 触摸设备没有 hover：直接常显。 */
@media (hover: none) {
  .bubble-actions {
    opacity: 1;
    transform: translateY(0);
    pointer-events: auto;
  }
}
/* hover 触发：只在「我方发出的消息」行（.row-user）hover 才出现，鼠标移走立刻收。
   :focus-within 让键盘 Tab 到按钮后保持可见。
   （.bubble-actions 目前只渲染在 .row-user 内，这里限定 .row-user 是为了把
   「助手回复不加 hover 控件」这条规则写死在选择器上，避免以后误加。） */
.row-user:hover > .bubble-user-wrap > .bubble-actions,
.row-user:focus-within > .bubble-user-wrap > .bubble-actions {
  opacity: 1;
  transform: translateY(0);
  pointer-events: auto;
}
/* el-button 在 feedback 态的颜色 */
.bubble-action.is-copied.el-button {
  color: var(--wb-success);
  border-color: var(--wb-success);
}
.bubble-action.is-error.el-button {
  color: var(--wb-ctx-danger);
  border-color: var(--wb-ctx-danger);
}

.row-assistant {
  gap: 12px;
  align-items: flex-start;
}

.content {
  min-width: 0;
  flex: 1;
  padding-top: 2px;
}

.content-meta {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 4px;
}

.content-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--wb-text-primary);
}

.content-time {
  font-size: 11px;
  color: var(--wb-text-tertiary);
}

/* ============== 思考过程折叠块 ============== */

.thinking-fold {
  margin: 4px 0 12px;
  border-radius: var(--wb-radius);
  background: var(--wb-bg-card);
  border: 1px solid var(--wb-border);
  overflow: hidden;
}

.thinking-fold-head {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: none;
  background: transparent;
  color: var(--wb-text-secondary);
  font-size: 12px;
  cursor: pointer;
  width: auto;
  transition: color 0.15s var(--wb-ease);
}

.thinking-fold-head:hover {
  color: var(--wb-accent-strong);
}

.thinking-fold-icon {
  font-size: 10px;
  display: inline-block;
  transition: transform 0.2s var(--wb-ease);
  color: var(--wb-text-tertiary);
}

.thinking-fold-icon .el-icon {
  margin-top: 0 !important;
}

.thinking-fold-icon.open {
  transform: rotate(90deg);
  color: var(--wb-accent);
}

/* 折叠头里的「思考中」三点：与独立兜底态共用 .thinking，字号/间距跟随折叠头 */
.thinking-fold-head .thinking {
  padding: 0;
  font-size: 12px;
  gap: 5px;
}

.thinking-fold-body {
  padding: 4px 14px 12px;
  font-size: 13px;
  color: var(--wb-text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.7;
}

.thinking-fold-body-live {
  color: var(--wb-text-primary);
}

/* ============== 光标（流式输出） ============== */

.caret {
  display: inline-block;
  width: 2px;
  height: 14px;
  margin-left: 2px;
  background: var(--wb-accent);
  vertical-align: text-bottom;
  animation: blink 1s steps(2, start) infinite;
}

.caret-inline {
  margin-top: 4px;
}

@keyframes blink {
  to {
    visibility: hidden;
  }
}

/* 思考中 */
.thinking {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--wb-text-secondary);
  padding: 4px 0;
}

.thinking .dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--wb-text-tertiary);
  animation: bounce 1.2s infinite;
}

.thinking .dot:nth-child(2) {
  animation-delay: 0.15s;
}

.thinking .dot:nth-child(3) {
  animation-delay: 0.3s;
}

@keyframes bounce {
  0%, 80%, 100% {
    opacity: 0.25;
    transform: translateY(0);
  }
  40% {
    opacity: 1;
    transform: translateY(-3px);
  }
}

/* ============== 积分展示（每条 AI 消息最下方） ============== */

.content-credits {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-top: 14px;
  /* 与附件卡片同一套行度量：等高（含边框）+ 中线对齐，上下边缘齐平。
     纵向 padding 归零、改由 align-items:center 做垂直居中 —— 这样里面的
     文字 / 图标 / 操作按钮都相对同一个中轴居中，不会因为各自的行高漂移。 */
  height: var(--meta-inline-h, 36px);
  min-height: var(--meta-inline-h, 36px);
  padding: 0 var(--meta-inline-pad-x, 12px);
  box-sizing: border-box;
  vertical-align: middle;
  line-height: var(--meta-inline-line, 1.2);
  border-radius: var(--wb-radius);
  background: var(--wb-bg-card);
  border: 1px solid var(--wb-border);
  font-size: 12px;
  /* 内容变多时横向铺开，绝不换行（换行会让高度再变、两侧又错位） */
  flex-wrap: nowrap;
  /* 分隔视图下窗格变窄时，本行不许被父级压到比内容窄 ——
     一旦被压，flex 子项会收缩、中文标签逐字竖排，整行错乱。
     策略：子项全部 flex-shrink:0 + 文本 nowrap 保持自然宽度，信息不丢也不截断；
     超宽时本行自身横向滚动查看保留全部内容。 */
  white-space: nowrap;
  overflow-x: auto;
  /* 滚动条细而淡：只在超宽时露面，给「还能往右看」的可视提示 */
  /* scrollbar-width: thin;
  overscroll-behavior-x: contain; */
}

.content-credits::-webkit-scrollbar {
  height: 4px;
}

.content-credits::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--wb-text-tertiary) 35%, transparent);
  border-radius: 999px;
}

.content-credits::-webkit-scrollbar-track {
  background: transparent;
}

/* 图标 + 文字：水平（gap）+ 垂直（align-items）双向居中 */
.credits-loading {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--meta-inline-gap, 6px);
  line-height: inherit;
  color: var(--wb-text-tertiary);
  flex-shrink: 0;
}

/* 每项内部同样是「标签 + 数值」，用 center 而非 baseline：
   两者字号一致，视觉等价，但内容换字号时仍保持居中不漂。 */
.credits-item {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--meta-inline-gap, 6px);
  line-height: inherit;
  /* 窄窗格下禁止被压缩成竖排（见 .content-credits 注释） */
  flex-shrink: 0;
}

.credits-label {
  color: var(--wb-text-tertiary);
  line-height: inherit;
}

.credits-value {
  font-weight: 600;
  font-family: "SFMono-Regular", "SF Mono", Consolas, Menlo, monospace;
  font-variant-numeric: tabular-nums;
  /* 数值本身也走同一套行高，避免与标签基线错位 */
  line-height: inherit;
}

.credits-value.spend {
  color: var(--wb-text-primary);
}

.credits-value.balance {
  color: var(--wb-accent-strong);
}

/* 模型名也保持完整（不截断）：信息优先，装不下就靠本行的横向滚动查看 */
.credits-item-model .credits-value.model {
  flex-shrink: 0;
  white-space: nowrap;
}

.credits-divider {
  flex-shrink: 0;
  width: 1px;
  height: 12px;
  background: var(--wb-border);
}

/* 上下文占用指示（移植自上游 renderMessageMeta 的 msg-meta__ctx） */

.credits-ctx {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--wb-text-secondary);
  cursor: default;
  flex-shrink: 0;
}

/* 占用环：SVG 表盘（逐字对齐旧版 .context-ring__dial / __track / __fill）
   —— -90° 让 0% 从 12 点起画，弧长由 stroke-dasharray / stroke-dashoffset 决定。
   ⚠️ 这里是**外层**样式：旧版 `__dial` 的 rotate 直接挂在 svg 上。 */
.ctx-ring {
  flex-shrink: 0;
  transform: rotate(-90deg);
}

.ctx-ring__track,
.ctx-ring__fill {
  fill: none;
  stroke-width: 2.5px;
}

.ctx-ring__track {
  stroke: color-mix(in srgb, currentColor 22%, transparent);
}

.ctx-ring__fill {
  stroke: currentColor;
  stroke-linecap: round;
}

.ctx-text {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* 阈值与上游一致：>=75% 警告，>=90% 危险 */
.credits-ctx.ctx-warn {
  color: var(--wb-ctx-warn);
}

.credits-ctx.ctx-danger {
  color: var(--wb-ctx-danger);
  font-weight: 600;
}

/* 无 usage 数据时的轻量占位（仅有窗口大小时） */
.credits-ctx--idle {
  color: var(--wb-text-tertiary);
  opacity: 0.7;
}

/* 上下文详情 popover 的样式见文件末尾的 **非 scoped** <style> 块 ——
   原因：el-popover 的内容被 teleport 到 body，Vue scoped 的 `:deep(X)` 会编译成
   `[data-v-x] X`，而 body 下的 popper 链（.el-popper → wrapper div → body）**没有任何
   data-v-x 祖先**，选择器永远命中不了。必须在非 scoped 块里用全局类名。
   实测证据：hover el-tooltip 后 popper 链上各节点的 data-v-* 属性均为空。 */

/* ============== 消息操作按钮（复制 / 删除） ============== */

.msg-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  /* 操作按钮（删除/复制）不许被压没 */
  flex-shrink: 0;
}

.msg-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: var(--wb-radius-sm);
  background: transparent;
  color: var(--wb-text-tertiary);
  cursor: pointer;
  transition: color 0.12s var(--wb-ease), background 0.12s var(--wb-ease);
}

.msg-action:hover:not(:disabled) {
  color: var(--wb-text-primary);
  background: var(--wb-bg-hover);
}

.msg-action:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.msg-action .el-icon {
  font-size: 14px;
}

/*
 * 删除按钮：hover 时转危险色提示不可逆。
 * 必须带 `:not(:disabled)` —— 上面通用规则 `.msg-action:hover:not(:disabled)` 权重为 (0,3,0)，
 * 若这里只写 `.msg-action--delete:hover`（0,2,0）会被通用规则盖掉，红色 hover 永远不生效。
 */
.msg-action--delete:hover:not(:disabled) {
  color: var(--wb-ctx-danger);
  background: color-mix(in srgb, var(--wb-ctx-danger) 12%, transparent);
}

/* 复制 id 按钮：hover 时转强调色，与「复制正文」的默认灰区分开 */
.msg-action--id:hover:not(:disabled) {
  color: var(--wb-accent-strong);
  background: var(--wb-accent-soft);
}

/* 复制反馈：成功转「已复制」绿、失败转危险色 */
.msg-action.is-copied {
  color: #16a34a;
}

.msg-action.is-error {
  color: var(--wb-ctx-danger);
}

/* ============== 删除确认浮层 ============== */

.delete-confirm {
  position: fixed;
  z-index: 2100;
  min-width: 200px;
  max-width: min(320px, calc(100vw - 32px));
  padding: 12px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius);
  background: var(--wb-bg-elevated);
  box-shadow: var(--wb-shadow-lg);
  transform-origin: top left;
  animation: delete-confirm-in 0.15s var(--wb-ease);
}

.delete-confirm[data-placement="above"] {
  transform-origin: bottom left;
}

.delete-confirm__text {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 500;
  color: var(--wb-text-primary);
}

.delete-confirm__remember {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
  font-size: 12px;
  color: var(--wb-text-secondary);
  cursor: pointer;
  user-select: none;
}

.delete-confirm__check {
  width: 14px;
  height: 14px;
  accent-color: var(--wb-accent);
  cursor: pointer;
}

.delete-confirm__actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}

.delete-confirm__cancel,
.delete-confirm__yes {
  padding: 4px 12px;
  border-radius: var(--wb-radius-sm);
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  transition: background 0.12s var(--wb-ease);
}

/* el-button 内部 span 需要覆盖：让「取消」呈中性灰、「删除」用项目主色而非 Element 默认红 */
.delete-confirm__cancel.el-button {
  background: var(--wb-bg-hover);
  color: var(--wb-text-secondary);
  border: none;
}
.delete-confirm__cancel.el-button:hover {
  background: var(--wb-bg-inset);
  color: var(--wb-text-primary);
}

.delete-confirm__yes.el-button {
  background: var(--wb-ctx-danger);
  color: #fff;
  border: none;
}
.delete-confirm__yes.el-button:hover {
  background: var(--wb-ctx-danger);
  filter: brightness(0.92);
  color: #fff;
}

@keyframes delete-confirm-in {
  from {
    opacity: 0;
    transform: scale(0.96);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

/* ============== 系统提示行 ============== */

.row-system {
  justify-content: center;
}

.system-text {
  font-size: 12px;
  color: var(--wb-text-tertiary);
  background: var(--wb-bg-card);
  border: 1px solid var(--wb-border);
  padding: 4px 12px;
}

/* ============== 工具结果 Activity 折叠卡片 ============== */
/* 移植上游 ui/src/styles/chat/tool-cards.css 的 .chat-activity-group*，
   把 --text / --muted / --border / --bg-hover / --radius-sm 换成项目 --wb-* 令牌。
   默认收起；中性展示（不再标红、不再默认展开，与思考过程一致）。 */

.chat-activity-group {
  width: 100%;
  min-width: 0;
  max-width: 100%;
}

.chat-activity-group__summary {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  padding: 5px 8px;
  border: 0;
  border-radius: var(--wb-radius-sm);
  background: transparent;
  color: var(--wb-text-secondary);
  font: inherit;
  text-align: left;
  cursor: pointer;
  user-select: text;
  transition: background 150ms ease;
}

.chat-activity-group__summary:hover,
.chat-activity-group__summary:focus-visible {
  background: color-mix(in srgb, var(--wb-bg-hover) 60%, transparent);
}

.chat-activity-group__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--wb-text-tertiary);
}

.chat-activity-group__label {
  flex-shrink: 0;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
}

/* 左竖线把展开体里的每条工具结果归到同一组，但不额外套卡片 */
.chat-activity-group__body {
  display: flex;
  flex-direction: column;
  gap: 0;
  margin: 2px 0 0 14px;
  padding-left: 8px;
  border-left: 1px solid color-mix(in srgb, var(--wb-border) 85%, transparent);
}

.collapse-chevron {
  margin-left: auto;
  flex-shrink: 0;
  color: var(--wb-text-tertiary);
  transition: transform 150ms ease;
}

.collapse-chevron--collapsed {
  transform: rotate(-90deg);
}

/* 组里单条工具结果（上游兜底 name="tool"） */
.chat-tool-msg {
  padding: 6px 0;
}

.chat-tool-msg__head {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--wb-text-tertiary);
  font-size: 12px;
  font-weight: 600;
}

.chat-tool-msg__icon {
  color: var(--wb-text-tertiary);
}

.chat-tool-msg__status {
  margin-left: 2px;
  padding: 0 6px;
  border-radius: 8px;
  background: var(--wb-bg-inset);
  color: var(--wb-text-tertiary);
  font-size: 11px;
  font-weight: 500;
}

.chat-tool-msg__body {
  margin: 4px 0 0;
  padding: 8px 10px;
  border-radius: var(--wb-radius-sm);
  background: var(--wb-bg-inset);
  color: var(--wb-text-secondary);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-x: auto;
}

/* ============== 输入区 ============== */

.chat-composer {
  position: relative;
  flex-shrink: 0;
  /* 左右 20 → 16：与 .chat-inner 的新 padding 对齐，输入框和消息列同边缘 */
  padding: 12px 16px 18px;
  background: var(--wb-bg-content);
}

.pending-tasks {
  /* 与 .chat-inner 内容列同宽（见其注释），别单改一处 */
  max-width: 1100px;
  margin: 0 auto 8px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius);
  background: var(--wb-bg-card);
  box-shadow: var(--wb-shadow);
  overflow: hidden;
}

.pending-tasks__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 34px;
  padding: 4px 8px 4px 12px;
  border-bottom: 1px solid var(--wb-border);
  color: var(--wb-text-secondary);
  font-size: 12px;
  font-weight: 600;
}

.pending-tasks__clear,
.pending-tasks__remove {
  width: 28px;
  height: 28px;
  padding: 0;
  color: var(--wb-text-tertiary);
}

.pending-tasks__clear:hover,
.pending-tasks__remove:hover {
  color: var(--wb-ctx-danger);
  background: color-mix(in srgb, var(--wb-ctx-danger) 10%, transparent);
}

.pending-tasks__list {
  max-height: 168px;
  overflow-y: auto;
}

.pending-tasks__item {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 44px;
  padding: 6px 8px 6px 12px;
}

.pending-tasks__item + .pending-tasks__item {
  border-top: 1px solid var(--wb-border);
}

.pending-tasks__text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--wb-text-primary);
  font-size: 13px;
  line-height: 1.5;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pending-tasks__actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.pending-tasks__steer {
  border-radius: 999px;
}

/* 提交失败的任务：整行淡红底 + 「失败」标签，按钮变「重试」 */
.pending-tasks__item.is-failed {
  background: var(--el-color-danger-light-9, #fef0f0);
}

.pending-tasks__error {
  flex-shrink: 0;
  padding: 1px 6px;
  border: 1px solid var(--el-color-danger-light-5, #fab6b6);
  border-radius: 999px;
  color: var(--el-color-danger, #f56c6c);
  font-size: 11px;
  line-height: 16px;
}

.composer-box {
  /* 与 .chat-inner 内容列同宽（输入框与消息左右边缘对齐），别单改一处 */
  max-width: 1100px;
  margin: 0 auto;
  border: 1px solid var(--wb-border-strong);
  border-radius: var(--wb-radius-xl);
  background: var(--wb-bg-card);
  box-shadow: var(--wb-shadow);
  transition: border-color 0.15s var(--wb-ease), box-shadow 0.15s var(--wb-ease);
}

.composer-box:focus-within {
  border-color: var(--wb-accent);
  box-shadow: 0 0 0 3px var(--wb-accent-soft), var(--wb-shadow);
}

.composer-input {
  width: 100%;
  border: none;
  outline: none;
  resize: none;
  background: transparent;
  color: var(--wb-text-primary);
  font-size: 14px;
  line-height: 1.6;
  padding: 14px 16px 6px;
  font-family: inherit;
  /* 高度由 autosizeComposer() 按内容设置（1 行起步，最高 200px）；
     到顶后 overflow-y 切 auto —— 滚动条收纳在输入框内部，
     对话流（.chat-thread）与窗格（.chat-pane, overflow:hidden）不被顶出滚动。 */
  height: auto;
  overflow-y: hidden;
}

.composer-input:disabled {
  cursor: not-allowed;
  opacity: 0.6;
  background: transparent;
}

.composer-input::placeholder {
  color: var(--wb-text-tertiary);
}

.composer-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 10px 10px;
}

/* 左下角工具按钮组：`+`（附件）与拆分入口紧邻，所以 gap 收窄成 icon 组间距（2px）；
   后面的文案靠自身 `padding-left` 拉开与按钮组的距离。 */
.composer-bar-left {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  flex: 1;
  overflow: hidden;
}

.composer-bar-right {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.composer-hint {
  font-size: 11px;
  color: var(--wb-text-tertiary);
  white-space: nowrap;
  padding-left: 12px;
}

.composer-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--wb-accent-strong);
  white-space: nowrap;
  padding-left: 12px;
}

/* ============== 发送按钮（图标 + 文案胶囊） ============== */

.send-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: none;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  padding: 7px 14px 7px 12px;
  height: 34px;
  transition: all 0.15s var(--wb-ease);
  user-select: none;
}

.send-button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.send-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.send-button-primary {
  background: var(--wb-accent-strong);
  color: #fff;
  box-shadow: 0 2px 8px rgba(37, 99, 235, 0.25);
}

.send-button-primary:hover:not(:disabled) {
  background: var(--wb-accent-hover);
  box-shadow: 0 4px 12px rgba(37, 99, 235, 0.32);
  transform: translateY(-1px);
}

.send-button-primary:active:not(:disabled) {
  transform: translateY(0);
  box-shadow: 0 1px 4px rgba(37, 99, 235, 0.20);
}

.send-button-stop {
  background: var(--wb-bg-card);
  color: #d93b3b;
  border: 1px solid rgba(217, 59, 59, 0.35);
}

.send-button-stop:hover {
  background: rgba(217, 59, 59, 0.08);
  border-color: #d93b3b;
}

/* ============== 引导徽标（流式气泡顶部，「已引导 N 次」） ============== */
.steer-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  padding: 3px 10px;
  margin-bottom: 8px;
  border-radius: 999px;
  background: rgba(245, 158, 11, 0.10);
  border: 1px solid rgba(245, 158, 11, 0.30);
  color: #b45309;
  font-size: 11px;
  font-weight: 500;
  line-height: 1;
  user-select: none;
  animation: steer-badge-in 0.2s ease-out;
}

.steer-badge-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #f59e0b;
  box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.18);
  animation: steer-badge-pulse 1.6s ease-in-out infinite;
}

@keyframes steer-badge-in {
  from { opacity: 0; transform: translateY(-2px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes steer-badge-pulse {
  0%, 100% { box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.18); }
  50% { box-shadow: 0 0 0 5px rgba(245, 158, 11, 0.05); }
}

/* ============== 流式阶段 composer：橙色光晕提示当前是「引导模式」 ============== */
.composer-box.is-steering {
  border-color: rgba(245, 158, 11, 0.45);
  box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.10);
  transition: border-color 0.18s ease, box-shadow 0.18s ease;
}

.composer-box.is-steering:focus-within {
  border-color: rgba(245, 158, 11, 0.65);
  box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.18);
}

/* ============== 附件入口 / 附件菜单 ============== */

/* 三个隐藏的 file input（旧版 .agent-chat__file-input 等，display:none 由 JS click 触发） */
.chat-file-input {
  display: none;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

/* 输入框左下角的「+」：28×28 的圆形图标按钮，与旧版 .agent-chat__input-btn 同量级 */
.composer-attach {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  min-width: 26px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--wb-text-secondary);
  font-size: 15px;
  cursor: pointer;
  transition: background 0.15s var(--wb-ease), color 0.15s var(--wb-ease);
}

.composer-attach:hover:not(:disabled) {
  background: var(--wb-bg-hover);
  color: var(--wb-accent-strong);
}

.composer-attach:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* ============== 附件预览条（旧版 .chat-attachments-preview） ============== */

.chat-attachments-preview {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 10px 0;
}

.chat-attachment-thumb {
  position: relative;
  width: 60px;
  height: 60px;
  border: 1px solid var(--wb-border-strong);
  border-radius: var(--wb-radius-sm);
  overflow: hidden;
  background: var(--wb-bg-card);
}

/* 非图片附件横向拉长，容得下文件名（旧版 .chat-attachment-thumb--file 为 180px） */
.chat-attachment-thumb--file {
  width: 180px;
}

/* 图片预览区的可点链接：铺满缩略图，不引入额外留白
   （`<img>` 的尺寸仍由下面的 `.chat-attachment-thumb img` 决定）。 */
.chat-attachment-thumb__image-link {
  display: block;
  width: 100%;
  height: 100%;
  cursor: default;
}

.chat-attachment-thumb__image-link[href] {
  cursor: pointer;
}

.chat-attachment-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.chat-attachment-file {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 100%;
  padding: 8px 30px 8px 10px;
  overflow: hidden;
  font-size: 11.5px;
  color: var(--wb-text-primary);
  background: var(--wb-bg-card-strong);
  /* 作为 <a> 渲染时的复位（非链接态不会有下划线差异，但颜色/光标要显式给） */
  text-decoration: none;
  cursor: default;
}

.chat-attachment-file[href] {
  cursor: pointer;
}

/* 双类选择器：ChatIcon 自带的 `.chat-icon` 单类规则会与这里同特异性，
   靠「两个类」稳定压过它（不依赖样式注入顺序）。 */
.chat-attachment-file .chat-attachment-file__icon {
  flex: 0 0 16px;
  width: 16px;
  height: 16px;
  color: var(--wb-text-secondary);
}

.chat-attachment-file__text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.chat-attachment-file__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-attachment-file__size {
  font-size: 10px;
  color: var(--wb-text-tertiary);
}

.chat-attachment-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s var(--wb-ease);
}

.chat-attachment-thumb:hover .chat-attachment-remove,
.chat-attachment-remove:focus-visible {
  opacity: 1;
}

.chat-attachment-remove:hover {
  background: #d93b3b;
}

.chat-attachments-reading {
  font-size: 11px;
  color: var(--wb-text-tertiary);
}

/* ============== 用户气泡内的附件 ============== */

.bubble-user__attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 6px;
}

/* 附件 = 可点开的 <a>（无安全地址时不带 href → 退化成纯展示）。
   `cursor` 只在真有 href 时才给放大镜，避免「能点但没反应」的假象。 */
.bubble-user__attachment {
  display: inline-flex;
  color: inherit;
  text-decoration: none;
  cursor: default;
}

.bubble-user__attachment--previewable {
  cursor: pointer;
}

/* 可点提示：只做极轻的高亮描边，不改变气泡排版 */
.bubble-user__attachment--previewable:hover .bubble-user__image,
.bubble-user__attachment--previewable:hover .bubble-user__file {
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.45);
}

.bubble-user__image {
  display: block;
  max-width: 220px;
  max-height: 160px;
  border-radius: var(--wb-radius-sm);
  object-fit: contain;
}

.bubble-user__file {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 220px;
  padding: 4px 8px;
  border-radius: var(--wb-radius-sm);
  background: rgba(255, 255, 255, 0.18);
  font-size: 12px;
}

.bubble-user__file .bubble-user__file-icon {
  flex: 0 0 14px;
  width: 14px;
  height: 14px;
}

.bubble-user__file-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bubble-user__text {
  white-space: pre-wrap;
  word-break: break-word;
}

/* ============== 助手内容里的内嵌媒体（content 数组块） ============== */

.content-media__images {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}

/* 有块但一条都解析不出地址时别留一排空 margin */
.content-media__images:empty {
  display: none;
}

/* 图片外层链接：`display: contents` ⇒ 不生成盒子，`<img>` 仍是 `.content-media__images`
   的直接 flex 项，布局与「加链接之前」完全一致（只多一个带 href 的可点祖先）。 */
.content-media__image-link {
  display: contents;
}

.content-media__image {
  display: block;
  max-width: 320px;
  max-height: 240px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  object-fit: contain;
  cursor: pointer;
}

.content-media__image:hover {
  box-shadow: 0 0 0 2px var(--wb-accent);
}

/* ---------------------------------------------------------------------------
   「同一行里的元信息块」共用一套行度量
   ---------------------------------------------------------------------------
   附件卡片（点它即查看 / 下载）与「消耗积分」元信息行是**同一行的两个 inline-flex
   兄弟节点**（都在助手 `.content` 里，卡片在前、积分行紧随其后）。

   改之前两者各写各的 padding，实测：
     卡片     h=33.2px  top=-5728.8  bottom=-5695.6
     积分行   h=36px    top=-5729.2  bottom=-5693.2
   —— 高度差 2.8px、底边差 2.4px。根因有两层：
   ① 高度由各自内容撑开（卡片 = 图标/文字 + 12px 纵向 padding，积分行被里面
      的操作按钮撑到 36px）；
   ② inline-level 盒默认 `vertical-align: baseline`，两盒高度不同 ⇒ 按基线对齐
      ⇒ 底边必然错位（就是肉眼看到的「文字基线不一致造成的偏移」。

   这里收成一套变量 + 等高盒 + 中线对齐；两侧内容各自 `align-items: center`
   做双向居中。变量同时提供字面量兜底，单独抽出来用也不会塌。
   --------------------------------------------------------------------------- */
.row-assistant .content {
  /** 同排元信息块的统一高度（同时也作为 min-height）。 */
  --meta-inline-h: 36px;
  /** 统一横向内边距（纵向为 0，垂直居中交给 align-items）。 */
  --meta-inline-pad-x: 12px;
  /** 统一「图标 ↔ 文字」间距。 */
  --meta-inline-gap: 6px;
  /** 统一行高：两侧一致，文字基线才不会各漂各的。 */
  --meta-inline-line: 1.2;
}

/* 文件卡片：与 AudioPlayer 同一套观感（胶囊描边 + 内嵌底色）。
   `cursor` 只在真有 href 时才给放大镜，避免「能点但没反应」的假象。 */
.content-media__card {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--meta-inline-gap, 6px);
  max-width: 320px;
  margin: 14px 10px 0 0;
  /* 与「消耗积分」行等高 + 中线对齐：上下边缘自然齐平 */
  height: var(--meta-inline-h, 36px);
  min-height: var(--meta-inline-h, 36px);
  padding: 0 var(--meta-inline-pad-x, 12px);
  /* 显式声明，不依赖全局 `* { box-sizing }`：高度里含边框才好对齐 */
  box-sizing: border-box;
  vertical-align: middle;
  line-height: var(--meta-inline-line, 1.2);
  border-radius: var(--wb-radius);
  background: var(--wb-bg-card);
  border: 1px solid var(--wb-border);
  font-size: 12px;
  /* 它是 <a>：不复位的话会被全局链接样式染成蓝色 + 下划线 */
  color: var(--wb-text-primary);
  text-decoration: none;
  /* 没 href（不安全地址在渲染期被剥掉）时不给可点提示，避免「能点但没反应」的假象 */
  cursor: default;
}

/* 与图片、用户侧附件同一套「可下载」手感 */
.content-media__card--previewable {
  cursor: pointer;
}

.content-media__card--previewable:hover {
  border-color: var(--wb-accent);
  color: var(--wb-accent);
}

.content-media__card-icon {
  flex: 0 0 14px;
  width: 14px;
  height: 14px;
  /* 跟文字一起在卡片里垂直居中（图标是 svg，默认 display:block） */
  align-self: center;
}

.content-media__card-name {
  /* 跟卡片本体走（pointer / default），不然 hover 到文字上会闪回别的光标 */
  cursor: inherit;
  /* 自成一个居中盒：内容再长也只是横向省略号，不会把行高顶高 */
  display: block;
  align-self: center;
  line-height: inherit;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>

<!--
  上下文详情 popover：内容由 el-popover teleport 到 body，
  popper 链上没有任何 data-v-* 祖先，scoped + :deep() 无法命中，
  因此这里必须是**非 scoped** 的全局样式块（类名已足够唯一，不会污染其他组件）。
-->
<style>
/* 弹层外壳：几何逐字对齐旧版 .context-usage__popover
   （padding 16px、圆角 --radius-lg、width min(340px, 100vw − 42px)、
   盒高 = 16 + 标题行 + 12 + 5 + 15 + 16 ≈ 82px，与参考截图像素级一致） */
.ctx-popover.el-popper {
  padding: 16px !important;
  border-radius: var(--wb-radius-lg) !important;
  max-width: calc(100vw - 42px) !important;
}
.ctx-detail {
  display: flex;
  flex-direction: column;
  font-size: 12px;
  color: var(--wb-text-secondary);
  /* 进度条填充色跟随占用阈值（补齐旧版 --ctx-color 的作用），
     与右侧环 .ctx-ring 的 currentColor 同源。 */
  --ctx-color: var(--wb-text-secondary);
}
.ctx-detail.ctx-warn {
  --ctx-color: var(--wb-ctx-warn);
}
.ctx-detail.ctx-danger {
  --ctx-color: var(--wb-ctx-danger);
}
/* 标题行：左标签 + 右「已用 / 上限 · pct%」（对齐旧版 .context-usage__header） */
.ctx-detail__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
}
.ctx-detail__header-title {
  color: var(--wb-text-secondary);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  white-space: nowrap;
}
.ctx-detail__header-value {
  color: var(--wb-text-primary);
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
/* 占用进度条（对齐旧版 .context-usage__bar：高 5px、上下间距 12/15px） */
.ctx-detail__bar {
  height: 5px;
  margin: 12px 0 15px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--wb-border-strong);
}
.ctx-detail__bar > span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--ctx-color);
  transition: width 0.2s ease;
}
.el-button+.el-button {
  margin-left: 0 !important;
}

/* ---------------------------------------------------------------------------
   附件菜单：内容由 el-popover teleport 到 body，popper 链上没有任何 data-v-* 祖先，
   `scoped + :deep()` 永远命中不了 —— 必须写在**非 scoped** 块里。
   尺寸逐条对齐旧版 `.agent-chat__attach-menu-popover`（152px 宽 / padding 5px /
   gap 2px / 每项 min-height 34px / 图标 16px）。
   --------------------------------------------------------------------------- */
.chat-attach-popover.el-popper {
  padding: 5px !important;
  border-radius: var(--wb-radius) !important;
  min-width: 152px !important;
}
.chat-attach-popover .attach-menu {
  display: grid;
  gap: 2px;
}
.chat-attach-popover .attach-menu__option {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 34px;
  padding: 6px 8px;
  border: 0;
  border-radius: var(--wb-radius-sm);
  background: transparent;
  color: var(--wb-text-primary);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.chat-attach-popover .attach-menu__option:hover,
.chat-attach-popover .attach-menu__option:focus-visible {
  background: var(--wb-bg-hover);
  outline: none;
}
.chat-attach-popover .attach-menu__option .chat-icon {
  flex: 0 0 16px;
  width: 16px;
  height: 16px;
  color: var(--wb-text-secondary);
}
/**
 * @description: 隐藏「拍照 / 照片」两个附件菜单项（仅 CSS 隐藏，不删除按钮代码，
 *   便于日后恢复）—— 与旧版 ui/src/styles/chat/layout.css 的同名规则一致。
 * @author yangchenglin11@jd.com（沿用旧版产品决定）
 */
.chat-attach-popover .attach-menu__option--hidden-media {
  display: none !important;
}

/**
 * 窗格头的会话 / agent 下拉（el-select 的弹层同样被 teleport 到 body，
 * 必须写在非 scoped 块里）。
 *
 * el-select 会把宿主宽度写进弹层的 `min-width`；窗格在拆分视图下有半屏宽
 * （实测 566px），弹层跟着变得又宽又空，所以这里收窄成内容宽度。
 */
.chat-pane__session-select-popper.el-select-dropdown {
  min-width: 180px !important;
  max-width: min(360px, calc(100vw - 24px)) !important;
}
.chat-pane__session-select-popper .el-select-group__title {
  /* 分组 DOM 保留（pane-agent-isolation / pane-wechat-session 按
     el-select-group__wrap 结构断言），但标题行视觉上隐藏：选项文案已带
     可读名，再显示组标题就是重行，且组标题本身不可点击 —— 对齐「下拉里
     只留会话名一行、点击即切」的产品口径。仅 CSS 隐藏，便于日后恢复。 */
  display: none;
  color: var(--wb-text-secondary);
  font-size: 12px;
}
.chat-pane__session-select-popper .el-select-dropdown__item {
  font-size: 12px;
}

/* ===========================================================================
   手机端（≤768px，含矮横屏）
   ===========================================================================

   与 `src/styles/layout.mobile.css` 的断点条件逐字一致。本文件放的是**本组件的**
   手机端规则；全局外壳（安全区、el-main、输入框字号）在那边。

   桌面基线不受影响：全部包在 media query 里（`pane-active-topline` 那套几何断言
   仍在 1366 下跑，头像偏移 54 / 标题偏移 88 / 行高 45 都不变）。
   =========================================================================== */

@media (max-width: 768px), (max-width: 932px) and (max-height: 500px) and (orientation: landscape) {
  /**
   * 输入区留白：桌面是 `12px 20px 18px`，手机横向把 20px 收到 12px 并把宽度让给输入框；
   * 底部叠三层：基础 10px + Home 指示条安全区 + **软键盘遮挡补偿**。
   *
   * `--wb-keyboard-inset` 由 `utils/keyboardInset.ts` 持续写入。iOS 不缩布局视口，
   * 键盘弹出时输入区会被盖住；把它加在 composer 的 padding-bottom 上就能把输入内容顶到
   * 键盘之上，而**不动整页高度**（不动就不会牵连窗格/抽屉那套已经调好的高度链路）。
   * Android 有 `interactive-widget=resizes-content`，该值恒为 0，不会重复补偿。
   */
  .chat-composer {
    padding: 8px calc(12px + var(--wb-safe-right, 0px))
      calc(10px + var(--wb-safe-bottom, 0px) + var(--wb-keyboard-inset, 0px))
      calc(12px + var(--wb-safe-left, 0px));
  }

  /**
   * 触控目标统一抬到 44px（iOS HIG）。只改尺寸，颜色/圆角沿用原样式，
   * 观感与桌面一致、只是更好点。
   */
  .composer-attach {
    width: var(--wb-touch-target, 44px);
    height: var(--wb-touch-target, 44px);
    min-width: var(--wb-touch-target, 44px);
    font-size: 18px;
  }

  .send-button {
    height: var(--wb-touch-target, 44px);
    min-width: var(--wb-touch-target, 44px);
    padding: 0 18px 0 16px;
    font-size: 14px;
  }

  .chat-pane :deep(.chat-open-split-view.el-button),
  .chat-pane :deep(.chat-export-conversation.el-button) {
    width: var(--wb-touch-target, 44px);
    height: var(--wb-touch-target, 44px);
  }

  /**
   * 「Enter 发送 · Shift+Enter 换行」在手机上毫无意义（没有物理键盘，回车就是换行），
   * 留着只会挤占输入区那一行。隐藏它不影响任何逻辑（纯提示文案，非交互元素）。
   */
  .composer-hint {
    display: none;
  }

  /** 输入框内边距按窄屏收紧，配合全局的 16px 字号（防 iOS 聚焦自动缩放）。 */
  .composer-input {
    padding: 12px 14px 4px;
  }

  /**
   * 目录折叠按钮（手机端是「打开抽屉」）抬到 44px。
   *
   * 这个按钮撑宽会让 `.side-toggle-slot` 从 24px 变成 44px ⇒ 头像/标题整体右移 ——
   * 只在手机上如此，桌面几何断言（头像偏移 54 / 标题偏移 88）不受影响；
   * 而手机上同一时刻只渲染活动窗格，不存在「选中/未选中窗格头部对不齐」的问题。
   */
  .chat-pane :deep(.side-toggle.el-button) {
    width: var(--wb-touch-target, 44px);
    height: var(--wb-touch-target, 44px);
  }

  .chat-pane :deep(.side-toggle-slot) {
    width: var(--wb-touch-target, 44px);
  }

  /** 窗格头两个按钮（会话下拉 / 关闭）也抬到 44px；窗格头在手机上是主要操作区。 */
  .chat-pane :deep(.chat-pane__action.el-button) {
    width: var(--wb-touch-target, 44px);
    height: var(--wb-touch-target, 44px);
  }

  /**
   * 双击缩放抑制：手机上按钮/标签的双击会触发浏览器缩放（300ms 延迟 + 整页放大），
   * 对应用型界面是纯干扰。`manipulation` 保留滚动与点按，只关掉双击缩放。
   */
  .chat-pane,
  .chat-pane button,
  .chat-pane .el-button,
  .chat-pane .el-select {
    touch-action: manipulation;
  }
}
</style>