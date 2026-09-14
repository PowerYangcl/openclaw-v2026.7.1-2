<script setup lang="ts">
/**
 * 对话页：仿 WorkBuddy 的用户/助手对话交互。
 *
 * 每条 AI 回复下方会渲染消耗/剩余积分（如果服务端消息携带了 spendResult）。
 * 流式生成时展示「思考中…」或带光标的内容；服务端若推送了 thinking 块，
 * 会展示在回复正文上方的可折叠「思考」块中。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { ElMessage } from "element-plus";
import { Check, CloseBold, CopyDocument, Delete, Loading, Promotion, Tickets, WarningFilled } from "@element-plus/icons-vue";
import { useGatewayStore } from "@/stores/gateway";
import { useSettingsStore } from "@/stores/settings";
import { useAgentsStore } from "@/stores/agents";
import { formatTime, formatDateTimeMinute } from "@/utils/format";
import { sessionKeysMatch } from "@/utils/sessionListSelection";
import {
  contextPercentClassOf,
  contextPercentOf,
  contextRemainingTokensOf,
  contextUsedTokensOf,
} from "@/utils/contextUsage";
import { resolveLocalUserName } from "@/utils/avatar";
import { copyToClipboard } from "@/utils/clipboard";
import type { SessionsListResult } from "@/api/types";
import MarkdownView from "@/components/MarkdownView.vue";
import ModelSelector, { type ModelOption } from "@/components/ModelSelector.vue";
import VoiceButton from "@/components/VoiceButton.vue";
import ChatSidebar from "@/components/ChatSidebar.vue";
import ChatAvatar from "@/components/ChatAvatar.vue";
import AudioPlayer from "@/components/AudioPlayer.vue";
import { extractAudioReferences, type AudioReference } from "@/utils/assistantMedia";

type ChatRole = "user" | "assistant" | "system" | "tool";

type JdSpendResult = {
  spend: number;
  balance: number;
};

type ModelCatalogEntry = {
  id: string;
  name?: string;
  provider: string;
  alias?: string;
  available?: boolean;
  contextWindow?: number;
  reasoning?: boolean;
};

/** 单次调用的 token 用量（移植自上游 `extractGroupMeta` 读的 usage 字段）。 */
type TokenUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /**
   * 该轮总 token 数（部分代理只报 total 拆分不出 input/output 时用作「prompt token」估算回退源）。
   * 与上游 `normalizeUsage` 的 `total` 字段对齐；持久化记录里多数会带 `{ input, output, totalTokens }` 三个字段。
   */
  totalTokens?: number;
};

type ChatMessage = {
  id: string;
  role: ChatRole;
  text: string;
  ts?: number;
  provider?: string;
  model?: string;
  completionId?: string;
  /** 本轮思考过程（如果服务端推送了 thinking 块） */
  thinking?: string;
  /** 本轮消耗积分与剩余积分（来自服务端消息） */
  spendResult?: JdSpendResult;
  /** 历史消息正在异步查询积分时为 true（前端 UI 展示「积分计算中」） */
  spendLoading?: boolean;
  /** 本轮 token 用量（用于算上下文占用百分比） */
  usage?: TokenUsage;
  /**
   * 消息在网关记录里的**原始 id**（不带 `resp-` / `oc-` 前缀），供「复制消息 id」按钮使用。
   * 取不到稳定字段时为 undefined，此时复制会回落到 `id`（本地稳定键）。
   */
  rawId?: string;
  /** `rawId` 取自哪个字段，仅用于 tooltip 说明来源。 */
  rawIdSource?: MessageIdSource;
};

/**
 * 消息 id 的来源字段，按可靠性排序。
 * - `responseId`：助手消息，历史与流式 `final` 帧都带
 * - `transcriptId`：transcript 内部 id（`__openclaw.id`），历史里有、流式 `final` 帧没有
 * - `recordId`：顶层 `id`
 * - `idempotencyKey`：用户消息
 * - `derived`：以上都没有，只能用本地派生的稳定键兜底
 */
