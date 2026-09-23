/**
 * 对话消息共享类型。
 *
 * 抽出来的原因：`ChatMessage` 既被视图（`views/ChatPane.vue`）使用，也被
 * `utils/chatMessageCache.ts` 等纯工具使用。放在 SFC 的 `<script setup>` 里
 * **无法被外部 `import type`**（会报 TS2307），故收敛到本模块。
 */

import type { ChatAttachment } from "@/utils/chatAttachments";
import type { TranscriptMediaItem } from "@/utils/transcriptMedia";
import type { ContentAttachmentItem, ContentImageBlock } from "@/utils/contentMedia";

export type ChatRole = "user" | "assistant" | "system" | "tool" | "toolResult";

export type JdSpendResult = {
  spend: number;
  balance: number;
};

/** 单次调用的 token 用量（移植自上游 `extractGroupMeta` 读的 usage 字段）。 */
export type TokenUsage = {
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

/**
 * 消息 id 的来源字段，按可靠性排序。
 * - `responseId`：助手消息，历史与流式 `final` 帧都带
 * - `transcriptId`：transcript 内部 id（`__openclaw.id`），历史里有、流式 `final` 帧没有
 * - `recordId`：顶层 `id`
 * - `idempotencyKey`：用户消息
 * - `derived`：以上都没有，只能用本地派生的稳定键兜底
 */
export type MessageIdSource = "responseId" | "transcriptId" | "recordId" | "idempotencyKey" | "derived";

export type ChatMessage = {
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
   * 用户消息携带的**页内**附件（仅本地渲染用，payload 在模块级 Map 里，刷新即丢）。
   *
   * ⚠️ 别据此认为「历史附件丢了」：网关 `chat.history` 对 user 消息**顶层**
   * 会返回 `MediaPath`/`MediaPaths`/`MediaType`/`MediaTypes`（实测确认，只是 `content`
   * 里只有 `{type:"text"}`）。刷新后 / 换会话后靠的就是那组字段，见 `historyMedia` 与
   * `utils/transcriptMedia.ts`。
   */
  attachments?: ChatAttachment[];
  /**
   * 历史消息自带的媒体附件（来自网关 `chat.history` 的 `MediaPath(s)` 字段）。
   *
   * 与 `attachments` 的关系：同一页内自己发的用 `attachments`（有 blob 预览、有 base64），
   * 刷新/换会话后 `attachments` 必然为空，此时用 `historyMedia` 还原气泡里的缩略图 / 文件卡片。
   * URL 由 `buildAssistantMediaUrl()` 现算（`/__openclaw__/assistant-media?source=...&token=...`）。
   */
  historyMedia?: TranscriptMediaItem[];
  /**
   * `content` 数组里的内嵌图片块（助手回复 / 工具结果 / 配对二维码 / OpenAI 与
   * Responses 风格的 image 块）。
   *
   * ⚠️ 工具结果里的图片在本部署下**拿不到字节**：网关发出前会把 base64 删掉、
   * 只留 `{type:"image",mimeType,omitted:true,bytes}`（见
   * `src/agents/embedded-agent-subscribe.tools.ts:257-262`）⇒ 这类块**不产出条目**，
   * 不会渲染成破图。详见 `utils/contentMedia.ts` 文件头。
   */
  contentImages?: ContentImageBlock[];
  /** `content` 里的非图片附件（助手 TTS 音频 / 文档卡片）。 */
  contentAttachments?: ContentAttachmentItem[];
  /**
   * 消息在网关记录里的**原始 id**（不带 `resp-` / `oc-` 前缀），供「复制消息 id」按钮使用。
   * 取不到稳定字段时为 undefined，此时复制会回落到 `id`（本地稳定键）。
   */
  rawId?: string;
  /** `rawId` 取自哪个字段，仅用于 tooltip 说明来源。 */
  rawIdSource?: MessageIdSource;
  /** 工具调用（`role:"tool"`）的工具名（防御性字段，本部署通常只下发 toolResult）。 */
  toolName?: string;
  /** 工具调用 / 工具结果的状态（如 running / success / error）。 */
  status?: string;
};
