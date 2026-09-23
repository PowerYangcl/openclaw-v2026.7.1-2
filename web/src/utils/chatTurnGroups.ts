/**
 * 「一个回合 = 一个回复单元」的分组口径（纯函数，**刻意不依赖 Vue**，可直接单测）。
 *
 * ## 为什么需要它（用户看到的问题现场）
 * 一个回合里模型每产出一段文字，网关的 transcript 就会**单独落一条** `role:"assistant"`
 * 记录，段与段之间夹着 `role:"toolResult"` 的连续块。`ChatPane.vue` 原本按「一条消息 = 一个
 * row」渲染 ⇒ 截图里那种「同一回合十几个 row」：每一行都重复**头像 + 名称/时间 + 积分/操作行**，
 * 5 段回复 + 5 次工具 = 10 行。
 *
 * 而**实时**看着只有一个气泡：网关在一个 run 结束时只推**一条** `final`，正文取该 run 的
 * 累积缓冲文本（`src/gateway/server-chat.ts:881-899` / `1007-1052`）⇒ 同一场对话
 * 「实时 1 行、刷新后 N 行」。分组把两者对齐。
 *
 * ## 分组规则（本模块的唯一权威口径）
 * - **边界**：`role:"user"` 与 `role:"system"` 各自独立渲染，是硬边界（见
 *   `TURN_RUN_SEPARATOR_ROLES`）。system 是会话内部记录，不参与助手回合。
 * - **组内**：两个边界之间的 `assistant` / `toolResult` / `tool` **全部归入同一组**，
 *   顺序保持原样；组 key = 组内**首条消息的 id**（稳定，可作 v-for key / 展开态 key）。
 * - 消息上**没有 runId**（transcript 只有 role/content/timestamp/responseId/toolCallId/
 *   `__openclaw.seq|id`），所以只能做结构性切分。`sessions_send` 转发进来的 assistant
 *   消息（上游 `ui/src/pages/chat/chat-thread.ts:395` 用 `provenance` 判边界）web 侧
 *   尚未解析 —— 目前会并进同一组，见 `isTurnRunSeparator` 的注释。
 *
 * ## 组级展示口径（产品已确认，2026-09-22）
 * - **积分**：不求和各段，取**末段**的 `spendResult`（剩余积分口径，与实时 final 一致）；
 *   组内任一段在查积分就显示「积分计算中」（`runSpendLoading`）。
 * - **复制**：「只复制组内正文」⇒ 只拼 assistant 段的正文，**不含**工具结果
 *   （`runCopyText`）。
 * - **详情**：显示组内**助手正文**（+ 各段媒体），**不含过程内容**（思考、工具结果 /
 *   工具调用的输出都不进详情 —— 2026-09-23 口径）。理由：气泡里「思考过程」是折叠块
 *   （`ChatPane.vue` 的 `.chat-activity-group` 折叠成「思考过程 · N 步」），而抽屉原先把
 *   `toolResult` 的原始 stdout（`Successfully wrote ...` / `pid=` / `saved`）当正文平铺，
 *   看起来既像正文又和正文重复 ⇒ 抽屉只留正文。`runDetailMessage` 刻意不写 `thinking`，
 *   也不拼非 assistant 段的 text（见 `ChatDetailSidebar.vue` 文件头）。
 * - **删除**：删整组（组件侧 `removeMessage` 识别组 key 后逐条删除并逐条记入
 *   `deletedMessages.v1`）。
 */

import type { ChatMessage, JdSpendResult, TokenUsage } from "@/types/chat";
import type { ContentAttachmentItem, ContentImageBlock } from "@/utils/contentMedia";
import type { TranscriptMediaItem } from "@/utils/transcriptMedia";

/** 独立成组、且打断助手回合的角色（硬边界）。 */
export const TURN_RUN_SEPARATOR_ROLES: ReadonlySet<string> = new Set(["user", "system"]);

/**
 * 这条消息是不是「回合边界」。
 *
 * ⚠️ 上游还用 `provenance.kind === "inter_session" && sourceTool === "sessions_send"`
 * 把「别的会话转发进来的助手消息」也当成新回合的起点（`ui/src/pages/chat/chat-thread.ts:395`）。
 * web 侧 `normalizeMessage` 目前不解析 provenance，所以这类消息会并进前一组。
 * 要补时在**这里**加判定即可（组件与模板都不用动）。
 */
export function isTurnRunSeparator(msg: Pick<ChatMessage, "role">): boolean {
  return TURN_RUN_SEPARATOR_ROLES.has(msg.role);
}

/** 组 key -> 组内消息；消息 id -> 组 key。与 `toolGroupPlan` 同款结构，便于模板原地改造。 */
export type TurnRunPlan = {
  keyToMessages: Map<string, ChatMessage[]>;
  msgIdToRunKey: Map<string, string>;
};