type MessageIdSource = "responseId" | "transcriptId" | "recordId" | "idempotencyKey" | "derived";

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

const gateway = useGatewayStore();
const settings = useSettingsStore();
const agents = useAgentsStore();
const route = useRoute();

/**
 * 消息气泡旁的助手头像与名称。
 *
 * 对齐上游 `chat-pane.ts` 的 `state.assistantName = config.current.assistantIdentity.name`
 * 与 `chat-message.ts` 的 `renderChatAvatar(role, { name, avatar }, ...)`：
 * 名称取当前 agent 的身份名，头像取 agent 图片头像 / emoji / 文本头像，
 * 最终由 `ChatAvatar` 按「图片 → 文本 → 首字母 → 角色图标」降级渲染。
 */
const assistantName = computed(() => agents.assistantName);
const assistantAvatar = computed(() => agents.assistantAvatar);
const assistantAvatarStatus = computed(() => agents.assistantAvatarStatus);
const assistantAvatarAgentId = computed(() => agents.assistantAvatarAgentId);

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
  const refs = extractAudioReferences(msg.text);
  audioRefsCache.set(msg, { text: msg.text, refs });
  return refs;
}

/** 用户侧展示名（本项目未接入本地用户身份配置，沿用上游兜底文案「You/你」）。 */
const userName = resolveLocalUserName(null);

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
 * 会话 key 解析：`?session=` 显式指定 > settings 里派生的 key > `main`。
 *
 * 这里刻意用 `||` 而不是 `??`：`?session=` 与 store 值都可能是空串
 * （空串不是 nullish，用 `??` 会让空串穿透），而网关的 `chat.history` /
 * `chat.send` 都要求 sessionKey 至少 1 个字符。
 */
const sessionKey = ref<string>(
  (typeof route.query.session === "string" ? route.query.session.trim() : "") ||
    settings.sessionKey ||
    "main",
);
const messages = ref<ChatMessage[]>([]);
const streamingText = ref("");
const streamingThinking = ref("");
const sending = ref(false);
const loading = ref(false);
const input = ref("");
const threadRef = ref<HTMLElement | null>(null);
const inputRef = ref<HTMLTextAreaElement | null>(null);

type PendingTask = {
  id: string;
  text: string;
};

const pendingTasks = ref<PendingTask[]>([]);
let pendingTaskSeed = 0;

function enqueuePendingTask(): void {
  const text = input.value.trim();
  if (!text || !sending.value) return;
  pendingTaskSeed += 1;
  pendingTasks.value.push({ id: `pending-${Date.now()}-${pendingTaskSeed}`, text });
  input.value = "";
}

function removePendingTask(id: string): void {
  pendingTasks.value = pendingTasks.value.filter((item) => item.id !== id);
}

function clearPendingTasks(): void {
  pendingTasks.value = [];
}

/** 当前流式回合的局部积分展示（用于发送中显示「已消耗 X 积分 · 剩余 Y 积分」） */
const streamingSpend = ref<JdSpendResult | null>(null);
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

/** 用户显式选中的模型；空串 = 使用默认模型。 */
const selectedModelParts = computed<{ provider: string; model: string } | null>(() =>
  splitModelKey(settings.selectedModel),
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

/**
 * 透传给 ModelSelector 的 v-model：用 computed 显式桥接 Pinia store，
 * 确保外部 setter 调用能可靠地反向回流到组件 props。
 */
const selectedModelRef = computed<string>({
  get: () => settings.selectedModel,
  set: (value: string) => settings.setSelectedModel(value),
});

// 切换模型时，模型的 contextWindow 可能不同（200k ↔ 16k），重拉一次
watch(selectedModelRef, () => {
  void loadContextWindow();
});

const streaming = computed(() => sending.value);
const creditsCalculating = computed(
  () => sending.value && Boolean(streamingText.value) && !streamingSpend.value,
);
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

function normalizeMessage(raw: unknown, index: number): ChatMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const role = (typeof record.role === "string" ? record.role : "assistant") as ChatRole;
  const rawContent = record.content ?? record.text;
  const text = extractText(rawContent);
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
    rawId: resolvedId?.value,
    rawIdSource: resolvedId?.source,
  };
}

