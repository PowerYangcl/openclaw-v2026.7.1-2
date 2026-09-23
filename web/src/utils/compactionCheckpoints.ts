/**
 * 会话流里的「压缩节点」——把一次 Compaction 压缩留下来的内容呈现给用户。
 *
 * ## 数据源（网关侧，全部只读）
 * 一次压缩会在会话条目上落一个 checkpoint（`src/gateway/session-compaction-checkpoints.ts`
 * 的 `SessionCompactionCheckpoint`），经 `sessions.compaction.list`（scope `operator.read`）
 * 下发给前端，字段里跟本模块相关的是：
 *   - `summary`           —— 压缩时生成的摘要正文（被压缩掉的那一段的浓缩）
 *   - `firstKeptEntryId`  —— 压缩后**保留下来的第一条** transcript 条目的 id
 *   - `tokensBefore/After`—— 压缩前后的 token 数
 *   - `reason`            —— manual / auto-threshold / overflow-retry / timeout-retry
 *
 * 于是「压缩保留下来的内容」在界面上是两样东西：
 *   ① **摘要**（`summary`）→ 本模块负责渲染成折叠节点；
 *   ② **保留下来的原始消息**（`firstKeptEntryId` 之后那些）→ 它们本来就在
 *      `chat.history` 里正常渲染，压缩节点只是**标出边界**，不做任何搬运。
 *
 * ## 硬边界：不影响发给模型的上下文
 * 本模块是**纯前端渲染**：
 *   - 只读 `sessions.compaction.list`，不发任何写方法（`branch` / `restore` 一律不碰）；
 *   - 不往 transcript 写任何内容、不回灌消息、不改 `messages` 数组（节点是独立渲染行）；
 *   - 拉不到 / 报错一律静默 —— 对话该怎么聊还怎么聊。
 * 模型看到的上下文由网关按 transcript 组装，与这里画什么完全无关。
 */

import type { ChatMessage } from "@/types/chat";

/** `SessionCompactionCheckpointReason` 的中文口径（对齐 sessions 页的展示）。 */
export type CompactionCheckpointReason =
  | "manual"
  | "auto-threshold"
  | "overflow-retry"
  | "timeout-retry";

export type CompactionCheckpoint = {
  checkpointId: string;
  createdAt: number;
  reason: CompactionCheckpointReason;
  tokensBefore?: number;
  tokensAfter?: number;
  summary?: string;
  firstKeptEntryId?: string;
};

const REASON_TEXT: Record<CompactionCheckpointReason, string> = {
  manual: "手动压缩",
  "auto-threshold": "自动压缩（达阈值）",
  "overflow-retry": "自动压缩（上下文溢出重试）",
  "timeout-retry": "自动压缩（超时重试）",
};

export function formatCompactionReason(reason: string | undefined): string {
  if (!reason) return "上下文已压缩";
  return REASON_TEXT[reason as CompactionCheckpointReason] ?? "上下文已压缩";
}

/** 千分位（与项目其它 token 展示一致，用 zh-CN 分组）。 */
function formatTokens(value: number | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(value).toLocaleString("zh-CN");
}

/**
 * 折叠态那一行摘要文案，例如「上下文已压缩 · 12,345 → 4,321 tokens」。
 * 没有 token 数据时退化成「上下文已压缩」，不编造数字。
 */
export function formatCompactionSummary(cp: CompactionCheckpoint): string {
  const before = formatTokens(cp.tokensBefore);
  const after = formatTokens(cp.tokensAfter);
  if (before && after) return `上下文已压缩 · ${before} → ${after} tokens`;
  if (after) return `上下文已压缩 · 压缩后 ${after} tokens`;
  return "上下文已压缩";
}

/** 有没有值得展开的内容（没摘要也没 token 数据时，只留一行标记）。 */
export function compactionHasDetails(cp: CompactionCheckpoint): boolean {
  return Boolean(cp.summary?.trim()) || typeof cp.tokensBefore === "number";
}

/**
 * 「哪个压缩节点该插在哪条消息前面」—— 返回 `消息 id → 该处要渲染的 checkpoint[]`。
 *
 * 定位优先级（与 transcript 的真实结构对齐）：
 *   ① `firstKeptEntryId` 命中某条消息的 `rawId`（transcript 内部 id，`__openclaw.id`）
 *      ⇒ 挂到它**前面** —— 语义就是「从这里往上是被压缩掉的，从这里往下是保留下来的」；
 *   ② 命中不了（历史被淘汰 / 旧网关没写这个字段）⇒ 退到时间戳：挂到第一条
 *      `ts >= createdAt` 的消息前面；
 *   ③ 仍然没有 ⇒ 挂到列表**最前面**（用 `TOP_KEY`），不凭空丢掉这条记录。
 *
 * ⚠️ 只按 `visibleMessages`（实际渲染的那几条）算：被隐藏的压缩提示之类
 * 不该影响定位，也避免算出「挂在一条看不见的消息前面」这种空指针插入点。
 */
export const COMPACTION_TOP_KEY = "\u0000top";

export function planCompactionNodes(
  messages: readonly ChatMessage[],
  checkpoints: readonly CompactionCheckpoint[],
): Map<string, CompactionCheckpoint[]> {
  const out = new Map<string, CompactionCheckpoint[]>();
  if (checkpoints.length === 0) return out;
  const byId = new Map<string, string>();
  for (const msg of messages) {
    if (msg.rawId && !byId.has(msg.rawId)) byId.set(msg.rawId, msg.id);
  }
  const push = (key: string, cp: CompactionCheckpoint) => {
    const list = out.get(key);
    if (list) list.push(cp);
    else out.set(key, [cp]);
  };
  for (const cp of checkpoints) {
    const keptId = cp.firstKeptEntryId ? byId.get(cp.firstKeptEntryId) : undefined;
    if (keptId) {
      push(keptId, cp);
      continue;
    }
    const anchor = messages.find(
      (msg) => typeof msg.ts === "number" && typeof cp.createdAt === "number" && msg.ts >= cp.createdAt,
    );
    if (anchor) {
      push(anchor.id, cp);
      continue;
    }
    push(COMPACTION_TOP_KEY, cp);
  }
  return out;
}