/** 把（已过滤的）消息序列切成回合组。 */
export function buildTurnRunPlan(messages: readonly ChatMessage[]): TurnRunPlan {
  const keyToMessages = new Map<string, ChatMessage[]>();
  const msgIdToRunKey = new Map<string, string>();
  let openKey = "";
  let open: ChatMessage[] | null = null;
  const flush = (): void => {
    // 空组不落表：组内消息可能被用户删光，留下空组会让模板渲染出一个空壳。
    if (open && open.length > 0) keyToMessages.set(openKey, open);
    open = null;
    openKey = "";
  };
  for (const msg of messages) {
    if (isTurnRunSeparator(msg)) {
      flush();
      continue;
    }
    if (!open) {
      open = [];
      openKey = msg.id;
    }
    open.push(msg);
    msgIdToRunKey.set(msg.id, openKey);
  }
  flush();
  return { keyToMessages, msgIdToRunKey };
}

/** 该消息所属组的 key（不属于任何组时回落到自身 id，调用方无需判空）。 */
export function turnRunKeyOf(plan: TurnRunPlan, msg: Pick<ChatMessage, "id">): string {
  return plan.msgIdToRunKey.get(msg.id) ?? msg.id;
}

/** 该消息是否属于某个回合组（即 role 为 assistant / toolResult / tool）。 */
export function isTurnRunMember(plan: TurnRunPlan, msg: Pick<ChatMessage, "id">): boolean {
  return plan.msgIdToRunKey.has(msg.id);
}

/** 是否是所在组的首条（整组只在这里渲染一次头像 + 名称/时间 + 底行）。 */
export function isTurnRunStart(
  plan: TurnRunPlan,
  msg: Pick<ChatMessage, "id">,
): boolean {
  return plan.msgIdToRunKey.get(msg.id) === msg.id;
}

/** 取整组（消息已不在表里时回落成单条，保证模板永远拿得到内容）。 */
export function turnRunOf(plan: TurnRunPlan, msg: Pick<ChatMessage, "id">): ChatMessage[] {
  return plan.keyToMessages.get(turnRunKeyOf(plan, msg)) ?? [];
}

/** 按组 key 取整组（用于「流式尾部并进最后一组」这类按 key 查找的场景）。 */
export function turnRunByKey(plan: TurnRunPlan, key: string): ChatMessage[] | null {
  return plan.keyToMessages.get(key) ?? null;
}

/** 组内是否有 assistant 段（决定要不要渲染名称/时间 + 底行：纯工具组与旧版一致，不渲染）。 */
export function runHasAssistantSegment(run: readonly ChatMessage[]): boolean {
  return run.some((msg) => msg.role === "assistant");
}

function assistantTexts(run: readonly ChatMessage[]): string[] {
  const out: string[] = [];
  for (const msg of run) {
    if (msg.role !== "assistant") continue;
    const text = (msg.text ?? "").trim();
    if (text) out.push(text);
  }
  return out;
}

/**
 * 「复制」用的正文：**只**拼组内 assistant 段的正文。
 *
 * 刻意不含 `toolResult` / `tool` 的正文 —— 那是「思考过程 / 工具活动」的内容，
 * 与产品口径里的「组内正文」不是一回事（要全量信息请走「详情」）。
 */
export function runCopyText(run: readonly ChatMessage[]): string {
  return assistantTexts(run).join("\n\n");
}

export function canCopyRun(run: readonly ChatMessage[]): boolean {
  return run.some((msg) => msg.role === "assistant" && (msg.text ?? "").trim().length > 0);
}

/**
 * 组级积分：**取末段**（从组尾往前找第一条带 `spendResult` 的消息）。
 *
 * 为什么不是「组内最后一条消息」：组尾常常是 `toolResult` 段（它没有 `responseId`、
 * 也就永远没有积分），严格按「末条」取会让整组的积分凭空消失。往前找第一条有值的
 * 消息，语义仍是「这一轮结束时的剩余积分」，与实时 `final` 帧的口径一致，且**不求和**。
 */
export function runSpendResult(run: readonly ChatMessage[]): JdSpendResult | undefined {
  for (let i = run.length - 1; i >= 0; i -= 1) {
    const spend = run[i]?.spendResult;
    if (spend) return spend;
  }
  return undefined;
}

/** 组内任一段还在查积分 ⇒ 底行显示「积分计算中」。 */
export function runSpendLoading(run: readonly ChatMessage[]): boolean {
  return run.some((msg) => msg.spendLoading === true);
}

/** 底行「生成模型」口径：取组内最后一条同时带 provider + model 的消息。 */
export function runModelOf(
  run: readonly ChatMessage[],
): { provider: string; model: string } | null {
  for (let i = run.length - 1; i >= 0; i -= 1) {
    const msg = run[i];
    if (msg?.provider && msg.model) return { provider: msg.provider, model: msg.model };
  }
  return null;
}