async function scrollToBottom(): Promise<void> {
  await nextTick();
  const el = threadRef.value;
  if (el) el.scrollTop = el.scrollHeight;
}

/**
 * 发请求前兜底会话 key：网关要求 `sessionKey` 至少 1 个字符，
 * 空串会直接报 `invalid chat.history params: at /sessionKey: must not have fewer than 1 characters`。
 * 正常情况下 store 已经保证非空，这里是最后一道闸。
 */
function resolvedSessionKey(): string {
  const key = sessionKey.value.trim();
  if (key) return key;
  const fallback = settings.sessionKey.trim() || "main";
  sessionKey.value = fallback;
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
  return sessionKeysMatch(sessionKeyValue, sessionKey.value, agents.selectedAgentId);
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
    const agents = Array.isArray(res?.agents) ? res.agents : [];
    const agent = agents.find((item) => item?.id === res?.defaultId) ?? agents[0];
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
    const key = resolvedSessionKey();
    const current = (res?.sessions ?? []).find((row) =>
      sessionKeysMatch(row.key, key, agents.selectedAgentId),
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

/** 一条消息可复制的内容：正文（不含思考过程），与上游 resolveNormalizedMessageMarkdown 一致。 */
function messageCopyText(msg: ChatMessage): string {
  return (msg.text ?? "").trim();
}

/** 是否有可复制内容（决定复制按钮是否可点）。 */
function canCopyMessage(msg: ChatMessage): boolean {
  return messageCopyText(msg).length > 0;
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

// ── chat 错误友好化 ──
//
// 网关 `state: "error"` 事件透传的 `errorMessage` 是英文原句（来自上游
// `agents/embedded-agent-helpers/sanitize-user-facing-text.ts` 的分类表），
// 例如 "LLM request failed: network connection error."，
// 再被上游 `reply/agent-runner-execution.ts:3474` 包装成
// "⚠️ Agent failed before reply: <inner>.\nLogs: openclaw logs --follow"。
// 直接 toast 给中文用户既难看也猜不出下一步。这里做一层规则化的中文映射，
// 落点（title+detail+retryable）与上游 sanitizeUserFacingText 的英文类目一一对应，
// 优先按上游已分类的句子匹配；命中失败时再剥离 "Agent failed before reply" 前缀和
// "Logs: ..." 后缀，把剩余部分继续匹配（兜底）；都匹配不上则原文展示。

type FriendlyError = { title: string; detail: string; retryable: boolean };

/**
 * 把上游英文 chat 错误文案映射成中文用户友好提示。
 * 返回 `{title, detail, retryable}`，调用方按需拼接 toast 文案。
 */
function localizeChatError(raw: string): FriendlyError {
  if (!raw) return { title: "生成失败", detail: "", retryable: true };

  // 上游已经本地化的锁竞争提示（见 server-chat.ts:220 buildChatErrorMessage）
  if (/当前会话正在处理中/.test(raw)) {
    return { title: "当前会话正在处理中，请稍后", detail: "", retryable: false };
  }

  // 规则表：英文片段 → 中文提示。每条都对应上游 sanitizeUserFacingText 的一个分支。
  // 顺序敏感 —— 更具体的（带前缀）放在前面，避免 "network" 这类宽泛词先匹配。
  const rules: Array<{ re: RegExp; title: string; detail: string; retryable: boolean }> = [
    {
      re: /LLM request failed: connection refused by the provider endpoint\./i,
      title: "模型提供方拒绝连接",
      detail: "可能服务未启动或地址错误，请稍后重试",
      retryable: true,
    },
    {
      re: /LLM request failed: DNS lookup for the provider endpoint failed\./i,
      title: "域名解析失败",
      detail: "无法解析模型提供方地址，请检查网络/DNS 设置",
      retryable: true,
    },
    {
      re: /LLM request failed: the provider endpoint is unreachable from this host\./i,
      title: "模型提供方不可达",
      detail: "当前主机无法访问该端点，请检查网络或代理",
      retryable: true,
    },
    {
      re: /LLM request failed: network connection (was interrupted|error)\./i,
      title: "网络连接失败",
      detail: "模型提供方的连接已断开，请稍后重试",
      retryable: true,
    },
    {
      re: /LLM request failed: provider reported a network error\./i,
      title: "模型提供方上报网络错误",
      detail: "请稍后重试",
      retryable: true,
    },
    {
      re: /LLM request failed: proxy or tunnel configuration blocked the provider request\./i,
      title: "代理配置阻断了请求",
      detail: "请检查代理或隧道设置",
      retryable: false,
    },
    {
      re: /LLM request timed out\./i,
      title: "请求超时",
      detail: "模型提供方响应超时，请重试",
      retryable: true,
    },
    {
      re: /LLM request rate limited\./i,
      title: "请求频率超限",
      detail: "请稍后重试或降低调用频率",
      retryable: true,
    },
    {
      re: /LLM request unauthorized\./i,
      title: "鉴权失败",
      detail: "API 密钥无效或已过期，请联系管理员",
      retryable: false,
    },
    {
      re: /LLM request failed: provider rejected the request schema or tool payload\./i,
      title: "模型提供方拒绝了请求结构",
      detail: "通常是消息体或工具定义与服务端契约不一致，可尝试开启新会话重试",
      retryable: true,
    },
    {
      re: /LLM request failed: provider returned an invalid streaming response\. Please try again\./i,
      title: "流式响应异常",
      detail: "模型提供方返回了无效的流式响应，请重试",
      retryable: true,
    },
    {
      re: /LLM request failed with an unknown error\./i,
      title: "模型提供方返回未知错误",
      detail: "请稍后重试，问题持续请联系管理员",
      retryable: true,
    },
    {
      re: /LLM request failed\./i,
      // 兜底分类：failover-matches.test.ts:187 把裸 "LLM request failed." 视为 timeout
      title: "生成失败",
      detail: "请求未在预期时间内完成，请重试",
      retryable: true,
    },
  ];
  for (const r of rules) {
    if (r.re.test(raw)) return r;
  }

  // 兜底：剥掉 "⚠️ Agent failed before reply: ..." / "Logs: ..." 这类包装，
  // 对内层继续匹配一次（可能在 inner 上命中一个更具体的分类）。
  const stripped = raw
    .replace(/^⚠️\s*/, "")
    .replace(/Agent failed before reply[:：]\s*/i, "")
    .replace(/\.\s*Logs:.*$/s, "")
    .replace(/\.\s*Please try again.*$/i, "")
    .trim();
  if (stripped && stripped !== raw) {
    for (const r of rules) {
      if (r.re.test(stripped)) return r;
    }
    return { title: "助手在回复前失败", detail: stripped, retryable: true };
  }
  return { title: "生成失败", detail: raw, retryable: true };
}

/** 把 FriendlyError 拍平成单行 toast 文案：title 在前，detail 换行接在后。 */
function formatFriendlyError(e: FriendlyError): string {
  return e.detail ? `${e.title}\n${e.detail}` : e.title;
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
  if (index >= 0) messages.value.splice(index, 1);
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

async function loadHistory(): Promise<void> {
  loading.value = true;
  try {
    const res = await gateway.request<{ messages?: unknown[]; sessionId?: string }>(
      "chat.history",
      { sessionKey: resolvedSessionKey(), limit: 200 },
    );
    // 先同步本次请求所属会话的「已删集合」，再据此过滤 —— 删除后刷新才不会再冒出来。
    loadDeletedMessageIds();
    const deleted = deletedMessageIds.value;
    messages.value = (res?.messages ?? [])
      .map((item, index) => normalizeMessage(item, index))
      .filter(
        (item): item is ChatMessage =>
          item !== null && Boolean(item.text) && !deleted.has(item.id),
      );
    await scrollToBottom();
    // 异步拉取历史消息的积分（不阻塞内容渲染）
    void fetchMissingSpendResults();
    // 加载完成后从历史补充模型列表
    void loadModelList();
  } catch (err) {
    ElMessage.error(`加载会话历史失败：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    loading.value = false;
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

/** 本轮生成内被引导的次数（流式气泡顶部「已引导 N 次」徽标用）。 */
const steerCount = ref(0);

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

async function send(textOverride?: string): Promise<boolean> {
  const text = (textOverride ?? input.value).trim();
  if (!text || sending.value) return false;

  messages.value.push({ id: `local-${Date.now()}`, role: "user", text, ts: Date.now() });
  if (textOverride === undefined) input.value = "";
  sending.value = true;
  streamingText.value = "";
  streamingThinking.value = "";
  streamingSpend.value = null;
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
    });
    return true;
  } catch (err) {
    sending.value = false;
    streamingText.value = "";
    streamingThinking.value = "";
    ElMessage.error(`发送失败：${err instanceof Error ? err.message : String(err)}`);
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
    ElMessage.error(`引导失败：${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

async function steerPendingTask(item: PendingTask): Promise<void> {
  try {
    await steer(item.text);
    removePendingTask(item.id);
  } catch {
    // 保留待执行任务，允许用户再次引导或手动删除。
  }
}

/** 非流式发送；流式阶段先加入待执行列表。 */
async function submitComposer(): Promise<void> {
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
  if (!streamingText.value.trim() && !streamingThinking.value.trim()) return;
  messages.value.push({
    id: `assistant-${Date.now()}`,
    role: "assistant",
    text: streamingText.value,
    thinking: streamingThinking.value || undefined,
    ts: Date.now(),
    provider: parts?.provider,
    model: parts?.model,
    spendResult: streamingSpend.value ?? undefined,
  });
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
  sending.value = true;
  awaitingSteeredRun.value = true;
  void scrollToBottom();
}

function finalizeStreaming(skipCommit = false): void {
  if (!skipCommit) commitStreamingMessage();
  streamingText.value = "";
  streamingThinking.value = "";
  streamingSpend.value = null;
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

function handleEvent(evt: { event: string; payload?: unknown }): void {
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
  if (!isEventForCurrentSession(payload.sessionKey)) return;

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
      if (normalized && (normalized.text || normalized.thinking)) {
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
          messages.value.push({
            ...normalized,
            provider: normalized.provider ?? fallbackParts?.provider,
            model: normalized.model ?? fallbackParts?.model,
            text: normalized.text || streamedText,
            thinking: normalized.thinking || streamedThinking || undefined,
            spendResult: normalized.spendResult ?? streamingSpend.value ?? undefined,
          });
          // final 推送可能带 model/provider，刷新选择器
          void loadModelList();
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
});

/**
 * 会话切换（二级目录 / 会话页点进来）：重置流式态并重新拉历史。
 *
 * 视图组件在路由 query 变化时不会被重建，必须显式监听，
 * 否则点了侧栏会话后内容仍是上一个会话的。
 */
watch(
  () => [route.query.session, settings.sessionKey] as const,
  () => {
    const next =
      (typeof route.query.session === "string" ? route.query.session.trim() : "") ||
      settings.sessionKey.trim() ||
      "main";
    if (next === sessionKey.value) return;
    sessionKey.value = next;
    messages.value = [];
    streamingText.value = "";
    streamingThinking.value = "";
    streamingSpend.value = null;
    sending.value = false;
    steeredMessages.value = [];
    awaitingSteeredRun.value = false;
    steerCount.value = 0;
    pendingTasks.value = [];
    expandedThinkingIds.value = new Set();
    void loadHistory();
    // 上下文窗口可能随会话变化（每个会话有自己的 contextTokens）
    void loadContextWindow();
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
</script>

<template>
  <div class="chat-layout">
    <!-- 二级目录：只有智能体列表一段（点击切换该 agent 的代表会话） -->
    <ChatSidebar :collapsed="sideCollapsed" @toggle="toggleSide" />

    <div class="chat">
    <header class="chat-top">
      <div class="chat-top-left">
        <el-tooltip :content="sideCollapsed ? '展开目录' : '收起目录'" placement="bottom">
          <el-button
            text
            size="small"
            class="side-toggle"
            :aria-label="sideCollapsed ? '展开目录' : '收起目录'"
            @click="toggleSide"
          >
            <i :class="sideCollapsed ? 'jc-icon-my-menu-right' : 'jc-icon-my-menu-left'"></i>
          </el-button>
        </el-tooltip>
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
        <span class="chat-session mono">{{ sessionKey }}</span>
        <span v-if="loading" class="chat-hint">加载中…</span>
      </div>
      <el-button text size="small" :loading="loading" @click="loadHistory">刷新</el-button>
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

    <div ref="threadRef" class="chat-thread">
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

        <template v-for="msg in messages" :key="msg.id">
          <!-- 用户消息：右侧蓝底气泡 -->
          <div v-if="msg.role === 'user'" class="row row-user">
            <div class="bubble-user-wrap">
              <div class="bubble bubble-user">{{ msg.text }}</div>
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
                  <span class="thinking-fold-icon" :class="{ open: expandedThinkingIds.has(msg.id) }">▸</span>
                  <span>思考过程</span>
                </el-button>
                <div v-if="expandedThinkingIds.has(msg.id)" class="thinking-fold-body">
                  {{ msg.thinking }}
                </div>
              </div>

              <MarkdownView :text="msg.text" />

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
                  <span class="credits-item">
                    <span class="credits-label">消耗积分</span>
                    <span class="credits-value spend">{{ formatCredits(msg.spendResult.spend) }}</span>
                  </span>
                  <span class="credits-divider" />
                  <span class="credits-item">
                    <span class="credits-label">剩余积分</span>
                    <span class="credits-value balance">{{ formatCredits(msg.spendResult.balance) }}</span>
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
                    <el-icon v-else><Tickets /></el-icon>
                  </el-button>
                </span>
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
                <span class="thinking-fold-icon open">▸</span>
                <span class="thinking"><i class="dot" /><i class="dot" /><i class="dot" /> 思考中</span>
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
              <MarkdownView :text="streamingText" :streaming="true" />
              <span class="caret caret-inline" />
              <div v-if="creditsCalculating || streamingSpend" class="content-credits">
                <span v-if="creditsCalculating" class="credits-loading">
                  <el-icon class="is-loading"><Loading /></el-icon>
                  <span>积分计算中</span>
                </span>
                <template v-else-if="streamingSpend">
                  <span class="credits-item">
                    <span class="credits-label">消耗积分</span>
                    <span class="credits-value spend">{{ formatCredits(streamingSpend.spend) }}</span>
                  </span>
                  <span class="credits-divider" />
                  <span class="credits-item">
                    <span class="credits-label">剩余积分</span>
                    <span class="credits-value balance">{{ formatCredits(streamingSpend.balance) }}</span>
                  </span>
                  <span v-if="effectiveModelParts" class="credits-divider" />
                  <span v-if="effectiveModelParts" class="credits-item credits-item-model" :title="`${effectiveModelParts.provider}/${effectiveModelParts.model}`">
                    <!-- <span class="credits-label">生成模型</span> -->
                    <span class="credits-value model">{{ effectiveModelParts.model }}</span>
                  </span>
                </template>
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
        <textarea
          ref="inputRef"
          v-model="input"
          class="composer-input"
          rows="1"
          :placeholder="
            streaming
              ? '输入消息加入待执行任务（Enter 添加，Shift+Enter 换行）'
              : '输入消息，Enter 发送，Shift+Enter 换行'
          "
          @keydown="onKeydown"
        />
        <div class="composer-bar">
          <div class="composer-bar-left">
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
              :width="220"
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
                  <span
                    class="ctx-ring"
                    :style="{ '--ctx-pct': latestContextPercent ?? 0 }"
                  />
                  <span class="ctx-text">{{ latestContextPercent }}% ctx</span>
                </span>
              </template>
              <div v-if="latestContextMsg" class="ctx-detail">
                <!-- 与旧版（用户参照的截图）逐行对齐：上下文窗口 / 本轮输入 / 缓存命中 /
                     缓存写入 / 本轮输出 / 已用·剩余。数字一律 toLocaleString("zh-CN") 全量展示。 -->
                <div class="ctx-detail__row ctx-detail__row--lead">
                  <span>上下文窗口</span>
                  <span class="ctx-detail__num">{{ (contextWindow ?? 0).toLocaleString("zh-CN") }} tokens</span>
                </div>
                <div v-if="latestContextMsg.usage" class="ctx-detail__row">
                  <span>本轮输入</span>
                  <span class="ctx-detail__num">{{ latestContextMsg.usage.input.toLocaleString("zh-CN") }} tokens</span>
                </div>
                <div v-if="latestContextMsg.usage?.cacheRead" class="ctx-detail__row">
                  <span>缓存命中</span>
                  <span class="ctx-detail__num">{{ latestContextMsg.usage.cacheRead.toLocaleString("zh-CN") }} tokens</span>
                </div>
                <div v-if="latestContextMsg.usage?.cacheWrite" class="ctx-detail__row">
                  <span>缓存写入</span>
                  <span class="ctx-detail__num">{{ latestContextMsg.usage.cacheWrite.toLocaleString("zh-CN") }} tokens</span>
                </div>
                <div v-if="latestContextMsg.usage?.output" class="ctx-detail__row">
                  <span>本轮输出</span>
                  <span class="ctx-detail__num">{{ latestContextMsg.usage.output.toLocaleString("zh-CN") }} tokens</span>
                </div>
                <!-- 上下文占用百分比：**独立成行**。
                     ⚠️ 曾经它被塞进上面 `v-if="usage?.output"` 那个 div 里 —— 代理不上报
                     output 时整行跟着消失，只有 output 非 0 才看得到占用百分比。别再放回去。 -->
                <div class="ctx-detail__row">
                  <span>上下文占用</span>
                  <span class="ctx-detail__num">{{ latestContextPercent }}%</span>
                </div>
                <div class="ctx-detail__row ctx-detail__row--sum">
                  <span>已用 / 剩余</span>
                  <span class="ctx-detail__num">
                    {{ contextUsedTokensOf(latestContextMsg.usage).toLocaleString("zh-CN") }}
                    /
                    {{ contextRemainingTokensOf(latestContextMsg.usage, contextWindow).toLocaleString("zh-CN") }} tokens
                  </span>
                </div>
                <div
                  v-if="latestContextPercent >= 90"
                  class="ctx-detail__alert"
                  :class="latestContextClass"
                >
                  <el-icon><WarningFilled /></el-icon>
                  <span>{{ latestContextPercent >= 100 ? "已超出上下文上限" : "上下文接近上限，建议清理历史" }}</span>
                </div>
              </div>
            </el-popover>
            <span
              v-else-if="contextWindow"
              class="credits-ctx credits-ctx--idle"
              :title="`上下文窗口 ${contextWindow.toLocaleString('zh-CN')} tokens · 暂无用量数据`"
            >
              <span class="ctx-text">— ctx</span>
            </span>
            <ModelSelector
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
              <svg t="1789090642894" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="5455" width="1.5em" height="1.5em"><path d="M213.333333 298.666667a85.333333 85.333333 0 0 1 85.333334-85.333334h426.666666a85.333333 85.333333 0 0 1 85.333334 85.333334v426.666666a85.333333 85.333333 0 0 1-85.333334 85.333334H298.666667a85.333333 85.333333 0 0 1-85.333334-85.333334V298.666667z m512 0H298.666667v426.666666h426.666666V298.666667z" fill="#707070" p-id="5456"></path></svg>
              <span>停止</span>
            </el-button>
            <el-button
              v-else
              type="primary"
              class="send-button send-button-primary"
              :disabled="!input.trim()"
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
  </div>
</template>

<style scoped>
/* 对话页 = 二级目录（智能体 + 最近会话） + 对话主区 */
.chat-layout {
  display: flex;
  height: 100%;
  min-height: 0;
}

.chat {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  height: 100%;
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

/* 二级目录收起/展开按钮 */
.side-toggle {
  font-size: 16px !important;
  padding: 4px !important;
  height: 26px !important;
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
  flex: 1;
  overflow-y: auto;
}

.chat-inner {
  max-width: 760px;
  margin: 0 auto;
  padding: 28px 20px 24px;
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
  gap: 12px;
  margin-top: 14px;
  padding: 6px 12px;
  border-radius: var(--wb-radius);
  background: var(--wb-bg-card);
  border: 1px solid var(--wb-border);
  font-size: 12px;
}

.credits-loading {
  display: inline-flex;
  align-items:center;
  gap: 6px;
  color: var(--wb-text-tertiary);
}

.credits-item {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
}

.credits-label {
  color: var(--wb-text-tertiary);
}

.credits-value {
  font-weight: 600;
  font-family: "SFMono-Regular", "SF Mono", Consolas, Menlo, monospace;
  font-variant-numeric: tabular-nums;
}

.credits-value.spend {
  color: var(--wb-text-primary);
}

.credits-value.balance {
  color: var(--wb-accent-strong);
}

.credits-divider {
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
}

/* 进度环：conic-gradient 按 --ctx-pct(0-100) 画弧，::before 挖空成环 */
.ctx-ring {
  position: relative;
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: conic-gradient(
    currentColor calc(var(--ctx-pct, 0) * 1%),
    var(--wb-border-strong) 0
  );
}

.ctx-ring::before {
  content: "";
  position: absolute;
  inset: 3px;
  border-radius: 50%;
  background: var(--wb-bg-card);
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

/* ============== 输入区 ============== */

.chat-composer {
  flex-shrink: 0;
  padding: 12px 20px 18px;
  background: var(--wb-bg-content);
}

.pending-tasks {
  max-width: 760px;
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

.composer-box {
  max-width: 760px;
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
  max-height: 200px;
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

.composer-bar-left {
  display: inline-flex;
  align-items: center;
  gap: 10px;
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
}

.composer-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--wb-accent-strong);
  white-space: nowrap;
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
</style>

<!--
  上下文详情 popover：内容由 el-popover teleport 到 body，
  popper 链上没有任何 data-v-* 祖先，scoped + :deep() 无法命中，
  因此这里必须是**非 scoped** 的全局样式块（类名已足够唯一，不会污染其他组件）。
-->
<style>
.ctx-popover.el-popper {
  padding: 10px 12px !important;
  border-radius: var(--wb-radius) !important;
}
.ctx-detail {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 240px;
  font-size: 12px;
  color: var(--wb-text-secondary);
}
.ctx-detail__row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
}
.ctx-detail__row--lead {
  color: var(--wb-text-primary);
  font-weight: 600;
  margin-bottom: 2px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--wb-border);
}
.ctx-detail__row--sum {
  margin-top: 4px;
  padding-top: 6px;
  border-top: 1px solid var(--wb-border);
  color: var(--wb-text-primary);
  font-weight: 600;
}
.ctx-detail__num {
  font-variant-numeric: tabular-nums;
}
.ctx-detail__alert {
  margin-top: 6px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: var(--wb-radius-sm);
  font-size: 11.5px;
}
.ctx-detail__alert.ctx-warn {
  background: rgba(245, 158, 11, 0.12);
  color: var(--wb-ctx-warn);
}
.ctx-detail__alert.ctx-danger {
  background: rgba(239, 68, 68, 0.12);
  color: var(--wb-ctx-danger);
  font-weight: 600;
}
</style>