/** 组内**复制消息 id** 用的文本：每行一个（去重、保序）。 */
export function runMessageIds(run: readonly ChatMessage[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const msg of run) {
    const value = (msg.rawId ?? msg.id ?? "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * 组内**最后一条**消息 id。
 *
 * 产品口径：一轮回复虽然由多段组成（每段是 transcript 里独立的一条记录），
 * 但对用户来说这是「一次回复」，对外只需要一个可定位的 id ⇒ 取组内最后一段的 id。
 * 空组（或所有段都没有 id）返回空串。
 */
export function runLastMessageId(run: readonly ChatMessage[]): string {
  const ids = runMessageIds(run);
  return ids.length > 0 ? ids[ids.length - 1] : "";
}

/** 是否可打开「详情」（对齐单条口径：助手段有正文或思考）。 */
export function canOpenRunDetail(run: readonly ChatMessage[]): boolean {
  return run.some(
    (msg) =>
      msg.role === "assistant" &&
      ((msg.text ?? "").trim().length > 0 || Boolean(msg.thinking)),
  );
}

function dedupeImages(items: readonly ContentImageBlock[]): ContentImageBlock[] {
  const out: ContentImageBlock[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.url || seen.has(item.url)) continue;
    seen.add(item.url);
    out.push(item);
  }
  return out;
}

function dedupeAttachments(items: readonly ContentAttachmentItem[]): ContentAttachmentItem[] {
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

function dedupeHistoryMedia(items: readonly TranscriptMediaItem[]): TranscriptMediaItem[] {
  const out: TranscriptMediaItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.source || seen.has(item.source)) continue;
    seen.add(item.source);
    out.push(item);
  }
  return out;
}

function lastUsage(run: readonly ChatMessage[]): TokenUsage | undefined {
  for (let i = run.length - 1; i >= 0; i -= 1) {
    const usage = run[i]?.usage;
    if (usage) return usage;
  }
  return undefined;
}

/**
 * 「详情」抽屉要展示的**合成消息**：组内所有段拼成一条。
 *
 * - 正文 = 组内 **assistant 段**的非空正文，按原顺序用空行拼接（2026-09-23 口径）。
 *   `toolResult` / `tool` 段的 text 是**过程输出**（命令 stdout、文件写入回执），气泡里被
 *   折叠成「思考过程 · N 步」，抽屉里不该平铺进正文 —— 用户看到的现场就是抽屉里冒出
 *   `Successfully wrote 9905 bytes ...` / `saved` 这类日志。
 * - 媒体位 = 组内各段的图片 / 附件 / 历史附件合并去重（同一个文件在多段里出现只留一份）。
 *   ⚠️ 媒体**仍取全部段**：过程段里带出的产物（生成的图 / 文档卡片）是**交付物**而非过程噪音，
 *   滤掉会让用户再也看不到它；实测本部署工具结果里的图片 base64 已被网关抹掉、
 *   压根不产出条目（见 `utils/contentMedia.ts`），所以这里保留全量不会带回噪音。
 * - **刻意不写 `thinking`**：详情抽屉不渲染思考（2026-09-22 口径，见 `ChatDetailSidebar.vue`）。
 * - id 用 `组key#detail`（组 key 由调用方传入），与真实消息 id 不会撞，且不参与删除集合。
 */
export function runDetailMessage(
  run: readonly ChatMessage[],
  runKey: string,
): ChatMessage | null {
  const first = run[0];
  if (!first) return null;
  const texts: string[] = [];
  const images: ContentImageBlock[] = [];
  const attachments: ContentAttachmentItem[] = [];
  const historyMedia: TranscriptMediaItem[] = [];
  for (const msg of run) {
    // ⚠️ 只收 assistant 段的正文：非 assistant 段（toolResult / tool）的 text 是过程输出，
    // 属于气泡里的「思考过程」折叠块，不进详情抽屉。改这里等于改「抽屉显不显示过程」，想清楚再动。
    if (msg.role === "assistant") {
      const text = (msg.text ?? "").trim();
      if (text) texts.push(text);
    }
    if (msg.contentImages?.length) images.push(...msg.contentImages);
    if (msg.contentAttachments?.length) attachments.push(...msg.contentAttachments);
    if (msg.historyMedia?.length) historyMedia.push(...msg.historyMedia);
  }
  const model = runModelOf(run);
  const usage = lastUsage(run);
  const spendResult = runSpendResult(run);
  const mergedImages = dedupeImages(images);
  const mergedAttachments = dedupeAttachments(attachments);
  const mergedHistoryMedia = dedupeHistoryMedia(historyMedia);
  return {
    id: `${runKey}#detail`,
    role: "assistant",
    text: texts.join("\n\n"),
    ts: first.ts,
    ...(model ? { provider: model.provider, model: model.model } : {}),
    ...(spendResult ? { spendResult } : {}),
    ...(usage ? { usage } : {}),
    ...(mergedImages.length > 0 ? { contentImages: mergedImages } : {}),
    ...(mergedAttachments.length > 0 ? { contentAttachments: mergedAttachments } : {}),
    ...(mergedHistoryMedia.length > 0 ? { historyMedia: mergedHistoryMedia } : {}),
  };
}
